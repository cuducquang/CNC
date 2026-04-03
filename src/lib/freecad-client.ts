/**
 * Client for the CNCapp Python microservice.
 *
 * New deterministic flow:
 *   analyzeFull(stepBlob, filename, drawingExtraction)
 *     → POST /analyze  (STEP + VLM extraction JSON)
 *     → returns {features, process_map, shape_summary}
 *
 * Legacy analyzeStep() is kept for the /analyze/step diagnostic endpoint.
 *
 * Set PYTHON_SERVICE_URL in .env.local:
 *   PYTHON_SERVICE_URL=http://localhost:8001
 */

const BASE_URL = (
  process.env.PYTHON_SERVICE_URL || "http://localhost:8001"
).replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Shared shape summary type
// ---------------------------------------------------------------------------

export interface ShapeSummary {
  shape_type:  string;
  n_solids:    number;
  n_faces:     number;
  n_edges:     number;
  n_vertices:  number;
  bbox_x_mm:   number;
  bbox_y_mm:   number;
  bbox_z_mm:   number;
  volume_mm3:  number;
  area_mm2:    number;
}

// ---------------------------------------------------------------------------
// Drawing extraction — mirrors VLM output schema from vision-drawing-shared.ts
// ---------------------------------------------------------------------------

export interface DimensionItem {
  id:              string;
  label:           string;
  nominal:         number;
  unit:            string;
  tolerance_plus?: number;
  tolerance_minus?: number;
  quantity?:       number;
}

export interface GdtItem {
  id:        string;
  symbol:    string;
  tolerance: number;
  unit:      string;
  datums:    string[];
}

export interface ThreadItem {
  id:       string;
  spec:     string;
  depth_mm: number;
  quantity: number;
}

export interface DrawingExtraction {
  dimensions?:     DimensionItem[];
  gdt?:            GdtItem[];
  threads?:        ThreadItem[];
  material?:       string | null;
  surface_finish?: string | null;
  notes?:          string[];
}

// ---------------------------------------------------------------------------
// Full analysis result  (POST /analyze)
// ---------------------------------------------------------------------------

export interface RecognizedFeature3D {
  id:          string;
  name:        string;
  type:        string;
  description: string;
  dimensions?: Record<string, string>;
  source:      string;   // "freecad" | "brepMFR"
}

export interface ProcessOperation {
  id:                   string;
  feature_id:           string;
  sequence:             number;
  operation:            string;
  label:                string;
  tool: {
    type:        string;
    diameter_mm: number;
    material:    string;
    teeth:       number;
  };
  params: {
    spindle_rpm:    number;
    feed_rate_mmpm: number;
    depth_mm:       number;
    width_mm?:      number;
    pitch_mm?:      number;
  };
  toolpath_distance_mm: number;
}

export interface FullAnalysisResult {
  success:        boolean;
  error?:         string;
  shape_summary?: ShapeSummary;
  features:       RecognizedFeature3D[];
  process_map:    ProcessOperation[];
  feature_source: string;
}

// ---------------------------------------------------------------------------
// Legacy step-only result  (POST /analyze/step)
// ---------------------------------------------------------------------------

export interface StepAnalysisResult {
  success: boolean;
  error?:  string;
  shape_summary?: ShapeSummary;
  feature_recognition?: {
    features: {
      id:          string;
      name:        string;
      type:        string;
      description: string;
      dimensions?: Record<string, string>;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function checkFreecadHealth(): Promise<{
  available:          boolean;
  freecad_available:  boolean;
}> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { available: false, freecad_available: false };
    const data = await res.json();
    return { available: true, freecad_available: data.freecad_available ?? false };
  } catch {
    return { available: false, freecad_available: false };
  }
}

// ---------------------------------------------------------------------------
// Full analysis: STEP + VLM extraction → features + process map
// ---------------------------------------------------------------------------

/**
 * Send a STEP file + VLM drawing extraction to the Python microservice.
 * Returns recognised features (BrepMFR → FreeCAD fallback) and process map.
 *
 * Cycle time and cost estimation are computed in Next.js from the process_map.
 */
export async function analyzeFull(
  stepBlob:         Blob,
  filename:         string,
  drawingExtraction: DrawingExtraction,
  material?:        string,
): Promise<FullAnalysisResult> {
  const form = new FormData();
  form.append("file_3d", stepBlob, filename);
  form.append("drawing_extraction", JSON.stringify(drawingExtraction));
  if (material) form.append("material", material);

  const res = await fetch(`${BASE_URL}/analyze`, {
    method: "POST",
    body:   form,
    signal: AbortSignal.timeout(180_000),  // BrepMFR + FreeCAD can be slow
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Python /analyze returned ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json() as Promise<FullAnalysisResult>;
}

// ---------------------------------------------------------------------------
// Legacy: geometry-only STEP analysis  (diagnostic / /analyze/step endpoint)
// ---------------------------------------------------------------------------

export async function analyzeStep(
  stepBlob: Blob,
  filename: string,
): Promise<StepAnalysisResult> {
  const form = new FormData();
  form.append("file_3d", stepBlob, filename);

  const res = await fetch(`${BASE_URL}/analyze/step`, {
    method: "POST",
    body:   form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Python /analyze/step returned ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json() as Promise<StepAnalysisResult>;
}
