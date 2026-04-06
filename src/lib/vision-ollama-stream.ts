/**
 * vLLM OpenAI-compatible API — vision chat for Qwen3-VL-32B-Thinking-FP8.
 * Endpoint: POST /v1/chat/completions  (replaces former Ollama /api/chat)
 *
 * The 32B Thinking model always reasons before answering. Thinking arrives via
 * delta.reasoning_content; the final answer arrives via delta.content.
 */

// null = no timeout. Set VISION_TIMEOUT_MS=0 in env to disable.
const VISION_TIMEOUT_MS: number | null = (() => {
  const raw = parseInt(process.env.VISION_TIMEOUT_MS || "300000", 10);
  if (raw === 0) return null;
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
  } catch { /* keep original */ }
  return Array.from(new Set(candidates));
}

function findMatchingBrace(s: string): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc)                 { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true;  continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Detect image MIME type from base64 header bytes.
 */
function getImageMimeType(base64: string): string {
  if (base64.startsWith("/9j/"))   return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  return "image/png"; // default
}

/**
 * Strip <think>...</think> wrapper from content if present.
 * Returns the portion after </think>, or empty string if only a think block.
 */
function stripThinkTags(text: string): string {
  const trimmed = text.trim();
  // Complete think block: <think>...</think> followed by answer
  const match = trimmed.match(/^<think>[\s\S]*?<\/think>\s*([\s\S]*)$/);
  if (match) return match[1].trim();
  // Incomplete (stream ended inside think block) — no usable content
  if (trimmed.startsWith("<think>")) return "";
  return trimmed;
}

/**
 * Scan thinking text for the best JSON object containing a "dimensions" key.
 * Picks the candidate with the most extracted features (not necessarily the last one).
 */
function extractJsonFromThinking(thinking: string): string {
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
      const score =
        (Array.isArray(parsed.dimensions) ? parsed.dimensions.length : 0) +
        (Array.isArray(parsed.threads)    ? parsed.threads.length    : 0) +
        (Array.isArray(parsed.gdt)        ? parsed.gdt.length        : 0);
      candidates.push({ json: jsonStr, score });
    } catch { /* skip malformed */ }
    searchFrom = dimsIdx;
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    console.log(`[vision-vllm] JSON from thinking: ${best.json.length} chars, score=${best.score}, ${candidates.length} candidate(s)`);
    return best.json;
  }

  // Last-resort: find any parseable JSON object
  for (let pos = thinking.length - 1; pos >= 0; pos--) {
    if (thinking[pos] !== "{") continue;
    const fromBrace = thinking.slice(pos);
    const closeIdx  = findMatchingBrace(fromBrace);
    if (closeIdx === -1) continue;
    const jsonStr = fromBrace.slice(0, closeIdx + 1);
    try { JSON.parse(jsonStr); return jsonStr; } catch { /* keep looking */ }
  }

  // Non-technical page detection: model reasoned about why there's no drawing content
  const lower = thinking.toLowerCase();
  const isNonTechnical =
    lower.includes("non_technical_page") ||
    lower.includes("not a drawing") ||
    lower.includes("not an engineering drawing") ||
    (lower.includes("no dimension") && lower.includes("title")) ||
    lower.includes("no visible dimension");
  if (isNonTechnical) {
    console.log("[vision-vllm] thinking concluded non-technical — synthesizing canonical JSON");
    return '{"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}';
  }

  return thinking; // nothing found — return raw (will be unparseable)
}

/**
 * Second-pass text-only call: send thinking content as context, ask for clean JSON.
 * Used when the first vision call produced thinking but no usable content.
 * Uses OpenAI format with no image.
 */
async function collectJsonFromThinking(
  thinkContent: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  // Use the freshest section of thinking (after the last <think> marker if any)
  const lastThinkIdx = thinkContent.lastIndexOf("<think>");
  const freshStart = lastThinkIdx !== -1
    ? thinkContent.slice(lastThinkIdx + 7)
    : thinkContent;
  const context = freshStart.length > 8000 ? freshStart.slice(0, 8000) : freshStart;

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content: "You are a JSON formatter. Output ONLY the valid JSON object. No explanation, no markdown.",
      },
      {
        role: "user",
        content:
          `Engineering drawing analysis:\n\n${context}\n\n` +
          `Convert to JSON schema:\n` +
          `{"dimensions":[{"id":"D001","label":"short description","nominal":0,"unit":"mm or in","tolerance_plus":null,"tolerance_minus":null,"quantity":1}],"gdt":[],"threads":[{"id":"T001","spec":"e.g. M8x1.25","depth_mm":null,"quantity":1}],"material":null,"surface_finish":null,"notes":[]}\n\n` +
          `If no dimensions found: {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}`,
      },
    ],
    stream: true,
    temperature: 0,
    max_tokens: 8192,
  };

  const candidateUrls = buildCandidateBaseUrls(baseUrl);
  let response: Response | undefined;
  for (const url of candidateUrls) {
    try {
      response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      break;
    } catch { /* try next candidate */ }
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
        const delta = chunk.choices?.[0]?.delta || {};
        // Collect content only (ignore reasoning_content in second pass)
        if (delta.content) out += delta.content;
        if (chunk.choices?.[0]?.finish_reason) break;
      } catch { /* skip malformed */ }
    }
    if (out.length > 10_000) break;
  }

  // Strip <think> tags if the 32B still wraps its answer
  const trimmed = out.trim();
  const afterThink = stripThinkTags(trimmed);
  return afterThink.length > 0 ? afterThink : trimmed;
}

export async function collectOllamaVisionChat(
  imageBase64: string | string[],
  systemPrompt: string,
  userPrompt: string,
  overrides?: { url?: string; model?: string; onThinking?: (chunk: string) => void },
): Promise<{ content: string }> {
  const visionUrl   = (overrides?.url   || process.env.LOCAL_OLLAMA_URL || "http://localhost:11434").trim();
  const visionModel = (overrides?.model || process.env.VISION_MODEL     || "/workspace/models/Qwen3-VL-32B-Thinking-FP8").trim();
  const t0 = Date.now();

  // Normalise: always work with an array internally
  const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];

  console.log(
    `[vision-vllm] start model=${visionModel} url=${visionUrl} ` +
    `images=${images.length} total_b64_len=${images.reduce((s, b) => s + b.length, 0)} timeout_ms=${VISION_TIMEOUT_MS ?? "unlimited"}`,
  );

  const payload = {
    model: visionModel,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          ...images.map((b64) => ({
            type: "image_url" as const,
            image_url: { url: `data:${getImageMimeType(b64)};base64,${b64}` },
          })),
          { type: "text" as const, text: userPrompt },
        ],
      },
    ],
    stream: true,
    // Qwen3-VL-32B-Thinking: use 0.15 rather than 0.
    // temperature=0 (greedy) causes deterministic repetition loops when the model is
    // uncertain about a GD&T symbol. 0.15 breaks loops while keeping JSON structure stable.
    temperature: 0.15,
    // Break repetitive loops in the thinking stream.
    // 1.05 was insufficient for this model on ambiguous GD&T symbols — bumped to 1.12.
    repetition_penalty: 1.12,
    // 12288 tokens total (thinking + answer). Per-page JSON answer needs ~2k tokens max;
    // the remaining ~10k is available for thinking. Keeping this lower forces the model
    // to conclude faster and prevents runaway thinking loops.
    max_tokens: 12288,
    chat_template_kwargs: { enable_thinking: true, thinking_budget_tokens: 6000 },
    // Required so the </think> boundary token is visible in delta.content,
    // allowing the streaming code to separate thinking from the answer.
    skip_special_tokens: false,
  };

  const candidateBaseUrls = buildCandidateBaseUrls(visionUrl);
  let response: Response | undefined;
  let lastNetworkError: Error | undefined;
  let activeAbortController: AbortController | undefined;

  for (const baseUrl of candidateBaseUrls) {
    const abortController = new AbortController();
    activeAbortController = abortController;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:   JSON.stringify(payload),
        signal: abortController.signal,
      });
      break;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Vision model timed out. The model may be overloaded. Please try again.`);
      }
      lastNetworkError = err as Error;
    }
  }
  void activeAbortController; // referenced above, suppress unused warning

  if (!response) {
    throw new Error(
      `Cannot reach vision model at ${visionUrl}: ${lastNetworkError?.message || "fetch failed"}`,
    );
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Vision model error (${response.status}): ${errText.slice(0, 200)}`);
  }

  if (!response.body) throw new Error("No response body from vision model");

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer      = "";
  let fullContent = "";
  let thinkContent = "";
  let streamError: Error | null = null;
  let streamTimedOut = false;
  let streamInactive = false;
  // Qwen3-VL thinking format: the <think> token is injected into the prompt prefix
  // by the chat template, so it never appears in delta.content. The model's output
  // starts directly as thinking text and transitions to the answer at </think>.
  // Stream all delta.content as thinking until </think> is seen.
  // Disabled automatically if delta.reasoning_content arrives (takes priority).
  let contentStreamInsideThink = true;

  const streamTimeout = VISION_TIMEOUT_MS !== null
    ? setTimeout(() => { streamTimedOut = true; void reader.cancel(); }, VISION_TIMEOUT_MS)
    : null;

  // Inactivity watchdog: 30s without any tokens = dead connection
  const INACTIVITY_MS = 30_000;
  let inactivityTimer = setTimeout(() => { streamInactive = true; void reader.cancel(); }, INACTIVITY_MS);
  const resetInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => { streamInactive = true; void reader.cancel(); }, INACTIVITY_MS);
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
        const raw = line.startsWith("data: ") ? line.slice(6) : line;
        if (raw === "[DONE]") break;
        try {
          const chunk = JSON.parse(raw);
          const delta = chunk.choices?.[0]?.delta || {};
          // reasoning_content = thinking tokens (vLLM reasoning model extension)
          if (delta.reasoning_content) {
            thinkContent += delta.reasoning_content;
            overrides?.onThinking?.(delta.reasoning_content);
            contentStreamInsideThink = false; // reasoning_content path takes priority
          }
          // content = actual response tokens
          if (delta.content) {
            fullContent += delta.content;
            // Stream content live as thinking until </think> is seen.
            // <think> lives in the prompt prefix so delta.content begins immediately
            // as thinking text; the answer follows after </think>.
            if (contentStreamInsideThink && thinkContent.length === 0) {
              if (delta.content.includes("</think>")) {
                const closeIdx = delta.content.indexOf("</think>");
                const thinkChunk = delta.content.slice(0, closeIdx);
                if (thinkChunk) overrides?.onThinking?.(thinkChunk);
                contentStreamInsideThink = false; // rest of stream is the answer
              } else {
                overrides?.onThinking?.(delta.content);
              }
            }
          }
          if (chunk.choices?.[0]?.finish_reason) break;
        } catch { /* skip malformed SSE lines */ }
      }

      // Cap total content (thinking + answer). With skip_special_tokens=false the
      // thinking portion may be large; 200k gives ~50k thinking tokens headroom.
      if (fullContent.length > 200_000) {
        console.warn("[vision-vllm] Output exceeded 200k chars, stopping");
        break;
      }
      // reasoning_content path: cap thinking separately
      if (thinkContent.length > 80_000) {
        console.warn(`[vision-vllm] Thinking exceeded 80k chars — breaking early`);
        break;
      }
    }
  } catch (streamErr) {
    const name = (streamErr as Error)?.name || "StreamError";
    const msg  = (streamErr as Error)?.message || String(streamErr);
    streamError = new Error(`${name}: ${msg}`);
    console.warn(`[vision-vllm] Stream read error: ${name}: ${msg}`);
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
    if (fullContent.length === 0 && thinkContent.length === 0) {
      throw new Error(
        `Vision model stopped responding — no tokens received for ${INACTIVITY_MS / 1000}s. ` +
        `Check that the vLLM server is running on the RunPod pod.`,
      );
    }
    console.warn(
      `[vision-vllm] Inactivity timeout — attempting JSON extraction from partial content ` +
      `(content=${fullContent.length}, thinking=${thinkContent.length})`,
    );
  }

  if (streamError) throw new Error(`Vision model stream failed: ${streamError.message}`);

  // Qwen3-VL format: [thinking text]</think>\n\n[answer]
  // <think> is in the prompt prefix so fullContent has no opening tag, only </think>.
  if (fullContent.length > 0 && thinkContent.length === 0 &&
      !fullContent.includes("<think>") && fullContent.includes("</think>")) {
    const closeIdx  = fullContent.indexOf("</think>");
    const afterThink = fullContent.slice(closeIdx + 8).trim();
    const thinking   = fullContent.slice(0, closeIdx).trim();
    if (afterThink.length > 0) {
      thinkContent = thinking;
      fullContent  = afterThink;
    } else {
      // Only thinking was generated (no answer) — move to thinkContent for JSON extraction
      thinkContent = thinking;
      fullContent  = "";
    }
    console.log(`[vision-vllm] Qwen3-VL think boundary: thinking=${thinkContent.length} answer=${fullContent.length}`);
  }

  // Fallback: models that embed full <think>...</think> in content (other vLLM configs).
  if (fullContent.length > 0 && thinkContent.length === 0 && fullContent.includes("<think>")) {
    const afterThink = stripThinkTags(fullContent);
    if (afterThink.length > 0) {
      // Mixed: think block + answer — use only the answer
      fullContent = afterThink;
    } else {
      // Entire content was a think block — move to thinkContent for fallback
      thinkContent = fullContent.replace(/^<think>/, "").replace(/<\/think>[\s\S]*$/, "");
      fullContent  = "";
    }
  }

  // Content empty but thinking has data — extract JSON from thinking
  if (fullContent.length === 0 && thinkContent.length > 0) {
    console.warn(`[vision-vllm] content=0 thinking=${thinkContent.length} — extracting JSON from thinking`);
    fullContent = extractJsonFromThinking(thinkContent);
  }

  // Two-pass fallback: thinking had no parseable JSON — send text-only second call
  if (fullContent === thinkContent && thinkContent.length > 0) {
    console.warn("[vision-vllm] no JSON in thinking — attempting text-only second pass");
    try {
      const jsonExtract = await collectJsonFromThinking(thinkContent, visionUrl, visionModel);
      if (jsonExtract.length > 0) {
        console.log(`[vision-vllm] second pass produced ${jsonExtract.length} chars`);
        fullContent = jsonExtract;
      }
    } catch (e) {
      console.warn(`[vision-vllm] second pass failed: ${(e as Error).message}`);
    }
  }

  console.log(
    `[vision-vllm] done elapsed_ms=${Date.now() - t0} content_len=${fullContent.length} thinking_len=${thinkContent.length}`,
  );
  return { content: fullContent };
}
