/**
 * Tool: analyze_drawing
 *
 * Uses the Vision-Language Model (Qwen3-VL) to extract manufacturing features,
 * dimensions, GD&T callouts, and material from a 2D engineering drawing.
 *
 * Supports multi-page PDFs: each rasterized page is analyzed and results merged.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition, ToolContext } from "../agent/types";
import {
  EXTRACTION_PROMPT,
  SYSTEM_PROMPT,
  classifyPageParsed,
  mergeVisionParsedResults,
  parseModelJson,
  summarizeOutcomes,
  type PageOutcome,
} from "../vision-drawing-shared";
import { collectOllamaVisionChat } from "../vision-ollama-stream";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
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
// Handler — runs when the LLM calls analyze_drawing
// ---------------------------------------------------------------------------

export async function analyzeDrawing(
  args: Record<string, any>,
  context: Pick<ToolContext, "imageBase64" | "imageBase64Pages" | "visionModelUrl" | "visionModelName" | "visionApiKey">,
): Promise<Record<string, unknown>> {
  const pageConcurrency = (() => {
    const raw = parseInt(process.env.VISION_PAGE_CONCURRENCY || "2", 10);
    if (!Number.isFinite(raw) || raw <= 0) return 2;
    return Math.min(raw, 4);
  })();

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

  console.log(
    `[Tool:analyze_drawing] Calling vision model for ${pages.length} page(s), concurrency=${pageConcurrency}...`,
  );

  const parsedPerPage: Record<string, unknown>[] = new Array(pages.length);
  const outcomes: PageOutcome[] = new Array(pages.length);

  const runOnePage = async (i: number): Promise<void> => {
    const pageStart = Date.now();
    console.log(`[Tool:analyze_drawing] Page ${i + 1}/${pages.length} vision request start`);
    try {
      const { content } = await collectOllamaVisionChat(
        pages[i],
        SYSTEM_PROMPT,
        EXTRACTION_PROMPT,
        {
          url:    context.visionModelUrl,
          model:  context.visionModelName,
          apiKey: context.visionApiKey,
        },
      );
      console.log(
        `[Tool:analyze_drawing] Page ${i + 1}/${pages.length} vision response received in ${Date.now() - pageStart}ms`,
      );
      if (!content.trim()) {
        parsedPerPage[i] = { features: [], gdt: [], material: null, notes: [], raw_model_output: "(empty response)" };
        outcomes[i] = "unparseable";
        return;
      }
      const parsed = parseModelJson(content);
      parsedPerPage[i] = parsed;
      outcomes[i] = classifyPageParsed(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Tool:analyze_drawing] Page ${i + 1}/${pages.length} failed:`, msg);
      parsedPerPage[i] = { features: [], gdt: [], material: null, notes: [], raw_model_output: msg };
      outcomes[i] = "unparseable";
    }
  };

  for (let start = 0; start < pages.length; start += pageConcurrency) {
    const end = Math.min(start + pageConcurrency, pages.length);
    const batch: Promise<void>[] = [];
    for (let i = start; i < end; i++) {
      batch.push(runOnePage(i));
    }
    await Promise.all(batch);
  }

  const merged = mergeVisionParsedResults(
    parsedPerPage.map((p) => p ?? { features: [], gdt: [], material: null, notes: [], raw_model_output: "(missing page result)" }),
  );
  const features = (merged.features as any[]) || [];
  const gdt      = (merged.gdt     as any[]) || [];
  const notes    = (merged.notes   as string[]) || [];

  const { anyOk, allHardReject, allBad } = summarizeOutcomes(outcomes);

  if (features.length > 0) {
    console.log(`[Tool:analyze_drawing] Extracted ${features.length} features, ${gdt.length} GD&T (merged)`);
    return { ...merged, feature_count: features.length, gdt_count: gdt.length, pages_analyzed: pages.length };
  }

  if (allHardReject || allBad) {
    return {
      ...merged,
      error: "This file does not appear to be an engineering drawing. Please upload a 2D technical drawing with dimensions and manufacturing features.",
      feature_count: 0, gdt_count: 0, pages_analyzed: pages.length,
    };
  }

  if (anyOk) {
    return {
      ...merged,
      error: "No manufacturing features detected after analyzing all pages. Please ensure dimensions and CNC features are visible.",
      feature_count: 0, gdt_count: 0, pages_analyzed: pages.length,
    };
  }

  const hasUnparseable = outcomes.some((o) => o === "unparseable");
  return {
    ...merged,
    error: hasUnparseable
      ? "The vision model could not parse one or more pages. Try a clearer PDF or install Poppler / use a PNG export of the drawing."
      : "No manufacturing features detected in this file. Cover-only first pages are skipped when possible; ensure at least one sheet shows the part with dimensions.",
    notes, feature_count: 0, gdt_count: 0, pages_analyzed: pages.length,
  };
}
