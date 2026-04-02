/**
 * Ollama /api/chat vision call — collect streamed response to strings.
 * Shared by analyze_drawing (multi-page) and vlmodel (single-page streaming wrapper).
 */

const VISION_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.VISION_TIMEOUT_MS || "120000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
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

export async function collectOllamaVisionChat(
  imageBase64: string,
  systemPrompt: string,
  userPrompt: string,
  overrides?: { url?: string; model?: string; apiKey?: string },
): Promise<{ content: string; thinking: string }> {
  const visionUrl   = overrides?.url    || process.env.VL_MODEL_API_URL  || "http://localhost:11434";
  const visionKey   = overrides?.apiKey ?? process.env.VL_MODEL_API_KEY  ?? "";
  const visionModel = (overrides?.model  || process.env.VL_MODEL_NAME     || "qwen3-vl:235b-cloud").replace(/-cloud$/, "");
  const t0 = Date.now();

  console.log(
    `[vision-ollama] start model=${visionModel} url=${visionUrl} image_b64_len=${imageBase64.length} timeout_ms=${VISION_TIMEOUT_MS}`,
  );

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (visionKey) headers["Authorization"] = `Bearer ${visionKey}`;

  const payload = {
    model: visionModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt, images: [imageBase64] },
    ],
    // Vision extraction does not need chain-of-thought tokens; disabling
    // this avoids long "reasoning" delays before JSON content appears.
    think: false,
    stream: true,
    options: { temperature: 0.1 },
  };

  const candidateBaseUrls = buildCandidateBaseUrls(visionUrl);
  let response: Response | undefined;
  let lastNetworkError: Error | undefined;
  let usedFallbackBaseUrl = false;

  for (const baseUrl of candidateBaseUrls) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), VISION_TIMEOUT_MS);
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });
      usedFallbackBaseUrl = baseUrl !== visionUrl;
      break;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(
          `Vision model timed out (${Math.round(VISION_TIMEOUT_MS / 1000)}s). The model may be overloaded. Please try again.`,
        );
      }
      lastNetworkError = err as Error;
    } finally {
      clearTimeout(timeout);
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
  let fullThinking = "";
  let streamError: Error | null = null;
  let streamTimedOut = false;
  const streamTimeout = setTimeout(() => {
    streamTimedOut = true;
    void reader.cancel();
  }, VISION_TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          const msg = chunk.message || {};
          const thinkToken: string = msg.thinking || "";
          if (thinkToken) fullThinking += thinkToken;
          if (msg.content) fullContent += msg.content;
          if (chunk.done) break;
        } catch {
          /* skip */
        }
      }

      if (fullContent.length > 100_000) {
        console.warn("[vision-ollama] Output exceeded 100k chars, stopping");
        break;
      }
    }
  } catch (streamErr) {
    const name = (streamErr as Error)?.name || "StreamError";
    const msg = (streamErr as Error)?.message || String(streamErr);
    streamError = new Error(`${name}: ${msg}`);
    console.warn(`[vision-ollama] Stream read error: ${name}: ${msg}`);
  } finally {
    clearTimeout(streamTimeout);
  }

  if (streamTimedOut) {
    throw new Error(
      `Vision model timed out (${Math.round(VISION_TIMEOUT_MS / 1000)}s) while reading stream.`,
    );
  }

  if (streamError) {
    throw new Error(`Vision model stream failed: ${streamError.message}`);
  }

  if (!fullThinking && fullContent.includes("<redacted_thinking>") && fullContent.includes("</redacted_thinking>")) {
    const thinkPart = fullContent.split("<redacted_thinking>")[1]?.split("</redacted_thinking>")[0];
    if (thinkPart?.trim()) fullThinking = thinkPart.trim();
    fullContent = fullContent.split("</redacted_thinking>").slice(1).join("</redacted_thinking>").trim() || fullContent;
  }

  console.log(
    `[vision-ollama] done elapsed_ms=${Date.now() - t0} content_len=${fullContent.length} thinking_len=${fullThinking.length}`,
  );
  return { content: fullContent, thinking: fullThinking };
}
