/**
 * Tool Registry — single entry point for all LLM tools.
 *
 * Each tool file owns its schema + handler.
 * This file aggregates them and exports:
 *   - TOOL_DEFINITIONS  → passed to the model on every chat call
 *   - executeToolCall() → called by the pipeline when a tool is selected
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolContext } from "../agent/types";

import { schema as analyzeDrawingSchema,    analyzeDrawing     } from "./analyze-drawing";
import { schema as analyzeStepFileSchema,   analyzeStepFile    } from "./analyze-step-file";
import { schema as recognizeFeaturesSchema, recognizeFeatures  } from "./recognize-features";
import { schema as lookupMaterialSchema,    lookupMaterial     } from "./lookup-material";
import { schema as mapProcessesSchema,      mapCncProcesses    } from "./map-processes";
import { schema as estimateCycleTimeSchema, estimateCycleTime  } from "./estimate-cycle-time";
import { schema as estimateCostSchema,      estimateCost       } from "./estimate-cost";
import { schema as validateResultsSchema,   validateEstimate   } from "./validate-results";

// ---------------------------------------------------------------------------
// Tool definitions — sent to the model
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  analyzeDrawingSchema,    // Step 1 — 2D GD&T extraction
  analyzeStepFileSchema,   // Step 2 — 3D STEP geometry (FreeCAD)
  recognizeFeaturesSchema, // Step 3 — merge 3D + 2D
  mapProcessesSchema,      // Step 4 — CNC operation mapping
  estimateCycleTimeSchema, // Step 5 — cycle time
  estimateCostSchema,      // Step 6 — cost
  lookupMaterialSchema,    // Optional — material property lookup
  validateResultsSchema,   // Optional — cross-check estimate
];

// ---------------------------------------------------------------------------
// Dispatch map — tool name → handler (same line = easy to audit)
// ---------------------------------------------------------------------------

const TOOL_MAP: Record<string, (args: Record<string, any>, ctx: ToolContext) => Promise<Record<string, unknown>>> = {
  [analyzeDrawingSchema.function.name]:    (args, ctx) => analyzeDrawing(args, ctx),
  [analyzeStepFileSchema.function.name]:   (args, ctx) => analyzeStepFile(args, ctx),
  [recognizeFeaturesSchema.function.name]: (args)      => recognizeFeatures(args),
  [lookupMaterialSchema.function.name]:    (args)      => lookupMaterial(args),
  [mapProcessesSchema.function.name]:      (args)      => mapCncProcesses(args),
  [estimateCycleTimeSchema.function.name]: (args)      => estimateCycleTime(args),
  [estimateCostSchema.function.name]:      (args)      => estimateCost(args),
  [validateResultsSchema.function.name]:   (args)      => validateEstimate(args),
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeToolCall(
  toolName: string,
  args: Record<string, any>,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const handler = TOOL_MAP[toolName];
  if (!handler) {
    return { error: `Unknown tool: "${toolName}". Available: ${Object.keys(TOOL_MAP).join(", ")}` };
  }
  console.log(`[ToolRegistry] → ${toolName}`);
  const result = await handler(args, context);
  console.log(`[ToolRegistry] ✓ ${toolName}`);
  return result;
}
