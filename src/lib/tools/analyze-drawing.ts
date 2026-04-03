/**
 * Tool: analyze_drawing
 *
 * Uses the Vision-Language Model to extract manufacturing features,
 * dimensions, GD&T callouts, and material from a 2D engineering drawing.
 *
 * Multi-page strategy:
 *   - ALL pages are tried one at a time (sequential — avoids VRAM overload on small models).
 *   - Each page result is classified:
 *       "ok"          → has features — included in merged result
 *       "soft_skip"   → cover sheet / title block / blank — skipped, but others still tried
 *       "hard_reject" → clearly not a drawing (photo, logo) — skipped
 *       "unparseable" → model timed out or returned garbage — skipped
 *   - Results from ALL "ok" pages are merged (features + GD&T + material).
 *   - This handles any PDF structure: cover on page 1, dims on page 2, tolerances on page 3, etc.
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

  console.log(`[Tool:analyze_drawing] Processing all ${pages.length} page(s) sequentially...`);

  const parsedPerPage: Record<string, unknown>[] = [];
  const outcomes: PageOutcome[] = [];

  // Process every page one at a time — never concurrent on small models.
  for (let i = 0; i < pages.length; i++) {
    const pageStart = Date.now();
    console.log(`[Tool:analyze_drawing] Page ${i + 1}/${pages.length} — sending to vision model...`);

    let parsed: Record<string, unknown>;
    let outcome: PageOutcome;

    try {
      const { content } = await collectOllamaVisionChat(
        pages[i],
        SYSTEM_PROMPT,
        EXTRACTION_PROMPT,
        {
          url:        context.visionModelUrl,
          model:      context.visionModelName,
          onThinking: context.onThinking,
        },
      );
      const elapsed = Date.now() - pageStart;
      console.log(`[Tool:analyze_drawing] Page ${i + 1}/${pages.length} responded in ${elapsed}ms`);

      if (!content.trim()) {
        console.warn(`[Tool:analyze_drawing] Page ${i + 1} returned empty response — skipping.`);
        parsed  = { features: [], gdt: [], material: null, notes: [], raw_model_output: "(empty response)" };
        outcome = "unparseable";
      } else {
        parsed  = parseModelJson(content);
        outcome = classifyPageParsed(parsed);
        const featureCount = ((parsed.dimensions as any[]) || []).length + ((parsed.threads as any[]) || []).length;
        console.log(`[Tool:analyze_drawing] Page ${i + 1} classified as "${outcome}" — ${featureCount} feature(s).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Tool:analyze_drawing] Page ${i + 1} error: ${msg} — skipping.`);
      parsed  = { features: [], gdt: [], material: null, notes: [], raw_model_output: msg };
      outcome = "unparseable";
    }

    parsedPerPage.push(parsed);
    outcomes.push(outcome);
  }

  // Merge results from all pages that returned features.
  const okParsed = parsedPerPage.filter((_, i) => outcomes[i] === "ok");
  const merged   = mergeVisionParsedResults(
    okParsed.length > 0 ? okParsed : parsedPerPage,
  );

  const features = (merged.dimensions as any[]) || [];
  const gdt      = (merged.gdt     as any[]) || [];
  const { anyOk, allHardReject, allBad } = summarizeOutcomes(outcomes);

  if (features.length > 0) {
    const okPages = outcomes.filter(o => o === "ok").length;
    console.log(
      `[Tool:analyze_drawing] Done — ${features.length} features, ${gdt.length} GD&T from ${okPages}/${pages.length} drawing page(s).`,
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
