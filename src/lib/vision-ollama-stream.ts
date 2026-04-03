/**
 * Ollama /api/chat vision call — collect streamed response to a string.
 * Local Ollama only (no cloud API, no API key).
 */

// null = no timeout. Set VISION_TIMEOUT_MS=0 in env to disable.
const VISION_TIMEOUT_MS: number | null = (() => {
  const raw = parseInt(process.env.VISION_TIMEOUT_MS || "300000", 10);
  if (raw === 0) return null;                                    // 0 → unlimited
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
})();

function buildCandidateBaseUrls(rawBaseUrl: string): string[] {
  const cleaned = rawBaseUrl.replace(/\/+$/, "");
  const candidates = [cleaned];

  try {
    const parsed = new URL(cleaned);
    if (parsed.hostname === "localhost") {
      const loopback = new URL(parsed.toString());
      loopback.hostname = "127.0.0.1";
      candidates.push(loopback.toString().replace(/\/+$/, ""));
    }
  } catch {
    // Keep only original value if URL parsing fails.
  }

  return Array.from(new Set(candidates));
}

/**
 * Walk forward through `s` starting at index 0 (must be '{') to find the
 * position of the matching closing '}', respecting nested braces and strings.
 * Returns -1 if no balanced close is found.
 */
function findMatchingBrace(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc)            { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true;  continue; }
    if (c === '"')      { inStr = !inStr; continue; }
    if (inStr)          continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Extract the last complete JSON object from a thinking block.
 *
 * qwen3-vl:4b embeds its final answer inside <think> tokens. We search backwards
 * for the last occurrence of "dimensions" (always present in our extraction schema),
 * locate the opening brace, find the matching closing brace, and parse only that slice.
 * Falls back to scanning all '{' positions from the end.
 */
function extractJsonFromThinking(thinking: string): string {
  // Scan backwards for "dimensions" — the model's JSON answer always contains this key.
  let searchFrom = thinking.length;
  while (searchFrom > 0) {
    const dimsIdx = thinking.lastIndexOf('"dimensions"', searchFrom - 1);
    if (dimsIdx === -1) break;

    const braceIdx = thinking.lastIndexOf("{", dimsIdx);
    if (braceIdx === -1) { searchFrom = dimsIdx; continue; }

    const fromBrace = thinking.slice(braceIdx);
    const closeIdx  = findMatchingBrace(fromBrace);
    if (closeIdx === -1) { searchFrom = dimsIdx; continue; }

    const jsonStr = fromBrace.slice(0, closeIdx + 1);
    try {
      JSON.parse(jsonStr);
      console.log(`[vision-ollama] extracted JSON from thinking (${jsonStr.length} chars)`);
      return jsonStr;
    } catch {
      searchFrom = dimsIdx;
    }
  }

  // Last-resort: scan all '{' positions from the end, return the last parseable JSON.
  for (let pos = thinking.length - 1; pos >= 0; pos--) {
    if (thinking[pos] !== "{") continue;
    const fromBrace = thinking.slice(pos);
    const closeIdx  = findMatchingBrace(fromBrace);
    if (closeIdx === -1) continue;
    const jsonStr = fromBrace.slice(0, closeIdx + 1);
    try { JSON.parse(jsonStr); return jsonStr; } catch { /* keep looking */ }
  }

  return thinking; // nothing found — pass raw content to parser (will be unparseable)
}

export async function collectOllamaVisionChat(
  imageBase64: string,
  systemPrompt: string,
  userPrompt: string,
  overrides?: { url?: string; model?: string; onThinking?: (chunk: string) => void },
): Promise<{ content: string }> {
  const visionUrl   = (overrides?.url   || process.env.LOCAL_OLLAMA_URL || "http://localhost:11434").trim();
  // Explicit override → env var → default.
  // qwen3-vl:4b (3.3 GiB) fits 69% in the T1200's 4 GB VRAM — faster than 8b (44% GPU).
  const visionModel = (overrides?.model || process.env.VISION_MODEL || "qwen3-vl:4b").trim();
  const t0 = Date.now();

  console.log(
    `[vision-ollama] start model=${visionModel} url=${visionUrl} image_b64_len=${imageBase64.length} timeout_ms=${VISION_TIMEOUT_MS ?? "unlimited"}`,
  );

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const payload = {
    model: visionModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt, images: [imageBase64] },
    ],
    think:   false,   // Disable Qwen3 thinking mode at API level
    stream:  true,
    options: {
      temperature: 0.1,
      // Images are capped at 2000px longest side → ~15 tiles → ~3840 visual tokens.
      // 32768 context: 4640 prompt tokens + ~12000 thinking tokens + ~500 JSON answer = ~17140 total.
      // At 16384 the model hits context limit mid-thinking and never writes the JSON answer.
      // A4500 20 GB VRAM: 8B model ~7.5 GB weights + ~4 GB KV cache at 32768 = ~11.5 GB — fits.
      num_ctx: 32768,
      // Hard cap on new tokens to prevent infinite thinking loops (qwen3-vl thinking mode can
      // loop forever with sliding-window context). 8000 tokens ≈ 2 min on A4500 — enough for
      // full extraction + JSON on a complex drawing page, with room for deep analysis.
      num_predict: 8000,
    },
  };

  const candidateBaseUrls = buildCandidateBaseUrls(visionUrl);
  let response: Response | undefined;
  let lastNetworkError: Error | undefined;
  let usedFallbackBaseUrl = false;

  // Single AbortController scoped to the whole request (connect + stream).
  // Keeping it alive through the stream means abort() also kills the server-side
  // generation on RunPod — without this, Ollama keeps generating after client timeout
  // and returns 404 on the next request because it's still busy.
  let activeAbortController: AbortController | undefined;

  for (const baseUrl of candidateBaseUrls) {
    const abortController = new AbortController();
    activeAbortController = abortController;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body:   JSON.stringify(payload),
        signal: abortController.signal,
      });
      usedFallbackBaseUrl = baseUrl !== visionUrl;
      break;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(
          `Vision model timed out (${VISION_TIMEOUT_MS !== null ? Math.round(VISION_TIMEOUT_MS / 1000) : "∞"}s). The model may be overloaded. Please try again.`,
        );
      }
      lastNetworkError = err as Error;
    }
  }

  if (!response) {
    const fallbackInfo = candidateBaseUrls.length > 1
      ? ` (also tried ${candidateBaseUrls.slice(1).join(", ")})`
      : "";
    throw new Error(`Cannot reach vision model at ${visionUrl}${fallbackInfo}: ${lastNetworkError?.message || "fetch failed"}`);
  }
  if (usedFallbackBaseUrl) {
    console.warn("[vision-ollama] Connected via localhost fallback (127.0.0.1)");
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.warn(
      `[vision-ollama] http_error status=${response.status} elapsed_ms=${Date.now() - t0}`,
    );
    throw new Error(`Vision model error (${response.status}): ${errText.slice(0, 200)}`);
  }

  if (!response.body) {
    throw new Error("No response body from vision model");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let thinkContent = "";   // accumulate thinking tokens as fallback
  let streamError: Error | null = null;
  let streamTimedOut = false;
  let streamInactive = false;

  // null timeout = no total limit (model runs until completion, however long that takes).
  const streamTimeout = VISION_TIMEOUT_MS !== null
    ? setTimeout(() => {
        streamTimedOut = true;
        // Only cancel the reader (stop consuming bytes), do NOT abort the underlying
        // HTTP connection. Aborting with TCP RST leaves Ollama mid-generation and the
        // RunPod proxy returns 404 on the next request. Letting the connection drain
        // naturally means Ollama finishes cleanly and accepts the next page immediately.
        void reader.cancel();
      }, VISION_TIMEOUT_MS)
    : null;

  // Inactivity watchdog: if the proxy silently drops the connection (no RST, no close),
  // reader.read() blocks forever. Reset this timer on every received token.
  // 90s with no tokens = treat as dead connection and move on.
  const INACTIVITY_MS = 90_000;
  let inactivityTimer = setTimeout(() => {
    streamInactive = true;
    void reader.cancel();
  }, INACTIVITY_MS);
  const resetInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      streamInactive = true;
      void reader.cancel();
    }, INACTIVITY_MS);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      resetInactivity();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const jsonStr = line.startsWith("data: ") ? line.slice(6) : line;
        if (jsonStr === "[DONE]") break;
        try {
          const chunk = JSON.parse(jsonStr);
          const msg = chunk.message || {};
          // msg.content = actual response; msg.thinking = Qwen3 think-mode tokens
          if (msg.content)  fullContent  += msg.content;
          if (msg.thinking) {
            thinkContent += msg.thinking;
            overrides?.onThinking?.(msg.thinking);  // stream thinking to caller in real time
          }
          if (chunk.done) break;
        } catch {
          /* skip malformed lines */
        }
      }

      if (fullContent.length > 100_000) {
        console.warn("[vision-ollama] Output exceeded 100k chars, stopping");
        break;
      }

      // qwen3-vl thinking mode can loop indefinitely (Ollama uses sliding-window context).
      // If thinking exceeds ~50k chars the model is stuck in a verification loop.
      // Break now so extractJsonFromThinking can recover the answer from the first pass.
      // 50k fires at ~270s on A4500, safely before Vercel's 300s function timeout.
      if (thinkContent.length > 50_000) {
        console.warn(`[vision-ollama] Thinking exceeded 50k chars (${thinkContent.length}) — breaking out of thinking loop`);
        break;
      }
    }
  } catch (streamErr) {
    const name = (streamErr as Error)?.name || "StreamError";
    const msg = (streamErr as Error)?.message || String(streamErr);
    streamError = new Error(`${name}: ${msg}`);
    console.warn(`[vision-ollama] Stream read error: ${name}: ${msg}`);
  } finally {
    if (streamTimeout !== null) clearTimeout(streamTimeout);
    clearTimeout(inactivityTimer);
  }

  if (streamTimedOut) {
    throw new Error(
      `Vision model timed out (${VISION_TIMEOUT_MS !== null ? Math.round(VISION_TIMEOUT_MS / 1000) : "∞"}s) while reading stream.`,
    );
  }

  if (streamInactive) {
    console.warn(`[vision-ollama] Inactivity timeout (${INACTIVITY_MS / 1000}s) — proxy dropped connection. Attempting JSON extraction from partial content.`);
    // Don't throw — attempt to extract whatever we have from thinking block.
  }

  if (streamError) {
    throw new Error(`Vision model stream failed: ${streamError.message}`);
  }

  // qwen3-vl:4b ignores think:false — its entire answer lives inside the thinking block.
  // Extract by searching backwards for the last {"dimensions" pattern (always present in our schema).
  if (fullContent.length === 0 && thinkContent.length > 0) {
    console.warn(`[vision-ollama] content_len=0 but thinking_len=${thinkContent.length} — extracting JSON from thinking block`);
    fullContent = extractJsonFromThinking(thinkContent);
  }

  console.log(
    `[vision-ollama] done elapsed_ms=${Date.now() - t0} content_len=${fullContent.length} thinking_len=${thinkContent.length}`,
  );
  return { content: fullContent };
}
