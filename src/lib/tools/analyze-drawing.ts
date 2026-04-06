/**
 * Tool: analyze_drawing
 *
 * Uses the Vision-Language Model to extract manufacturing features,
 * dimensions, GD&T callouts, and material from a 2D engineering drawing.
 *
 * Multi-page strategy:
 *   - BATCH_SIZE=1 — one page per vLLM call.
 *     The Qwen3-VL-32B-Thinking model exhausts its entire token budget on thinking
 *     when given multiple images, never producing JSON. Per-page calls keep the
 *     thinking chain short enough to complete within max_tokens.
 *   - Each page result is classified:
 *       "ok"          → has features — included in merged result
 *       "soft_skip"   → cover sheet / title block / blank
 *       "hard_reject" → clearly not a drawing (photo, logo)
 *       "unparseable" → model timed out or returned garbage — retried once
 *   - Results from ALL "ok" batches are merged (features + GD&T + material).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition, ToolContext } from "../agent/types";
import {
  EXTRACTION_PROMPT,
  SYSTEM_PROMPT,
  buildMultiPagePrompt,
  classifyPageParsed,
  mergeVisionParsedResults,
  parseModelJson,
  summarizeOutcomes,
  type PageOutcome,
} from "../vision-drawing-shared";
import { collectOllamaVisionChat } from "../vision-ollama-stream";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "analyze_drawing",
    description:
      "Extract manufacturing features, dimensions, GD&T callouts, and material specification from a 2D engineering drawing image using vision AI. This is always the first step — it reads the drawing and identifies what needs to be manufactured.",
    parameters: {
      type: "object",
      properties: {
        focus_areas: {
          type: "string",
          description:
            "Optional comma-separated areas to focus on (e.g., 'holes,threads,tolerances'). Leave empty for full extraction.",
        },
      },
      required: [],
    },
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function analyzeDrawing(
  args: Record<string, any>,
  context: Pick<ToolContext, "imageBase64" | "imageBase64Pages" | "visionModelUrl" | "visionModelName"> & {
    onThinking?: (chunk: string) => void;
  },
): Promise<Record<string, unknown>> {
  const pages =
    context.imageBase64Pages && context.imageBase64Pages.length > 0
      ? context.imageBase64Pages
      : context.imageBase64
        ? [context.imageBase64]
        : [];

  if (pages.length === 0) {
    return {
      error: "No 2D drawing image available. Please upload a 2D engineering drawing.",
      features: [],
      gdt: [],
      material: null,
    };
  }

  // ── Batch strategy ────────────────────────────────────────────────────────
  // Send up to BATCH_SIZE images in one vLLM call.
  // With 64k context + 96GB VRAM, 4 images fit comfortably in a single request,
  // reducing a 4-page PDF from 4 sequential calls to 1.
  const BATCH_SIZE = 1;
  const MAX_RETRIES = 1;

  const batches: string[][] = [];
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    batches.push(pages.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `[Tool:analyze_drawing] ${pages.length} page(s) → ${batches.length} batch(es) of up to ${BATCH_SIZE} images each`,
  );

  const parsedPerBatch: Record<string, unknown>[] = [];
  const outcomes: PageOutcome[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch  = batches[b];
    const isMulti = batch.length > 1;
    const prompt  = isMulti ? buildMultiPagePrompt(batch.length) : EXTRACTION_PROMPT;
    const pageRange = batches.length === 1
      ? `${pages.length} page(s)`
      : `batch ${b + 1}/${batches.length} (pages ${b * BATCH_SIZE + 1}–${Math.min((b + 1) * BATCH_SIZE, pages.length)})`;

    let parsed: Record<string, unknown> = { features: [], gdt: [], material: null, notes: [], raw_model_output: "" };
    let outcome: PageOutcome = "unparseable";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const batchStart   = Date.now();
      const attemptLabel = attempt === 0 ? "" : ` (retry ${attempt})`;
      console.log(`[Tool:analyze_drawing] ${pageRange}${attemptLabel} — sending ${batch.length} image(s) to vision model...`);

      try {
        const { content } = await collectOllamaVisionChat(
          batch.length === 1 ? batch[0] : batch,
          SYSTEM_PROMPT,
          prompt,
          {
            url:        context.visionModelUrl,
            model:      context.visionModelName,
            onThinking: context.onThinking,
          },
        );
        const elapsed = Date.now() - batchStart;
        console.log(`[Tool:analyze_drawing] ${pageRange}${attemptLabel} responded in ${elapsed}ms`);

        if (!content.trim()) {
          console.warn(`[Tool:analyze_drawing] ${pageRange}${attemptLabel} returned empty response.`);
          parsed  = { features: [], gdt: [], material: null, notes: [], raw_model_output: "(empty response)" };
          outcome = "unparseable";
        } else {
          parsed  = parseModelJson(content);
          outcome = classifyPageParsed(parsed);
          const featureCount = ((parsed.dimensions as any[]) || []).length + ((parsed.threads as any[]) || []).length;
          console.log(`[Tool:analyze_drawing] ${pageRange}${attemptLabel} classified as "${outcome}" — ${featureCount} feature(s).`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Tool:analyze_drawing] ${pageRange}${attemptLabel} error: ${msg}`);
        parsed  = { features: [], gdt: [], material: null, notes: [], raw_model_output: msg };
        outcome = "unparseable";
      }

      if (outcome !== "unparseable") break;
      if (attempt < MAX_RETRIES) {
        console.log(`[Tool:analyze_drawing] ${pageRange} error — retrying...`);
      }
    }

    parsedPerBatch.push(parsed);
    outcomes.push(outcome);
  }

  // Merge results from all batches that returned features.
  const okParsed = parsedPerBatch.filter((_, i) => outcomes[i] === "ok");
  const merged   = mergeVisionParsedResults(
    okParsed.length > 0 ? okParsed : parsedPerBatch,
  );

  const features = (merged.dimensions as any[]) || [];
  const gdt      = (merged.gdt     as any[]) || [];
  const { anyOk, allHardReject, allBad } = summarizeOutcomes(outcomes);

  if (features.length > 0) {
    const okBatches = outcomes.filter(o => o === "ok").length;
    console.log(
      `[Tool:analyze_drawing] Done — ${features.length} features, ${gdt.length} GD&T from ${okBatches}/${batches.length} batch(es) (${pages.length} page(s) total).`,
    );
    return { ...merged, feature_count: features.length, gdt_count: gdt.length, pages_analyzed: pages.length };
  }

  if (allHardReject) {
    return {
      ...merged,
      error: "This file does not appear to contain engineering drawings. Please upload a 2D technical drawing with dimensions and manufacturing features.",
      feature_count: 0, gdt_count: 0, pages_analyzed: pages.length,
    };
  }

  if (allBad) {
    return {
      ...merged,
      error: "The vision model could not parse any page. Try exporting the drawing as a PNG or JPG for better results.",
      feature_count: 0, gdt_count: 0, pages_analyzed: pages.length,
    };
  }

  const skippedCount = outcomes.filter(o => o === "soft_skip").length;
  return {
    ...merged,
    error: anyOk
      ? "No manufacturing features detected despite finding drawing pages. Ensure dimensions and CNC features are visible."
      : `No drawing content found — all ${pages.length} page(s) appear to be cover sheets or non-technical pages (${skippedCount} skipped). Please upload the page with the actual part geometry.`,
    feature_count: 0, gdt_count: 0, pages_analyzed: pages.length,
  };
}
