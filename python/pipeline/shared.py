"""
Shared helpers for both CNC pipeline approaches.

Provides:
  - _base_url / _model_name     — LLM connection config (from env vars)
  - _call_text_llm              — non-streaming text LLM call (Qwen3 3-case thinking)
  - _scan_json_in_text          — scan text backwards for last parseable JSON object
  - _download                   — async HTTP download helper
"""
from __future__ import annotations

import json
import logging
import os

import httpx

from vlm_stream import _find_matching_brace, parse_model_json

logger = logging.getLogger("cncapp.pipeline.shared")


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
# JSON scanner (scan text backwards for the last parseable JSON object)
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


# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


# ---------------------------------------------------------------------------
# Text LLM helper — non-streaming POST to /v1/chat/completions
# ---------------------------------------------------------------------------

async def _call_text_llm(
    system: str,
    user: str,
    temperature: float = 0.2,
    max_tokens: int = 6144,
    thinking_budget: int = 1024,
) -> tuple[str, str]:
    """
    Call Qwen3 endpoint (no image) and return (answer_content, thinking_content).

    Uses streaming mode to avoid Cloudflare/RunPod 524 proxy timeouts — the first
    token arrives quickly and keeps the connection alive for the full generation.

    Handles all three thinking-boundary formats produced by Qwen3 + vLLM:

      A. reasoning_content field in stream delta (vLLM >= 0.7)
      B. Full inline block  <think>...</think>{answer}
      C. Qwen3-VL template — content starts with thinking text, ends at </think>
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
        "stream":          True,
        "temperature":     temperature,
        "max_tokens":      max_tokens,
        # Force JSON output via vLLM guided decoding — prevents the model from
        # generating narrative prose instead of the requested JSON structure.
        "response_format": {"type": "json_object"},
        "chat_template_kwargs": {
            "enable_thinking":        True,
            "thinking_budget_tokens": thinking_budget,
        },
    }

    import asyncio as _asyncio

    _TRANSIENT_ERRORS = (
        httpx.RemoteProtocolError,
        httpx.ReadError,
        httpx.ConnectError,
        ConnectionResetError,
    )
    MAX_RETRIES = 2

    for attempt in range(MAX_RETRIES + 1):
        try:
            raw_content = ""
            thinking    = ""

            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=10.0)) as client:
                async with client.stream("POST", endpoint, json=payload) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        chunk = line[6:].strip()
                        if chunk == "[DONE]":
                            break
                        try:
                            data  = json.loads(chunk)
                            delta = ((data.get("choices") or [{}])[0]).get("delta", {})
                            # Case A: vLLM >= 0.7 sends reasoning_content in delta
                            rc = delta.get("reasoning_content")
                            if rc:
                                thinking += rc
                            ct = delta.get("content")
                            if ct:
                                raw_content += ct
                        except (json.JSONDecodeError, KeyError):
                            continue

            raw_content = raw_content.strip()
            thinking    = thinking.strip()

            # Case B / C: thinking embedded inline with </think> boundary
            if not thinking and "</think>" in raw_content:
                if raw_content.startswith("<think>"):
                    close       = raw_content.index("</think>")
                    thinking    = raw_content[7:close].strip()
                    raw_content = raw_content[close + 8:].strip()
                else:
                    close       = raw_content.index("</think>")
                    thinking    = raw_content[:close].strip()
                    raw_content = raw_content[close + 8:].strip()

            # Fallback: model spent all tokens thinking, answer empty
            if not raw_content and thinking:
                logger.warning("_call_text_llm: answer empty — scanning thinking for JSON")
                raw_content = _scan_json_in_text(thinking)

            logger.info(
                "_call_text_llm: answer_len=%d thinking_len=%d",
                len(raw_content), len(thinking),
            )
            return raw_content, thinking

        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"LLM HTTP {exc.response.status_code}: {exc.response.text[:300]}"
            ) from exc
        except _TRANSIENT_ERRORS as exc:
            if attempt < MAX_RETRIES:
                wait = 2 ** attempt
                logger.warning(
                    "_call_text_llm: attempt %d/%d transient error (%s) — retrying in %ds",
                    attempt + 1, MAX_RETRIES + 1, exc, wait,
                )
                await _asyncio.sleep(wait)
                continue
            raise RuntimeError(
                f"LLM call failed after {MAX_RETRIES + 1} attempts: {exc}"
            ) from exc
        except Exception as exc:
            raise RuntimeError(f"LLM call failed: {exc}") from exc
