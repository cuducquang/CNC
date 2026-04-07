"""
Approach 1 pipeline — LLM drives every step.
Steps are standalone async functions, called separately (no end-to-end SSE).

  1. analyze_gdt()              — VLM reads PDF pages (async generator -> SSE)
  2. analyze_step3d()           — Text LLM reads STEP geometry summary -> JSON
  3. recognize_features()       — Text LLM merges 2D+3D -> JSON
  4. map_processes()            — Text LLM maps CNC operations -> JSON
  5. estimate_cycle_time_llm()  — Text LLM estimates machining time -> JSON
  6. estimate_cost_formula()    — Formula (deterministic, no LLM)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from collections import Counter
from typing import AsyncGenerator

from pipeline.shared import _call_text_llm, _download, _scan_json_in_text
from vlm_stream import (
    SYSTEM_PROMPT,
    EXTRACTION_PROMPT,
    collect_ollama_vision_chat,
    classify_page_parsed,
    merge_vision_results,
    parse_model_json,
)

logger = logging.getLogger("cncapp.pipeline.approach1")

MAX_VLM_PAGES = 4  # cap pages to stay within ~10 min edge timeout

# ---------------------------------------------------------------------------
# PDF -> base64 pages (reused from approach2 via shared import below)
# ---------------------------------------------------------------------------

def _get_pdf_pages(drawing_bytes: bytes) -> list[str]:
    """Convert drawing bytes to base64 pages. Import lazily to avoid circular deps."""
    from pipeline.approach2 import pdf_to_base64_pages
    return pdf_to_base64_pages(drawing_bytes)


# ---------------------------------------------------------------------------
# STEP geometry parser — extracts a compact summary from raw STEP text
# ---------------------------------------------------------------------------

def _parse_step_geometry(step_text: str) -> str:
    """
    Parse raw STEP file text and return a human-readable geometry summary.

    Extracts:
      - CYLINDRICAL_SURFACE  -> diameter (radius x 2), counted by size
      - PLANE                -> total face count
      - CONICAL_SURFACE      -> semi-angle converted to degrees
      - TOROIDAL_SURFACE     -> minor_radius (fillet radius)
      - CARTESIAN_POINT      -> bounding box from all x,y,z coordinates
    """
    # ── Cylindrical surfaces ─────────────────────────────────────────────────
    cyl_radii = re.findall(
        r"CYLINDRICAL_SURFACE\s*\('[^']*',\s*#\d+,\s*([\d.]+)\s*\)",
        step_text,
    )
    cyl_diameters = [round(float(r) * 2, 4) for r in cyl_radii]
    cyl_counter   = Counter(cyl_diameters)

    # ── Planar faces ─────────────────────────────────────────────────────────
    plane_count = len(re.findall(r"\bPLANE\s*\(", step_text))

    # ── Conical surfaces / chamfers ──────────────────────────────────────────
    cone_angles_rad = re.findall(
        r"CONICAL_SURFACE\s*\('[^']*',\s*#\d+,\s*[\d.]+,\s*([\d.]+)\s*\)",
        step_text,
    )
    cone_counter = Counter(
        round(math.degrees(float(a)), 2) for a in cone_angles_rad
    )

    # ── Toroidal surfaces / fillets ──────────────────────────────────────────
    torus_minors = re.findall(
        r"TOROIDAL_SURFACE\s*\('[^']*',\s*#\d+,\s*[\d.]+,\s*([\d.]+)\s*\)",
        step_text,
    )
    torus_counter = Counter(round(float(r), 4) for r in torus_minors)

    # ── Bounding box from CARTESIAN_POINT ────────────────────────────────────
    cp_matches = re.findall(
        r"CARTESIAN_POINT\s*\('[^']*',\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*\)",
        step_text,
    )
    bbox_str = ""
    if cp_matches:
        xs = [float(m[0]) for m in cp_matches]
        ys = [float(m[1]) for m in cp_matches]
        zs = [float(m[2]) for m in cp_matches]
        bbox_x = round(max(xs) - min(xs), 3)
        bbox_y = round(max(ys) - min(ys), 3)
        bbox_z = round(max(zs) - min(zs), 3)
        bbox_str = f"Bounding box: {bbox_x} × {bbox_y} × {bbox_z} mm"

    # ── Assemble summary ─────────────────────────────────────────────────────
    lines: list[str] = []

    if cyl_counter:
        cyl_parts = ", ".join(f"Ø{d}×{n}" for d, n in sorted(cyl_counter.items()))
        lines.append(f"Cylindrical surfaces (diameter mm): {cyl_parts}")

    if plane_count:
        lines.append(f"Planar faces: {plane_count}")

    if cone_counter:
        cone_parts = ", ".join(f"{deg}°×{n}" for deg, n in sorted(cone_counter.items()))
        lines.append(f"Conical/chamfer surfaces: {cone_parts}")

    if torus_counter:
        torus_parts = ", ".join(f"R{r}×{n}" for r, n in sorted(torus_counter.items()))
        lines.append(f"Fillet radii (mm): {torus_parts}")

    if bbox_str:
        lines.append(bbox_str)

    if not lines:
        entity_count = step_text.count(";")
        lines.append(f"STEP file parsed ({entity_count} entities; no geometry extracted by regex)")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Step 1: analyze_gdt — VLM extracts GD&T from 2D drawing (SSE generator)
# ---------------------------------------------------------------------------

async def analyze_gdt(
    drawing_url: str,
    file_name: str,
) -> AsyncGenerator[tuple[str, dict], None]:
    """
    Step 1: Download the 2D drawing, convert to pages, run VLM on each page.

    Yields (event_type, data) tuples:
      ("thinking",   {"content": "..."})     — VLM reasoning tokens
      ("heartbeat",  {})                     — keep-alive when thinking is silent
      ("gdt_result", merged_extraction_dict) — final merged extraction
      ("done",       {})                     — end of stream
    """
    logger.info("analyze_gdt: downloading %s", drawing_url)
    try:
        drawing_bytes = await _download(drawing_url)
    except Exception as exc:
        yield "error", {"message": f"Download failed: {exc}"}
        yield "done",  {}
        return

    loop = asyncio.get_running_loop()
    try:
        pages = await loop.run_in_executor(None, _get_pdf_pages, drawing_bytes)
        logger.info("analyze_gdt: %d page(s) from %s", len(pages), file_name)
    except Exception as exc:
        yield "error", {"message": f"PDF conversion failed: {exc}"}
        yield "done",  {}
        return

    if not pages:
        yield "error", {"message": "Drawing produced no pages — check file format."}
        yield "done",  {}
        return

    pages_to_process = pages[:MAX_VLM_PAGES]
    if len(pages) > MAX_VLM_PAGES:
        logger.info(
            "analyze_gdt: %d pages in PDF, processing first %d (MAX_VLM_PAGES)",
            len(pages), MAX_VLM_PAGES,
        )

    all_parsed:   list[dict] = []
    all_outcomes: list[str]  = []

    for i, page_b64 in enumerate(pages_to_process):
        logger.info(
            "analyze_gdt: page %d/%d (b64_len=%d)",
            i + 1, len(pages_to_process), len(page_b64),
        )

        thinking_queue: asyncio.Queue = asyncio.Queue()

        async def _on_thinking(chunk: str, _q: asyncio.Queue = thinking_queue) -> None:
            await _q.put(chunk)

        async def _run_page(
            _p: str = page_b64,
            _q: asyncio.Queue = thinking_queue,
        ) -> tuple[dict, str]:
            parsed: dict = {
                "dimensions": [], "gdt": [], "threads": [],
                "material": None, "notes": [], "raw_model_output": "",
            }
            outcome = "unparseable"
            try:
                result  = await collect_ollama_vision_chat(
                    _p, SYSTEM_PROMPT, EXTRACTION_PROMPT, on_thinking=_on_thinking,
                )
                content = result.get("content") or ""
                if not content.strip():
                    parsed  = {**parsed, "raw_model_output": "(empty)"}
                    outcome = "unparseable"
                else:
                    parsed  = parse_model_json(content)
                    outcome = classify_page_parsed(parsed)
            except Exception as exc:
                logger.warning("analyze_gdt page %d error: %s", i + 1, exc)
                parsed  = {**parsed, "raw_model_output": str(exc)}
                outcome = "unparseable"
            finally:
                await _q.put(None)
            return parsed, outcome

        page_task = asyncio.create_task(_run_page())

        while True:
            try:
                chunk = await asyncio.wait_for(thinking_queue.get(), timeout=15.0)
                if chunk is None:
                    break
                yield "thinking", {"content": chunk}
            except asyncio.TimeoutError:
                yield "heartbeat", {}

        parsed, outcome = await page_task
        all_parsed.append(parsed)
        all_outcomes.append(outcome)
        logger.info("analyze_gdt: page %d/%d done, outcome=%s", i + 1, len(pages_to_process), outcome)

    ok_parsed = [p for p, o in zip(all_parsed, all_outcomes) if o == "ok"]
    merged    = merge_vision_results(ok_parsed if ok_parsed else all_parsed)

    extraction = {
        **merged,
        "feature_count":  len(merged.get("dimensions") or []),
        "gdt_count":      len(merged.get("gdt")        or []),
        "pages_analyzed": len(pages_to_process),
    }

    yield "gdt_result", extraction
    yield "done",       {}


# ---------------------------------------------------------------------------
# Step 2: analyze_step3d — hybrid FreeCAD + LLM 3D geometry analysis
# ---------------------------------------------------------------------------

def _freecad_features_to_features_3d(features: list) -> list:
    """
    Convert FreeCAD STEPAnalyzer feature dicts directly to features_3d format.
    Groups same-type same-dimension holes together (quantity > 1).
    Called when FreeCAD data is available so the LLM text call can be skipped.
    """
    _OP = {
        "through_hole":  "drill",
        "blind_hole":    "drill",
        "threaded_hole": "tap",
        "countersink":   "countersink",
        "pocket":        "mill",
        "slot":          "mill",
        "boss":          "mill",
        "step":          "mill",
        "fillet":        "ball_end_mill",
        "chamfer":       "chamfer_mill",
        "face":          "face_mill",
        "groove":        "mill",
        "bend":          "bend",
        "flange":        "form",
    }

    # Group holes by (subtype, diameter_mm, depth_mm) to merge duplicates
    hole_groups: dict = {}
    non_holes:   list = []

    for f in features:
        ftype = (f.get("type") or "").lower()
        dims  = f.get("dimensions") or {}

        if ftype == "hole":
            subtype = dims.get("type", "blind")      # "through" | "blind"
            key_type = "through_hole" if subtype == "through" else "blind_hole"
            try:
                dia   = round(float(dims.get("diameter_mm", 0)), 3)
                depth = round(float(dims.get("depth_mm",    0)), 3) if subtype != "through" else None
            except (TypeError, ValueError):
                dia, depth = 0.0, None
            key = (key_type, dia, depth)
            hole_groups.setdefault(key, []).append(f)
        else:
            non_holes.append(f)

    result = []
    seq    = 1

    # Emit grouped holes
    for (key_type, dia, depth), group in hole_groups.items():
        qty = len(group)
        f0  = group[0]
        dims = f0.get("dimensions") or {}
        desc = (
            f"{qty}× Ø{dia}mm "
            + ("through hole" if key_type == "through_hole" else f"blind hole depth {depth}mm")
        )
        entry: dict = {
            "id":          f"F{seq:03d}",
            "type":        key_type,
            "diameter_mm": dia,
            "quantity":    qty,
            "operation":   _OP.get(key_type, "drill"),
            "description": desc,
        }
        if depth is not None:
            entry["depth_mm"] = depth
        axis = dims.get("axis")
        if axis:
            entry["axis"] = axis
        result.append(entry)
        seq += 1

    # Emit non-hole features
    for f in non_holes:
        ftype = (f.get("type") or "other").lower()
        dims  = f.get("dimensions") or {}

        def _fv(key: str):
            try:
                return round(float(dims[key]), 3) if key in dims else None
            except (TypeError, ValueError):
                return None

        entry: dict = {
            "id":        f"F{seq:03d}",
            "type":      ftype,
            "quantity":  int(dims.get("count") or f.get("_count") or 1),
            "operation": _OP.get(ftype, "mill"),
            "description": f.get("description") or f.get("name") or ftype,
        }
        # Attach relevant dimensions
        for src_key, dst_key in (
            ("diameter_mm", "diameter_mm"),
            ("depth_mm",    "depth_mm"),
            ("radius_mm",   "radius_mm"),
            ("width_mm",    "width_mm"),
            ("length_mm",   "length_mm"),
            ("angle_deg",   "angle_deg"),
            ("size_mm",     "size_mm"),
        ):
            v = _fv(src_key)
            if v is not None:
                entry[dst_key] = v

        result.append(entry)
        seq += 1

    return result


def _build_freecad_geometry_summary(analysis_result: dict, sheet_metal: dict) -> str:
    """
    Build a rich, human-readable geometry summary string from FreeCAD output.
    Used as the primary geometry context passed to the text LLM.
    """
    lines: list[str] = []
    ss = analysis_result.get("shape_summary") or {}

    # Bounding box + volume
    bbox_parts = [
        f'{ss["bbox_x_mm"]:.3f}' if ss.get("bbox_x_mm") else None,
        f'{ss["bbox_y_mm"]:.3f}' if ss.get("bbox_y_mm") else None,
        f'{ss["bbox_z_mm"]:.3f}' if ss.get("bbox_z_mm") else None,
    ]
    if all(bbox_parts):
        lines.append(f"Bounding box: {' × '.join(bbox_parts)} mm")
    if ss.get("volume_mm3"):
        lines.append(f"Volume: {ss['volume_mm3']:.1f} mm³")
    if ss.get("area_mm2"):
        lines.append(f"Surface area: {ss['area_mm2']:.1f} mm²")
    if ss.get("n_faces"):
        lines.append(f"Total faces: {ss['n_faces']} (solids: {ss.get('n_solids', 1)}, edges: {ss.get('n_edges', '?')})")

    # Features extracted by FreeCAD
    features = analysis_result.get("features") or []
    from collections import Counter
    feat_by_type: dict[str, list] = {}
    for f in features:
        ftype = (f.get("type") or "other").lower()
        feat_by_type.setdefault(ftype, []).append(f)

    for ftype, flist in sorted(feat_by_type.items()):
        if not flist:
            continue
        # Summarise each group
        parts = []
        import math as _math
        for f in flist:
            dims = f.get("dimensions") or {}
            try:
                if "diameter_mm" in dims and "depth_mm" in dims:
                    parts.append(f"Ø{float(dims['diameter_mm']):.3f}×{float(dims['depth_mm']):.2f}mm")
                elif "diameter_mm" in dims:
                    parts.append(f"Ø{float(dims['diameter_mm']):.3f}mm")
                elif "radius_mm" in dims:
                    parts.append(f"R{float(dims['radius_mm']):.3f}mm")
                elif "angle_deg" in dims:
                    parts.append(f"{float(dims['angle_deg']):.1f}°")
                elif "width_mm" in dims and "length_mm" in dims:
                    parts.append(f"{float(dims['width_mm']):.2f}×{float(dims['length_mm']):.2f}mm")
            except (TypeError, ValueError):
                pass
        summary = ", ".join(parts) if parts else str(len(flist)) + " instance(s)"
        lines.append(f"{ftype.replace('_', ' ').title()} ({len(flist)}): {summary}")

    # Sheet metal data
    if sheet_metal.get("is_sheet_metal"):
        lines.append(f"Sheet metal part — thickness: {sheet_metal.get('thickness_mm', 0):.3f} mm")
        bends = sheet_metal.get("bends") or []
        if bends:
            bend_parts = [f"R{b['radius_mm']:.2f}@{b['angle_deg']:.0f}°×{b['count']}" for b in bends]
            lines.append(f"Bends: {', '.join(bend_parts)}")
        flanges = sheet_metal.get("flanges") or []
        if flanges:
            flange_parts = [f"{fl['width_mm']:.2f}×{fl['length_mm']:.2f}" for fl in flanges[:6]]
            lines.append(f"Flanges (mm): {', '.join(flange_parts)}")
        if sheet_metal.get("relief_cuts"):
            lines.append(f"Relief cuts: {sheet_metal['relief_cuts']}")

    if not lines:
        lines.append("(No geometry extracted by FreeCAD)")

    return "\n".join(lines)


async def analyze_step3d(step_url: str, file_name: str) -> dict:
    """
    Step 2: Download the STEP file, run FreeCAD STEPAnalyzer + sheet metal
    detector to build a rich geometry summary, then ask the text LLM to
    classify machining features from real geometry numbers.

    Falls back to regex-only parsing if FreeCAD is unavailable.

    Returns a dict with keys: features_3d (list), shape_summary (dict).
    On failure returns an empty structure with an 'error' key.
    """
    import asyncio
    import tempfile
    import os

    logger.info("analyze_step3d: downloading %s", step_url)
    try:
        step_bytes = await _download(step_url)
    except Exception as exc:
        logger.error("analyze_step3d: download failed: %s", exc)
        return {"features_3d": [], "shape_summary": {}, "error": str(exc)}

    # ── Attempt FreeCAD analysis ─────────────────────────────────────────────
    freecad_result: dict  = {}
    sheet_metal:    dict  = {"is_sheet_metal": False}
    step_path_tmp:  str   = ""
    tmpdir_obj            = None

    try:
        from freecad_analyzer import STEPAnalyzer, load_freecad
        import freecad_analyzer.step_analyzer as _fc_step
        from pipeline.approach2 import _detect_sheet_metal

        if not _fc_step.FREECAD_AVAILABLE:
            load_freecad()

        if _fc_step.FREECAD_AVAILABLE:
            tmpdir_obj = tempfile.TemporaryDirectory()
            ext = ".stp" if not file_name.lower().endswith((".stp", ".step")) else ""
            step_path_tmp = os.path.join(
                tmpdir_obj.name,
                file_name if file_name.lower().endswith((".stp", ".step")) else f"part{ext or '.stp'}",
            )
            with open(step_path_tmp, "wb") as fh:
                fh.write(step_bytes)

            loop = asyncio.get_running_loop()

            # Run STEPAnalyzer and sheet metal detector in parallel
            freecad_result, sheet_metal = await asyncio.gather(
                loop.run_in_executor(None, lambda: STEPAnalyzer(step_path_tmp).analyze()),
                loop.run_in_executor(None, _detect_sheet_metal, step_path_tmp),
            )
            logger.info(
                "analyze_step3d: FreeCAD extracted %d features, sheet_metal=%s",
                len(freecad_result.get("features") or []),
                sheet_metal.get("is_sheet_metal"),
            )
        else:
            logger.info("analyze_step3d: FreeCAD unavailable — using regex fallback")
    except Exception as exc:
        logger.warning("analyze_step3d: FreeCAD analysis failed: %s — falling back to regex", exc)
        freecad_result = {}
        sheet_metal    = {"is_sheet_metal": False}
    finally:
        if tmpdir_obj is not None:
            try:
                tmpdir_obj.cleanup()
            except Exception:
                pass

    # ── Fast path: FreeCAD extracted features — convert directly, skip LLM ──
    fc_features_raw = freecad_result.get("features") or []
    if fc_features_raw and freecad_result.get("shape_summary"):
        features_3d = _freecad_features_to_features_3d(fc_features_raw)
        shape_summary = freecad_result["shape_summary"]
        geometry_source = "freecad"
        logger.info(
            "analyze_step3d: converted %d FreeCAD features to features_3d (LLM skipped)",
            len(features_3d),
        )
        return {
            "features_3d":     features_3d,
            "shape_summary":   shape_summary,
            "sheet_metal":     sheet_metal,
            "geometry_source": geometry_source,
            "thinking":        "",
        }

    # ── Fallback: no FreeCAD features — build text summary and call LLM ─────
    if freecad_result.get("shape_summary"):
        step_geometry_summary = _build_freecad_geometry_summary(freecad_result, sheet_metal)
        geometry_source = "freecad"
    else:
        try:
            step_text = step_bytes.decode("utf-8", errors="replace")
        except Exception as exc:
            return {"features_3d": [], "shape_summary": {}, "error": f"Decode failed: {exc}"}
        step_geometry_summary = _parse_step_geometry(step_text)
        geometry_source = "regex"

    logger.info(
        "analyze_step3d: no FreeCAD features — calling LLM (source=%s)",
        geometry_source,
    )

    system_prompt = (
        "You are a CNC manufacturing engineer. "
        "Analyze STEP geometry data and identify machining features with precise dimensions. "
        "Output ONLY valid JSON — no explanation, no preamble, no markdown."
    )

    sheet_metal_note = ""
    if sheet_metal.get("is_sheet_metal"):
        sheet_metal_note = (
            "\nThis is a SHEET METAL part. Include bend, flange, and hem features."
        )

    user_prompt = f"""STEP geometry for "{file_name}":

{step_geometry_summary}{sheet_metal_note}

Respond with ONLY this JSON structure (no other text):
{{
  "features_3d": [
    {{"id":"F001","type":"blind_hole","diameter_mm":6.731,"depth_mm":6.858,"quantity":8,"operation":"drill","description":"8× Ø6.731mm blind holes"}},
    {{"id":"F002","type":"pocket","width_mm":183.3,"length_mm":463.6,"depth_mm":18.4,"quantity":1,"operation":"mill","description":"Large milled pocket"}}
  ],
  "shape_summary": {{"bbox_x_mm":466.5,"bbox_y_mm":932.9,"bbox_z_mm":31.75,"volume_mm3":3870409.5}}
}}"""

    try:
        raw, thinking = await _call_text_llm(system_prompt, user_prompt)
        parsed = parse_model_json(raw)

        features_3d = parsed.get("features_3d") or []
        if not isinstance(features_3d, list):
            features_3d = []

        fc_shape   = freecad_result.get("shape_summary") or {}
        llm_shape  = parsed.get("shape_summary") or {}
        shape_summary = {**llm_shape, **{k: v for k, v in fc_shape.items() if v is not None}}

        logger.info(
            "analyze_step3d: LLM returned %d features (source=%s), thinking_len=%d",
            len(features_3d), geometry_source, len(thinking),
        )
        return {
            "features_3d":     features_3d,
            "shape_summary":   shape_summary,
            "sheet_metal":     sheet_metal,
            "geometry_source": geometry_source,
            "thinking":        thinking,
        }

    except Exception as exc:
        logger.error("analyze_step3d: LLM call failed: %s", exc)
        return {
            "features_3d":     [],
            "shape_summary":   freecad_result.get("shape_summary") or {},
            "sheet_metal":     sheet_metal,
            "geometry_source": geometry_source,
            "thinking":        "",
            "error":           str(exc),
        }


# ---------------------------------------------------------------------------
# Step 3: recognize_features — text LLM merges 2D GD&T with 3D features
# ---------------------------------------------------------------------------

async def recognize_features(extraction: dict, step_analysis: dict) -> dict:
    """
    Step 3: Match 2D drawing annotations to 3D CAD features via the text LLM.

    Returns a dict with keys: features (list), material (dict), feature_count (int).
    On failure returns an empty structure with an 'error' key.
    """
    system_prompt = (
        "You are a manufacturing feature recognition specialist. "
        "Match 2D drawing data to 3D features. "
        "Output ONLY valid JSON."
    )

    user_prompt = f"""Match 2D drawing annotations to 3D CAD features.

2D GD&T extraction:
{json.dumps(extraction, indent=2)}

3D features from STEP:
{json.dumps(step_analysis.get("features_3d", []), indent=2)}

Rules:
- Match by type+size: Ø8.86mm cylinder + .190-32 UNF thread = threaded_hole
- Assign tolerances from 2D dimensions to matched 3D features
- If no 3D match, use 2D data alone (source: "2d")
- tolerance_class: "precision" (<=0.001), "close" (<=0.005), "medium" (<=0.010), "general" (>0.010)
- Prefer material from 2D drawing; fallback to "AL6061-T6"

Output ONLY this JSON:
{{
  "features": [
    {{
      "id": "F001",
      "type": "threaded_hole",
      "description": "3x M8x1.25 tapped through holes",
      "quantity": 3,
      "geometry": {{"diameter_mm": 8.86, "depth_mm": null}},
      "tolerance": {{"plus": 0.0, "minus": 0.005}},
      "tolerance_class": "close",
      "gdt_callouts": [],
      "source": "3d+2d"
    }}
  ],
  "material": {{"name": "Aluminum 6061-T6", "spec": "AL6061-T6"}},
  "feature_count": 1
}}"""

    try:
        raw, thinking = await _call_text_llm(system_prompt, user_prompt)
        parsed = parse_model_json(raw)

        features      = parsed.get("features")      or []
        material      = parsed.get("material")      or {"name": "Aluminum 6061-T6", "spec": "AL6061-T6"}
        feature_count = parsed.get("feature_count") or len(features)

        if not isinstance(features, list):
            features = []

        logger.info(
            "recognize_features: %d features, material=%s, thinking_len=%d",
            len(features), material, len(thinking),
        )
        return {
            "features":      features,
            "material":      material,
            "feature_count": feature_count,
            "thinking":      thinking,
        }

    except Exception as exc:
        logger.error("recognize_features: LLM call failed: %s", exc)
        return {
            "features":      [],
            "material":      {"name": "Aluminum 6061-T6", "spec": "AL6061-T6"},
            "feature_count": 0,
            "thinking":      "",
            "error":         str(exc),
        }


# ---------------------------------------------------------------------------
# Step 4: map_processes — text LLM maps features to CNC operations
# ---------------------------------------------------------------------------

async def map_processes(features: list, material: dict) -> dict:
    """
    Step 4: Ask the text LLM to produce a CNC operation list for the given
    features and material.

    Returns a dict with keys: operations (list), setup_count (int), operation_count (int).
    On failure returns an empty structure with an 'error' key.
    """
    system_prompt = (
        "You are a CNC process planning engineer. "
        "Map features to machining operations. "
        "Output ONLY valid JSON."
    )

    user_prompt = f"""Map CNC machining operations for these features.

Material: {material.get("spec", "AL6061-T6")} — {material.get("name", "Aluminum")}
Machine: 3-axis VMC (Vertical Machining Center)

Features:
{json.dumps(features, indent=2)}

Rules:
- through_hole/blind_hole: center_drill -> drill
- threaded_hole: center_drill -> drill -> tap
- pocket/slot: rough_mill -> finish_mill
- chamfer: chamfer_mill
- fillet: ball_end_mill
- face: face_mill
- List operations in logical machining order (setup then features)
- One entry per operation per feature (quantity on the feature, not repeated rows)

Output ONLY this JSON:
{{
  "operations": [
    {{"id":"OP001","feature_id":"F001","operation":"center_drill","tool":"Center Drill Ø3.17mm","quantity":3,"note":"Pilot for M8 holes"}},
    {{"id":"OP002","feature_id":"F001","operation":"drill","tool":"Twist Drill Ø8.86mm","quantity":3,"note":""}},
    {{"id":"OP003","feature_id":"F001","operation":"tap","tool":"M8x1.25 Tap","quantity":3,"note":""}}
  ],
  "setup_count": 1,
  "operation_count": 3
}}"""

    try:
        raw, thinking = await _call_text_llm(system_prompt, user_prompt)
        parsed = parse_model_json(raw)

        operations      = parsed.get("operations")      or []
        setup_count     = parsed.get("setup_count")     or 1
        operation_count = parsed.get("operation_count") or len(operations)

        if not isinstance(operations, list):
            operations = []

        logger.info(
            "map_processes: %d operations, %d setups, thinking_len=%d",
            len(operations), setup_count, len(thinking),
        )
        return {
            "operations":      operations,
            "setup_count":     setup_count,
            "operation_count": operation_count,
            "thinking":        thinking,
        }

    except Exception as exc:
        logger.error("map_processes: LLM call failed: %s", exc)
        return {
            "operations":      [],
            "setup_count":     0,
            "operation_count": 0,
            "thinking":        "",
            "error":           str(exc),
        }


# ---------------------------------------------------------------------------
# Step 5: estimate_cycle_time_llm — text LLM estimates machining time
# ---------------------------------------------------------------------------

async def estimate_cycle_time_llm(operations: list, material_spec: str) -> dict:
    """
    Step 5: Ask the text LLM to estimate per-operation and total cycle time.

    Returns a dict with keys: total_minutes, setup_minutes, machining_minutes,
    operations (list of per-op estimates).
    On failure returns a zeroed structure with an 'error' key.
    """
    system_prompt = (
        "You are a CNC machining time estimator. "
        "Estimate cycle times based on standard speeds/feeds. "
        "Output ONLY valid JSON."
    )

    user_prompt = f"""Estimate machining cycle time in minutes.

Material: {material_spec}
Standard assumptions:
- Al6061: spindle 8000-12000 RPM, feed 2000-3000 mm/min for end mills; 3000-5000 RPM + 500 mm/min for drills
- Tool change: 0.05 min each new tool
- Setup (fixturing + zeroing): 5.0 min flat

Operations:
{json.dumps(operations, indent=2)}

Output ONLY this JSON:
{{
  "total_minutes": 11.2,
  "setup_minutes": 5.0,
  "machining_minutes": 6.2,
  "operations": [
    {{"operation_id":"OP001","minutes":0.05,"note":"Center drill 3x pilot holes"}},
    {{"operation_id":"OP002","minutes":0.15,"note":"Drill 3x Ø8.86mm through"}},
    {{"operation_id":"OP003","minutes":0.45,"note":"Tap M8x1.25 3x at 300 RPM"}}
  ]
}}"""

    try:
        raw, thinking = await _call_text_llm(system_prompt, user_prompt)
        parsed = parse_model_json(raw)

        total_minutes     = float(parsed.get("total_minutes")     or 0)
        setup_minutes     = float(parsed.get("setup_minutes")     or 5.0)
        machining_minutes = float(parsed.get("machining_minutes") or max(0, total_minutes - setup_minutes))
        op_estimates      = parsed.get("operations") or []

        if not isinstance(op_estimates, list):
            op_estimates = []

        logger.info(
            "estimate_cycle_time_llm: total=%.2f min (setup=%.2f + machining=%.2f), thinking_len=%d",
            total_minutes, setup_minutes, machining_minutes, len(thinking),
        )
        return {
            "total_minutes":     total_minutes,
            "setup_minutes":     setup_minutes,
            "machining_minutes": machining_minutes,
            "operations":        op_estimates,
            "thinking":          thinking,
        }

    except Exception as exc:
        logger.error("estimate_cycle_time_llm: LLM call failed: %s", exc)
        return {
            "total_minutes":     0,
            "setup_minutes":     5.0,
            "machining_minutes": 0,
            "operations":        [],
            "thinking":          "",
            "error":             str(exc),
        }


# ---------------------------------------------------------------------------
# Step 6: estimate_cost_formula — deterministic cost formula (no LLM)
# ---------------------------------------------------------------------------

def estimate_cost_formula(
    cycle_time: dict,
    material_spec: str = "AL6061-T6",
) -> dict:
    """
    Step 6: Compute fabrication cost from cycle time using fixed rates.

    No LLM call — pure arithmetic so it is fast, reproducible, and free.

    Rates (USD):
      shop_rate    = $60.00 / hour
      material     = $15.00 flat (raw stock default)
    """
    shop_rate:     float = 60.0
    material_cost: float = 15.0

    total_minutes:     float = float(cycle_time.get("total_minutes")     or 0)
    setup_minutes:     float = float(cycle_time.get("setup_minutes")     or 5.0)
    machining_minutes: float = max(0.0, total_minutes - setup_minutes)

    machining_cost: float = (total_minutes / 60.0) * shop_rate
    total_usd:      float = round(machining_cost + material_cost, 2)

    logger.info(
        "estimate_cost_formula: material=$%.2f machining=$%.2f total=$%.2f (%s)",
        material_cost, round(machining_cost, 2), total_usd, material_spec,
    )

    return {
        "total_usd":          total_usd,
        "currency":           "USD",
        "shop_rate_per_hour": shop_rate,
        "material_cost":      material_cost,
        "machining_cost":     round(machining_cost, 2),
        "breakdown": [
            {"item": "Raw Material", "usd": material_cost},
            {
                "item": "Setup",
                "usd": round((setup_minutes / 60.0) * shop_rate, 2),
            },
            {
                "item": "Machining",
                "usd": round((machining_minutes / 60.0) * shop_rate, 2),
            },
        ],
    }
