"""
Approach 1 server — separate endpoint per pipeline step.
Run: uvicorn server_llm:app --host 0.0.0.0 --port 8002 --reload

Endpoints:
  POST /v1/gdt          → SSE stream  (step 1: VLM PDF extraction)
  POST /v1/step3d       → JSON        (step 2: STEP geometry via text LLM)
  POST /v1/features     → JSON        (step 3: feature recognition via text LLM)
  POST /v1/processes    → JSON        (step 4: process mapping via text LLM)
  POST /v1/cycletime    → JSON        (step 5: cycle time via text LLM)
  POST /v1/cost         → JSON        (step 6: cost formula)
  GET  /v1/health       → {"status":"ok"}
"""
from __future__ import annotations

import json
import logging
import os

# ---------------------------------------------------------------------------
# Load .env.local from project root (local dev) — no-op if absent or no dotenv
# ---------------------------------------------------------------------------
try:
    from dotenv import load_dotenv
    _env = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    if os.path.exists(_env):
        load_dotenv(_env, override=False)
except ImportError:
    pass

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from pipeline_llm import (
    analyze_gdt,
    analyze_step3d,
    recognize_features,
    map_processes,
    estimate_cycle_time_llm,
    estimate_cost_formula,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cncapp.server_llm")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="CNCapp LLM Pipeline API  (Approach 1)",
    description=(
        "Separate endpoint per CNC costing pipeline step.\n"
        "All steps powered by Qwen3-VL-32B via vLLM OpenAI-compat API.\n"
        "Step 1 streams SSE; steps 2-6 return JSON synchronously."
    ),
    version="1.0.0",
)

# Allow all origins — useful for local front-end dev and RunPod proxied ports
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sse_event(event_type: str, data: dict) -> str:
    """Format a named SSE event frame."""
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


def _sse_heartbeat() -> str:
    """SSE comment — invisible to EventSource, keeps CDN/proxy connections alive."""
    return ": heartbeat\n\n"


async def _json_body(request: Request) -> dict:
    """Parse request body as JSON; raise 400 on failure."""
    try:
        return await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}")


# ---------------------------------------------------------------------------
# GET /v1/health
# ---------------------------------------------------------------------------

@app.get("/v1/health")
async def health():
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

    try:
        result = await analyze_step3d(step_url, file_name)
        # Propagate any error flag from the pipeline function but still return 200
        # so callers can check "ok" rather than catching HTTP errors
        if "error" in result:
            logger.warning("/v1/step3d pipeline error: %s", result["error"])
            return JSONResponse(
                {
                    "ok":           False,
                    "error":        result["error"],
                    "features_3d":  result.get("features_3d",  []),
                    "shape_summary": result.get("shape_summary", {}),
                    "thinking":     result.get("thinking", ""),
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

    try:
        result = await recognize_features(extraction, step_analysis)
        if "error" in result:
            logger.warning("/v1/features pipeline error: %s", result["error"])
            return JSONResponse(
                {
                    "ok":           False,
                    "error":        result["error"],
                    "features":     result.get("features",      []),
                    "material":     result.get("material",      {}),
                    "feature_count": result.get("feature_count", 0),
                    "thinking":     result.get("thinking", ""),
                },
                status_code=200,
            )
        return JSONResponse({
            "ok":           True,
            "features":     result.get("features",      []),
            "material":     result.get("material",      {}),
            "feature_count": result.get("feature_count", 0),
            "thinking":     result.get("thinking", ""),
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

    try:
        result = await map_processes(features, material)
        if "error" in result:
            logger.warning("/v1/processes pipeline error: %s", result["error"])
            return JSONResponse(
                {
                    "ok":             False,
                    "error":          result["error"],
                    "operations":     result.get("operations",     []),
                    "operation_count": result.get("operation_count", 0),
                    "thinking":       result.get("thinking", ""),
                },
                status_code=200,
            )
        return JSONResponse({
            "ok":             True,
            "operations":     result.get("operations",     []),
            "operation_count": result.get("operation_count", 0),
            "thinking":       result.get("thinking", ""),
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
      material_spec : str  — e.g. "AL6061-T6"  (for logging / future rate tables)

    Response JSON:
      { "ok": true, "total_usd": float, "breakdown": [...] }
    """
    body          = await _json_body(request)
    cycle_time    = body.get("cycle_time")    or {}
    material_spec = body.get("material_spec") or "AL6061-T6"

    if not isinstance(cycle_time, dict):
        raise HTTPException(status_code=400, detail="cycle_time must be a JSON object")

    try:
        result = estimate_cost_formula(cycle_time, material_spec)
        return JSONResponse({
            "ok":        True,
            "total_usd": result.get("total_usd",  0),
            "breakdown": result.get("breakdown",  []),
            # Also include the full cost dict so callers can display details
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
    uvicorn.run("server_llm:app", host=host, port=port, reload=False)
