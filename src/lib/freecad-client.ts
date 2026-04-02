/**
 * Client for the CNCapp Python microservice (FreeCAD headless).
 *
 * The Python service only performs STEP geometry analysis (FreeCAD).
 * All downstream steps — VL extraction, feature recognition, process
 * mapping, cycle time and cost — run in Next.js.
 *
 * Set PYTHON_SERVICE_URL in .env.local:
 *   PYTHON_SERVICE_URL=http://localhost:8001
 */

const BASE_URL = (
  process.env.PYTHON_SERVICE_URL || "http://localhost:8001"
).replace(/\/$/, "");

// Shape of the Python /analyze/step response
export interface StepAnalysisResult {
  success: boolean;
  error?: string;
  shape_summary?: {
    shape_type: string;
    n_solids: number;
    n_faces: number;
    n_edges: number;
    n_vertices: number;
    bbox_x_mm: number;
    bbox_y_mm: number;
    bbox_z_mm: number;
    volume_mm3: number;
    area_mm2: number;
  };
  feature_recognition?: {
    features: {
      id: string;
      name: string;
      type: string;
      description: string;
      dimensions?: Record<string, string>;
    }[];
  };
}

/**
 * Check whether the Python microservice is reachable and FreeCAD is available.
 */
export async function checkFreecadHealth(): Promise<{
  available: boolean;
  freecad_available: boolean;
}> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { available: false, freecad_available: false };
    const data = await res.json();
    return {
      available: true,
      freecad_available: data.freecad_available ?? false,
    };
  } catch {
    return { available: false, freecad_available: false };
  }
}

/**
 * Send a STEP file to the Python microservice for FreeCAD geometry analysis.
 * Returns shape summary + raw 3D feature list (no process mapping or cost).
 */
export async function analyzeStep(
  stepBlob: Blob,
  filename: string,
): Promise<StepAnalysisResult> {
  const form = new FormData();
  form.append("file_3d", stepBlob, filename);

  const res = await fetch(`${BASE_URL}/analyze/step`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000), // FreeCAD analysis timeout
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Python service returned ${res.status}: ${text.slice(0, 300)}`,
    );
  }

  return res.json() as Promise<StepAnalysisResult>;
}
