/**
 * Tool: validate_estimate
 *
 * Cross-checks the complete estimate for consistency and flags issues.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "validate_estimate",
    description:
      "Cross-check and validate the complete cost estimate for consistency. Flags issues like: unreasonable cycle times, missing features, cost outliers, or inconsistent material/process combinations.",
    parameters: {
      type: "object",
      properties: {
        features_json: {
          type: "string",
          description: "JSON string of recognized features",
        },
        processes_json: {
          type: "string",
          description: "JSON string of mapped processes",
        },
        cycle_time_json: {
          type: "string",
          description: "JSON string of cycle time breakdown",
        },
        cost_json: {
          type: "string",
          description: "JSON string of cost breakdown",
        },
      },
      required: ["features_json", "cycle_time_json", "cost_json"],
    },
  },
};

// ---------------------------------------------------------------------------
// Handler — runs when the LLM calls validate_estimate
// ---------------------------------------------------------------------------

export async function validateEstimate(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const features  = typeof args.features_json   === "string" ? JSON.parse(args.features_json)   : (args.features_json   || {});
  const processes = args.processes_json
    ? (typeof args.processes_json === "string" ? JSON.parse(args.processes_json) : args.processes_json)
    : null;
  const cycleTime = typeof args.cycle_time_json === "string" ? JSON.parse(args.cycle_time_json) : (args.cycle_time_json || {});
  const cost      = typeof args.cost_json       === "string" ? JSON.parse(args.cost_json)       : (args.cost_json       || {});

  const warnings: string[] = [];
  const info:     string[] = [];

  const featCount = features.feature_count || features.features?.length || 0;
  if (featCount === 0)  warnings.push("No manufacturing features detected. Cost estimate may be inaccurate.");
  if (featCount > 20)   info.push(`High feature count (${featCount}). This is a complex part.`);

  const totalMin = cycleTime.total_minutes || 0;
  if (totalMin < 1 && featCount > 0) warnings.push("Cycle time seems unusually low. Check the process mapping.");
  if (totalMin > 120)                warnings.push("Cycle time exceeds 2 hours. Verify this is a single-part estimate, not a batch.");
  if (totalMin > 0 && totalMin <= 60) info.push("Cycle time is within normal range for a single machined part.");

  const totalUsd = cost.total_usd || 0;
  if (totalUsd < 5    && featCount > 0) warnings.push("Total cost seems unusually low. Verify material and shop rate assumptions.");
  if (totalUsd > 1000)                  warnings.push("Total cost exceeds $1000. This may be correct for complex parts but verify assumptions.");

  if (processes) {
    const opCount = processes.operation_count || processes.operations?.length || 0;
    if (opCount === 0 && featCount > 0) warnings.push("No CNC operations mapped despite having features.");
    info.push(`${opCount} CNC operations mapped for ${featCount} features.`);
  }

  const matName = features.material?.name || "Unknown";
  if (matName.includes("Unknown")) warnings.push("Material not identified from drawing. Using default assumption (Aluminum).");

  const feats     = features.features || [];
  const tightTol  = feats.filter((f: any) => ["precision", "close"].includes(f.tolerance_class)).length;
  if (tightTol > 0) info.push(`${tightTol} features have tight tolerances (precision/close), which will increase cost.`);

  return {
    valid:    warnings.length === 0,
    warnings,
    info,
    summary:  warnings.length === 0
      ? "Estimate looks consistent. No major issues detected."
      : `Found ${warnings.length} potential issue(s) that may need review.`,
  };
}
