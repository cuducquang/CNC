/**
 * Tool: recognize_features
 *
 * Merges 3D geometric features (from analyze_step_file / FreeCAD) with
 * 2D GD&T/tolerance data (from analyze_drawing / VLM) to produce an
 * enriched feature set that drives process mapping.
 *
 * Two paths:
 *   3D + 2D  →  FreeCAD geometry tagged with drawing tolerances  (preferred)
 *   2D only  →  VLM features classified into mfg types           (fallback)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";
import { matchMaterial } from "../materials";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "recognize_features",
    description:
      "Merge 3D CAD features (from analyze_step_file) with 2D GD&T/tolerance data (from analyze_drawing) to produce an enriched feature set. When both inputs are provided the 3D geometry is used as ground truth and 2D tolerance callouts are tagged onto matching features. Pass both JSON outputs.",
    parameters: {
      type: "object",
      properties: {
        extraction_json: {
          type: "string",
          description: "JSON output from analyze_drawing (2D GD&T, tolerances, material, features list)",
        },
        step_analysis_json: {
          type: "string",
          description: "JSON output from analyze_step_file (3D features from FreeCAD). Include this whenever available — it provides ground-truth geometry.",
        },
      },
      required: ["extraction_json"],
    },
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MM_TO_IN = 1 / 25.4; // FreeCAD reports dimensions in mm; downstream works in inches

const TYPE_MAP: Record<string, string> = {
  hole: "through_hole", fillet: "fillet", chamfer: "chamfer", step: "step",
  slot: "slot", pocket: "pocket", thread: "thread", bore: "bore",
  face: "face", radius: "fillet", groove: "groove",
  counterbore: "counterbore", countersink: "countersink",
  cylindrical: "bore", planar: "face",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toleranceClass(tol: any): string {
  if (!tol) return "general";
  const band = Math.abs(parseFloat(tol.plus || 0)) + Math.abs(parseFloat(tol.minus || 0));
  if (band <= 0.001) return "precision";
  if (band <= 0.005) return "close";
  if (band <= 0.010) return "medium";
  return "general";
}

/**
 * Convert a FreeCAD dimension dict (mm) to inches.
 * Numeric keys are converted; non-numeric and meta keys are passed through.
 */
function convertDimsToInches(dims: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { unit: "inch" };
  for (const [k, v] of Object.entries(dims)) {
    if (k === "unit") continue;
    out[k] = typeof v === "number" ? Math.round(v * MM_TO_IN * 1e4) / 1e4 : v;
  }
  return out;
}

/**
 * Infer geometry for 2D-only features (used when no STEP data is available).
 */
function inferGeometry2D(feat: any): Record<string, any> {
  const dims    = feat.dimensions || {};
  const primary = parseFloat(dims.primary_value || 0);
  const unit    = dims.unit || "inch";
  const geo: Record<string, any> = { unit };
  const ft = (feat.type || "").toLowerCase();

  if (["hole", "bore", "counterbore", "countersink"].includes(ft)) {
    geo.diameter = primary || 0.25; geo.depth = parseFloat(dims.depth || geo.diameter * 2);
  } else if (ft === "thread") {
    geo.diameter = primary || 0.19; geo.tpi = parseFloat(dims.tpi || 20); geo.depth = parseFloat(dims.depth || geo.diameter * 1.5);
  } else if (ft === "fillet" || ft === "radius") {
    geo.radius = primary || 0.05;
  } else if (ft === "chamfer") {
    geo.width = primary || 0.02; geo.angle = parseFloat(dims.angle || 45);
  } else if (ft === "step") {
    geo.depth = primary || 0.125; geo.width = parseFloat(dims.width || (primary ? primary * 4 : 0.5));
  } else if (ft === "slot") {
    geo.width = primary || 0.25; geo.length = parseFloat(dims.length || (primary ? primary * 4 : 1.0)); geo.depth = parseFloat(dims.depth || (primary || 0.25));
  } else if (ft === "pocket") {
    geo.width = primary || 0.5; geo.length = parseFloat(dims.length || (primary ? primary * 2 : 1.0)); geo.depth = parseFloat(dims.depth || 0.25);
  } else if (ft === "face") {
    geo.width = primary || 1.0; geo.length = parseFloat(dims.length || (primary || 1.0));
  } else {
    geo.primary_value = primary || 0.25;
  }
  return geo;
}

// ---------------------------------------------------------------------------
// 3D + 2D merge path
// ---------------------------------------------------------------------------

/**
 * Tag 3D features with tolerance/GD&T data from the 2D drawing.
 *
 * Matching strategy: group 2D features by normalized type, then assign
 * them to 3D features of the same type in ordinal order. This is a
 * simplified version of the Python FeatureTagger that avoids coordinate
 * matching (which requires unit-consistent 3D coordinates).
 */
function tag3dWith2d(
  features3d: any[],
  features2d: any[],
  gdtCallouts: any[],
): any[] {
  // Index 2D features by normalized type
  const byType: Record<string, any[]> = {};
  for (const f of features2d) {
    const t = TYPE_MAP[(f.type || "").toLowerCase()] || (f.type || "other").toLowerCase();
    (byType[t] = byType[t] || []).push(f);
  }
  const cursor: Record<string, number> = {};

  return features3d.map((feat3d: any) => {
    const rawType = (feat3d.type || "other").toLowerCase();
    const mfgType = TYPE_MAP[rawType] || rawType;

    // Pick the next unmatched 2D feature of the same type
    cursor[mfgType] = cursor[mfgType] ?? 0;
    const match2d   = (byType[mfgType] || [])[cursor[mfgType]];
    if (match2d) cursor[mfgType]++;

    // GD&T callouts referencing this feature ID or its 2D match
    const relatedGdt = gdtCallouts.filter(
      (g: any) => g.feature_id === feat3d.id || (match2d && g.feature_id === match2d.id),
    );

    return {
      id:              feat3d.id,
      raw_type:        rawType,
      mfg_type:        mfgType,
      description:     feat3d.description || feat3d.name || rawType,
      quantity:        Math.max(parseInt(match2d?.quantity ?? 1), 1),
      // 3D dims converted to inches (FreeCAD is mm-native)
      geometry:        convertDimsToInches(feat3d.dimensions || {}),
      // Tolerance from the matching 2D feature (or null = general)
      tolerance:       match2d?.tolerance ?? null,
      tolerance_class: toleranceClass(match2d?.tolerance),
      gdt_callouts:    relatedGdt,
      source:          "3d",
    };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function recognizeFeatures(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const extraction    = typeof args.extraction_json === "string"
    ? JSON.parse(args.extraction_json) : (args.extraction_json ?? {});
  const stepAnalysis  = args.step_analysis_json
    ? (typeof args.step_analysis_json === "string" ? JSON.parse(args.step_analysis_json) : args.step_analysis_json)
    : null;

  const materialSpec  = (extraction.material?.specification as string) || "";
  const material      = matchMaterial(materialSpec);

  const features3d    = stepAnalysis?.features_3d ?? [];
  const features2d    = extraction.features        ?? [];
  const gdtCallouts   = extraction.gdt             ?? [];

  // ── 3D + 2D merge path ────────────────────────────────────────────────────
  if (features3d.length > 0) {
    const enriched = tag3dWith2d(features3d, features2d, gdtCallouts);
    console.log(`[Tool:recognize_features] Merged ${enriched.length} 3D features with ${features2d.length} 2D annotations`);
    return {
      material,
      material_spec:  materialSpec,
      features:       enriched,
      feature_count:  enriched.length,
      source:         "3d+2d",
      shape_summary:  stepAnalysis?.shape_summary ?? null,
    };
  }

  // ── 2D-only fallback ──────────────────────────────────────────────────────
  // (Reached only if STEP analysis returned zero features — e.g. simple geometry)
  console.warn("[Tool:recognize_features] No 3D features available — falling back to 2D classification only");
  const recognized = features2d.map((feat: any) => {
    const rawType = (feat.type || "unknown").toLowerCase();
    return {
      id:              feat.id,
      raw_type:        rawType,
      mfg_type:        TYPE_MAP[rawType] || rawType,
      description:     feat.description || rawType,
      quantity:        Math.max(parseInt(feat.quantity || 1), 1),
      geometry:        inferGeometry2D(feat),
      tolerance:       feat.tolerance,
      tolerance_class: toleranceClass(feat.tolerance),
      gdt_callouts:    gdtCallouts.filter((g: any) => g.feature_id === feat.id),
      source:          "2d",
    };
  });

  return {
    material,
    material_spec:  materialSpec,
    features:       recognized,
    feature_count:  recognized.length,
    source:         "2d",
    shape_summary:  null,
  };
}
