/**
 * Ollama VLM streaming extraction — uses shared prompts and merge helpers.
 */

import {
  EXTRACTION_PROMPT,
  SYSTEM_PROMPT,
  mergeVisionParsedResults,
  parseModelJson,
} from "./vision-drawing-shared";
import { collectOllamaVisionChat } from "./vision-ollama-stream";

export type StreamEvent =
  | { type: "thinking"; data: { content: string } }
  | { type: "result"; data: Record<string, unknown> };

export { parseModelJson };

export async function* extractFeaturesStream(
  imageBase64: string,
): AsyncGenerator<StreamEvent> {
  const { thinking, content } = await collectOllamaVisionChat(
    imageBase64,
    SYSTEM_PROMPT,
    EXTRACTION_PROMPT,
  );
  if (thinking.trim()) {
    yield { type: "thinking", data: { content: thinking } };
  }
  yield { type: "result", data: parseModelJson(content) };
}

/** Multi-page PDF (or multiple rasterized sheets): one VLM call per page, merged result. */
export async function* extractFeaturesStreamFromPages(
  imageBase64Pages: string[],
): AsyncGenerator<StreamEvent> {
  if (imageBase64Pages.length === 0) {
    throw new Error("No drawing pages to analyze");
  }
  if (imageBase64Pages.length === 1) {
    yield* extractFeaturesStream(imageBase64Pages[0]);
    return;
  }

  const parsedList: Record<string, unknown>[] = [];

  for (let i = 0; i < imageBase64Pages.length; i++) {
    yield {
      type: "thinking",
      data: { content: `Analyzing drawing page ${i + 1} of ${imageBase64Pages.length}...` },
    };
    try {
      const { content } = await collectOllamaVisionChat(
        imageBase64Pages[i],
        SYSTEM_PROMPT,
        EXTRACTION_PROMPT,
      );
      parsedList.push(parseModelJson(content));
    } catch (err) {
      console.warn(`[VLM] Page ${i + 1} failed:`, err);
      parsedList.push({
        features: [],
        gdt: [],
        material: null,
        notes: [],
        raw_model_output: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const merged = mergeVisionParsedResults(parsedList);
  yield { type: "result", data: merged };
}
