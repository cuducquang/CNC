"""
VLM streaming for Qwen3-VL-32B-Thinking-FP8 via vLLM OpenAI-compat API.
Port of src/lib/vision-ollama-stream.ts + src/lib/vision-drawing-shared.ts.

Key behaviours:
  - Streams SSE from POST /v1/chat/completions
  - Separates thinking (reasoning_content or pre-</think> content) from the answer
  - 30 s inactivity watchdog — cancels the stream if no tokens arrive
  - extractJsonFromThinking: scans thinking for the best JSON object
  - Second-pass text-only call when first pass yields only thinking
  - No per-call timeout — pipeline has no Vercel limit to work around
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Awaitable, Callable, Optional

import httpx

logger = logging.getLogger("cncapp.vlm_stream")

INACTIVITY_S = 30.0  # cancel stream if silent for this long


# ---------------------------------------------------------------------------
# Shared prompts (vision-drawing-shared.ts)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a metrology specialist reading a 2D engineering drawing. "
    "Extract dimensions, tolerances, GD&T callouts, and thread specifications. "
    "Spend at most 2 sentences on any ambiguity, then decide and move on. "
    "Output ONLY the JSON result — nothing else."
)

EXTRACTION_PROMPT = """Extract all visible dimensions, GD&T callouts, threads, and material from this 2D engineering drawing page.

NON-DRAWING PAGES — return immediately without further analysis:
- Cover page / logo / blank / title block only → {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}
- Photo or artwork (not a drawing) → {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["not_a_drawing"]}

DRAWING PAGES — output this JSON schema:
{
  "dimensions": [{"id":"D001","label":"Overall length","nominal":12.5,"unit":"in","tolerance_plus":0.02,"tolerance_minus":0.02,"quantity":1}],
  "gdt": [{"id":"G001","symbol":"position","tolerance":0.05,"unit":"in","datums":["A"]}],
  "threads": [{"id":"T001","spec":".190-32 UNF-2B","depth_mm":15.0,"quantity":2}],
  "material": "AL6061-T6 or null",
  "surface_finish": "Ra 1.6 or null",
  "notes": []
}

RULES (read carefully — each decision: 1–2 sentences maximum, then move on):
1. Extract ONLY explicitly labeled values — never infer or guess dimensions not shown.
2. UNCERTAIN SYMBOL OR CALLOUT → output nothing for it, move to the next item immediately.
2b. UNIT — decide in ONE pass, do not revisit:
    • Title block or notes say INCHES / DECIMAL INCH / ASME Y14.5, or drawing uses UNF/UNC/NPT threads → unit = "in"
    • Title block or notes say MM / METRIC, or dimensions use comma separators → unit = "mm"
    • Truly ambiguous (no clues at all) → unit = null
    Apply the same unit to every dimension on the page. Never debate this again.
3. Omit tolerance_plus/tolerance_minus entirely if no tolerance callout is shown for that dimension.
4. Bilateral ±X → tolerance_plus=X, tolerance_minus=X. Unilateral +A/−B → tolerance_plus=A, tolerance_minus=B.
5. R prefix = RADIUS always (R2.34, 4X R4.50). Never a thread. Threads have pitch notation: M8x1.25, .190-32 UNF-2B, 1/4-20 UNC, TAP, THRU.
6. A dot/circle at a leader line end = arrowhead, not a GD&T diameter symbol.
7. Parenthesized values () = reference only — include as a dimension entry, omit tolerance fields.
8. BOM table (ITEM/QTY/PART NO./DESCRIPTION) = parts list. Ignore ALL cells.
9. Assembly view with BOM and no dimension lines → empty dimensions array.
10. Same nominal in N locations = ONE entry with quantity=N.
11. Thread depth_mm always in mm (inches × 25.4). Omit depth_mm if not shown.
12. notes must be [] for drawing pages.
13. BIAS TOWARD INCLUSION: when uncertain whether to include a dimension, include it. A dimension with unit=null is better than a missing dimension.
14. Response MUST be ONLY the JSON object. No text before or after."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_image_mime_type(b64: str) -> str:
    if b64.startswith("/9j/"):
        return "image/jpeg"
    if b64.startswith("iVBOR"):
        return "image/png"
    return "image/png"


def _find_matching_brace(s: str) -> int:
    """Walk forward from index 0 (must be '{') and return index of matching '}'."""
    depth = 0
    in_str = False
    esc = False
    for i, c in enumerate(s):
        if esc:
            esc = False
            continue
        if c == "\\" and in_str:
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c in ("{", "["):
            depth += 1
        elif c in ("}", "]"):
            depth -= 1
            if depth == 0:
                return i
    return -1


def _strip_think_tags(text: str) -> str:
    """Strip <think>...</think> wrapper. Returns answer portion, or '' if only thinking."""
    trimmed = text.strip()
    idx = trimmed.find("</think>")
    if trimmed.startswith("<think>") and idx != -1:
        return trimmed[idx + 8:].strip()
    if trimmed.startswith("<think>"):
        return ""
    return trimmed


def extract_json_from_thinking(thinking: str) -> str:
    """
    Scan thinking text for the best JSON object containing a 'dimensions' key.
    Picks candidate with most extracted features.
    """
    candidates: list[dict] = []
    search_from = len(thinking)

    while search_from > 0:
        dims_idx = thinking.rfind('"dimensions"', 0, search_from)
        if dims_idx == -1:
            break
        brace_idx = thinking.rfind("{", 0, dims_idx)
        if brace_idx == -1:
            search_from = dims_idx
            continue
        from_brace = thinking[brace_idx:]
        close_idx  = _find_matching_brace(from_brace)
        if close_idx == -1:
            search_from = dims_idx
            continue
        json_str = from_brace[: close_idx + 1]
        try:
            parsed = json.loads(json_str)
            score = (
                len(parsed.get("dimensions") or [])
                + len(parsed.get("threads")   or [])
                + len(parsed.get("gdt")       or [])
            )
            candidates.append({"json": json_str, "score": score})
        except (json.JSONDecodeError, ValueError):
            pass
        search_from = dims_idx

    if candidates:
        candidates.sort(key=lambda x: x["score"], reverse=True)
        best = candidates[0]
        logger.info(
            "JSON from thinking: %d chars score=%d candidates=%d",
            len(best["json"]), best["score"], len(candidates),
        )
        return best["json"]

    # Last resort: any parseable JSON object
    for pos in range(len(thinking) - 1, -1, -1):
        if thinking[pos] != "{":
            continue
        from_brace = thinking[pos:]
        close_idx  = _find_matching_brace(from_brace)
        if close_idx == -1:
            continue
        json_str = from_brace[: close_idx + 1]
        try:
            json.loads(json_str)
            return json_str
        except (json.JSONDecodeError, ValueError):
            continue

    # Non-technical page detection
    lower = thinking.lower()
    if (
        "non_technical_page" in lower
        or "not a drawing" in lower
        or "not an engineering drawing" in lower
        or ("no dimension" in lower and "title" in lower)
        or "no visible dimension" in lower
    ):
        logger.info("thinking concluded non-technical — synthesizing canonical JSON")
        return '{"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}'

    return thinking  # nothing found — return raw (unparseable)


def parse_model_json(raw_text: str) -> dict:
    """Parse model output that may be JSON, fenced JSON, or JSON with prefix text."""
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.split("\n")[1:])
    if cleaned.endswith("```"):
        cleaned = cleaned[: cleaned.rfind("```")]
    cleaned = cleaned.strip().rstrip("`").strip()
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        pass
    brace_idx = cleaned.find("{")
    if brace_idx != -1:
        try:
            return json.loads(cleaned[brace_idx:])
        except (json.JSONDecodeError, ValueError):
            pass
        from_brace = cleaned[brace_idx:]
        close_idx  = _find_matching_brace(from_brace)
        if close_idx != -1:
            try:
                return json.loads(from_brace[: close_idx + 1])
            except (json.JSONDecodeError, ValueError):
                pass

    # Final fallback: domain-aware key search.
    # The model often wraps the JSON in prose; find the outermost object that
    # contains one of the expected top-level keys.
    _EXPECTED_KEYS = (
        '"features_3d"', '"features"', '"operations"',
        '"dimensions"', '"total_minutes"', '"shape_summary"',
    )
    for key in _EXPECTED_KEYS:
        idx = cleaned.rfind(key)
        if idx == -1:
            continue
        # Walk back to the { that opens the object containing this key
        brace_pos = cleaned.rfind("{", 0, idx)
        if brace_pos == -1:
            continue
        from_brace = cleaned[brace_pos:]
        close_idx  = _find_matching_brace(from_brace)
        if close_idx == -1:
            continue
        try:
            result = json.loads(from_brace[: close_idx + 1])
            if isinstance(result, dict):
                return result
        except (json.JSONDecodeError, ValueError):
            continue

    return {"raw_model_output": raw_text, "dimensions": [], "gdt": [], "threads": []}


def classify_page_parsed(parsed: dict) -> str:
    """Classify a VLM response as 'ok' | 'hard_reject' | 'soft_skip' | 'unparseable'."""
    if parsed.get("raw_model_output"):
        return "unparseable"
    dims    = parsed.get("dimensions") or []
    threads = parsed.get("threads")    or []
    if dims or threads:
        return "ok"
    notes = parsed.get("notes") or []
    note_str = " ".join(str(n).lower() for n in notes)
    if "not_a_drawing" in note_str:
        return "hard_reject"
    if "non_technical" in note_str or "not_a_drawing" in note_str:
        return "soft_skip"
    return "soft_skip"


def merge_vision_results(parsed_list: list[dict]) -> dict:
    """Merge per-page VLM JSON objects into one result (renumbered IDs)."""
    all_dims:    list = []
    all_gdt:     list = []
    all_threads: list = []
    material:    object = None
    surface_finish: object = None
    all_notes:   list[str] = []
    d_count = g_count = t_count = 1

    for parsed in parsed_list:
        if parsed.get("raw_model_output"):
            continue
        dims_raw    = parsed.get("dimensions")
        gdt_raw     = parsed.get("gdt")
        threads_raw = parsed.get("threads")
        for d in (dims_raw if isinstance(dims_raw, list) else []):
            if not isinstance(d, dict):
                continue
            rest = {k: v for k, v in d.items() if k != "id"}
            all_dims.append({**rest, "id": f"D{str(d_count).zfill(3)}"})
            d_count += 1
        for g in (gdt_raw if isinstance(gdt_raw, list) else []):
            if not isinstance(g, dict):
                continue
            rest = {k: v for k, v in g.items() if k != "id"}
            all_gdt.append({**rest, "id": f"G{str(g_count).zfill(3)}"})
            g_count += 1
        for t in (threads_raw if isinstance(threads_raw, list) else []):
            if not isinstance(t, dict):
                continue
            rest = {k: v for k, v in t.items() if k != "id"}
            all_threads.append({**rest, "id": f"T{str(t_count).zfill(3)}"})
            t_count += 1
        if not material and parsed.get("material"):
            material = parsed["material"]
        if not surface_finish and parsed.get("surface_finish"):
            surface_finish = parsed["surface_finish"]
        for note in (parsed.get("notes") or []):
            if isinstance(note, str) and note.strip():
                all_notes.append(note)

    return {
        "dimensions":     all_dims,
        "gdt":            all_gdt,
        "threads":        all_threads,
        "material":       material,
        "surface_finish": surface_finish,
        "notes":          all_notes,
    }


# ---------------------------------------------------------------------------
# Second-pass: text-only call with thinking content
# ---------------------------------------------------------------------------

async def _collect_json_from_thinking(think_content: str, base_url: str, model: str) -> str:
    """Second-pass text-only call when first pass produced only thinking."""
    last_think = think_content.rfind("<think>")
    fresh_start = think_content[last_think + 7:] if last_think != -1 else think_content
    context = fresh_start[:8000]

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a JSON formatter. Output ONLY the valid JSON object. No explanation, no markdown."},
            {"role": "user", "content": (
                f"Engineering drawing analysis:\n\n{context}\n\n"
                "Convert to JSON schema:\n"
                '{"dimensions":[{"id":"D001","label":"short description","nominal":0,"unit":"mm or in","tolerance_plus":null,"tolerance_minus":null,"quantity":1}],"gdt":[],"threads":[{"id":"T001","spec":"e.g. M8x1.25","depth_mm":null,"quantity":1}],"material":null,"surface_finish":null,"notes":[]}\n\n'
                'If no dimensions found: {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}'
            )},
        ],
        "stream": True,
        "temperature": 0,
        "max_tokens": 8192,
    }

    url = f"{base_url.rstrip('/')}/v1/chat/completions"
    out = ""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, json=payload) as resp:
                if resp.status_code != 200:
                    return ""
                buf = ""
                async for chunk in resp.aiter_bytes():
                    buf += chunk.decode("utf-8", errors="replace")
                    lines = buf.split("\n")
                    buf = lines.pop()
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        raw = line[6:] if line.startswith("data: ") else line
                        if raw == "[DONE]":
                            break
                        try:
                            data = json.loads(raw)
                            delta = (data.get("choices") or [{}])[0].get("delta") or {}
                            if delta.get("content"):
                                out += delta["content"]
                            if (data.get("choices") or [{}])[0].get("finish_reason"):
                                break
                        except (json.JSONDecodeError, IndexError):
                            pass
                        if len(out) > 10_000:
                            break
    except Exception as e:
        logger.warning("Second-pass failed: %s", e)
        return ""

    trimmed = out.strip()
    after   = _strip_think_tags(trimmed)
    return after if after else trimmed


# ---------------------------------------------------------------------------
# Main VLM call
# ---------------------------------------------------------------------------

async def collect_ollama_vision_chat(
    image_base64: str | list[str],
    system_prompt: str,
    user_prompt: str,
    url: Optional[str] = None,
    model: Optional[str] = None,
    on_thinking: Optional[Callable[[str], Awaitable[None]]] = None,
) -> dict:
    """
    Call vLLM /v1/chat/completions with vision content and stream the response.

    Returns: {"content": str}
    Raises on network errors or inactivity timeout.
    """
    base_url    = (url   or os.environ.get("VISION_MODEL_URL") or os.environ.get("LOCAL_OLLAMA_URL") or "http://localhost:11434").rstrip("/")
    vision_model = (model or os.environ.get("VISION_MODEL_NAME") or os.environ.get("VISION_MODEL") or "/workspace/models/Qwen3-VL-32B-Thinking-FP8")

    images = image_base64 if isinstance(image_base64, list) else [image_base64]
    t0     = time.time()

    logger.info(
        "vlm_stream start model=%s url=%s images=%d total_b64=%d",
        vision_model, base_url, len(images), sum(len(b) for b in images),
    )

    payload = {
        "model": vision_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    *[
                        {"type": "image_url", "image_url": {"url": f"data:{_get_image_mime_type(b)};base64,{b}"}}
                        for b in images
                    ],
                    {"type": "text", "text": user_prompt},
                ],
            },
        ],
        "stream": True,
        "temperature": 1.5,
        "repetition_penalty": 1.12,
        "max_tokens": 8192,
        "chat_template_kwargs": {"enable_thinking": True, "thinking_budget_tokens": 3000},
        "skip_special_tokens": False,
    }

    endpoint = f"{base_url}/v1/chat/completions"

    full_content  = ""
    think_content = ""
    stream_timed_out  = False
    stream_inactive   = False
    content_in_think  = True  # treat content as thinking until </think> seen

    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", endpoint, json=payload, timeout=None) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise RuntimeError(f"VLM returned HTTP {resp.status_code}: {body[:200].decode(errors='replace')}")

                buf = ""
                aiter = resp.aiter_bytes().__aiter__()

                while True:
                    # Inactivity watchdog: 30 s per chunk
                    try:
                        raw_bytes = await asyncio.wait_for(aiter.__anext__(), timeout=INACTIVITY_S)
                    except asyncio.TimeoutError:
                        stream_inactive = True
                        logger.warning("VLM inactivity timeout after %gs", INACTIVITY_S)
                        break
                    except StopAsyncIteration:
                        break

                    buf += raw_bytes.decode("utf-8", errors="replace")
                    lines = buf.split("\n")
                    buf = lines.pop()

                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        raw = line[6:] if line.startswith("data: ") else line
                        if raw == "[DONE]":
                            break
                        try:
                            chunk = json.loads(raw)
                            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}

                            if delta.get("reasoning_content"):
                                think_content  += delta["reasoning_content"]
                                content_in_think = False
                                if on_thinking:
                                    await on_thinking(delta["reasoning_content"])

                            if delta.get("content"):
                                full_content += delta["content"]
                                if content_in_think and not think_content:
                                    if "</think>" in delta["content"]:
                                        idx = delta["content"].index("</think>")
                                        chunk_think = delta["content"][:idx]
                                        if chunk_think and on_thinking:
                                            await on_thinking(chunk_think)
                                        content_in_think = False
                                    elif on_thinking:
                                        await on_thinking(delta["content"])

                            if (chunk.get("choices") or [{}])[0].get("finish_reason"):
                                break
                        except (json.JSONDecodeError, IndexError, KeyError):
                            pass

                    # Safety caps
                    if len(full_content) > 200_000:
                        logger.warning("Output exceeded 200k chars, stopping")
                        break
                    if len(think_content) > 80_000:
                        logger.warning("Thinking exceeded 80k chars, breaking early")
                        break

    except Exception as e:
        raise RuntimeError(f"VLM stream error: {e}") from e

    if stream_inactive and not full_content and not think_content:
        raise RuntimeError(
            f"Vision model stopped responding (no tokens for {INACTIVITY_S}s). "
            "Check the vLLM server on the RunPod pod."
        )

    # ── Resolve thinking vs answer boundary ────────────────────────────────

    # Qwen3-VL format: <think> is in the prompt prefix, so full_content starts with thinking
    # and transitions to the answer after </think>.
    if full_content and not think_content and "</think>" in full_content and "<think>" not in full_content:
        close_idx   = full_content.index("</think>")
        after_think = full_content[close_idx + 8:].strip()
        thinking    = full_content[:close_idx].strip()
        if after_think:
            think_content = thinking
            full_content  = after_think
        else:
            think_content = thinking
            full_content  = ""
        logger.info("Qwen3-VL think boundary: thinking=%d answer=%d", len(think_content), len(full_content))

    # Fallback: full <think>...</think> block in content
    if full_content and not think_content and "<think>" in full_content:
        after = _strip_think_tags(full_content)
        if after:
            full_content = after
        else:
            think_content = full_content.lstrip("<think>").split("</think>")[0]
            full_content  = ""

    # If stream timed out or went inactive, try to extract JSON from what we got
    if stream_inactive or stream_timed_out:
        partial = think_content or full_content
        if partial:
            logger.warning("Stream ended early — extracting JSON from partial content (%d chars)", len(partial))
            full_content  = extract_json_from_thinking(partial)
            think_content = ""

    # Content empty but thinking has data — extract JSON
    if not full_content and think_content:
        logger.warning("content=0 thinking=%d — extracting JSON from thinking", len(think_content))
        full_content = extract_json_from_thinking(think_content)

    # Two-pass fallback: still no JSON in content
    if full_content == think_content and think_content:
        logger.warning("No JSON in thinking — attempting text-only second pass")
        try:
            json_extract = await _collect_json_from_thinking(think_content, base_url, vision_model)
            if json_extract:
                logger.info("Second pass produced %d chars", len(json_extract))
                full_content = json_extract
        except Exception as e2:
            logger.warning("Second pass failed: %s", e2)

    elapsed = time.time() - t0
    logger.info(
        "vlm_stream done elapsed=%.1fs content=%d thinking=%d",
        elapsed, len(full_content), len(think_content),
    )
    return {"content": full_content}
