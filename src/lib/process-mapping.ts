/**
 * CNC Process Mapping — port of backend/app/services/process_mapping.py
 *
 * Selects tools, calculates cutting parameters (RPM, feed rate, DOC),
 * and estimates toolpath distances for each operation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { RecognitionResult } from "./feature-recognition";

// ---------------------------------------------------------------------------
// Tool library
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
  center_drill: { type: "center_drill", diameter: 0.125, teeth: 2, fpt: 0.001, tool_material: "HSS" },
  twist_drill: { type: "twist_drill", teeth: 2, fpt_per_inch_dia: 0.004, tool_material: "HSS" },
  reamer: { type: "reamer", teeth: 6, fpt: 0.002, tool_material: "HSS" },
  end_mill_2f: { type: "end_mill", teeth: 2, fpt: 0.003, tool_material: "Carbide" },
  end_mill_4f: { type: "end_mill", teeth: 4, fpt: 0.002, tool_material: "Carbide" },
  ball_end_mill: { type: "ball_end_mill", teeth: 2, fpt: 0.002, tool_material: "Carbide" },
  thread_mill: { type: "thread_mill", teeth: 1, fpt: 0.001, tool_material: "Carbide" },
  chamfer_mill: { type: "chamfer_mill", teeth: 2, fpt: 0.002, tool_material: "Carbide" },
};

// ---------------------------------------------------------------------------
// Feature → operations mapping
// ---------------------------------------------------------------------------

interface OpTemplate {
  op: string;
  tool: string;
  label: string;
}

const FEATURE_OPS: Record<string, OpTemplate[]> = {
  through_hole: [
    { op: "center_drill", tool: "center_drill", label: "Center Drill" },
    { op: "drill", tool: "twist_drill", label: "Drill" },
  ],
  blind_hole: [
    { op: "center_drill", tool: "center_drill", label: "Center Drill" },
    { op: "drill", tool: "twist_drill", label: "Drill" },
  ],
  fillet: [{ op: "finish_mill", tool: "ball_end_mill", label: "Finish Mill" }],
  chamfer: [{ op: "chamfer", tool: "chamfer_mill", label: "Chamfer Mill" }],
  step: [
    { op: "rough_mill", tool: "end_mill_4f", label: "Rough Mill" },
    { op: "finish_mill", tool: "end_mill_4f", label: "Finish Mill" },
  ],
  slot: [{ op: "slot_mill", tool: "end_mill_2f", label: "Slot Mill" }],
  pocket: [
    { op: "rough_mill", tool: "end_mill_4f", label: "Rough Mill" },
    { op: "finish_mill", tool: "end_mill_4f", label: "Finish Mill" },
  ],
  thread: [
    { op: "center_drill", tool: "center_drill", label: "Center Drill" },
    { op: "drill", tool: "twist_drill", label: "Drill" },
    { op: "thread_mill", tool: "thread_mill", label: "Thread Mill" },
  ],
  bore: [
    { op: "rough_mill", tool: "end_mill_4f", label: "Rough Bore" },
    { op: "finish_mill", tool: "end_mill_4f", label: "Finish Bore" },
  ],
  face: [{ op: "face_mill", tool: "end_mill_4f", label: "Face Mill" }],
};

const TIGHT_TOL_EXTRA: OpTemplate = { op: "ream", tool: "reamer", label: "Ream" };

// ---------------------------------------------------------------------------
// Cutting parameter calculations
// ---------------------------------------------------------------------------

function calcRpm(sfm: number, toolDia: number): number {
  if (toolDia <= 0) return 1000;
  return Math.round((sfm * 12) / (Math.PI * toolDia));
}

function calcFeedIpm(rpm: number, fpt: number, teeth: number): number {
  return Math.round(rpm * fpt * teeth * 100) / 100;
}

function toolDiameter(toolKey: string, featureGeo: Record<string, any>): number {
  const tool = TOOLS[toolKey];
  if (toolKey === "center_drill") return tool.diameter!;
  if (toolKey === "twist_drill") return featureGeo.diameter || 0.25;
  if (toolKey === "reamer") return featureGeo.diameter || 0.25;
  if (toolKey === "thread_mill") return (featureGeo.diameter || 0.19) * 0.7;
  const featDim = featureGeo.diameter || featureGeo.width || (featureGeo.radius || 0) * 2 || 0.25;
  return Math.max(0.125, featDim * 0.6);
}

// ---------------------------------------------------------------------------
// Toolpath distance estimation
// ---------------------------------------------------------------------------

function toolpathDistance(opType: string, geo: Record<string, any>): number {
  const diameter = geo.diameter || 0.25;
  const depth = geo.depth || diameter * 2;
  const width = geo.width || 0.25;
  const length = geo.length || width * 3;
  const radius = geo.radius || 0.05;

  if (["drill", "center_drill", "ream"].includes(opType)) return depth;

  if (opType === "thread_mill") {
    const pitch = 1.0 / (geo.tpi || 20);
    const turns = depth / pitch;
    return Math.PI * diameter * turns;
  }

  if (["rough_mill", "finish_mill", "rough_bore", "finish_bore"].includes(opType)) {
    if (diameter > 0 && geo.diameter) {
      const stepDown = Math.max(0.02, diameter * 0.1);
      const passes = Math.max(1, Math.ceil(depth / stepDown));
      return Math.PI * diameter * passes;
    }
    const stepOver = Math.max(0.05, width * 0.4);
    const rows = Math.max(1, Math.ceil(width / stepOver));
    return length * rows;
  }

  if (opType === "chamfer") {
    const circ = diameter > 0 ? Math.PI * diameter : Math.PI * width * 2;
    return Math.max(circ, 0.5);
  }

  if (opType === "slot_mill") return length;

  if (opType === "face_mill") {
    const stepOver = 0.5;
    const rows = Math.max(1, Math.ceil(width / stepOver));
    return length * rows;
  }

  return depth + 0.5;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MappedOperation {
  id: string;
  operation: string;
  label: string;
  feature_id: string;
  quantity: number;
  tool: {
    key: string;
    type: string;
    diameter: number;
    material: string;
    teeth: number;
  };
  params: {
    spindle_rpm: number;
    feed_rate_ipm: number;
    feed_per_tooth: number;
  };
  toolpath_distance_in: number;
}

export interface ProcessMapResult {
  material: Record<string, any>;
  operations: MappedOperation[];
  operation_count: number;
}

export function mapProcesses(recognition: RecognitionResult): ProcessMapResult {
  const features = recognition.features;
  const material = recognition.material;
  const sfmCarbide = material.sfm_carbide;
  const sfmHss = material.sfm_hss;
  const feedFactor = material.feed_factor;

  console.log(`[ProcessMapping] Mapping processes for ${features.length} features`);

  const operations: MappedOperation[] = [];
  let opId = 0;

  for (const feat of features) {
    const mfgType = feat.mfg_type;
    const geo = feat.geometry;
    const qty = feat.quantity;
    const tolClass = feat.tolerance_class;
    const desc = feat.description;

    let opTemplates = FEATURE_OPS[mfgType] || FEATURE_OPS["through_hole"] || [];

    if (["through_hole", "blind_hole"].includes(mfgType) && ["precision", "close"].includes(tolClass)) {
      opTemplates = [...opTemplates, TIGHT_TOL_EXTRA];
    }

    for (const tmpl of opTemplates) {
      const toolKey = tmpl.tool;
      const tool = TOOLS[toolKey];
      const opType = tmpl.op;

      const toolDia = toolDiameter(toolKey, geo);
      const sfm = tool.tool_material === "Carbide" ? sfmCarbide : sfmHss;
      const rpm = calcRpm(sfm, toolDia);

      const fpt = tool.fpt || (tool.fpt_per_inch_dia || 0.003) * toolDia;
      const teeth = tool.teeth;
      const feedIpm = calcFeedIpm(rpm, fpt * feedFactor, teeth);

      const distance = toolpathDistance(opType, geo);
      const totalDistance = distance * qty;

      opId++;
      operations.push({
        id: `op_${opId}`,
        operation: opType,
        label: `${tmpl.label} - ${desc}`,
        feature_id: feat.id,
        quantity: qty,
        tool: {
          key: toolKey,
          type: tool.type,
          diameter: Math.round(toolDia * 10000) / 10000,
          material: tool.tool_material,
          teeth,
        },
        params: {
          spindle_rpm: rpm,
          feed_rate_ipm: feedIpm,
          feed_per_tooth: Math.round(fpt * feedFactor * 10000) / 10000,
        },
        toolpath_distance_in: Math.round(totalDistance * 1000) / 1000,
      });
    }
  }

  // Sort by tool to minimize tool changes
  operations.sort((a, b) => a.tool.key.localeCompare(b.tool.key));

  console.log(`[ProcessMapping] Complete: ${operations.length} operations`);

  return {
    material,
    operations,
    operation_count: operations.length,
  };
}
