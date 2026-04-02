/**
 * Tool: analyze_step_file
 *
 * Sends the uploaded STEP/STP file to the Python microservice (FreeCAD headless)
 * for 3D geometric feature extraction: holes, pockets, faces, fillets, threads, etc.
 *
 * Returns raw 3D features with precise dimensions (in mm, FreeCAD native units)
 * that will be enriched with GD&T/tolerance data from the 2D drawing in
 * the recognize_features step.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition, ToolContext } from "../agent/types";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "analyze_step_file",
    description:
      "Analyze a 3D STEP/STP CAD file using FreeCAD to extract precise geometric features (holes, pockets, faces, fillets, threads, chamfers) with actual dimensions from the solid model. Must be called AFTER analyze_drawing so that the 2D GD&T data is available for the subsequent feature recognition step.",
    parameters: {
      type: "object",
      properties: {
        material: {
          type: "string",
          description: "Material code for cost pre-estimation (e.g. 'Al6061', 'SS304', 'Ti6Al4V'). Defaults to 'Al6061'.",
        },
      },
      required: [],
    },
  },
};

// ---------------------------------------------------------------------------
// Handler — runs when the LLM calls analyze_step_file
// ---------------------------------------------------------------------------

const STEP_TIMEOUT_MS = 60_000; // FreeCAD can be slow

export async function analyzeStepFile(
  args: Record<string, any>,
  context: Pick<ToolContext, "stepFileContent">,
): Promise<Record<string, unknown>> {
  if (!context.stepFileContent) {
    return {
      error: "No STEP file content available. Ensure a .stp or .step file was uploaded alongside the 2D drawing.",
      features_3d: [],
    };
  }

  const pythonUrl = process.env.PYTHON_SERVICE_URL || "http://localhost:8001";
  const material  = (args.material as string) || "Al6061";

  // Build multipart form — Python expects a file upload named "file_3d"
  const form = new FormData();
  form.append(
    "file_3d",
    new Blob([context.stepFileContent], { type: "application/step" }),
    "part.step",
  );
  form.append("material", material);

  let response: Response;
  try {
    response = await fetch(`${pythonUrl}/analyze/step`, {
      method: "POST",
      body:   form,
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = (err as Error).name === "TimeoutError"
      ? `FreeCAD analysis timed out after ${STEP_TIMEOUT_MS / 1000}s. The STEP file may be too complex.`
      : `Cannot reach Python microservice at ${pythonUrl}: ${(err as Error).message}. Start it with: cd python && py -3.11 -m uvicorn server:app --port 8001`;
    return { error: msg, features_3d: [] };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 503) {
      return {
        error: "FreeCAD is not available on this server. Ensure the Python microservice is running with FreeCAD installed. Continue with recognize_features using 2D-only fallback data.",
        features_3d: [],
      };
    }
    return {
      error: `STEP analysis service returned ${response.status}: ${body.slice(0, 200)}`,
      features_3d: [],
    };
  }

  const result = await response.json().catch(() => ({ success: false, error: "Invalid JSON response from STEP service" }));

  if (!result.success) {
    return {
      error: result.error || "FreeCAD STEP analysis failed",
      features_3d: [],
    };
  }

  const features3d = result.feature_recognition?.features || [];
  const shapeSummary = result.shape_summary || {};

  console.log(`[Tool:analyze_step_file] Extracted ${features3d.length} 3D features from STEP`);

  return {
    features_3d:      features3d,
    shape_summary:    shapeSummary,
    feature_count_3d: features3d.length,
    // Volume/bbox for material cost reference
    volume_mm3:  shapeSummary.volume_mm3  ?? null,
    bbox_x_mm:   shapeSummary.bbox_x_mm   ?? null,
    bbox_y_mm:   shapeSummary.bbox_y_mm   ?? null,
    bbox_z_mm:   shapeSummary.bbox_z_mm   ?? null,
  };
}
