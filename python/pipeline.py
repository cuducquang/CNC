"""
CNC analysis pipeline — port of src/lib/agent/fallback-pipeline.ts.

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

import httpx

from vlm_stream import (
    SYSTEM_PROMPT,
    EXTRACTION_PROMPT,
    collect_ollama_vision_chat,
    classify_page_parsed,
    merge_vision_results,
    parse_model_json,
    extract_json_from_thinking,
)
from materials import match_material
from cycle_time_tool import estimate_cycle_time
from cost_tool import estimate_cost

logger = logging.getLogger("cncapp.pipeline")

MAX_LONG_PX = 2000  # cap longest side sent to VLM (same as pdf-to-image.ts)
MAX_RETRIES = 1


# ---------------------------------------------------------------------------
# PDF → PNG pages
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
        logger.info("resize %dx%d → %dx%d (cap %d)", w, h, new_w, new_h, max_long)
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
# Download file from URL
# ---------------------------------------------------------------------------

async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


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
        if isinstance(dims_raw, dict):
            dims = dims_raw
        else:
            dims = {}

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
        return {
            "material":      material,
            "material_spec": material_spec,
            "features":      enriched,
            "feature_count": len(enriched),
            "source":        "3d+2d",
            "shape_summary": (step_analysis or {}).get("shape_summary"),
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
    extraction:   Optional[dict],
    step_analysis: Optional[dict],
    recognition:  Optional[dict],
    processes:    Optional[dict],
    cycle_time:   Optional[dict],
    cost:         Optional[dict],
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
        logger.info("2D drawing → %d page(s)", len(pages))
    except Exception as e:
        yield "error", {"message": f"Drawing conversion failed: {e}"}
        yield "done",  {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    if not pages:
        yield "error", {"message": "Drawing produced no pages. Please re-upload a valid PDF, PNG, JPG, or TIFF."}
        yield "done",  {"total_minutes": 0, "total_usd": 0, "elapsed_seconds": elapsed()}
        return

    # ── Step 1: analyze_drawing ───────────────────────────────────────────────
    extraction:  Optional[dict] = None
    step_analysis: Optional[dict] = None
    recognition: Optional[dict] = None
    processes:   Optional[dict] = None
    cycle_time_res: Optional[dict] = None
    cost_res:    Optional[dict] = None

    yield "status",    {"step": 1, "title": "GD&T Extraction", "message": "Extracting dimensions and GD&T from 2D drawing..."}
    yield "tool_call", {"tool": "analyze_drawing", "args": {"pages": len(pages)}, "iteration": 1}
    t1 = time.time()

    try:
        if len(pages) == 1:
            # Stream thinking for the single page
            thinking_queue: asyncio.Queue = asyncio.Queue()

            async def _on_thinking(chunk: str):
                await thinking_queue.put(chunk)

            async def _page1_with_signal():
                result = await _analyze_one_page(pages[0], on_thinking=_on_thinking)
                await thinking_queue.put(None)  # done signal
                return result

            page1_task = asyncio.create_task(_page1_with_signal())

            while True:
                chunk = await thinking_queue.get()
                if chunk is None:
                    break
                yield "thinking", {"content": chunk}

            page1_parsed, page1_outcome = await page1_task
            all_parsed   = [page1_parsed]
            all_outcomes = [page1_outcome]

        else:
            # Multiple pages: stream thinking for page 1, run others silently in parallel
            thinking_queue = asyncio.Queue()

            async def _on_thinking(chunk: str):
                await thinking_queue.put(chunk)

            async def _page1_signal():
                result = await _analyze_one_page(pages[0], on_thinking=_on_thinking)
                await thinking_queue.put(None)
                return result

            page1_task  = asyncio.create_task(_page1_signal())
            other_tasks = [asyncio.create_task(_analyze_one_page(p)) for p in pages[1:]]

            # Drain thinking from page 1
            while True:
                chunk = await thinking_queue.get()
                if chunk is None:
                    break
                yield "thinking", {"content": chunk}

            page1_result = await page1_task
            other_results = await asyncio.gather(*other_tasks, return_exceptions=True)

            all_parsed   = [page1_result[0]]
            all_outcomes = [page1_result[1]]
            for r in other_results:
                if isinstance(r, Exception):
                    all_parsed.append({"raw_model_output": str(r), "dimensions": [], "gdt": [], "threads": []})
                    all_outcomes.append("unparseable")
                else:
                    all_parsed.append(r[0])
                    all_outcomes.append(r[1])

        # Merge results
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
                "feature_count":    len(dims),
                "gdt_count":        len(merged.get("gdt") or []),
                "pages_analyzed":   len(pages),
            }
            extraction = step1_result
        else:
            err_msg = (
                "This file does not appear to contain engineering drawings."
                if all(o == "hard_reject" for o in all_outcomes)
                else "No manufacturing features detected despite finding drawing pages. Ensure dimensions are visible."
                if any_ok
                else f"No drawing content found — all {len(pages)} page(s) appear to be cover sheets or non-technical."
            )
            step1_result = {**merged, "error": err_msg, "feature_count": 0, "gdt_count": 0, "pages_analyzed": len(pages)}
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

    raw_features_3d: list = []
    shape_summary:   Optional[dict] = None
    feat_source = "freecad"

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

        step_analysis = {
            "features_3d":    raw_features_3d,
            "shape_summary":  shape_summary,
            "feature_count_3d": len(raw_features_3d),
            "volume_mm3":     (shape_summary or {}).get("volume_mm3"),
            "bbox_x_mm":      (shape_summary or {}).get("bbox_x_mm"),
            "bbox_y_mm":      (shape_summary or {}).get("bbox_y_mm"),
            "bbox_z_mm":      (shape_summary or {}).get("bbox_z_mm"),
        }
        yield "tool_result", {"tool": "analyze_step_file", "result": {
            "feature_count_3d": len(raw_features_3d),
            "volume_mm3":  (shape_summary or {}).get("volume_mm3"),
            "bbox_x_mm":   (shape_summary or {}).get("bbox_x_mm"),
            "bbox_y_mm":   (shape_summary or {}).get("bbox_y_mm"),
            "bbox_z_mm":   (shape_summary or {}).get("bbox_z_mm"),
        }, "duration_ms": round((time.time() - t2) * 1000)}

    except Exception as e:
        logger.warning("STEP analysis unavailable: %s", e)
        step_analysis = None
        yield "tool_result", {"tool": "analyze_step_file", "result": {"error": str(e)}, "duration_ms": round((time.time() - t2) * 1000)}
        yield "status", {"step": 2, "title": "3D Analysis", "message": "STEP analysis unavailable — continuing with 2D features only."}

    # ── Step 3: recognize_features ────────────────────────────────────────────
    yield "status",    {"step": 3, "title": "Feature Recognition", "message": "Merging 3D geometry with 2D GD&T..."}
    yield "tool_call", {"tool": "recognize_features", "args": {}, "iteration": 3}
    t3 = time.time()

    mat_key = "6061-T6"
    try:
        mat_spec = (extraction or {}).get("material") or ""
        if isinstance(mat_spec, dict):
            mat_spec = mat_spec.get("specification") or ""
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
        from freecad_analyzer import map_processes, resolve_material
        mat_raw = (extraction or {}).get("material") or ""
        if isinstance(mat_raw, dict):
            mat_raw = mat_raw.get("specification") or ""
        resolved_mat = resolve_material(mat_raw, default="Al6061")

        if raw_features_3d:
            # Python map_processes expects the raw freecad feature dicts
            proc_map_list = await loop.run_in_executor(
                None, lambda: map_processes(raw_features_3d, extraction or {}, resolved_mat)
            )
        else:
            # No 3D features — fall back to dimensions-based heuristic (no process map)
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
    results       = build_results(extraction, step_analysis, recognition, processes, cycle_time_res, cost_res)
    total_min     = results.get("total_minutes") or 0
    total_usd     = results.get("total_usd") or 0
    mat_name      = ((recognition or {}).get("material") or {}).get("name") or "Unknown material"
    feat_count    = (recognition or {}).get("feature_count") or (extraction or {}).get("feature_count") or 0
    source        = (recognition or {}).get("source") or "2d"

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
