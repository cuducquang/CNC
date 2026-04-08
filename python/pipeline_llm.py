"""
Approach 1 pipeline — LLM drives every step.
Steps are standalone async functions, called separately (no end-to-end SSE).

  1. analyze_gdt()         — VLM reads PDF pages (async generator → SSE)
  2. analyze_step3d()      — Text LLM reads STEP geometry summary → JSON
  3. recognize_features()  — Text LLM merges 2D+3D → JSON
  4. map_processes()       — Text LLM maps CNC operations → JSON
  5. estimate_cycle_time_llm() — Text LLM estimates machining time → JSON
  6. estimate_cost_formula()   — Formula (deterministic, no LLM)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
from collections import Counter
from typing import AsyncGenerator

import httpx

from pipeline import _download, pdf_to_base64_pages, MAX_VLM_PAGES
from vlm_stream import (
    SYSTEM_PROMPT,
    EXTRACTION_PROMPT,
    collect_ollama_vision_chat,
    classify_page_parsed,
    merge_vision_results,
    parse_model_json,
    extract_json_from_thinking,
    _find_matching_brace,
)

logger = logging.getLogger("cncapp.pipeline_llm")

# ---------------------------------------------------------------------------
# LLM connection config (resolved at call time so env vars can be set late)
# ---------------------------------------------------------------------------

def _base_url() -> str:
    return (
        os.environ.get("VISION_MODEL_URL")
        or os.environ.get("LOCAL_OLLAMA_URL")
        or "http://localhost:11434"
    ).rstrip("/")


def _model_name() -> str:
    return (
        os.environ.get("VISION_MODEL_NAME")
        or os.environ.get("VISION_MODEL")
        or "/workspace/models/Qwen3-VL-32B-Thinking-FP8"
    )


# ---------------------------------------------------------------------------
# STEP geometry parser — extracts a compact summary from raw STEP text
# ---------------------------------------------------------------------------

def _parse_step_geometry(step_text: str) -> str:
    """
    Parse raw STEP file text and return a human-readable geometry summary.

    Extracts:
      - CYLINDRICAL_SURFACE  → diameter (radius × 2), counted by size
      - PLANE                → total face count
      - CONICAL_SURFACE      → semi-angle converted to degrees
      - TOROIDAL_SURFACE     → minor_radius (fillet radius)
      - CARTESIAN_POINT      → bounding box from all x,y,z coordinates
    """
    # ── Cylindrical surfaces ─────────────────────────────────────────────────
    # Entity: CYLINDRICAL_SURFACE('label', #ref, radius)
    cyl_radii = re.findall(
        r"CYLINDRICAL_SURFACE\s*\('[^']*',\s*#\d+,\s*([\d.]+)\s*\)",
        step_text,
    )
    cyl_diameters = [round(float(r) * 2, 4) for r in cyl_radii]
    cyl_counter   = Counter(cyl_diameters)

    # ── Planar faces ─────────────────────────────────────────────────────────
    plane_count = len(re.findall(r"\bPLANE\s*\(", step_text))

    # ── Conical surfaces / chamfers ──────────────────────────────────────────
    # Entity: CONICAL_SURFACE('label', #ref, semi_angle_rad)
    cone_angles_rad = re.findall(
        r"CONICAL_SURFACE\s*\('[^']*',\s*#\d+,\s*[\d.]+,\s*([\d.]+)\s*\)",
        step_text,
    )
    cone_counter = Counter(
        round(math.degrees(float(a)), 2) for a in cone_angles_rad
    )

    # ── Toroidal surfaces / fillets ──────────────────────────────────────────
    # Entity: TOROIDAL_SURFACE('label', #ref, major_radius, minor_radius)
    torus_minors = re.findall(
        r"TOROIDAL_SURFACE\s*\('[^']*',\s*#\d+,\s*[\d.]+,\s*([\d.]+)\s*\)",
        step_text,
    )
    torus_counter = Counter(round(float(r), 4) for r in torus_minors)

    # ── Bounding box from CARTESIAN_POINT ────────────────────────────────────
    # Entity: CARTESIAN_POINT('label', (x, y, z)) — various whitespace patterns
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
        cyl_parts = ", ".join(
            f"Ø{d}×{n}" for d, n in sorted(cyl_counter.items())
        )
        lines.append(f"Cylindrical surfaces (diameter mm): {cyl_parts}")

    if plane_count:
        lines.append(f"Planar faces: {plane_count}")

    if cone_counter:
        cone_parts = ", ".join(
            f"{deg}°×{n}" for deg, n in sorted(cone_counter.items())
        )
        lines.append(f"Conical/chamfer surfaces: {cone_parts}")

    if torus_counter:
        torus_parts = ", ".join(
            f"R{r}×{n}" for r, n in sorted(torus_counter.items())
        )
        lines.append(f"Fillet radii (mm): {torus_parts}")

    if bbox_str:
        lines.append(bbox_str)

    if not lines:
        # Minimal fallback — at least report the STEP entity count
        entity_count = step_text.count(";")
        lines.append(f"STEP file parsed ({entity_count} entities; no geometry extracted by regex)")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Text LLM helper — non-streaming POST to /v1/chat/completions
# ---------------------------------------------------------------------------

def _scan_json_in_text(text: str) -> str:
    """
    Scan text for the last well-formed JSON object and return it.
    Iterates backwards so we prefer the most complete/final answer.
    Returns empty string if nothing found.
    """
    for pos in range(len(text) - 1, -1, -1):
        if text[pos] != "{":
            continue
        from_brace = text[pos:]
        close_idx  = _find_matching_brace(from_brace)
        if close_idx == -1:
            continue
        candidate = from_brace[: close_idx + 1]
        try:
            json.loads(candidate)
            return candidate
        except (json.JSONDecodeError, ValueError):
            continue
    return ""


async def _call_text_llm(
    system: str,
    user: str,
    temperature: float = 0.2,
    max_tokens: int = 6144,
    thinking_budget: int = 1024,
) -> tuple[str, str]:
    """
    Call Qwen3 endpoint (no image) and return (answer_content, thinking_content).

    Handles all three thinking-boundary formats produced by Qwen3 + vLLM:

      A. reasoning_content field (vLLM ≥ 0.7)
         → content   = clean JSON answer
         → reasoning_content = thinking trace

      B. Full inline block  <think>…</think>{answer}
         → strip tags, split at </think>

      C. Qwen3-VL chat-template format — no <think> prefix, boundary is </think>
         → content = "thinking text…\n</think>\n{answer}"
         → split at first </think>

    If the answer portion is empty after stripping (model spent all tokens thinking),
    _scan_json_in_text scans the thinking content for a parseable JSON object.
    """
    base_url   = _base_url()
    model_name = _model_name()
    endpoint   = f"{base_url}/v1/chat/completions"

    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "stream":      False,
        "temperature": temperature,
        "max_tokens":  max_tokens,
        "chat_template_kwargs": {
            "enable_thinking":        True,
            "thinking_budget_tokens": thinking_budget,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(endpoint, json=payload)
            resp.raise_for_status()
            data    = resp.json()
            message = ((data.get("choices") or [{}])[0]).get("message", {})

            raw_content = (message.get("content") or "").strip()

            # ── Case A: dedicated reasoning_content field ──────────────────────
            thinking = (message.get("reasoning_content") or "").strip()

            if not thinking and "</think>" in raw_content:
                # ── Case B: full inline  <think>…</think>{answer} ──────────────
                if raw_content.startswith("<think>"):
                    close        = raw_content.index("</think>")
                    thinking     = raw_content[7 : close].strip()
                    raw_content  = raw_content[close + 8 :].strip()

                # ── Case C: Qwen3-VL template — content starts with thinking, no <think> tag
                else:
                    close        = raw_content.index("</think>")
                    thinking     = raw_content[:close].strip()
                    raw_content  = raw_content[close + 8 :].strip()

            # ── Fallback: model spent all tokens in thinking, answer is empty ──
            if not raw_content and thinking:
                logger.warning(
                    "_call_text_llm: answer empty after stripping thinking — scanning thinking for JSON"
                )
                raw_content = _scan_json_in_text(thinking)

            logger.info(
                "_call_text_llm: tokens=%d answer_len=%d thinking_len=%d",
                (data.get("usage") or {}).get("total_tokens", 0),
                len(raw_content),
                len(thinking),
            )
            return raw_content, thinking

    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"LLM HTTP {exc.response.status_code}: {exc.response.text[:300]}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"LLM call failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Step 1: analyze_gdt — VLM extracts GD&T from 2D drawing (SSE generator)
# ---------------------------------------------------------------------------

async def analyze_gdt(
    drawing_url: str,
    file_name: str,
) -> AsyncGenerator[tuple[str, dict], None]:
    """
    Step 1: Download the 2D drawing, convert to pages, run VLM on each page.

    Yields (event_type, data) tuples compatible with server_llm.py SSE serialisation:
      ("thinking",   {"content": "..."})     — VLM reasoning tokens (forwarded as SSE)
      ("heartbeat",  {})                     — keep-alive when thinking is silent
      ("gdt_result", merged_extraction_dict) — final merged extraction
      ("done",       {})                     — signals end of stream
    """
    # ── Download ──────────────────────────────────────────────────────────────
    logger.info("analyze_gdt: downloading %s", drawing_url)
    try:
        drawing_bytes = await _download(drawing_url)
    except Exception as exc:
        yield "error", {"message": f"Download failed: {exc}"}
        yield "done",  {}
        return

    # ── Convert to pages ──────────────────────────────────────────────────────
    loop = asyncio.get_running_loop()
    try:
        pages = await loop.run_in_executor(
            None, pdf_to_base64_pages, drawing_bytes
        )
        logger.info("analyze_gdt: %d page(s) from %s", len(pages), file_name)
    except Exception as exc:
        yield "error", {"message": f"PDF conversion failed: {exc}"}
        yield "done",  {}
        return

    if not pages:
        yield "error", {"message": "Drawing produced no pages — check file format."}
        yield "done",  {}
        return

    # Cap at MAX_VLM_PAGES to avoid excessively long inference runs
    pages_to_process = pages[:MAX_VLM_PAGES]
    if len(pages) > MAX_VLM_PAGES:
        logger.info(
            "analyze_gdt: %d pages in PDF, processing first %d (MAX_VLM_PAGES)",
            len(pages), MAX_VLM_PAGES,
        )

    # ── Process pages sequentially ────────────────────────────────────────────
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
                await _q.put(None)   # sentinel — signals the drain loop to exit
            return parsed, outcome

        page_task = asyncio.create_task(_run_page())

        # Drain thinking queue; emit heartbeat every 15 s of silence to keep CDN/proxy alive
        while True:
            try:
                chunk = await asyncio.wait_for(thinking_queue.get(), timeout=15.0)
                if chunk is None:
                    break   # sentinel received — page done
                yield "thinking", {"content": chunk}
            except asyncio.TimeoutError:
                yield "heartbeat", {}

        parsed, outcome = await page_task
        all_parsed.append(parsed)
        all_outcomes.append(outcome)
        logger.info("analyze_gdt: page %d/%d done, outcome=%s", i + 1, len(pages_to_process), outcome)

    # ── Merge results ─────────────────────────────────────────────────────────
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
# Step 2: analyze_step3d — text LLM reads STEP geometry → JSON features
# ---------------------------------------------------------------------------

async def analyze_step3d(step_url: str, file_name: str) -> dict:
    """
    Step 2: Download the STEP file, parse geometry with regex, then ask the
    text LLM to classify machining features.

    Returns a dict with keys: features_3d (list), shape_summary (dict).
    On failure returns an empty structure with an 'error' key.
    """
    # ── Download STEP ─────────────────────────────────────────────────────────
    logger.info("analyze_step3d: downloading %s", step_url)
    try:
        step_bytes = await _download(step_url)
    except Exception as exc:
        logger.error("analyze_step3d: download failed: %s", exc)
        return {"features_3d": [], "shape_summary": {}, "error": str(exc)}

    # ── Parse geometry ────────────────────────────────────────────────────────
    try:
        step_text = step_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        return {"features_3d": [], "shape_summary": {}, "error": f"Decode failed: {exc}"}

    step_geometry_summary = _parse_step_geometry(step_text)
    logger.info("analyze_step3d: geometry summary:\n%s", step_geometry_summary)

    # ── LLM prompt ────────────────────────────────────────────────────────────
    system_prompt = (
        "You are a CNC manufacturing engineer. "
        "Analyze STEP geometry and identify machining features. "
        "Output ONLY valid JSON."
    )

    user_prompt = f"""STEP file geometric summary for part "{file_name}":

{step_geometry_summary}

Identify all machining features. Group cylinders of same diameter as one feature with quantity.

Output ONLY this JSON (no markdown, no text outside JSON):
{{
  "features_3d": [
    {{"id":"F001","type":"through_hole","diameter_mm":8.86,"depth_mm":null,"quantity":3}},
    {{"id":"F002","type":"pocket","width_mm":50.0,"length_mm":30.0,"depth_mm":10.0,"quantity":1}},
    {{"id":"F003","type":"chamfer","angle_deg":45.0,"size_mm":1.0,"quantity":2}},
    {{"id":"F004","type":"fillet","radius_mm":2.0,"quantity":4}},
    {{"id":"F005","type":"face","area_class":"large","quantity":2}}
  ],
  "shape_summary": {{
    "bbox_x_mm": 100.5,
    "bbox_y_mm": 80.2,
    "bbox_z_mm": 20.0
  }}
}}

Feature types: through_hole, blind_hole, threaded_hole, pocket, slot, chamfer, fillet, face, boss, step, groove"""

    # ── Call LLM ──────────────────────────────────────────────────────────────
    try:
        raw, thinking = await _call_text_llm(system_prompt, user_prompt)
        parsed = parse_model_json(raw)

        features_3d   = parsed.get("features_3d")   or []
        shape_summary = parsed.get("shape_summary") or {}

        if not isinstance(features_3d, list):
            features_3d = []

        logger.info(
            "analyze_step3d: %d features, bbox=%s, thinking_len=%d",
            len(features_3d), shape_summary, len(thinking),
        )
        return {"features_3d": features_3d, "shape_summary": shape_summary, "thinking": thinking}

    except Exception as exc:
        logger.error("analyze_step3d: LLM call failed: %s", exc)
        return {"features_3d": [], "shape_summary": {}, "thinking": "", "error": str(exc)}


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
- tolerance_class: "precision" (≤0.001), "close" (≤0.005), "medium" (≤0.010), "general" (>0.010)
- Prefer material from 2D drawing; fallback to "AL6061-T6"

Output ONLY this JSON:
{{
  "features": [
    {{
      "id": "F001",
      "type": "threaded_hole",
      "description": "3x M8×1.25 tapped through holes",
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
- through_hole/blind_hole: center_drill → drill
- threaded_hole: center_drill → drill → tap
- pocket/slot: rough_mill → finish_mill
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
    {{"id":"OP003","feature_id":"F001","operation":"tap","tool":"M8×1.25 Tap","quantity":3,"note":""}}
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
- Al6061: spindle 8000–12000 RPM, feed 2000–3000 mm/min for end mills; 3000–5000 RPM + 500 mm/min for drills
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
    {{"operation_id":"OP003","minutes":0.45,"note":"Tap M8×1.25 3x at 300 RPM"}}
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
        "total_usd":           total_usd,
        "currency":            "USD",
        "shop_rate_per_hour":  shop_rate,
        "material_cost":       material_cost,
        "machining_cost":      round(machining_cost, 2),
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
