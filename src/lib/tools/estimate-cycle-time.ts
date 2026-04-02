/**
 * Tool: estimate_cycle_time
 *
 * Calculates CNC machining cycle time using either:
 *   - from_processes: Precise calculation from process mapping (3D path)
 *   - from_features: Heuristic scaling from raw extraction (2D path)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "estimate_cycle_time",
    description:
      "Calculate total CNC machining cycle time from process mapping. Uses cutting-parameter-based estimation (distance/feed_rate) when process data is available, or feature-based heuristics for 2D-only analysis.",
    parameters: {
      type: "object",
      properties: {
        process_map_json: {
          type: "string",
          description: "JSON string of the process mapping result from map_cnc_processes",
        },
        method: {
          type: "string",
          description: "Estimation method: 'from_processes' (precise, needs process map) or 'from_features' (heuristic, needs raw extraction)",
          enum: ["from_processes", "from_features"],
        },
        extraction_json: {
          type: "string",
          description: "JSON string of raw extraction (only needed if method is 'from_features')",
        },
      },
      required: ["method"],
    },
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETUP_MIN       = 10.0;
const TOOL_CHANGE_MIN = 0.5;
const RAPID_IPM       = 200.0;
const APPROACH_IN     = 0.25;

const REF_DIM: Record<string, number> = {
  hole: 0.34, fillet: 0.1, chamfer: 0.02, thread: 0.19,
  radius: 0.01, step: 0.125, slot: 0.25, pocket: 0.5, bore: 0.5, face: 1.0,
};

const BASE_TIME: Record<string, number> = {
  fillet: 3, step: 2, chamfer: 0.5, slot: 2,
  pocket_rough: 2, pocket_finish: 1.5,
  hole_rough: 1.5, hole_finish: 1,
  thread_drill: 0.75, thread_cut: 1,
  radius_per_unit: 0.125, bore: 2, face: 1,
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scale(actual: number, ref: number): number {
  if (ref <= 0 || actual <= 0) return 1;
  return Math.max(0.3, Math.min(Math.pow(actual / ref, 0.7), 5));
}

function featProcs(feat: any): any[] {
  const t    = (feat.type || "").toLowerCase();
  const desc = feat.description || t;
  const dim  = parseFloat(feat?.dimensions?.primary_value || 0);
  const s    = scale(dim, REF_DIM[t] || 0.25);
  const procs: any[] = [];

  if (t === "hole") {
    procs.push(
      { process: `Rough Milling - ${desc}`,  minutes: r2(BASE_TIME.hole_rough  * s) },
      { process: `Finish Milling - ${desc}`, minutes: r2(BASE_TIME.hole_finish * s) },
    );
  } else if (t === "thread") {
    procs.push(
      { process: "Drilling - Thread Hole",   minutes: r2(BASE_TIME.thread_drill * s) },
      { process: `Thread Cut - ${desc}`,     minutes: r2(BASE_TIME.thread_cut   * s) },
    );
  } else if (t === "pocket") {
    procs.push(
      { process: `Rough Milling - ${desc}`,  minutes: r2(BASE_TIME.pocket_rough  * s) },
      { process: `Finish Milling - ${desc}`, minutes: r2(BASE_TIME.pocket_finish * s) },
    );
  } else {
    procs.push({ process: `Milling - ${desc}`, minutes: r2((BASE_TIME[t] || 1) * s) });
  }
  return procs;
}

// ---------------------------------------------------------------------------
// Handler — runs when the LLM calls estimate_cycle_time
// ---------------------------------------------------------------------------

export async function estimateCycleTime(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const method = args.method || "from_processes";

  // ---- Precise path: use process map ----
  if (method === "from_processes" && args.process_map_json) {
    const pm  = typeof args.process_map_json === "string" ? JSON.parse(args.process_map_json) : args.process_map_json;
    const ops = pm.operations || [];
    const bd: any[] = [{ process: "Setup", minutes: SETUP_MIN, category: "setup" }];
    let prev: string | null = null, tc = 0;

    for (const op of ops) {
      const feed = op.params?.feed_rate_ipm || 1;
      const dist = op.toolpath_distance_in || 0;
      if (prev !== null && op.tool.key !== prev) tc++;
      prev = op.tool.key;
      const cut   = feed > 0 && dist > 0 ? dist / feed : 0.5;
      const rapid = (2 * APPROACH_IN) / RAPID_IPM;
      bd.push({ process: op.label, minutes: r3(cut + rapid), category: "machining" });
    }
    if (tc > 0) bd.push({ process: `Tool Changes (${tc}x)`, minutes: r2(tc * TOOL_CHANGE_MIN), category: "tool_change" });

    const total = r2(bd.reduce((s: number, p: any) => s + p.minutes, 0));
    return { method: "cutting_parameter_based", total_minutes: total, breakdown: bd };
  }

  // ---- Heuristic path: use raw extraction (2D only) ----
  const ext   = typeof args.extraction_json === "string" ? JSON.parse(args.extraction_json) : (args.extraction_json || {});
  const feats = ext.features || [];
  const bd: any[] = [{ process: "Setup", minutes: SETUP_MIN, category: "setup" }];
  const toolTypes = new Set<string>();

  for (const f of feats) {
    for (const p of featProcs(f)) bd.push({ ...p, category: "machining" });
    toolTypes.add(f.type || "");
  }
  if (toolTypes.size > 1) {
    bd.push({ process: `Tool Changes (${toolTypes.size - 1}x)`, minutes: r2((toolTypes.size - 1) * TOOL_CHANGE_MIN), category: "tool_change" });
  }

  const total = r2(bd.reduce((s: number, p: any) => s + p.minutes, 0));
  return { method: "feature_based_heuristic", total_minutes: total, breakdown: bd };
}
