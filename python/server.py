"""
CNCapp Python microservice — FastAPI server.

Single responsibility: FreeCAD headless STEP geometry analysis.
All other pipeline steps (VL extraction, feature tagging, process mapping,
cost estimation) run in the Next.js layer.

Endpoints:
  POST /analyze/step  STEP feature recognition via FreeCAD (geometry only)
  POST /convert-pdf   PDF → PNG base64 pages via pdftoppm (for Vercel fallback)
  GET  /health        Health check (includes FreeCAD availability)

Run:
  py -3.11 -m uvicorn server:app --host 0.0.0.0 --port 8001 --reload

Or with Docker:
  docker build -t cncapp-python . && docker run -p 8001:8001 cncapp-python
"""
from __future__ import annotations

import base64
import glob
import logging
import os
import subprocess
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from freecad_analyzer import STEPAnalyzer, load_freecad
import freecad_analyzer.step_analyzer as freecad_step
from freecad_analyzer.models import (
    AnalysisResponse,
    FeatureRecognitionResult,
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
    title="CNCapp STEP Analysis API",
    description="FreeCAD headless STEP geometry analysis — feature recognition only.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
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
# PDF → PNG conversion (used by Vercel which has no pdftoppm)
# ---------------------------------------------------------------------------

@app.post("/convert-pdf")
async def convert_pdf(
    file: UploadFile = File(..., description="PDF file to convert to PNG images"),
):
    """
    Convert a PDF to a list of base64-encoded PNG images using pdftoppm.
    Returns: {"pages": ["<base64png>", ...], "count": N}
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = os.path.join(tmpdir, "input.pdf")
        out_prefix = os.path.join(tmpdir, "page")

        with open(pdf_path, "wb") as f:
            f.write(await file.read())

        try:
            subprocess.run(
                ["pdftoppm", "-png", "-r", "150", "-f", "1", "-l", "32", pdf_path, out_prefix],
                check=True,
                timeout=120,
                capture_output=True,
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
# STEP geometry analysis (the only analysis endpoint)
# ---------------------------------------------------------------------------

@app.post("/analyze/step", response_model=AnalysisResponse)
async def analyze_step(
    file_3d: UploadFile = File(..., description="STEP/STP file"),
):
    """
    Analyze a STEP file with FreeCAD headless.
    Returns shape summary and detected manufacturing features (geometry only).
    VL extraction, feature tagging, process mapping and cost run in Next.js.
    """
    if not _freecad_available():
        raise HTTPException(status_code=503, detail="FreeCAD not available. Set FREECAD_PATH and restart.")

    with tempfile.TemporaryDirectory() as tmpdir:
        step_path = os.path.join(tmpdir, file_3d.filename or "part.stp")
        with open(step_path, "wb") as f:
            f.write(await file_3d.read())

        try:
            logger.info("Analyzing STEP: %s  (%s)", step_path, file_3d.filename)
            result = STEPAnalyzer(step_path).analyze()

            # ---------------------------------------------------------------
            # Log extracted feature list so you can trace what was detected
            # ---------------------------------------------------------------
            ss = result.get("shape_summary", {})
            logger.info(
                "Shape: %s  faces=%d  bbox=%.2f×%.2f×%.2f mm  vol=%.1f mm³",
                ss.get("shape_type"),
                ss.get("n_faces"),
                ss.get("bbox_x_mm", 0),
                ss.get("bbox_y_mm", 0),
                ss.get("bbox_z_mm", 0),
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
            for f in feats:
                dims = {k: v for k, v in f.get("dimensions", {}).items() if not k.startswith("_")}
                logger.info(
                    "  %-6s %-40s  %s",
                    f.get("id", "?"),
                    f.get("name", ""),
                    "  ".join(f"{k}={v}" for k, v in dims.items()),
                )
            # ---------------------------------------------------------------

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
                for f in result["features"]
            ]

            return AnalysisResponse(
                success=True,
                shape_summary=ShapeSummary(**result["shape_summary"]),
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
