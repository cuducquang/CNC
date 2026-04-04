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
  // Collect ALL valid JSON objects with a "dimensions" key, pick the one with
  // the most features (dimensions + threads + gdt count). This prevents the model's
  // self-doubt from overwriting a real extraction: if the model first writes a good JSON
  // then second-guesses to {"dimensions": [], "notes": ["non_technical_page"]}, we keep
  // the good one (higher score) rather than the last one (backwards-scan artifact).
  const candidates: { json: string; score: number }[] = [];

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
      const parsed = JSON.parse(jsonStr);
      const dims    = Array.isArray(parsed.dimensions) ? parsed.dimensions.length : 0;
      const threads = Array.isArray(parsed.threads)    ? parsed.threads.length    : 0;
      const gdt     = Array.isArray(parsed.gdt)        ? parsed.gdt.length        : 0;
      candidates.push({ json: jsonStr, score: dims + threads + gdt });
    } catch { /* skip malformed */ }
    searchFrom = dimsIdx; // continue scanning backwards
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    console.log(`[vision-ollama] extracted JSON from thinking (${best.json.length} chars, score=${best.score}, ${candidates.length} candidate(s))`);
    return best.json;
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

  // No JSON found anywhere. Check whether the thinking concluded non-technical/no-dimensions.
  // qwen3-vl 8B sometimes reasons in English about why a page has no drawing content and then
  // stops without writing the canonical JSON. Detect these conclusions and synthesize the JSON
  // so the page is classified as soft_skip rather than unparseable.
  const lower = thinking.toLowerCase();
  const isNonTechnical =
    lower.includes("non_technical_page") ||
    lower.includes("non-technical") ||
    lower.includes("not a drawing") ||
    lower.includes("not an engineering drawing") ||
    (lower.includes("no dimension") && lower.includes("title")) ||
    (lower.includes("no visible dimension") || lower.includes("no dimension line"));
  if (isNonTechnical) {
    console.log("[vision-ollama] thinking concluded non-technical — synthesizing canonical JSON");
    return '{"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}';
  }

  return thinking; // nothing found — pass raw content to parser (will be unparseable)
}

/**
 * Text-only second pass: send the thinking content as context and ask the model
 * to output the JSON extraction. Used when the first vision call produced thinking
 * but no JSON content. This call is fast (no image) and uses temperature=0.
 */
async function collectJsonFromThinking(
  thinkContent: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  // Truncate thinking to last 6000 chars — the conclusion is most relevant.
  const context = thinkContent.length > 6000 ? thinkContent.slice(-6000) : thinkContent;

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content: "You are a JSON formatter. Given an engineer's analysis of a 2D drawing, output ONLY the valid JSON object. No explanation, no markdown.",
      },
      {
        role: "user",
        content: `Engineering drawing analysis:\n\n${context}\n\nConvert to JSON using this schema (dimensions in original drawing units, depth_mm in mm):\n{"dimensions":[{"id":"D001","label":"short description","nominal":0,"unit":"in or mm","tolerance_plus":null,"tolerance_minus":null,"quantity":1}],"gdt":[],"threads":[{"id":"T001","spec":"e.g. 1/4-20 UNC","depth_mm":null,"quantity":1}],"material":null,"surface_finish":null,"notes":[]}\n\nIf no dimensions: {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}`,
      },
      // Prefix-forcing: guarantee the model writes JSON content (not just thinking).
      { role: "assistant", content: "{" },
    ],
    think:  false,
    stream: true,
    options: { temperature: 0, num_predict: 3000 },
  };

  const candidateUrls = buildCandidateBaseUrls(baseUrl);
  let response: Response | undefined;
  for (const url of candidateUrls) {
    try {
      response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      break;
    } catch { /* try next */ }
  }
  if (!response?.ok) throw new Error(`text-only pass HTTP ${response?.status}`);
  if (!response.body)  throw new Error("no body");

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const raw = line.startsWith("data: ") ? line.slice(6) : line;
      if (raw === "[DONE]") break;
      try {
        const chunk = JSON.parse(raw);
        const msg = chunk.message || {};
        if (msg.content) out += msg.content;
        if (chunk.done)  break;
      } catch { /* skip */ }
    }
    if (out.length > 10_000) break;
  }
  const trimmed = out.trim();
  // Prepend the "{" prefix we injected via the assistant role message.
  if (trimmed.length > 0 && !trimmed.startsWith("{")) return "{" + trimmed;
  return trimmed;
}

export async function collectOllamaVisionChat(
  imageBase64: string,
  systemPrompt: string,
  userPrompt: string,
  overrides?: { url?: string; model?: string; onThinking?: (chunk: string) => void },
): Promise<{ content: string }> {
  const visionUrl   = (overrides?.url   || process.env.LOCAL_OLLAMA_URL || "http://localhost:11434").trim();
  // Explicit override → env var → default.
  const visionModel = (overrides?.model || process.env.VISION_MODEL || "qwen3-vl:8b").trim();
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
    think:   false,
    stream:  true,
    options: {
      temperature: 0.3,
      repeat_penalty: 1.3,   // Break thinking repetition loops (model tends to loop on mm/in, tolerance debates)
      // Images are capped at 2000px longest side → ~15 tiles → ~3840 visual tokens.
      // 32768 context: 4640 prompt tokens + ~12000 thinking tokens + ~500 JSON answer = ~17140 total.
      // At 16384 the model hits context limit mid-thinking and never writes the JSON answer.
      // A4500 20 GB VRAM: 8B model ~7.5 GB weights + ~4 GB KV cache at 32768 = ~11.5 GB — fits.
      num_ctx: 32768,
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
      // If thinking exceeds ~15k chars the model is likely stuck in a verification loop.
      // Break now so extractJsonFromThinking / the two-call fallback can recover the answer.
      // 15k ≈ 3750 thinking tokens ≈ ~60-90s on A4500, well within the Vercel timeout.
      if (thinkContent.length > 15_000) {
        console.warn(`[vision-ollama] Thinking exceeded 15k chars (${thinkContent.length}) — breaking early to trigger fallback`);
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

  // qwen3-vl may stream its final answer inside the thinking block.
  // Extract by searching backwards for the last {"dimensions" pattern (always present in our schema).
  if (fullContent.length === 0 && thinkContent.length > 0) {
    console.warn(`[vision-ollama] content_len=0 but thinking_len=${thinkContent.length} — extracting JSON from thinking block`);
    fullContent = extractJsonFromThinking(thinkContent);
  }

  // If extractJsonFromThinking returned raw thinking (no JSON found), try a fast second call:
  // strip the image, send only the thinking text as context and ask for JSON directly.
  // This text-only call is fast (~5-10s) and deterministic at temperature=0.
  if (fullContent === thinkContent && thinkContent.length > 0) {
    console.warn(`[vision-ollama] no JSON in thinking — attempting text-only JSON extraction pass`);
    try {
      const jsonExtract = await collectJsonFromThinking(thinkContent, visionUrl, visionModel);
      if (jsonExtract.length > 0) {
        console.log(`[vision-ollama] text-only pass produced ${jsonExtract.length} chars`);
        fullContent = jsonExtract;
      }
    } catch (e) {
      console.warn(`[vision-ollama] text-only pass failed: ${(e as Error).message}`);
    }
  }

  console.log(
    `[vision-ollama] done elapsed_ms=${Date.now() - t0} content_len=${fullContent.length} thinking_len=${thinkContent.length}`,
  );
  return { content: fullContent };
}
