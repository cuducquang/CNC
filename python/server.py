"""
CNCapp Python microservice — FastAPI server.

Endpoints:
  POST /analyze-stream SSE streaming pipeline (new primary endpoint)
                       Browser → Python directly; no Vercel timeout limit.
  POST /analyze        Full analysis: STEP feature recognition + process mapping
                       (legacy — kept for compatibility)
  POST /analyze/step   STEP-only feature recognition (geometry, no process map)
  POST /convert-pdf    PDF → PNG base64 pages via pdftoppm
  GET  /health         Health check (FreeCAD availability)

Run:
  py -3.11 -m uvicorn server:app --host 0.0.0.0 --port 8001 --reload

Or with Docker:
  docker build -t cncapp-python . && docker run -p 8001:8001 cncapp-python
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
    recognize_features,
    map_processes,
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


app = FastAPI(
    title="CNCapp Analysis API",
    description=(
        "Deterministic CNC analysis pipeline.\n"
        "POST /analyze — full feature recognition + process mapping.\n"
        "POST /analyze/step — geometry-only feature recognition."
    ),
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Streaming pipeline  (new primary endpoint — bypasses Vercel timeout)
# ---------------------------------------------------------------------------

@app.post("/analyze-stream")
async def analyze_stream(request: Request):
    """
    SSE streaming endpoint for the full 6-step CNC costing pipeline.

    Request body (JSON):
      analysis_id  : str  — UUID for tracking
      drawing_url  : str  — Supabase signed URL for the 2D drawing
      step_url     : str  — Supabase signed URL for the STEP file
      file_name    : str  — original filename (used in summary text)

    The browser calls this endpoint DIRECTLY — no Next.js proxy, no timeout limit.
    Events: status | tool_call | tool_result | thinking | final_answer | error | done
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    analysis_id  = body.get("analysis_id") or "unknown"
    drawing_url  = body.get("drawing_url") or ""
    step_url     = body.get("step_url")    or ""
    file_name    = body.get("file_name")   or "part.stp"

    if not drawing_url or not step_url:
        raise HTTPException(status_code=400, detail="drawing_url and step_url are required")

    from pipeline import run_pipeline

    async def event_generator():
        try:
            async for event_type, data in run_pipeline(analysis_id, drawing_url, step_url, file_name):
                yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
        except Exception as e:
            logger.exception("Streaming pipeline error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
            yield f"event: done\ndata: {json.dumps({'total_minutes': 0, 'total_usd': 0, 'elapsed_seconds': 0})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":      "no-cache, no-transform",
            "X-Accel-Buffering":  "no",
            "Connection":         "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status":            "ok",
        "freecad_available": _freecad_available(),
    }


# ---------------------------------------------------------------------------
# PDF → PNG conversion
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
            subprocess.run(
                # 96 DPI: E-size drawings (34"×22") render to ~3264×2112px.
            # 150 DPI produces ~5100×3300px which exceeds Qwen3-VL's ~4000-token visual context
            # and causes content_len=0 (no room left for JSON output after image tokens).
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
# Full analysis: STEP + drawing extraction → features + process map
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
      1. Feature recognition  — BrepMFR (if installed) → FreeCAD geometric fallback
      2. Process mapping      — deterministic rule-based (FreeCAD Path concepts)

    Returns shape summary, recognised features, and full process map.
    Cycle time and cost estimation are computed in Next.js.
    """
    if not _freecad_available():
        raise HTTPException(
            status_code=503,
            detail="FreeCAD not available. Set FREECAD_PATH and restart.",
        )

    # Parse drawing extraction
    extraction: dict = {}
    if drawing_extraction.strip():
        try:
            extraction = json.loads(drawing_extraction)
        except json.JSONDecodeError as exc:
            logger.warning("drawing_extraction is not valid JSON: %s", exc)

    # Resolve material: drawing spec takes priority over form field
    mat_raw  = (extraction.get("material") or material or "Al6061")
    mat_key  = resolve_material(mat_raw, default="Al6061")
    logger.info("Resolved material: %r → %s", mat_raw, mat_key)

    with tempfile.TemporaryDirectory() as tmpdir:
        step_path = os.path.join(tmpdir, file_3d.filename or "part.stp")
        with open(step_path, "wb") as f:
            f.write(await file_3d.read())

        try:
            # ── 1. Feature Recognition ────────────────────────────────────────
            logger.info("Feature recognition: %s", file_3d.filename)
            features_raw, feat_source = recognize_features(step_path)
            logger.info(
                "Recognised %d features via %s",
                len(features_raw), feat_source,
            )
            for fr in features_raw:
                dims_clean = {
                    k: v for k, v in fr.get("dimensions", {}).items()
                    if not k.startswith("_")
                }
                logger.info(
                    "  %-6s %-40s  %s",
                    fr.get("id", "?"),
                    fr.get("name", ""),
                    "  ".join(f"{k}={v}" for k, v in dims_clean.items()),
                )

            # ── 2. Shape Summary (from FreeCAD — always available) ────────────
            shape_summary = None
            try:
                raw_result   = STEPAnalyzer(step_path).analyze()
                ss           = raw_result.get("shape_summary", {})
                shape_summary = ShapeSummary(**ss) if ss else None
            except Exception as exc:
                logger.warning("Shape summary extraction failed: %s", exc)

            # ── 3. Process Mapping ────────────────────────────────────────────
            logger.info("Process mapping for %d features (material=%s)", len(features_raw), mat_key)
            process_map = map_processes(features_raw, extraction, mat_key)
            logger.info("Generated %d operations", len(process_map))

            # Build typed feature objects
            feature_objects = [
                RecognizedFeature(
                    id=f.get("id", "?"),
                    name=f.get("name", ""),
                    type=f.get("type", "other"),
                    description=f.get("description", ""),
                    dimensions={
                        k: v for k, v in f.get("dimensions", {}).items()
                        if not k.startswith("_")
                    },
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
# STEP-only geometry analysis (kept for diagnostics / compatibility)
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
                    dimensions={
                        k: v for k, v in f.get("dimensions", {}).items()
                        if not k.startswith("_")
                    },
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


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    from config import HOST, PORT
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
