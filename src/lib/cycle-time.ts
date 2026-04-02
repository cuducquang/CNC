/**
 * Cycle time estimation — port of backend/app/services/cycle_time_estimator.py
 *
 * 2D flow: estimateFromFeatures() — heuristic scaling from VLM-extracted features
 * 3D flow: estimateFromProcesses() — precise calculation from process mapping
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ProcessMapResult } from "./process-mapping";

const SETUP_MINUTES = 10.0;
const TOOL_CHANGE_MINUTES = 0.5;
const RAPID_TRAVERSE_IPM = 200.0;
const APPROACH_RETRACT_INCHES = 0.25;

// ---------------------------------------------------------------------------
// 2D flow: feature-based heuristics
// ---------------------------------------------------------------------------

const REF_DIM: Record<string, number> = {
  hole: 0.34, fillet: 0.1, chamfer: 0.02, thread: 0.19,
  radius: 0.01, step: 0.125, slot: 0.25, pocket: 0.5,
  bore: 0.5, face: 1.0,
};

const BASE_TIME: Record<string, number> = {
  fillet: 3.0, step: 2.0, chamfer: 0.5, slot: 2.0,
  pocket_rough: 2.0, pocket_finish: 1.5,
  hole_rough: 1.5, hole_finish: 1.0,
  thread_drill: 0.75, thread_cut: 1.0,
  radius_per_unit: 0.125,
  bore: 2.0, face: 1.0,
};

function dimVal(feat: any): number {
  return parseFloat(feat?.dimensions?.primary_value || 0);
}

function scale(actual: number, ref: number): number {
  if (ref <= 0 || actual <= 0) return 1.0;
  return Math.max(0.3, Math.min(Math.pow(actual / ref, 0.7), 5.0));
}

function featureProcesses(feat: any): Array<{ process: string; minutes: number }> {
  const ftype = (feat.type || "").toLowerCase();
  const desc = feat.description || ftype;
  const qty = Math.max(parseInt(feat.quantity || 1), 1);
  const dim = dimVal(feat);
  const ref = REF_DIM[ftype] || 0.25;
  const s = scale(dim, ref);

  const procs: Array<{ process: string; minutes: number }> = [];

  if (ftype === "hole") {
    procs.push({ process: `Rough Milling - ${desc}`, minutes: round2(BASE_TIME["hole_rough"] * s) });
    procs.push({ process: `Finish Milling - ${desc}`, minutes: round2(BASE_TIME["hole_finish"] * s) });
  } else if (ftype === "thread") {
    procs.push({ process: "Drilling \u2013 Thread Hole", minutes: round2(BASE_TIME["thread_drill"] * s) });
    procs.push({ process: `Thread Cut - ${desc}`, minutes: round2(BASE_TIME["thread_cut"] * s) });
  } else if (ftype === "pocket") {
    procs.push({ process: `Rough Milling - ${desc}`, minutes: round2(BASE_TIME["pocket_rough"] * s) });
    procs.push({ process: `Finish Milling - ${desc}`, minutes: round2(BASE_TIME["pocket_finish"] * s) });
  } else if (ftype === "radius") {
    const per = round3(BASE_TIME["radius_per_unit"] * s);
    const label = qty > 1 ? `Milling \u2013 ${qty} x ${desc}` : `Milling \u2013 ${desc}`;
    procs.push({ process: label, minutes: round2(per * qty) });
  } else {
    const base = BASE_TIME[ftype] || 1.0;
    procs.push({ process: `Milling \u2013 ${desc}`, minutes: round2(base * s) });
  }

  return procs;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

export interface CycleTimeBreakdownItem {
  process: string;
  minutes: number;
  category: string;
  detail?: Record<string, any>;
}

export interface CycleTimeResult {
  method: string;
  total_minutes: number;
  breakdown: CycleTimeBreakdownItem[];
  formatted_lines: string[];
}

export function estimateFromFeatures(extraction: Record<string, any>): CycleTimeResult {
  const features = extraction.features || [];
  console.log(`[CycleTime] Estimating from ${features.length} features (2D mode)...`);

  const breakdown: CycleTimeBreakdownItem[] = [
    { process: "Setup", minutes: SETUP_MINUTES, category: "setup" },
  ];

  const toolTypes = new Set<string>();
  for (const feat of features) {
    for (const p of featureProcesses(feat)) {
      breakdown.push({ ...p, category: "machining" });
    }
    toolTypes.add(feat.type || "");
  }

  if (toolTypes.size > 1) {
    const tc = round2((toolTypes.size - 1) * TOOL_CHANGE_MINUTES);
    breakdown.push({ process: `Tool Changes (${toolTypes.size - 1}x)`, minutes: tc, category: "tool_change" });
  }

  const total = round2(breakdown.reduce((sum, p) => sum + p.minutes, 0));

  const formatted = ["\u2756 Cycle time breakdown to manufacturing processes:"];
  for (const p of breakdown) {
    formatted.push(`\u2022 ${p.process} : ${p.minutes} mins`);
  }

  return { method: "feature_based_heuristic", total_minutes: total, breakdown, formatted_lines: formatted };
}

// ---------------------------------------------------------------------------
// 3D flow: cutting-parameter-based (from process mapping)
// ---------------------------------------------------------------------------

export function estimateFromProcesses(processMap: ProcessMapResult): CycleTimeResult {
  const operations = processMap.operations;
  console.log(`[CycleTime] Estimating from ${operations.length} operations (3D mode)...`);

  const breakdown: CycleTimeBreakdownItem[] = [
    { process: "Setup", minutes: SETUP_MINUTES, category: "setup" },
  ];

  let prevTool: string | null = null;
  let toolChanges = 0;

  for (const op of operations) {
    const feedIpm = op.params.feed_rate_ipm || 1.0;
    const distance = op.toolpath_distance_in || 0;
    const toolKey = op.tool.key;

    if (prevTool !== null && toolKey !== prevTool) toolChanges++;
    prevTool = toolKey;

    const cutTime = feedIpm > 0 && distance > 0 ? distance / feedIpm : 0.5;
    const rapidTime = (2 * APPROACH_RETRACT_INCHES) / RAPID_TRAVERSE_IPM;
    const totalOp = round3(cutTime + rapidTime);

    breakdown.push({
      process: op.label,
      minutes: totalOp,
      category: "machining",
      detail: {
        cutting_min: Math.round(cutTime * 10000) / 10000,
        rapid_min: Math.round(rapidTime * 10000) / 10000,
        feed_ipm: feedIpm,
        distance_in: distance,
      },
    });
  }

  if (toolChanges > 0) {
    const tc = round2(toolChanges * TOOL_CHANGE_MINUTES);
    breakdown.push({ process: `Tool Changes (${toolChanges}x)`, minutes: tc, category: "tool_change" });
  }

  const total = round2(breakdown.reduce((sum, p) => sum + p.minutes, 0));

  const formatted = ["\u2756 Cycle time breakdown to manufacturing processes:"];
  for (const p of breakdown) {
    formatted.push(`\u2022 ${p.process} : ${p.minutes} mins`);
  }

  return { method: "cutting_parameter_based", total_minutes: total, breakdown, formatted_lines: formatted };
}
