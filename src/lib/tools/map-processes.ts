/**
 * Tool: map_cnc_processes
 *
 * Maps recognized manufacturing features to CNC operations with tooling,
 * cutting parameters, and toolpath distance estimation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "map_cnc_processes",
    description:
      "Map recognized manufacturing features to specific CNC operations with tooling selection, cutting parameters (RPM, feed rate, feed per tooth), and toolpath distance estimation. Requires the output from recognize_features.",
    parameters: {
      type: "object",
      properties: {
        recognition_json: {
          type: "string",
          description: "JSON string of the recognition result from recognize_features",
        },
      },
      required: ["recognition_json"],
    },
  },
};

// ---------------------------------------------------------------------------
// Tooling definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  type: string;
  diameter?: number;
  teeth: number;
  fpt?: number;
  fpt_per_inch_dia?: number;
  tool_material: string;
}

const TOOLS: Record<string, ToolDef> = {
  center_drill:  { type: "center_drill",  diameter: 0.125, teeth: 2, fpt: 0.001,             tool_material: "HSS"     },
  twist_drill:   { type: "twist_drill",                    teeth: 2, fpt_per_inch_dia: 0.004, tool_material: "HSS"     },
  reamer:        { type: "reamer",                         teeth: 6, fpt: 0.002,              tool_material: "HSS"     },
  end_mill_2f:   { type: "end_mill",                       teeth: 2, fpt: 0.003,              tool_material: "Carbide" },
  end_mill_4f:   { type: "end_mill",                       teeth: 4, fpt: 0.002,              tool_material: "Carbide" },
  ball_end_mill: { type: "ball_end_mill",                  teeth: 2, fpt: 0.002,              tool_material: "Carbide" },
  thread_mill:   { type: "thread_mill",                    teeth: 1, fpt: 0.001,              tool_material: "Carbide" },
  chamfer_mill:  { type: "chamfer_mill",                   teeth: 2, fpt: 0.002,              tool_material: "Carbide" },
};

const FEATURE_OPS: Record<string, Array<{ op: string; tool: string; label: string }>> = {
  through_hole: [{ op: "center_drill", tool: "center_drill", label: "Center Drill" }, { op: "drill", tool: "twist_drill", label: "Drill" }],
  blind_hole:   [{ op: "center_drill", tool: "center_drill", label: "Center Drill" }, { op: "drill", tool: "twist_drill", label: "Drill" }],
  fillet:       [{ op: "finish_mill",  tool: "ball_end_mill", label: "Finish Mill" }],
  chamfer:      [{ op: "chamfer",      tool: "chamfer_mill",  label: "Chamfer Mill" }],
  step:         [{ op: "rough_mill",   tool: "end_mill_4f",   label: "Rough Mill"   }, { op: "finish_mill", tool: "end_mill_4f", label: "Finish Mill" }],
  slot:         [{ op: "slot_mill",    tool: "end_mill_2f",   label: "Slot Mill" }],
  pocket:       [{ op: "rough_mill",   tool: "end_mill_4f",   label: "Rough Mill"   }, { op: "finish_mill", tool: "end_mill_4f", label: "Finish Mill" }],
  thread:       [{ op: "center_drill", tool: "center_drill", label: "Center Drill"  }, { op: "drill", tool: "twist_drill", label: "Drill" }, { op: "thread_mill", tool: "thread_mill", label: "Thread Mill" }],
  bore:         [{ op: "rough_mill",   tool: "end_mill_4f",   label: "Rough Bore"   }, { op: "finish_mill", tool: "end_mill_4f", label: "Finish Bore" }],
  face:         [{ op: "face_mill",    tool: "end_mill_4f",   label: "Face Mill" }],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calcRpm(sfm: number, dia: number): number {
  return dia <= 0 ? 1000 : Math.round((sfm * 12) / (Math.PI * dia));
}

function calcFeed(rpm: number, fpt: number, teeth: number): number {
  return Math.round(rpm * fpt * teeth * 100) / 100;
}

function toolDia(key: string, geo: any): number {
  if (key === "center_drill") return TOOLS[key].diameter!;
  if (key === "twist_drill" || key === "reamer") return geo.diameter || 0.25;
  if (key === "thread_mill") return (geo.diameter || 0.19) * 0.7;
  return Math.max(0.125, (geo.diameter || geo.width || (geo.radius || 0) * 2 || 0.25) * 0.6);
}

function toolpathDist(op: string, geo: any): number {
  const d = geo.diameter || 0.25, depth = geo.depth || d * 2, w = geo.width || 0.25, l = geo.length || w * 3;
  if (["drill", "center_drill", "ream"].includes(op)) return depth;
  if (op === "thread_mill") { const p = 1 / (geo.tpi || 20); return Math.PI * d * (depth / p); }
  if (["rough_mill", "finish_mill", "rough_bore", "finish_bore"].includes(op)) {
    if (d > 0 && geo.diameter) { const sd = Math.max(0.02, d * 0.1); return Math.PI * d * Math.max(1, Math.ceil(depth / sd)); }
    return l * Math.max(1, Math.ceil(w / Math.max(0.05, w * 0.4)));
  }
  if (op === "chamfer") return Math.max(d > 0 ? Math.PI * d : Math.PI * w * 2, 0.5);
  if (op === "slot_mill") return l;
  if (op === "face_mill") return l * Math.max(1, Math.ceil(w / 0.5));
  return depth + 0.5;
}

// ---------------------------------------------------------------------------
// Handler — runs when the LLM calls map_cnc_processes
// ---------------------------------------------------------------------------

export async function mapCncProcesses(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const recognition = typeof args.recognition_json === "string"
    ? JSON.parse(args.recognition_json) : args.recognition_json;

  const features = recognition.features || [];
  const material  = recognition.material || { sfm_carbide: 800, sfm_hss: 250, feed_factor: 0.9 };
  const operations: any[] = [];
  let opId = 0;

  for (const feat of features) {
    let ops = FEATURE_OPS[feat.mfg_type] || FEATURE_OPS["through_hole"] || [];
    if (["through_hole", "blind_hole"].includes(feat.mfg_type) && ["precision", "close"].includes(feat.tolerance_class)) {
      ops = [...ops, { op: "ream", tool: "reamer", label: "Ream" }];
    }

    for (const tmpl of ops) {
      const tool = TOOLS[tmpl.tool];
      const td   = toolDia(tmpl.tool, feat.geometry);
      const sfm  = tool.tool_material === "Carbide" ? material.sfm_carbide : material.sfm_hss;
      const rpm  = calcRpm(sfm, td);
      const fpt  = tool.fpt || (tool.fpt_per_inch_dia || 0.003) * td;
      const feed = calcFeed(rpm, fpt * material.feed_factor, tool.teeth);
      const dist = toolpathDist(tmpl.op, feat.geometry) * feat.quantity;

      operations.push({
        id: `op_${++opId}`,
        operation: tmpl.op,
        label:     `${tmpl.label} - ${feat.description}`,
        feature_id: feat.id,
        quantity:   feat.quantity,
        tool: { key: tmpl.tool, type: tool.type, diameter: Math.round(td * 1e4) / 1e4, material: tool.tool_material, teeth: tool.teeth },
        params: { spindle_rpm: rpm, feed_rate_ipm: feed, feed_per_tooth: Math.round(fpt * material.feed_factor * 1e4) / 1e4 },
        toolpath_distance_in: Math.round(dist * 1e3) / 1e3,
      });
    }
  }

  operations.sort((a, b) => a.tool.key.localeCompare(b.tool.key));
  return { material, operations, operation_count: operations.length };
}
