/**
 * Fallback Deterministic Pipeline
 *
 * Runs when the agentic loop fails. Same 6-step sequence as the agent,
 * but deterministic — no LLM reasoning, tools execute in fixed order.
 *
 *   1. analyze_drawing    — VLM GD&T extraction from 2D drawing
 *   2. analyze_step_file  — FreeCAD 3D feature extraction from STEP
 *   3. recognize_features — merge 3D geometry with 2D GD&T
 *   4. map_cnc_processes  — CNC operation mapping
 *   5. estimate_cycle_time
 *   6. estimate_cost
 *
 * Every step is wrapped in try/catch — partial results are always returned.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { AgentEvent } from "./types";
import { buildPipelineResults } from "../pipeline-results";
import { analyzeDrawing    } from "../tools/analyze-drawing";
import { analyzeStepFile   } from "../tools/analyze-step-file";
import { recognizeFeatures } from "../tools/recognize-features";
import { mapCncProcesses   } from "../tools/map-processes";
import { estimateCycleTime } from "../tools/estimate-cycle-time";
import { estimateCost      } from "../tools/estimate-cost";

interface FallbackParams {
  analysisId: string;
  imageBase64?: string;
  imageBase64Pages?: string[];
  stepFileContent?: string;
  fileName: string;
  reason?: string;
}

// ── Helper: emit status → tool_call → run fn → emit tool_result ─────────────
async function* runStep(
  tool:    string,
  step:    number,
  title:   string,
  message: string,
  args:    Record<string, unknown>,
  fn:      () => Promise<Record<string, unknown>>,
): AsyncGenerator<AgentEvent, Record<string, unknown> | null> {
  yield { type: "status",    data: { step, title, message } };
  yield { type: "tool_call", data: { tool, args, iteration: step } };

  const t = Date.now();
  try {
    const result = await fn();
    yield { type: "tool_result", data: { tool, result, duration_ms: Date.now() - t } };
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : `${tool} failed`;
    yield { type: "tool_result", data: { tool, result: { error: msg }, duration_ms: Date.now() - t } };
    return null;
  }
}

// ── Shortcut to build partial results at any abort point ────────────────────
function partial(
  drawing: any, step3d: any, recognition: any, processMap: any, cycleTime: any, cost: any,
) {
  return buildPipelineResults({
    analyze_drawing:     drawing,
    analyze_step_file:   step3d,
    recognize_features:  recognition,
    map_cnc_processes:   processMap,
    estimate_cycle_time: cycleTime,
    estimate_cost:       cost,
  });
}

// ---------------------------------------------------------------------------

export async function* runFallbackPipeline(params: FallbackParams): AsyncGenerator<AgentEvent> {
  // ── Step 1: 2D GD&T extraction ────────────────────────────────────────────
  let extraction: Record<string, unknown> | null = null;

  for await (const event of runStep(
    "analyze_drawing", 1, "GD&T Extraction", "Extracting dimensions and GD&T from 2D drawing...",
    { drawing_id: params.analysisId },
    () => analyzeDrawing({ drawing_id: params.analysisId }, {
      imageBase64:      params.imageBase64,
      imageBase64Pages: params.imageBase64Pages,
    }),
  )) {
    yield event;
    if (event.type === "tool_result") extraction = (event.data as any).result;
  }

  if (!extraction || extraction.error) {
    const msg = (extraction?.error as string) || "2D drawing extraction failed.";
    yield { type: "error",        data: { message: msg } };
    yield { type: "final_answer", data: { summary: msg, results: partial(extraction, null, null, null, null, null) } };
    return;
  }
  if (extraction.raw_model_output || (extraction.feature_count as number) === 0) {
    const msg = extraction.raw_model_output
      ? "The vision model could not parse the drawing. Please upload a clearer 2D engineering drawing."
      : "No features detected in the 2D drawing. Ensure it is a clear technical drawing with visible dimensions.";
    yield { type: "error",        data: { message: msg } };
    yield { type: "final_answer", data: { summary: msg, results: partial(extraction, null, null, null, null, null) } };
    return;
  }

  // ── Step 2: 3D STEP analysis ──────────────────────────────────────────────
  let stepAnalysis: Record<string, unknown> | null = null;

  for await (const event of runStep(
    "analyze_step_file", 2, "3D Analysis", "Extracting geometric features from STEP file...",
    { step_file_id: params.analysisId },
    () => analyzeStepFile({ step_file_id: params.analysisId }, { stepFileContent: params.stepFileContent }),
  )) {
    yield event;
    if (event.type === "tool_result" && !(event.data as any).result?.error) {
      stepAnalysis = (event.data as any).result;
    }
  }

  // STEP failure is non-fatal if FreeCAD is unavailable — log but continue
  // with 2D-only features rather than stopping the pipeline.
  if (!stepAnalysis) {
    yield {
      type: "status",
      data: { step: 2, title: "3D Analysis", message: "STEP analysis unavailable — continuing with 2D features only." },
    };
  }

  // ── Step 3: Feature recognition (merge 3D + 2D) ───────────────────────────
  let recognition: Record<string, unknown> | null = null;

  const recognizeArgs: Record<string, unknown> = {
    extraction_json: JSON.stringify(extraction),
  };
  if (stepAnalysis) recognizeArgs.step_analysis_json = JSON.stringify(stepAnalysis);

  for await (const event of runStep(
    "recognize_features", 3, "Feature Recognition", "Merging 3D geometry with 2D GD&T...",
    {},
    () => recognizeFeatures(recognizeArgs),
  )) {
    yield event;
    if (event.type === "tool_result" && !(event.data as any).result?.error) {
      recognition = (event.data as any).result;
    }
  }

  if (!recognition) {
    const msg = "Feature recognition failed. Partial results returned.";
    yield { type: "error",        data: { message: msg } };
    yield { type: "final_answer", data: { summary: msg, results: partial(extraction, stepAnalysis, null, null, null, null) } };
    return;
  }

  // ── Step 4: Process mapping ────────────────────────────────────────────────
  let processMap: Record<string, unknown> | null = null;

  for await (const event of runStep(
    "map_cnc_processes", 4, "Process Mapping", "Mapping CNC operations and tooling...",
    {},
    () => mapCncProcesses({ recognition_json: JSON.stringify(recognition) }),
  )) {
    yield event;
    if (event.type === "tool_result" && !(event.data as any).result?.error) {
      processMap = (event.data as any).result;
    }
  }

  // ── Step 5: Cycle time ────────────────────────────────────────────────────
  let cycleTime: Record<string, unknown> | null = null;

  const cycleArgs = processMap
    ? { method: "from_processes", process_map_json: JSON.stringify(processMap) }
    : { method: "from_features",  extraction_json:  JSON.stringify(extraction) };

  for await (const event of runStep(
    "estimate_cycle_time", 5, "Cycle Time", "Estimating machining cycle time...",
    cycleArgs,
    () => estimateCycleTime(cycleArgs),
  )) {
    yield event;
    if (event.type === "tool_result" && !(event.data as any).result?.error) {
      cycleTime = (event.data as any).result;
    }
  }

  if (!cycleTime) {
    const msg = "Cycle time estimation failed. Partial results returned.";
    yield { type: "error",        data: { message: msg } };
    yield { type: "final_answer", data: { summary: msg, results: partial(extraction, stepAnalysis, recognition, processMap, null, null) } };
    return;
  }

  // ── Step 6: Cost estimation ───────────────────────────────────────────────
  let cost: Record<string, unknown> | null = null;

  for await (const event of runStep(
    "estimate_cost", 6, "Cost Estimation", "Calculating fabrication cost...",
    { cycle_time_json: JSON.stringify(cycleTime) },
    () => estimateCost({ cycle_time_json: JSON.stringify(cycleTime) }),
  )) {
    yield event;
    if (event.type === "tool_result" && !(event.data as any).result?.error) {
      cost = (event.data as any).result;
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const results    = partial(extraction, stepAnalysis, recognition, processMap, cycleTime, cost);
  const totalMin   = (cycleTime as any)?.total_minutes || 0;
  const totalUsd   = (cost      as any)?.total_usd     || 0;
  const matName    = (recognition as any)?.material?.name || "Unknown material";
  const featCount  = (recognition as any)?.feature_count || (extraction as any)?.feature_count || 0;
  const source     = (recognition as any)?.source || "2d";

  yield {
    type: "final_answer",
    data: {
      summary: `Analysis complete for "${params.fileName}". ${source === "3d+2d" ? "3D+2D pipeline" : "2D pipeline"}. Material: ${matName}. ${featCount} feature${featCount !== 1 ? "s" : ""} detected. Cycle time: ${totalMin.toFixed(1)} min. Cost: USD ${totalUsd.toFixed(2)}.`,
      results,
    },
  };
}






