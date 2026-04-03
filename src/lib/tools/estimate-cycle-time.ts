/**
 * Tool: estimate_cycle_time
 *
 * Calculates CNC machining cycle time from the process map returned by
 * the Python microservice (mm units) or the legacy TypeScript process mapper
 * (inch units — auto-detected via field names).
 *
 * Formula: cutting_time = toolpath_distance / feed_rate
 * Works identically whether mm/mm-per-min or in/in-per-min, so no unit
 * conversion is needed — just use whichever fields are present.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";

// ---------------------------------------------------------------------------
// Schema (kept for agent tool registry compatibility)
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "estimate_cycle_time",
    description:
      "Calculate total CNC machining cycle time from a process map. " +
      "Accepts the Python microservice process_map (mm units) or the legacy TypeScript " +
      "process map (inch units). Uses cutting-parameter-based estimation.",
    parameters: {
      type: "object",
      properties: {
        process_map_json: {
          type: "string",
          description: "JSON string of the process map (from Python /analyze or map_cnc_processes)",
        },
        method: {
          type: "string",
          description:
            "Estimation method: 'from_processes' (from process map) or " +
            "'from_features' (heuristic, legacy 2D-only path)",
          enum: ["from_processes", "from_features"],
        },
        extraction_json: {
          type: "string",
          description: "JSON of raw extraction (only for method='from_features')",
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

// Rapid traverse — same ratio works for any unit system
// mm: 5080 mm/min approach: 6.35 mm | in: 200 IPM approach: 0.25 in
const RAPID_MMPM      = 5080;
const APPROACH_MM     = 6.35;

// Legacy inch constants (for from_features heuristic path)
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
// from_features heuristic (legacy 2D-only path)
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
// Handler
// ---------------------------------------------------------------------------

export async function estimateCycleTime(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const method = args.method || "from_processes";

  // ---- Precise path: use process map ----
  if (method === "from_processes" && args.process_map_json) {
    const pm  = typeof args.process_map_json === "string"
      ? JSON.parse(args.process_map_json)
      : args.process_map_json;

    // Support both Python (mm) and legacy TypeScript (inch) process maps
    const ops: any[] = pm.operations || pm.process_map || pm || [];
    const bd: any[] = [{ process: "Setup", minutes: SETUP_MIN, category: "setup" }];
    let prevTool: string | null = null;
    let toolChanges = 0;

    for (const op of ops) {
      // Python process_map uses: toolpath_distance_mm + feed_rate_mmpm
      // Legacy TypeScript uses:  toolpath_distance_in + feed_rate_ipm
      const distMm = op.toolpath_distance_mm
        ?? (op.toolpath_distance_in != null ? op.toolpath_distance_in * 25.4 : 0);
      const feedMmpm = op.params?.feed_rate_mmpm
        ?? (op.params?.feed_rate_ipm != null ? op.params.feed_rate_ipm * 25.4 : 1);

      // Tool identity key — Python uses tool.type, legacy uses tool.key
      const toolKey = op.tool?.type ?? op.tool?.key ?? "unknown";

      if (prevTool !== null && toolKey !== prevTool) toolChanges++;
      prevTool = toolKey;

      const cutMin   = feedMmpm > 0 && distMm > 0 ? distMm / feedMmpm : 0.5;
      const rapidMin = (2 * APPROACH_MM) / RAPID_MMPM;

      bd.push({
        process:  op.label || op.operation || toolKey,
        minutes:  r3(cutMin + rapidMin),
        category: "machining",
      });
    }

    if (toolChanges > 0) {
      bd.push({
        process:  `Tool Changes (${toolChanges}x)`,
        minutes:  r2(toolChanges * TOOL_CHANGE_MIN),
        category: "tool_change",
      });
    }

    const total = r2(bd.reduce((s: number, p: any) => s + p.minutes, 0));
    return { method: "cutting_parameter_based", total_minutes: total, breakdown: bd };
  }

  // ---- Heuristic path: legacy 2D extraction (no process map) ----
  const ext   = typeof args.extraction_json === "string"
    ? JSON.parse(args.extraction_json)
    : (args.extraction_json || {});

  // Support both new schema (dimensions array) and old schema (features array)
  const feats       = ext.features   || [];
  const dims        = ext.dimensions || [];
  const threads     = ext.threads    || [];
  const bd: any[]   = [{ process: "Setup", minutes: SETUP_MIN, category: "setup" }];
  const toolTypes   = new Set<string>();

  if (feats.length > 0) {
    // Old schema path
    for (const f of feats) {
      for (const p of featProcs(f)) bd.push({ ...p, category: "machining" });
      toolTypes.add(f.type || "");
    }
  } else {
    // New D&GDT schema path — estimate from dimension + thread count
    const dimCount    = dims.length;
    const threadCount = threads.length;
    if (dimCount > 0) {
      bd.push({ process: "Machining (dimension-based estimate)", minutes: r2(dimCount * 1.5), category: "machining" });
      toolTypes.add("mill");
    }
    for (const t of threads) {
      bd.push({ process: `Thread ${t.spec || "?"}`, minutes: 3.0, category: "machining" });
      toolTypes.add("thread_mill");
    }
    if (threadCount > 0) toolTypes.add("thread_mill");
  }

  if (toolTypes.size > 1) {
    bd.push({
      process:  `Tool Changes (${toolTypes.size - 1}x)`,
      minutes:  r2((toolTypes.size - 1) * TOOL_CHANGE_MIN),
      category: "tool_change",
    });
  }

  const total = r2(bd.reduce((s: number, p: any) => s + p.minutes, 0));
  return { method: "feature_based_heuristic", total_minutes: total, breakdown: bd };
}
