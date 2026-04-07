"""
Approach 2 pipeline — FreeCAD deterministic pipeline.
Async generator that yields (event_type, data) tuples as SSE events:
  status | tool_call | tool_result | thinking | final_answer | error | done

Steps:
  1. analyze_drawing    — VLM GD&T extraction from 2D drawing pages
  2. analyze_step_file  — FreeCAD 3D feature extraction from STEP
  3. recognize_features — merge 3D geometry with 2D GD&T
  4. map_cnc_processes  — CNC operation mapping (Python process mapper)
  5. estimate_cycle_time
  6. estimate_cost
"""
from __future__ import annotations

import asyncio
import base64
import glob
import json
import logging
import os
import subprocess
import tempfile
import time
from io import BytesIO
from typing import Any, AsyncGenerator, Optional

from pipeline.shared import _download
from vlm_stream import (
    SYSTEM_PROMPT,
    EXTRACTION_PROMPT,
    collect_ollama_vision_chat,
    classify_page_parsed,
    merge_vision_results,
    parse_model_json,
)
from materials import match_material
from cycle_time_tool import estimate_cycle_time
from cost_tool import estimate_cost

logger = logging.getLogger("cncapp.pipeline.approach2")

MAX_LONG_PX   = 2000  # cap longest side sent to VLM (same as pdf-to-image.ts)
MAX_RETRIES   = 1
MAX_VLM_PAGES = 4     # cap pages to stay within ~10 min edge timeout


# ---------------------------------------------------------------------------
# Sheet metal detection (FreeCAD Sheet Metal workbench)
# ---------------------------------------------------------------------------

def _detect_sheet_metal(step_path: str) -> dict:
    """
    Analyse a loaded STEP file for sheet metal characteristics using FreeCAD.

    Strategy (no Sheet Metal workbench required):
      - FreeCAD Part geometry is used directly to detect:
        * Uniform thin flat face spacing → material thickness
        * Cylindrical faces with small radius relative to thickness → bends
        * Rectangular flanges (planar faces adjacent to bends)
        * Narrow rectangular notches in flat planes → relief cuts

    Returns:
        {
            "is_sheet_metal": bool,
            "thickness_mm": float,          # 0.0 if not detected
            "bends": [
                {"radius_mm": float, "angle_deg": float, "count": int}
            ],
            "flanges": [
                {"width_mm": float, "length_mm": float}
            ],
            "relief_cuts": int,
        }

    Falls back to {"is_sheet_metal": False} on any error or if FreeCAD is
    unavailable.
    """
    _FALLBACK: dict = {"is_sheet_metal": False}

    try:
        import freecad_analyzer.step_analyzer as _fc_step
        if not _fc_step.FREECAD_AVAILABLE:
            from freecad_analyzer.step_analyzer import load_freecad
            load_freecad()
        if not _fc_step.FREECAD_AVAILABLE:
            logger.debug("_detect_sheet_metal: FreeCAD unavailable — skipping")
            return _FALLBACK

        Part = _fc_step.Part

        shape = Part.Shape()
        shape.read(step_path)

        # For assemblies, analyse the largest solid
        if shape.ShapeType == "Compound":
            solids = shape.Solids
            if solids:
                shape = sorted(solids, key=lambda s: s.Volume, reverse=True)[0]

        faces = shape.Faces
        if not faces:
            return _FALLBACK

        # ── Collect planar faces and their approximate Z-levels ──────────────
        import math

        plane_z_levels: list[float] = []
        plane_areas:    list[float] = []
        for face in faces:
            stype = type(face.Surface).__name__
            if stype != "Plane":
                continue
            try:
                bb = face.BoundBox
                z_center = bb.ZMin + bb.ZLength / 2.0
                plane_z_levels.append(z_center)
                plane_areas.append(face.Area)
            except Exception:
                continue

        # ── Estimate thickness from the gap between largest parallel planes ──
        thickness_mm = 0.0
        if len(plane_z_levels) >= 2:
            sorted_z = sorted(set(round(z, 3) for z in plane_z_levels))
            if len(sorted_z) >= 2:
                gaps = [abs(sorted_z[i + 1] - sorted_z[i]) for i in range(len(sorted_z) - 1)]
                # The smallest consistent gap between major planes is the thickness
                small_gaps = [g for g in gaps if g > 0.1]
                if small_gaps:
                    thickness_mm = round(min(small_gaps), 4)

        # Sheet metal heuristic: part must have planes and the min dimension of
        # its bounding box must be <= 6 mm (or <= 20 % of the largest dimension)
        bb_shape = shape.BoundBox
        min_dim   = min(bb_shape.XLength, bb_shape.YLength, bb_shape.ZLength)
        max_dim   = max(bb_shape.XLength, bb_shape.YLength, bb_shape.ZLength)

        is_sheet = (
            thickness_mm > 0.0
            # Detected thickness must be at least 5 % of the smallest bbox dimension.
            # Values far below this are measurement artifacts (e.g. pocket-floor gaps,
            # chamfer face spacings) and indicate a machined part, not sheet metal.
            and thickness_mm >= min_dim * 0.05
            and (min_dim <= 6.0 or (max_dim > 0 and min_dim / max_dim <= 0.20))
        )

        if not is_sheet:
            return _FALLBACK

        # ── Detect bends (cylindrical faces with bend-radius heuristic) ──────
        bends_raw: dict[tuple, int] = {}
        for face in faces:
            stype = type(face.Surface).__name__
            if stype != "Cylinder":
                continue
            try:
                surf   = face.Surface
                radius = round(surf.Radius, 4)
                # Bends have radius comparable to (or slightly larger than) thickness
                if radius > thickness_mm * 10:
                    continue

                # Estimate angular extent for bend angle
                prange = face.ParameterRange
                angle_rad = abs(prange[1] - prange[0])
                # Clamp to meaningful bend angles (5° – 180°)
                angle_deg = round(math.degrees(angle_rad), 1)
                if not (5.0 <= angle_deg <= 180.0):
                    continue

                key = (radius, angle_deg)
                bends_raw[key] = bends_raw.get(key, 0) + 1
            except Exception:
                continue

        bends = [
            {"radius_mm": k[0], "angle_deg": k[1], "count": v}
            for k, v in bends_raw.items()
        ]

        # ── Detect flanges (large planar faces not in the main body plane) ───
        flanges: list[dict] = []
        if plane_areas:
            max_area   = max(plane_areas)
            area_thresh = max_area * 0.05   # flanges are at least 5 % of largest face
            for face in faces:
                if type(face.Surface).__name__ != "Plane":
                    continue
                try:
                    if face.Area < area_thresh or face.Area >= max_area * 0.9:
                        continue
                    bb = face.BoundBox
                    w  = round(min(bb.XLength, bb.YLength, bb.ZLength +
                                   max(bb.XLength, bb.YLength)), 4)
                    l  = round(max(bb.XLength, bb.YLength), 4)
                    if w > 0 and l > 0:
                        flanges.append({"width_mm": w, "length_mm": l})
                except Exception:
                    continue

        # ── Count relief cuts (very small narrow planar faces) ───────────────
        relief_cuts = 0
        for face in faces:
            if type(face.Surface).__name__ != "Plane":
                continue
            try:
                bb = face.BoundBox
                dims = sorted([bb.XLength, bb.YLength, bb.ZLength])
                # Relief cut: very narrow (< 3 × thickness) and short
                if dims[0] < 1e-3 and dims[1] <= thickness_mm * 3 and dims[1] > 0:
                    relief_cuts += 1
            except Exception:
                continue

        # Only classify as sheet metal if bends are actually detected.
        # A flat machined plate may pass the thickness/ratio heuristic but
        # has no bends — it's a CNC-milled part, not sheet metal.
        if not bends:
            return _FALLBACK

        result = {
            "is_sheet_metal": True,
            "thickness_mm":   thickness_mm,
            "bends":          bends,
            "flanges":        flanges[:20],   # cap list size
            "relief_cuts":    relief_cuts,
        }
        logger.info(
            "_detect_sheet_metal: thickness=%.3f mm  bends=%d  flanges=%d  relief_cuts=%d",
            thickness_mm, len(bends), len(flanges), relief_cuts,
        )
        return result

    except Exception as exc:
        logger.warning("_detect_sheet_metal failed: %s", exc)
        return _FALLBACK


# ---------------------------------------------------------------------------
# PDF -> PNG pages
# ---------------------------------------------------------------------------

def _natural_sort_key(filename: str) -> int:
    digits = "".join(c for c in filename if c.isdigit())
    return int(digits) if digits else 0


def _cap_long_side(png_bytes: bytes, max_long: int) -> bytes:
    """Resize PNG so longest side <= max_long. Returns original if already within limits."""
    try:
        from PIL import Image
        img = Image.open(BytesIO(png_bytes))
        w, h = img.size
        longest = max(w, h)
        if longest <= max_long:
            return png_bytes
        scale = max_long / longest
        new_w = round(w * scale)
        new_h = round(h * scale)
        logger.info("resize %dx%d -> %dx%d (cap %d)", w, h, new_w, new_h, max_long)
        resized = img.resize((new_w, new_h), Image.LANCZOS)
        buf = BytesIO()
        resized.save(buf, format="PNG", optimize=True)
        return buf.getvalue()
    except Exception as e:
        logger.warning("Cap long side failed: %s — returning original", e)
        return png_bytes


def _pdf_to_pages_poppler(pdf_bytes: bytes, max_pages: int = 32) -> list[str]:
    """Convert PDF to base64 PNG pages via pdftoppm."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path   = os.path.join(tmpdir, "input.pdf")
        out_prefix = os.path.join(tmpdir, "page")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)

        subprocess.run(
            ["pdftoppm", "-png", "-r", "150", "-f", "1", "-l", str(max_pages), pdf_path, out_prefix],
            check=True, timeout=120, capture_output=True,
        )

        png_files = sorted(
            glob.glob(os.path.join(tmpdir, "page*.png")),
            key=lambda p: _natural_sort_key(os.path.basename(p)),
        )
        if not png_files:
            raise RuntimeError("pdftoppm produced no PNG output")

        pages = []
        for png_path in png_files:
            with open(png_path, "rb") as f:
                raw = f.read()
            resized = _cap_long_side(raw, MAX_LONG_PX)
            pages.append(base64.b64encode(resized).decode())
        return pages


def _pdf_to_pages_pypdfium(pdf_bytes: bytes, max_pages: int = 32) -> list[str]:
    """Convert PDF to base64 PNG pages via pypdfium2."""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf_bytes)
    pages = []
    TARGET_DPI = 150
    for i in range(min(len(doc), max_pages)):
        page  = doc[i]
        w_pt, h_pt = page.get_size()
        longest_pt  = max(w_pt, h_pt)
        scale_dpi   = TARGET_DPI / 72.0
        scale_cap   = MAX_LONG_PX / (longest_pt * scale_dpi)
        scale       = min(scale_dpi, scale_dpi * scale_cap)
        bitmap = page.render(scale=scale)
        pil_img = bitmap.to_pil()
        buf = BytesIO()
        pil_img.save(buf, format="PNG")
        resized = _cap_long_side(buf.getvalue(), MAX_LONG_PX)
        pages.append(base64.b64encode(resized).decode())
    return pages


def pdf_to_base64_pages(pdf_bytes: bytes, max_pages: int = 32) -> list[str]:
    """Convert PDF bytes to a list of base64 PNG strings, one per page."""
    try:
        return _pdf_to_pages_poppler(pdf_bytes, max_pages)
    except Exception as e:
        logger.warning("pdftoppm failed (%s), trying pypdfium2", e)
    return _pdf_to_pages_pypdfium(pdf_bytes, max_pages)


def file_to_base64_pages(file_bytes: bytes, filename: str = "", max_pages: int = 32) -> list[str]:
    """Convert a drawing file (PDF or image) to base64 pages."""
    if file_bytes[:4] == b"%PDF":
        return pdf_to_base64_pages(file_bytes, max_pages)
    return [base64.b64encode(file_bytes).decode()]


# ---------------------------------------------------------------------------
# VLM page analysis (single page)
# ---------------------------------------------------------------------------

async def _analyze_one_page(
    page_b64: str,
    on_thinking: Optional[Any] = None,
) -> tuple[dict, str]:
    """Run VLM on one page, return (parsed_dict, outcome)."""
    parsed: dict = {"dimensions": [], "gdt": [], "threads": [], "material": None, "notes": [], "raw_model_output": ""}
    outcome = "unparseable"

    for attempt in range(MAX_RETRIES + 1):
        try:
            result = await collect_ollama_vision_chat(
                page_b64,
                SYSTEM_PROMPT,
                EXTRACTION_PROMPT,
                on_thinking=on_thinking,
            )
            content = result.get("content") or ""
            if not content.strip():
                parsed = {"dimensions": [], "gdt": [], "threads": [], "material": None, "notes": [], "raw_model_output": "(empty)"}
                outcome = "unparseable"
            else:
                parsed  = parse_model_json(content)
                outcome = classify_page_parsed(parsed)
        except Exception as e:
            logger.warning("VLM page attempt %d error: %s", attempt, e)
            parsed = {"dimensions": [], "gdt": [], "threads": [], "material": None, "notes": [], "raw_model_output": str(e)}
            outcome = "unparseable"

        if outcome != "unparseable":
            break
        if attempt < MAX_RETRIES:
            logger.info("Retrying page (attempt %d)", attempt + 1)

    return parsed, outcome


# ---------------------------------------------------------------------------
# Feature merge helpers (port of recognize-features.ts)
# ---------------------------------------------------------------------------

_TYPE_MAP: dict[str, str] = {
    "hole": "through_hole", "fillet": "fillet", "chamfer": "chamfer",
    "step": "step", "slot": "slot", "pocket": "pocket", "thread": "thread",
    "bore": "bore", "face": "face", "radius": "fillet", "groove": "groove",
    "counterbore": "counterbore", "countersink": "countersink",
    "cylindrical": "bore", "planar": "face",
}

_MM_TO_IN = 1 / 25.4


def _tolerance_class(tol: Any) -> str:
    if not tol:
        return "general"
    band = abs(float(tol.get("plus") or 0)) + abs(float(tol.get("minus") or 0))
    if band <= 0.001:
        return "precision"
    if band <= 0.005:
        return "close"
    if band <= 0.010:
        return "medium"
    return "general"


def _convert_dims_to_inches(dims: dict) -> dict:
    out: dict = {"unit": "inch"}
    for k, v in dims.items():
        if k == "unit":
            continue
        out[k] = round(float(v) * _MM_TO_IN * 1e4) / 1e4 if isinstance(v, (int, float)) else v
    return out


def _tag_3d_with_2d(features_3d: list, features_2d: list, gdt_callouts: list) -> list:
    """Tag 3D features with tolerance/GD&T data from the 2D drawing."""
    by_type: dict[str, list] = {}
    for f in features_2d:
        t = _TYPE_MAP.get((f.get("type") or "").lower(), (f.get("type") or "other").lower())
        by_type.setdefault(t, []).append(f)
    cursor: dict[str, int] = {}

    enriched = []
    for feat3d in features_3d:
        raw_type = (feat3d.get("type") or "other").lower()
        mfg_type = _TYPE_MAP.get(raw_type, raw_type)
        cursor.setdefault(mfg_type, 0)
        match_2d = (by_type.get(mfg_type) or [])[cursor[mfg_type]] if cursor[mfg_type] < len(by_type.get(mfg_type) or []) else None
        if match_2d:
            cursor[mfg_type] += 1

        related_gdt = [
            g for g in gdt_callouts
            if g.get("feature_id") == feat3d.get("id") or (match_2d and g.get("feature_id") == match_2d.get("id"))
        ]

        dims_raw = feat3d.get("dimensions") or {}
        dims = dims_raw if isinstance(dims_raw, dict) else {}

        enriched.append({
            "id":              feat3d.get("id", "?"),
            "raw_type":        raw_type,
            "mfg_type":        mfg_type,
            "description":     feat3d.get("description") or feat3d.get("name") or raw_type,
            "quantity":        max(int((match_2d or {}).get("quantity") or 1), 1),
            "geometry":        _convert_dims_to_inches(dims),
            "tolerance":       (match_2d or {}).get("tolerance"),
            "tolerance_class": _tolerance_class((match_2d or {}).get("tolerance")),
            "gdt_callouts":    related_gdt,
            "source":          "3d",
        })
    return enriched


def recognize_features_merge(extraction: dict, step_analysis: Optional[dict], mat_key: str) -> dict:
    """Merge 3D geometry with 2D GD&T — port of TypeScript recognizeFeatures."""
    material_spec = (extraction.get("material") or {}) if isinstance(extraction.get("material"), dict) else (extraction.get("material") or "")
    if isinstance(material_spec, dict):
        material_spec = material_spec.get("specification") or ""
    material = match_material(material_spec or mat_key)

    features_3d  = (step_analysis or {}).get("features_3d") or []
    features_2d  = extraction.get("features") or []
    gdt_callouts = extraction.get("gdt") or []

    if features_3d:
        enriched = _tag_3d_with_2d(features_3d, features_2d, gdt_callouts)
        logger.info("Merged %d 3D features with %d 2D annotations", len(enriched), len(features_2d))
        shape_sum = (step_analysis or {}).get("shape_summary") or {}
        sm = (step_analysis or {}).get("sheet_metal") or {}
        if sm.get("is_sheet_metal"):
            shape_sum = {
                **shape_sum,
                "sheet_metal_thickness_mm": sm.get("thickness_mm", 0.0),
                "sheet_metal_bends":        sm.get("bends", []),
                "sheet_metal_flanges":      sm.get("flanges", []),
                "sheet_metal_relief_cuts":  sm.get("relief_cuts", 0),
            }
        return {
            "material":      material,
            "material_spec": material_spec,
            "features":      enriched,
            "feature_count": len(enriched),
            "source":        "3d+2d",
            "shape_summary": shape_sum or None,
        }

    # 2D-only fallback
    logger.warning("No 3D features — falling back to 2D classification")
    recognized = []
    for feat in features_2d:
        raw_type = (feat.get("type") or "unknown").lower()
        recognized.append({
            "id":              feat.get("id", "?"),
            "raw_type":        raw_type,
            "mfg_type":        _TYPE_MAP.get(raw_type, raw_type),
            "description":     feat.get("description") or raw_type,
            "quantity":        max(int(feat.get("quantity") or 1), 1),
            "geometry":        feat.get("dimensions") or {},
            "tolerance":       feat.get("tolerance"),
            "tolerance_class": _tolerance_class(feat.get("tolerance")),
            "gdt_callouts":    [g for g in gdt_callouts if g.get("feature_id") == feat.get("id")],
            "source":          "2d",
        })
    return {
        "material":      material,
        "material_spec": material_spec,
        "features":      recognized,
        "feature_count": len(recognized),
        "source":        "2d",
        "shape_summary": None,
    }


# ---------------------------------------------------------------------------
# Build final results (port of buildPipelineResults)
# ---------------------------------------------------------------------------

def build_results(
    extraction:    Optional[dict],
    step_analysis: Optional[dict],
    recognition:   Optional[dict],
    processes:     Optional[dict],
    cycle_time:    Optional[dict],
    cost:          Optional[dict],
) -> dict:
    return {
        "extraction":    extraction   or None,
        "step_analysis": step_analysis or None,
        "recognition":   recognition  or None,
        "processes":     processes    or None,
        "cycle_time":    cycle_time   or None,
        "cost":          cost         or None,
        "features":      (recognition or {}).get("features") or (extraction or {}).get("features") or [],
        "gdt_callouts":  (extraction  or {}).get("gdt") or [],
        "material":      (recognition or {}).get("material") or None,
        "shape_summary": (step_analysis or {}).get("shape_summary") or (recognition or {}).get("shape_summary") or None,
        "sheet_metal":   (step_analysis or {}).get("sheet_metal") or {"is_sheet_metal": False},
        "total_minutes": (cycle_time or {}).get("total_minutes") or 0,
        "total_usd":     (cost       or {}).get("total_usd")     or 0,
    }


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

async def run_pipeline(
    analysis_id: str,
    drawing_url: str,
    step_url:    str,
    file_name:   str,
) -> AsyncGenerator[tuple[str, dict], None]:
    """
    Main pipeline generator. Yields (event_type, data) tuples.
    Caller wraps each into an SSE frame.
    """
    t_pipeline = time.time()

    def elapsed() -> float:
        return round(time.time() - t_pipeline, 2)

    loop = asyncio.get_running_loop()

    # ── Download both files in parallel ──────────────────────────────────────
    try:
        logger.info("Downloading files for analysis_id=%s", analysis_id)
        drawing_bytes, step_bytes = await asyncio.gather(
            _download(drawing_url),
            _download(step_url),
        )
    except Exception as e:
        yield "error", {"message": f"File download failed: {e}"}
        yield "done",  {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    # ── Convert 2D drawing to pages ───────────────────────────────────────────
    try:
        pages = await loop.run_in_executor(
            None, file_to_base64_pages, drawing_bytes, file_name
        )
        logger.info("2D drawing -> %d page(s)", len(pages))
    except Exception as e:
        yield "error", {"message": f"Drawing conversion failed: {e}"}
        yield "done",  {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    if not pages:
        yield "error", {"message": "Drawing produced no pages. Please re-upload a valid PDF, PNG, JPG, or TIFF."}
        yield "done",  {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    # ── Step 1: analyze_drawing ───────────────────────────────────────────────
    extraction:     Optional[dict] = None
    step_analysis:  Optional[dict] = None
    recognition:    Optional[dict] = None
    processes:      Optional[dict] = None
    cycle_time_res: Optional[dict] = None
    cost_res:       Optional[dict] = None

    yield "status",    {"step": 1, "title": "GD&T Extraction", "message": "Extracting dimensions and GD&T from 2D drawing..."}
    yield "tool_call", {"tool": "analyze_drawing", "args": {"pages": len(pages)}, "iteration": 1}
    t1 = time.time()

    try:
        all_parsed:   list = []
        all_outcomes: list = []

        pages_to_process = pages[:MAX_VLM_PAGES]
        if len(pages) > MAX_VLM_PAGES:
            logger.info("PDF has %d pages — processing first %d only (MAX_VLM_PAGES)", len(pages), MAX_VLM_PAGES)

        for i, page_b64 in enumerate(pages_to_process):
            logger.info("Page %d/%d -> VLM (b64_len=%d)", i + 1, len(pages_to_process), len(page_b64))
            thinking_queue: asyncio.Queue = asyncio.Queue()

            async def _on_thinking(chunk: str, _q: asyncio.Queue = thinking_queue) -> None:
                await _q.put(chunk)

            async def _run_page(_p: str = page_b64, _q: asyncio.Queue = thinking_queue) -> tuple[dict, str]:
                result = await _analyze_one_page(_p, on_thinking=_on_thinking)
                await _q.put(None)
                return result

            page_task = asyncio.create_task(_run_page())

            while True:
                try:
                    chunk = await asyncio.wait_for(thinking_queue.get(), timeout=15.0)
                    if chunk is None:
                        break
                    yield "thinking", {"content": chunk}
                except asyncio.TimeoutError:
                    yield "heartbeat", {}

            logger.info("Page %d/%d done", i + 1, len(pages_to_process))
            parsed, outcome = await page_task
            all_parsed.append(parsed)
            all_outcomes.append(outcome)

        ok_parsed = [p for p, o in zip(all_parsed, all_outcomes) if o == "ok"]
        merged = merge_vision_results(ok_parsed if ok_parsed else all_parsed)

        dims    = merged.get("dimensions") or []
        threads = merged.get("threads")    or []
        any_ok  = any(o == "ok" for o in all_outcomes)
        all_bad = all(o in ("hard_reject", "unparseable") for o in all_outcomes)

        step1_result: dict
        if dims or threads:
            step1_result = {
                **merged,
                "feature_count":  len(dims),
                "gdt_count":      len(merged.get("gdt") or []),
                "pages_analyzed": len(pages_to_process),
            }
            extraction = step1_result
        else:
            err_msg = (
                "This file does not appear to contain engineering drawings."
                if all(o == "hard_reject" for o in all_outcomes)
                else "No manufacturing features detected despite finding drawing pages. Ensure dimensions are visible."
                if any_ok
                else f"No drawing content found — all {len(pages_to_process)} page(s) appear to be cover sheets or non-technical."
            )
            step1_result = {**merged, "error": err_msg, "feature_count": 0, "gdt_count": 0, "pages_analyzed": len(pages_to_process)}
            extraction = step1_result

    except Exception as e:
        step1_result = {"error": str(e), "dimensions": [], "gdt": [], "threads": [], "feature_count": 0}
        extraction = step1_result

    yield "tool_result", {"tool": "analyze_drawing", "result": {
        "feature_count":  (extraction or {}).get("feature_count", 0),
        "gdt_count":      (extraction or {}).get("gdt_count", 0),
        "pages_analyzed": (extraction or {}).get("pages_analyzed", len(pages)),
        "material":       (extraction or {}).get("material"),
    }, "duration_ms": round((time.time() - t1) * 1000)}

    if not extraction or extraction.get("error"):
        msg = (extraction or {}).get("error") or "2D drawing extraction failed."
        yield "error",        {"message": msg}
        yield "final_answer", {"summary": msg, "results": build_results(extraction, None, None, None, None, None)}
        yield "done",         {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    if (extraction.get("feature_count") or 0) == 0:
        msg = "No features detected in the 2D drawing. Ensure it is a clear technical drawing with visible dimensions."
        yield "error",        {"message": msg}
        yield "final_answer", {"summary": msg, "results": build_results(extraction, None, None, None, None, None)}
        yield "done",         {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    # ── Step 2: analyze_step_file ─────────────────────────────────────────────
    yield "status",    {"step": 2, "title": "3D Analysis", "message": "Extracting geometric features from STEP file..."}
    yield "tool_call", {"tool": "analyze_step_file", "args": {}, "iteration": 2}
    t2 = time.time()

    raw_features_3d:   list = []
    shape_summary:     Optional[dict] = None
    sheet_metal_result: dict = {"is_sheet_metal": False}

    try:
        from freecad_analyzer import STEPAnalyzer, recognize_features as fc_recognize, load_freecad
        import freecad_analyzer.step_analyzer as freecad_step
        if not freecad_step.FREECAD_AVAILABLE:
            load_freecad()

        if not freecad_step.FREECAD_AVAILABLE:
            raise RuntimeError("FreeCAD not available")

        with tempfile.TemporaryDirectory() as tmpdir:
            step_path = os.path.join(tmpdir, file_name if file_name.lower().endswith((".stp", ".step")) else "part.stp")
            with open(step_path, "wb") as f:
                f.write(step_bytes)

            analyzer = STEPAnalyzer(step_path)
            analysis_result = await loop.run_in_executor(None, analyzer.analyze)
            ss = analysis_result.get("shape_summary") or {}
            shape_summary = ss if ss else None

            features_raw_list, feat_source = await loop.run_in_executor(
                None, fc_recognize, step_path
            )
            raw_features_3d = [
                {
                    "id":          f.get("id", "?"),
                    "name":        f.get("name", ""),
                    "type":        f.get("type", "other"),
                    "description": f.get("description", ""),
                    "dimensions":  {k: v for k, v in (f.get("dimensions") or {}).items() if not k.startswith("_")},
                    "source":      f.get("source", feat_source),
                }
                for f in (features_raw_list if isinstance(features_raw_list, list) else [])
            ]

            # ── Sheet metal detection ────────────────────────────────────────
            sheet_metal_result = await loop.run_in_executor(
                None, _detect_sheet_metal, step_path
            )
            logger.info("Sheet metal detection: %s", sheet_metal_result)

        step_analysis = {
            "features_3d":      raw_features_3d,
            "shape_summary":    shape_summary,
            "sheet_metal":      sheet_metal_result,
            "feature_count_3d": len(raw_features_3d),
            "volume_mm3":       (shape_summary or {}).get("volume_mm3"),
            "bbox_x_mm":        (shape_summary or {}).get("bbox_x_mm"),
            "bbox_y_mm":        (shape_summary or {}).get("bbox_y_mm"),
            "bbox_z_mm":        (shape_summary or {}).get("bbox_z_mm"),
        }
        yield "tool_result", {"tool": "analyze_step_file", "result": {
            "feature_count_3d":   len(raw_features_3d),
            "volume_mm3":         (shape_summary or {}).get("volume_mm3"),
            "bbox_x_mm":          (shape_summary or {}).get("bbox_x_mm"),
            "bbox_y_mm":          (shape_summary or {}).get("bbox_y_mm"),
            "bbox_z_mm":          (shape_summary or {}).get("bbox_z_mm"),
            "is_sheet_metal":     sheet_metal_result.get("is_sheet_metal", False),
            "sheet_metal_thickness_mm": sheet_metal_result.get("thickness_mm", 0.0),
        }, "duration_ms": round((time.time() - t2) * 1000)}

    except Exception as e:
        logger.warning("STEP analysis unavailable: %s", e)
        step_analysis = None
        sheet_metal_result = {"is_sheet_metal": False}
        yield "tool_result", {"tool": "analyze_step_file", "result": {"error": str(e)}, "duration_ms": round((time.time() - t2) * 1000)}
        yield "status", {"step": 2, "title": "3D Analysis", "message": "STEP analysis unavailable — continuing with 2D features only."}

    # ── Step 3: recognize_features ────────────────────────────────────────────
    yield "status",    {"step": 3, "title": "Feature Recognition", "message": "Merging 3D geometry with 2D GD&T..."}
    yield "tool_call", {"tool": "recognize_features", "args": {}, "iteration": 3}
    t3 = time.time()

    mat_key = "6061-T6"
    try:
        recognition = recognize_features_merge(extraction or {}, step_analysis, mat_key)
        yield "tool_result", {"tool": "recognize_features", "result": {
            "feature_count": recognition.get("feature_count", 0),
            "source":        recognition.get("source", "2d"),
            "material":      recognition.get("material"),
        }, "duration_ms": round((time.time() - t3) * 1000)}
    except Exception as e:
        logger.exception("recognize_features failed")
        msg = f"Feature recognition failed: {e}"
        yield "tool_result", {"tool": "recognize_features", "result": {"error": msg}, "duration_ms": round((time.time() - t3) * 1000)}
        yield "error",        {"message": msg}
        yield "final_answer", {"summary": msg, "results": build_results(extraction, step_analysis, None, None, None, None)}
        yield "done",         {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    # ── Step 4: map_cnc_processes ─────────────────────────────────────────────
    yield "status",    {"step": 4, "title": "Process Mapping", "message": "Mapping CNC operations and tooling..."}
    yield "tool_call", {"tool": "map_cnc_processes", "args": {}, "iteration": 4}
    t4 = time.time()

    try:
        from freecad_analyzer import map_processes as fc_map_processes, resolve_material
        mat_raw = (extraction or {}).get("material") or ""
        if isinstance(mat_raw, dict):
            mat_raw = mat_raw.get("specification") or ""
        resolved_mat = resolve_material(mat_raw, default="Al6061")

        if raw_features_3d:
            proc_map_list = await loop.run_in_executor(
                None, lambda: fc_map_processes(raw_features_3d, extraction or {}, resolved_mat)
            )
        else:
            proc_map_list = []

        processes = {"operations": proc_map_list, "operation_count": len(proc_map_list)}
        yield "tool_result", {"tool": "map_cnc_processes", "result": {
            "operation_count": len(proc_map_list),
        }, "duration_ms": round((time.time() - t4) * 1000)}
    except Exception as e:
        logger.warning("map_cnc_processes failed: %s", e)
        processes = None
        yield "tool_result", {"tool": "map_cnc_processes", "result": {"error": str(e)}, "duration_ms": round((time.time() - t4) * 1000)}

    # ── Step 5: estimate_cycle_time ───────────────────────────────────────────
    yield "status",    {"step": 5, "title": "Cycle Time", "message": "Estimating machining cycle time..."}
    yield "tool_call", {"tool": "estimate_cycle_time", "args": {}, "iteration": 5}
    t5 = time.time()

    try:
        if processes and (processes.get("operations") or []):
            ct_args = {"method": "from_processes", "process_map_json": json.dumps(processes)}
        else:
            ct_args = {"method": "from_features", "extraction_json": json.dumps(extraction or {})}

        cycle_time_res = estimate_cycle_time(ct_args)
        yield "tool_result", {"tool": "estimate_cycle_time", "result": {
            "total_minutes": cycle_time_res.get("total_minutes", 0),
            "method":        cycle_time_res.get("method"),
        }, "duration_ms": round((time.time() - t5) * 1000)}
    except Exception as e:
        logger.exception("estimate_cycle_time failed")
        msg = f"Cycle time estimation failed: {e}"
        yield "tool_result", {"tool": "estimate_cycle_time", "result": {"error": msg}, "duration_ms": round((time.time() - t5) * 1000)}
        yield "error",        {"message": msg}
        yield "final_answer", {"summary": msg, "results": build_results(extraction, step_analysis, recognition, processes, None, None)}
        yield "done",         {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    # ── Step 6: estimate_cost ─────────────────────────────────────────────────
    yield "status",    {"step": 6, "title": "Cost Estimation", "message": "Calculating fabrication cost..."}
    yield "tool_call", {"tool": "estimate_cost", "args": {}, "iteration": 6}
    t6 = time.time()

    try:
        cost_res = estimate_cost({"cycle_time_json": json.dumps(cycle_time_res)})
        yield "tool_result", {"tool": "estimate_cost", "result": {
            "total_usd":          cost_res.get("total_usd", 0),
            "currency":           cost_res.get("currency", "USD"),
            "shop_rate_per_hour": cost_res.get("shop_rate_per_hour", 60),
        }, "duration_ms": round((time.time() - t6) * 1000)}
    except Exception as e:
        logger.exception("estimate_cost failed")
        cost_res = None
        yield "tool_result", {"tool": "estimate_cost", "result": {"error": str(e)}, "duration_ms": round((time.time() - t6) * 1000)}

    # ── Done ──────────────────────────────────────────────────────────────────
    results    = build_results(extraction, step_analysis, recognition, processes, cycle_time_res, cost_res)
    total_min  = results.get("total_minutes") or 0
    total_usd  = results.get("total_usd") or 0
    mat_name   = ((recognition or {}).get("material") or {}).get("name") or "Unknown material"
    feat_count = (recognition or {}).get("feature_count") or (extraction or {}).get("feature_count") or 0
    source     = (recognition or {}).get("source") or "2d"

    summary = (
        f'Analysis complete for "{file_name}". '
        f'{"3D+2D pipeline" if source == "3d+2d" else "2D pipeline"}. '
        f"Material: {mat_name}. "
        f'{feat_count} feature{"s" if feat_count != 1 else ""} detected. '
        f"Cycle time: {total_min:.1f} min. "
        f"Cost: USD {total_usd:.2f}."
    )

    yield "final_answer", {"summary": summary, "results": results}
    yield "done",         {"total_minutes": total_min, "total_usd": total_usd, "elapsed_seconds": elapsed()}
