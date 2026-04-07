/**
 * API call helpers — thin wrappers so components stay free of fetch logic.
 * All functions return raw Response objects so callers can stream them.
 */

export function parseSSEBuffer(buffer: string) {
  const events: Array<{ event: string; data: string }> = [];
  const parts = buffer.split("\n\n");
  const remaining = parts.pop() ?? "";
  for (const block of parts) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) events.push({ event, data });
  }
  return { events, remaining };
}

// ---------------------------------------------------------------------------
// Approach 2 (FreeCAD) — single SSE stream
// ---------------------------------------------------------------------------

export interface Approach2StreamPayload {
  analysis_id: string;
  drawing_url: string;
  step_url: string;
  file_name: string;
}

export async function startApproach2Stream(
  payload: Approach2StreamPayload,
  signal: AbortSignal
): Promise<Response> {
  const pythonUrl = (
    process.env.NEXT_PUBLIC_PYTHON_SERVICE_URL || "http://localhost:8001"
  ).replace(/\/$/, "");

  const resp = await fetch(`${pythonUrl}/analyze-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Server error: ${resp.status}`);
  }

  return resp;
}

// ---------------------------------------------------------------------------
// Approach 1 (LLM-per-step) — individual JSON/SSE calls
// ---------------------------------------------------------------------------

function v1Url(path: string): string {
  const base = (
    process.env.NEXT_PUBLIC_PYTHON_V1_URL || "http://localhost:8002"
  ).replace(/\/$/, "");
  return `${base}${path}`;
}

export async function v1GdtStream(
  payload: { drawing_url: string; file_name: string },
  signal: AbortSignal
): Promise<Response> {
  const resp = await fetch(v1Url("/v1/gdt"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`/v1/gdt HTTP ${resp.status}`);
  return resp;
}

export async function v1Step3d(
  payload: { step_url: string; file_name: string },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const resp = await fetch(v1Url("/v1/step3d"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error ?? "step3d failed");
  return data;
}

export async function v1Features(
  payload: { extraction: unknown; step_analysis: unknown },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const resp = await fetch(v1Url("/v1/features"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error ?? "features failed");
  return data;
}

export async function v1Processes(
  payload: { features: unknown; material: unknown },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const resp = await fetch(v1Url("/v1/processes"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error ?? "processes failed");
  return data;
}

export async function v1CycleTime(
  payload: { operations: unknown; material_spec: string },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const resp = await fetch(v1Url("/v1/cycletime"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error ?? "cycletime failed");
  return data;
}

export async function v1Cost(
  payload: { cycle_time: unknown; material_spec: string },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const resp = await fetch(v1Url("/v1/cost"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error ?? "cost failed");
  return data;
}

// ---------------------------------------------------------------------------
// Supabase upload + register (shared by both approaches)
// ---------------------------------------------------------------------------

import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

export interface UploadedFiles {
  analysisId: string;
  drawingUrl: string;
  stepUrl: string;
  uploadResult: Record<string, unknown>;
}

export async function uploadFilesToSupabase(
  file3d: File,
  file2d: File,
  pathPrefix: string
): Promise<UploadedFiles> {
  const sbClient = createSupabaseBrowserClient();
  const analysisId = crypto.randomUUID();
  const file3dPath = `uploads/${pathPrefix}${analysisId}/3d_${file3d.name}`;
  const file2dPath = `uploads/${pathPrefix}${analysisId}/2d_${file2d.name}`;

  const [up3d, up2d] = await Promise.all([
    sbClient.storage.from("parts").upload(file3dPath, file3d, {
      contentType: "application/step",
      upsert: true,
    }),
    sbClient.storage.from("parts").upload(file2dPath, file2d, {
      contentType: file2d.type || "application/octet-stream",
      upsert: true,
    }),
  ]);

  if (up3d.error) throw new Error(`3D upload failed: ${up3d.error.message}`);
  if (up2d.error) throw new Error(`2D upload failed: ${up2d.error.message}`);

  const [sign3d, sign2d] = await Promise.all([
    sbClient.storage.from("parts").createSignedUrl(file3dPath, 3600),
    sbClient.storage.from("parts").createSignedUrl(file2dPath, 3600),
  ]);

  if (sign3d.error) throw new Error(`Signed URL for 3D failed: ${sign3d.error.message}`);
  if (sign2d.error) throw new Error(`Signed URL for 2D failed: ${sign2d.error.message}`);

  return {
    analysisId,
    drawingUrl: sign2d.data!.signedUrl,
    stepUrl: sign3d.data!.signedUrl,
    uploadResult: { analysis_id: analysisId },
  };
}

export async function registerUpload(
  analysisId: string,
  file3dPath: string,
  file2dPath: string,
  fileName: string
): Promise<Record<string, unknown>> {
  const res = await fetch("/api/upload/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      analysis_id: analysisId,
      file_3d_path: file3dPath,
      file_2d_path: file2dPath,
      file_name: fileName,
    }),
  });
  if (!res.ok) {
    const d = await res.json();
    throw new Error(d.error || "Registration failed");
  }
  return res.json();
}
