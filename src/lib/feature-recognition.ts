/**
 * Manufacturing Feature Recognition — port of backend/app/services/feature_recognition.py
 *
 * Standardizes raw VLM features into typed manufacturing features with
 * geometry, tolerance classes, and material properties.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Known manufacturing feature types & type mapping
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  hole: "through_hole",
  fillet: "fillet",
  chamfer: "chamfer",
  step: "step",
  slot: "slot",
  pocket: "pocket",
  thread: "thread",
  bore: "bore",
  face: "face",
  radius: "fillet",
  groove: "groove",
  counterbore: "counterbore",
  countersink: "countersink",
};

// ---------------------------------------------------------------------------
// Material database
// ---------------------------------------------------------------------------

interface MaterialInfo {
  name: string;
  hardness_bhn: number;
  sfm_hss: number;
  sfm_carbide: number;
  feed_factor: number;
  density_lb_in3: number;
  cost_per_lb: number;
}

const MATERIALS: Record<string, MaterialInfo> = {
  "6061-T6": {
    name: "6061-T6 Aluminum",
    hardness_bhn: 95,
    sfm_hss: 300,
    sfm_carbide: 900,
    feed_factor: 1.0,
    density_lb_in3: 0.098,
    cost_per_lb: 3.0,
  },
  "7075-T6": {
    name: "7075-T6 Aluminum",
    hardness_bhn: 150,
    sfm_hss: 200,
    sfm_carbide: 700,
    feed_factor: 0.9,
    density_lb_in3: 0.101,
    cost_per_lb: 5.0,
  },
  "1018": {
    name: "1018 Mild Steel",
    hardness_bhn: 126,
    sfm_hss: 80,
    sfm_carbide: 450,
    feed_factor: 0.7,
    density_lb_in3: 0.284,
    cost_per_lb: 1.5,
  },
  "304_ss": {
    name: "304 Stainless Steel",
    hardness_bhn: 170,
    sfm_hss: 50,
    sfm_carbide: 300,
    feed_factor: 0.5,
    density_lb_in3: 0.289,
    cost_per_lb: 4.0,
  },
};

const DEFAULT_MATERIAL: MaterialInfo = {
  name: "Unknown Material (assumed Aluminum)",
  hardness_bhn: 100,
  sfm_hss: 250,
  sfm_carbide: 800,
  feed_factor: 0.9,
  density_lb_in3: 0.098,
  cost_per_lb: 3.0,
};

function matchMaterial(spec: string): MaterialInfo {
  if (!spec) return DEFAULT_MATERIAL;
  const specLower = spec.toLowerCase().replace(/-/g, "");
  for (const [key, mat] of Object.entries(MATERIALS)) {
    if (specLower.includes(key.toLowerCase().replace(/-/g, ""))) return mat;
    if (specLower.includes(mat.name.toLowerCase().split(" ")[0])) return mat;
  }
  if (specLower.includes("aluminum") || specLower.includes("aluminium")) return MATERIALS["6061-T6"];
  if (specLower.includes("stainless")) return MATERIALS["304_ss"];
  if (specLower.includes("steel")) return MATERIALS["1018"];
  return DEFAULT_MATERIAL;
}

// ---------------------------------------------------------------------------
// Tolerance classification
// ---------------------------------------------------------------------------

function toleranceClass(tol: any): string {
  if (!tol) return "general";
  const plus = Math.abs(parseFloat(tol.plus || 0));
  const minus = Math.abs(parseFloat(tol.minus || 0));
  const band = plus + minus;
  if (band <= 0.001) return "precision";
  if (band <= 0.005) return "close";
  if (band <= 0.010) return "medium";
  return "general";
}

// ---------------------------------------------------------------------------
// Geometry inference
// ---------------------------------------------------------------------------

function inferGeometry(feat: any): Record<string, any> {
  const dims = feat.dimensions || {};
  const primary = parseFloat(dims.primary_value || 0);
  const unit = dims.unit || "inch";
  const geo: Record<string, any> = { unit };
  const ftype = (feat.type || "").toLowerCase();

  if (["hole", "bore", "counterbore", "countersink"].includes(ftype)) {
    geo.diameter = primary || 0.25;
    geo.depth = parseFloat(dims.depth || geo.diameter * 2);
  } else if (ftype === "thread") {
    geo.diameter = primary || 0.19;
    geo.tpi = parseFloat(dims.tpi || 20);
    geo.depth = parseFloat(dims.depth || geo.diameter * 1.5);
  } else if (ftype === "fillet" || ftype === "radius") {
    geo.radius = primary || 0.05;
  } else if (ftype === "chamfer") {
    geo.width = primary || 0.02;
    geo.angle = parseFloat(dims.angle || 45);
  } else if (ftype === "step") {
    geo.depth = primary || 0.125;
    geo.width = parseFloat(dims.width || (primary ? primary * 4 : 0.5));
  } else if (ftype === "slot") {
    geo.width = primary || 0.25;
    geo.length = parseFloat(dims.length || (primary ? primary * 4 : 1.0));
    geo.depth = parseFloat(dims.depth || (primary || 0.25));
  } else if (ftype === "pocket") {
    geo.width = primary || 0.5;
    geo.length = parseFloat(dims.length || (primary ? primary * 2 : 1.0));
    geo.depth = parseFloat(dims.depth || 0.25);
  } else if (ftype === "face") {
    geo.width = primary || 1.0;
    geo.length = parseFloat(dims.length || (primary || 1.0));
  } else {
    geo.primary_value = primary || 0.25;
  }

  return geo;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RecognizedFeature {
  id: string;
  raw_type: string;
  mfg_type: string;
  description: string;
  quantity: number;
  geometry: Record<string, any>;
  tolerance: any;
  tolerance_class: string;
}

export interface RecognitionResult {
  material: MaterialInfo;
  material_spec: string;
  features: RecognizedFeature[];
  feature_count: number;
}

export function recognizeFeatures(extraction: Record<string, any>): RecognitionResult {
  const rawFeatures = extraction.features || [];
  const rawMaterial = extraction.material || {};
  const materialSpec: string = rawMaterial.specification || "";

  const material = matchMaterial(materialSpec);
  console.log(`[FeatureRecognition] Material identified: ${material.name}`);

  const recognized: RecognizedFeature[] = [];

  for (const feat of rawFeatures) {
    const rawType = (feat.type || "unknown").toLowerCase();
    const mfgType = TYPE_MAP[rawType] || rawType;
    const qty = Math.max(parseInt(feat.quantity || 1), 1);
    const tol = feat.tolerance;
    const tolClass = toleranceClass(tol);
    const geometry = inferGeometry(feat);

    recognized.push({
      id: feat.id,
      raw_type: rawType,
      mfg_type: mfgType,
      description: feat.description || rawType,
      quantity: qty,
      geometry,
      tolerance: tol,
      tolerance_class: tolClass,
    });
  }

  console.log(`[FeatureRecognition] Complete: ${recognized.length} features recognized`);

  return {
    material,
    material_spec: materialSpec,
    features: recognized,
    feature_count: recognized.length,
  };
}
