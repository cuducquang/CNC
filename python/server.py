"""
CNCapp Python microservice — unified FastAPI server (port 8001).

Approach 2 endpoints (FreeCAD deterministic pipeline):
  POST /analyze-stream   SSE streaming pipeline (primary endpoint)
  POST /analyze          Full feature recognition + process mapping (legacy)
  POST /analyze/step     STEP-only geometry analysis
  POST /convert-pdf      PDF -> PNG base64 pages via pdftoppm
  GET  /health           Health check (FreeCAD availability)

Approach 1 endpoints (LLM-per-step):
  POST /v1/gdt           Step 1: VLM GD&T extraction (SSE stream)
  POST /v1/step3d        Step 2: STEP geometry via text LLM (JSON)
  POST /v1/features      Step 3: Feature recognition via text LLM (JSON)
  POST /v1/processes     Step 4: Process mapping via text LLM (JSON)
  POST /v1/cycletime     Step 5: Cycle time estimation via text LLM (JSON)
  POST /v1/cost          Step 6: Cost formula, no LLM (JSON)
  GET  /v1/health        Liveness check for Approach 1

Run:
  uvicorn server:app --host 0.0.0.0 --port 8001 --reload
"""
from __future__ import annotations

import base64
import glob
import json
import logging
import os
import subprocess
import tempfile

# Load .env.local from project root (local dev) — no-op if file absent or dotenv not installed
try:
    from dotenv import load_dotenv
    _env = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    if os.path.exists(_env):
        load_dotenv(_env, override=False)
except ImportError:
    pass

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from freecad_analyzer import (
    STEPAnalyzer,
    load_freecad,
    recognize_features as fc_recognize_features,
    map_processes as fc_map_processes,
    resolve_material,
)
import freecad_analyzer.step_analyzer as freecad_step
from freecad_analyzer.models import (
    AnalysisResponse,
    FeatureRecognitionResult,
    FullAnalysisResponse,
    RecognizedFeature,
    ShapeSummary,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cncapp.server")

load_freecad()


def _freecad_available() -> bool:
    if freecad_step.FREECAD_AVAILABLE:
        return True
    return load_freecad()


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="CNCapp Analysis API",
    description=(
        "Unified CNC analysis server.\n"
        "Approach 2 (FreeCAD): POST /analyze, /analyze/step, /analyze-stream.\n"
        "Approach 1 (LLM-per-step): POST /v1/gdt, /v1/step3d, /v1/features, /v1/processes, /v1/cycletime, /v1/cost."
    ),
    version="4.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------

def _sse_event(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


def _sse_heartbeat() -> str:
    return ": heartbeat\n\n"


async def _json_body(request: Request) -> dict:
    try:
        return await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}")


# ===========================================================================
# APPROACH 2 ENDPOINTS (FreeCAD deterministic pipeline)
# ===========================================================================

# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status":            "ok",
        "freecad_available": _freecad_available(),
    }


# ---------------------------------------------------------------------------
# POST /analyze-stream  (SSE streaming pipeline)
# ---------------------------------------------------------------------------

@app.post("/analyze-stream")
async def analyze_stream(request: Request):
    """
    SSE streaming endpoint for the full 6-step FreeCAD CNC costing pipeline.

    Request body (JSON):
      analysis_id  : str  — UUID for tracking
      drawing_url  : str  — Supabase signed URL for the 2D drawing
      step_url     : str  — Supabase signed URL for the STEP file
      file_name    : str  — original filename (used in summary text)

    Events: status | tool_call | tool_result | thinking | final_answer | error | done
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    analysis_id = body.get("analysis_id") or "unknown"
    drawing_url = body.get("drawing_url") or ""
    step_url    = body.get("step_url")    or ""
    file_name   = body.get("file_name")   or "part.stp"

    if not drawing_url or not step_url:
        raise HTTPException(status_code=400, detail="drawing_url and step_url are required")

    from pipeline import run_pipeline

    async def event_generator():
        try:
            async for event_type, data in run_pipeline(analysis_id, drawing_url, step_url, file_name):
                if event_type == "heartbeat":
                    yield ": heartbeat\n\n"
                else:
                    yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
        except Exception as e:
            logger.exception("Streaming pipeline error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
            yield f"event: done\ndata: {json.dumps({'total_minutes': 0, 'total_usd': 0, 'elapsed_seconds': 0})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# POST /convert-pdf
# ---------------------------------------------------------------------------

@app.post("/convert-pdf")
async def convert_pdf(
    file: UploadFile = File(..., description="PDF file to convert to PNG images"),
):
    """Convert a PDF to base64-encoded PNG pages via pdftoppm."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path   = os.path.join(tmpdir, "input.pdf")
        out_prefix = os.path.join(tmpdir, "page")

        with open(pdf_path, "wb") as f:
            f.write(await file.read())

        try:
            # 96 DPI: E-size drawings (34"×22") render to ~3264×2112px.
            # 150 DPI produces ~5100×3300px which exceeds Qwen3-VL's ~4000-token visual
            # context and causes content_len=0 (no room left for JSON output after image tokens).
            subprocess.run(
                ["pdftoppm", "-png", "-r", "96", "-f", "1", "-l", "32", pdf_path, out_prefix],
                check=True, timeout=120, capture_output=True,
            )
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="pdftoppm not found on this server")
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"pdftoppm failed: {e.stderr.decode()[:200]}")

        png_files = sorted(glob.glob(os.path.join(tmpdir, "page*.png")))
        if not png_files:
            raise HTTPException(status_code=422, detail="pdftoppm produced no output — is this a valid PDF?")

        pages = []
        for png_path in png_files:
            with open(png_path, "rb") as f:
                pages.append(base64.b64encode(f.read()).decode("utf-8"))

        logger.info("convert-pdf: %d page(s) converted from %s", len(pages), file.filename)
        return JSONResponse({"pages": pages, "count": len(pages)})


# ---------------------------------------------------------------------------
# POST /analyze  (full feature recognition + process mapping)
# ---------------------------------------------------------------------------

@app.post("/analyze", response_model=FullAnalysisResponse)
async def analyze_full(
    file_3d: UploadFile = File(..., description="STEP / STP file"),
    drawing_extraction: str = Form(
        default="",
        description=(
            "JSON string from VLM extraction step. "
            "Schema: {dimensions, gdt, threads, material, surface_finish, notes}"
        ),
    ),
    material: str = Form(
        default="Al6061",
        description="Material key override (used if drawing_extraction.material is absent)",
    ),
):
    """
    Full deterministic pipeline:
      1. Feature recognition — BrepMFR (if installed) -> FreeCAD geometric fallback
      2. Process mapping     — deterministic rule-based (FreeCAD Path concepts)

    Returns shape summary, recognised features, and full process map.
    Cycle time and cost estimation are computed in Next.js.
    """
    if not _freecad_available():
        raise HTTPException(
            status_code=503,
            detail="FreeCAD not available. Set FREECAD_PATH and restart.",
        )

    extraction: dict = {}
    if drawing_extraction.strip():
        try:
            extraction = json.loads(drawing_extraction)
        except json.JSONDecodeError as exc:
            logger.warning("drawing_extraction is not valid JSON: %s", exc)

    mat_raw = (extraction.get("material") or material or "Al6061")
    mat_key = resolve_material(mat_raw, default="Al6061")
    logger.info("Resolved material: %r -> %s", mat_raw, mat_key)

    with tempfile.TemporaryDirectory() as tmpdir:
        step_path = os.path.join(tmpdir, file_3d.filename or "part.stp")
        with open(step_path, "wb") as f:
            f.write(await file_3d.read())

        try:
            logger.info("Feature recognition: %s", file_3d.filename)
            features_raw, feat_source = fc_recognize_features(step_path)
            logger.info("Recognised %d features via %s", len(features_raw), feat_source)
            for fr in features_raw:
                dims_clean = {k: v for k, v in fr.get("dimensions", {}).items() if not k.startswith("_")}
                logger.info(
                    "  %-6s %-40s  %s",
                    fr.get("id", "?"), fr.get("name", ""),
                    "  ".join(f"{k}={v}" for k, v in dims_clean.items()),
                )

            shape_summary = None
            try:
                raw_result    = STEPAnalyzer(step_path).analyze()
                ss            = raw_result.get("shape_summary", {})
                shape_summary = ShapeSummary(**ss) if ss else None
            except Exception as exc:
                logger.warning("Shape summary extraction failed: %s", exc)

            logger.info("Process mapping for %d features (material=%s)", len(features_raw), mat_key)
            process_map = fc_map_processes(features_raw, extraction, mat_key)
            logger.info("Generated %d operations", len(process_map))

            feature_objects = [
                RecognizedFeature(
                    id=f.get("id", "?"),
                    name=f.get("name", ""),
                    type=f.get("type", "other"),
                    description=f.get("description", ""),
                    dimensions={k: v for k, v in f.get("dimensions", {}).items() if not k.startswith("_")},
                    source=f.get("source", feat_source),
                )
                for f in features_raw
            ]

            return FullAnalysisResponse(
                success=True,
                shape_summary=shape_summary,
                features=feature_objects,
                process_map=process_map,
                feature_source=feat_source,
            )

        except Exception as exc:
            logger.exception("Full analysis failed")
            return FullAnalysisResponse(success=False, error=str(exc))


# ---------------------------------------------------------------------------
# POST /analyze/step  (STEP-only geometry analysis)
# ---------------------------------------------------------------------------

@app.post("/analyze/step", response_model=AnalysisResponse)
async def analyze_step(
    file_3d: UploadFile = File(..., description="STEP/STP file"),
):
    """
    Geometry-only feature recognition via FreeCAD.
    Returns shape summary and raw feature list — no process mapping.
    """
    if not _freecad_available():
        raise HTTPException(status_code=503, detail="FreeCAD not available.")

    with tempfile.TemporaryDirectory() as tmpdir:
        step_path = os.path.join(tmpdir, file_3d.filename or "part.stp")
        with open(step_path, "wb") as f:
            f.write(await file_3d.read())

        try:
            logger.info("STEP-only analysis: %s", file_3d.filename)
            result = STEPAnalyzer(step_path).analyze()

            ss = result.get("shape_summary", {})
            logger.info(
                "Shape: %s  faces=%d  bbox=%.2f×%.2f×%.2f mm  vol=%.1f mm³",
                ss.get("shape_type"), ss.get("n_faces"),
                ss.get("bbox_x_mm", 0), ss.get("bbox_y_mm", 0), ss.get("bbox_z_mm", 0),
                ss.get("volume_mm3", 0),
            )

            feats = result.get("features", [])
            type_counts: dict = {}
            for f in feats:
                t = f.get("type", "other")
                type_counts[t] = type_counts.get(t, 0) + 1
            logger.info(
                "Extracted %d features: %s",
                len(feats),
                "  ".join(f"{t}={n}" for t, n in sorted(type_counts.items())),
            )

            feat_objects = [
                RecognizedFeature(
                    id=f.get("id", "?"),
                    name=f.get("name", ""),
                    type=f.get("type", "other"),
                    description=f.get("description", ""),
                    dimensions={k: v for k, v in f.get("dimensions", {}).items() if not k.startswith("_")},
                )
                for f in feats
            ]

            return AnalysisResponse(
                success=True,
                shape_summary=ShapeSummary(**ss),
                feature_recognition=FeatureRecognitionResult(features=feat_objects),
            )

        except Exception as exc:
            logger.exception("STEP analysis failed")
            return AnalysisResponse(success=False, error=str(exc))


# ===========================================================================
# APPROACH 1 ENDPOINTS (/v1/...) — LLM-per-step pipeline
# ===========================================================================

# ---------------------------------------------------------------------------
# GET /v1/health
# ---------------------------------------------------------------------------

@app.get("/v1/health")
async def v1_health():
    """Quick liveness check for load balancers and CI."""
    return {"status": "ok", "approach": "1-llm"}


# ---------------------------------------------------------------------------
# POST /v1/gdt  — Step 1: VLM GD&T extraction (SSE stream)
# ---------------------------------------------------------------------------

@app.post("/v1/gdt")
async def endpoint_gdt(request: Request):
    """
    Step 1: Extract dimensions, GD&T callouts, and threads from a 2D drawing PDF.

    Request body:
      drawing_url : str  — URL to the drawing file (PDF / PNG / JPG)
      file_name   : str  — original filename (used in log messages)

    Response: text/event-stream
      event: thinking   — VLM reasoning tokens
      : heartbeat       — keep-alive comment (every ~15 s of silence)
      event: gdt_result — merged extraction dict (final result)
      event: error      — if something went wrong
      event: done       — signals end of stream
    """
    body        = await _json_body(request)
    drawing_url = body.get("drawing_url") or ""
    file_name   = body.get("file_name")   or "drawing.pdf"

    if not drawing_url:
        raise HTTPException(status_code=400, detail="drawing_url is required")

    from pipeline import analyze_gdt

    async def event_generator():
        try:
            async for event_type, data in analyze_gdt(drawing_url, file_name):
                if event_type == "heartbeat":
                    yield _sse_heartbeat()
                else:
                    yield _sse_event(event_type, data)
        except Exception as exc:
            logger.exception("SSE /v1/gdt error")
            yield _sse_event("error", {"message": str(exc)})
            yield _sse_event("done",  {})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# POST /v1/step3d  — Step 2: STEP geometry analysis (JSON)
# ---------------------------------------------------------------------------

@app.post("/v1/step3d")
async def endpoint_step3d(request: Request):
    """
    Step 2: Download a STEP file, parse geometry with regex, then classify
    machining features via the text LLM.

    Request body:
      step_url  : str — URL to the STEP / STP file
      file_name : str — original filename (used in the LLM prompt)

    Response JSON:
      { "ok": true, "features_3d": [...], "shape_summary": {...} }
    """
    body      = await _json_body(request)
    step_url  = body.get("step_url")  or ""
    file_name = body.get("file_name") or "part.stp"

    if not step_url:
        raise HTTPException(status_code=400, detail="step_url is required")

    from pipeline import analyze_step3d

    try:
        result = await analyze_step3d(step_url, file_name)
        if "error" in result:
            has_data = bool(result.get("features_3d") or result.get("shape_summary"))
            if has_data:
                # LLM classification failed but FreeCAD geometry is available —
                # return as degraded success so the pipeline can continue.
                logger.warning("/v1/step3d LLM failed (FreeCAD data available): %s", result["error"])
                return JSONResponse({
                    "ok":           True,
                    "warning":      result["error"],
                    "features_3d":  result.get("features_3d",  []),
                    "shape_summary": result.get("shape_summary", {}),
                    "thinking":     result.get("thinking", ""),
                })
            logger.warning("/v1/step3d pipeline error (no geometry): %s", result["error"])
            return JSONResponse(
                {
                    "ok":           False,
                    "error":        result["error"],
                    "features_3d":  [],
                    "shape_summary": {},
                    "thinking":     "",
                },
                status_code=200,
            )
        return JSONResponse({
            "ok":           True,
            "features_3d":  result.get("features_3d",  []),
            "shape_summary": result.get("shape_summary", {}),
            "thinking":     result.get("thinking", ""),
        })
    except Exception as exc:
        logger.exception("/v1/step3d unhandled error")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)


# ---------------------------------------------------------------------------
# POST /v1/features  — Step 3: feature recognition (JSON)
# ---------------------------------------------------------------------------

@app.post("/v1/features")
async def endpoint_features(request: Request):
    """
    Step 3: Merge 2D GD&T extraction with 3D STEP features via the text LLM.

    Request body:
      extraction   : dict — output of /v1/gdt  (gdt_result event payload)
      step_analysis: dict — output of /v1/step3d

    Response JSON:
      { "ok": true, "features": [...], "material": {...}, "feature_count": int }
    """
    body          = await _json_body(request)
    extraction    = body.get("extraction")    or {}
    step_analysis = body.get("step_analysis") or {}

    if not isinstance(extraction, dict):
        raise HTTPException(status_code=400, detail="extraction must be a JSON object")
    if not isinstance(step_analysis, dict):
        raise HTTPException(status_code=400, detail="step_analysis must be a JSON object")

    from pipeline import recognize_features

    try:
        result = await recognize_features(extraction, step_analysis)
        if "error" in result:
            logger.warning("/v1/features pipeline error: %s", result["error"])
            return JSONResponse(
                {
                    "ok":            False,
                    "error":         result["error"],
                    "features":      result.get("features",      []),
                    "material":      result.get("material",      {}),
                    "feature_count": result.get("feature_count", 0),
                    "thinking":      result.get("thinking", ""),
                },
                status_code=200,
            )
        return JSONResponse({
            "ok":            True,
            "features":      result.get("features",      []),
            "material":      result.get("material",      {}),
            "feature_count": result.get("feature_count", 0),
            "thinking":      result.get("thinking", ""),
        })
    except Exception as exc:
        logger.exception("/v1/features unhandled error")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)


# ---------------------------------------------------------------------------
# POST /v1/processes  — Step 4: CNC process mapping (JSON)
# ---------------------------------------------------------------------------

@app.post("/v1/processes")
async def endpoint_processes(request: Request):
    """
    Step 4: Map recognised features to CNC operations via the text LLM.

    Request body:
      features : list — output features list from /v1/features
      material : dict — material dict from /v1/features  ({"name": ..., "spec": ...})

    Response JSON:
      { "ok": true, "operations": [...], "operation_count": int }
    """
    body     = await _json_body(request)
    features = body.get("features") or []
    material = body.get("material") or {}

    if not isinstance(features, list):
        raise HTTPException(status_code=400, detail="features must be a JSON array")
    if not isinstance(material, dict):
        raise HTTPException(status_code=400, detail="material must be a JSON object")

    from pipeline import map_processes

    try:
        result = await map_processes(features, material)
        if "error" in result:
            logger.warning("/v1/processes pipeline error: %s", result["error"])
            return JSONResponse(
                {
                    "ok":              False,
                    "error":           result["error"],
                    "operations":      result.get("operations",     []),
                    "operation_count": result.get("operation_count", 0),
                    "thinking":        result.get("thinking", ""),
                },
                status_code=200,
            )
        return JSONResponse({
            "ok":              True,
            "operations":      result.get("operations",     []),
            "operation_count": result.get("operation_count", 0),
            "thinking":        result.get("thinking", ""),
        })
    except Exception as exc:
        logger.exception("/v1/processes unhandled error")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)


# ---------------------------------------------------------------------------
# POST /v1/cycletime  — Step 5: cycle time estimation (JSON)
# ---------------------------------------------------------------------------

@app.post("/v1/cycletime")
async def endpoint_cycletime(request: Request):
    """
    Step 5: Estimate per-operation and total machining cycle time via the text LLM.

    Request body:
      operations    : list — operations list from /v1/processes
      material_spec : str  — e.g. "AL6061-T6"  (used in the LLM prompt)

    Response JSON:
      { "ok": true, "total_minutes": float, "setup_minutes": float, "operations": [...] }
    """
    body          = await _json_body(request)
    operations    = body.get("operations")    or []
    material_spec = body.get("material_spec") or "AL6061-T6"

    if not isinstance(operations, list):
        raise HTTPException(status_code=400, detail="operations must be a JSON array")

    from pipeline import estimate_cycle_time_llm

    try:
        result = await estimate_cycle_time_llm(operations, material_spec)
        if "error" in result:
            logger.warning("/v1/cycletime pipeline error: %s", result["error"])
            return JSONResponse(
                {
                    "ok":             False,
                    "error":          result["error"],
                    "total_minutes":  result.get("total_minutes",  0),
                    "setup_minutes":  result.get("setup_minutes",  5.0),
                    "operations":     result.get("operations",     []),
                    "thinking":       result.get("thinking", ""),
                },
                status_code=200,
            )
        return JSONResponse({
            "ok":             True,
            "total_minutes":  result.get("total_minutes",  0),
            "setup_minutes":  result.get("setup_minutes",  5.0),
            "operations":     result.get("operations",     []),
            "thinking":       result.get("thinking", ""),
        })
    except Exception as exc:
        logger.exception("/v1/cycletime unhandled error")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)


# ---------------------------------------------------------------------------
# POST /v1/cost  — Step 6: cost estimation formula (JSON)
# ---------------------------------------------------------------------------

@app.post("/v1/cost")
async def endpoint_cost(request: Request):
    """
    Step 6: Compute fabrication cost from cycle time using a fixed-rate formula.
    No LLM call — deterministic and instant.

    Request body:
      cycle_time    : dict — output of /v1/cycletime
      material_spec : str  — e.g. "AL6061-T6"

    Response JSON:
      { "ok": true, "total_usd": float, "breakdown": [...] }
    """
    body          = await _json_body(request)
    cycle_time    = body.get("cycle_time")    or {}
    material_spec = body.get("material_spec") or "AL6061-T6"

    if not isinstance(cycle_time, dict):
        raise HTTPException(status_code=400, detail="cycle_time must be a JSON object")

    from pipeline import estimate_cost_formula

    try:
        result = estimate_cost_formula(cycle_time, material_spec)
        return JSONResponse({
            "ok":        True,
            "total_usd": result.get("total_usd",  0),
            "breakdown": result.get("breakdown",  []),
            **{k: v for k, v in result.items() if k not in ("total_usd", "breakdown")},
        })
    except Exception as exc:
        logger.exception("/v1/cost unhandled error")
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run("server:app", host=host, port=port, reload=False)
