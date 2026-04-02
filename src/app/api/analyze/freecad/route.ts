/**
 * FreeCAD analysis endpoint — parallel geometry + drawing extraction.
 *
 * Flow:
 *   1. Download STEP + 2D files from Supabase in parallel
 *   2. Run FreeCAD geometry analysis (Python) AND VL drawing extraction
 *      (TypeScript) concurrently — the two are fully independent
 *   3. Merge: recognize_features tags 3D geometry with 2D tolerances
 *   4. Chain TypeScript pipeline: map processes → cycle time → cost
 *   5. Stream SSE progress events to the client
 *   6. Persist results to Supabase
 */

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { checkFreecadHealth, analyzeStep } from "@/lib/freecad-client";
import { extractFeaturesStreamFromPages } from "@/lib/vlmodel";
import { drawingBufferToBase64Pages } from "@/lib/pdf-to-image";
import { recognizeFeatures } from "@/lib/tools/recognize-features";
import { mapCncProcesses } from "@/lib/tools/map-processes";
import { estimateCycleTime } from "@/lib/tools/estimate-cycle-time";
import { estimateCost } from "@/lib/tools/estimate-cost";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Material cost helper (mirrors Python _material_cost, uses actual 3D volume)
// ---------------------------------------------------------------------------

const DENSITY: Record<string, number> = {
  Al6061: 0.0027, Al7075: 0.0028, SS304: 0.0079, SS316: 0.0080,
  Ti6Al4V: 0.0044, C1018: 0.00785, C4140: 0.00785, Delrin: 0.00142, PEEK: 0.00132,
};
const COST_KG: Record<string, number> = {
  Al6061: 5.0, Al7075: 7.5, SS304: 10.0, SS316: 12.0,
  Ti6Al4V: 45.0, C1018: 3.0, C4140: 4.0, Delrin: 8.0, PEEK: 85.0,
};

function calcMaterialCost(
  bbox: { bbox_x_mm: number; bbox_y_mm: number; bbox_z_mm: number } | undefined,
  material: string,
): number {
  if (!bbox) return 15.0;
  const density = DENSITY[material] ?? 0.0027;
  const costKg  = COST_KG[material]  ?? 5.0;
  const massG   = bbox.bbox_x_mm * bbox.bbox_y_mm * bbox.bbox_z_mm * 1.3 * density;
  return Math.round((massG / 1000) * costKg * 100) / 100;
}

// ---------------------------------------------------------------------------
// Collect VL extraction result from the async generator (non-streaming helper)
// ---------------------------------------------------------------------------

async function collectVlExtraction(
  pages: string[],
): Promise<Record<string, unknown> | null> {
  let result: Record<string, unknown> | null = null;
  for await (const event of extractFeaturesStreamFromPages(pages)) {
    if (event.type === "result") result = event.data as Record<string, unknown>;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { analysis_id, shoprate = 75, material = "Al6061" } = body;

  if (!analysis_id) {
    return new Response(JSON.stringify({ error: "analysis_id is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: analysis, error: fetchError } = await supabase
    .from("analyses")
    .select("*")
    .eq("id", analysis_id)
    .single();

  if (fetchError || !analysis) {
    return new Response(JSON.stringify({ error: "Analysis not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!analysis.file_3d_path) {
    return new Response(
      JSON.stringify({ error: "A STEP file is required for FreeCAD analysis." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = (event: string, data: any) =>
        controller.enqueue(enc.encode(sse(event, data)));

      const t0 = Date.now();

      try {
        await supabase
          .from("analyses")
          .update({ status: "processing" })
          .eq("id", analysis_id);

        // ── 1. Check Python service ────────────────────────────────────────
        send("status", { step: 0, title: "FreeCAD Service", message: "Checking FreeCAD microservice…" });
        const health = await checkFreecadHealth();
        if (!health.available) {
          throw new Error(
            "Python microservice is not reachable. " +
            "Start it with: cd python && py -3.11 -m uvicorn server:app --port 8001",
          );
        }
        if (!health.freecad_available) {
          throw new Error("FreeCAD is not installed in the Python environment. Set FREECAD_PATH.");
        }

        // ── 2. Download files from Supabase in parallel ───────────────────
        send("status", { step: 1, title: "Loading Files", message: "Downloading STEP and drawing from storage…" });

        const [stepDownload, drawingDownload] = await Promise.all([
          supabase.storage.from("parts").download(analysis.file_3d_path),
          analysis.file_2d_path
            ? supabase.storage.from("parts").download(analysis.file_2d_path)
            : Promise.resolve({ data: null, error: null }),
        ]);

        if (stepDownload.error || !stepDownload.data) {
          throw new Error(`Failed to download STEP file: ${stepDownload.error?.message}`);
        }

        const stepBlob     = stepDownload.data as Blob;
        const stepFilename = analysis.file_3d_path.split("/").pop() || "part.stp";

        // Convert drawing to base64 pages (needed for VL model)
        let imageBase64Pages: string[] = [];
        if (drawingDownload.data) {
          const buf = Buffer.from(await (drawingDownload.data as Blob).arrayBuffer());
          imageBase64Pages = await drawingBufferToBase64Pages(buf);
        }

        // ── 3. FreeCAD + VL extraction in PARALLEL ────────────────────────
        send("status", {
          step: 2,
          title: "Parallel Analysis",
          message: "FreeCAD geometry analysis and drawing extraction running simultaneously…",
        });

        const [stepResult, extraction] = await Promise.all([
          analyzeStep(stepBlob, stepFilename),
          imageBase64Pages.length > 0
            ? collectVlExtraction(imageBase64Pages)
            : Promise.resolve(null),
        ]);

        if (!stepResult.success) {
          throw new Error(stepResult.error || "FreeCAD STEP analysis failed");
        }

        const features3d = stepResult.feature_recognition?.features ?? [];
        console.log(`[FreeCAD SSE] ${features3d.length} 3D features, extraction: ${extraction ? "ok" : "none"}`);

        if (stepResult.shape_summary) {
          send("shape_summary", stepResult.shape_summary);
        }

        send("features", {
          feature_count: features3d.length,
          features: features3d.map((f) => ({
            id: f.id,
            type: f.type,
            description: f.description,
            dimensions: f.dimensions,
          })),
        });

        // ── 4. Recognize features (merge 3D geometry + 2D tolerances) ─────
        send("status", { step: 3, title: "Feature Recognition", message: "Linking 2D tolerances to 3D geometry…" });

        const stepAnalysisForRecognizer = {
          features_3d:   features3d,
          shape_summary: stepResult.shape_summary ?? null,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recognitionResult = await recognizeFeatures({
          extraction_json:    JSON.stringify(extraction ?? { features: [], gdt: [], material: null }),
          step_analysis_json: JSON.stringify(stepAnalysisForRecognizer),
        }) as Record<string, any>;

        // ── 5. Process mapping ─────────────────────────────────────────────
        send("status", { step: 4, title: "Process Mapping", message: "Mapping CNC operations…" });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const processMapResult = await mapCncProcesses({
          recognition_json: JSON.stringify(recognitionResult),
        }) as Record<string, any>;

        send("processes", {
          operation_count: processMapResult.operation_count,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          operations: (processMapResult.operations as any[]).map((op) => ({
            label: op.label,
            tool:  `${op.tool.diameter.toFixed(3)}" ${op.tool.type}`,
            rpm:   op.params.spindle_rpm,
            feed:  op.params.feed_rate_ipm,
          })),
        });

        // ── 6. Cycle time ──────────────────────────────────────────────────
        send("status", { step: 5, title: "Cycle Time", message: "Calculating machining time…" });

        const materialCostUsd = calcMaterialCost(stepResult.shape_summary, String(material));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cycleTimeResult = await estimateCycleTime({
          method:           "from_processes",
          process_map_json: JSON.stringify(processMapResult),
        }) as Record<string, any>;

        send("cycle_time", {
          total_minutes: cycleTimeResult.total_minutes,
          breakdown:     cycleTimeResult.breakdown,
        });

        // ── 7. Cost estimation ─────────────────────────────────────────────
        send("status", { step: 6, title: "Cost Estimation", message: "Calculating fabrication cost…" });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const costResult = await estimateCost({
          cycle_time_json:   JSON.stringify(cycleTimeResult),
          shop_rate_per_hour: String(shoprate),
          raw_material_usd:  String(materialCostUsd),
        }) as Record<string, any>;

        send("cost", {
          total_usd: costResult.total_usd,
          breakdown: costResult.breakdown,
        });

        // ── 8. Persist to Supabase ─────────────────────────────────────────
        await supabase
          .from("analyses")
          .update({
            status: "completed",
            feature_recognition: {
              features: recognitionResult.features ?? [],
            },
            process_mapping: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              processes: (processMapResult.operations as any[]).map((op) => ({
                name:        op.label,
                category:    op.operation,
                description: op.label,
              })),
            },
            cycle_time: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              items: (cycleTimeResult.breakdown as any[]).map((b) => ({
                process:      b.process,
                time_minutes: b.minutes,
              })),
              total_minutes: cycleTimeResult.total_minutes,
            },
            cost_estimation: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              items: (costResult.breakdown as any[]).map((b) => ({
                process:  b.line,
                cost_usd: b.amount_usd,
              })),
              total_cost_usd: costResult.total_usd,
            },
            dimension_gdt: extraction
              ? {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  dimensions: ((extraction.features as any[]) ?? []).map((f: any) => ({
                    feature:         f.description,
                    nominal:         f.dimensions?.primary_value,
                    tolerance_plus:  f.tolerance?.plus,
                    tolerance_minus: f.tolerance?.minus,
                    unit:            f.dimensions?.unit,
                  })),
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  gdt_callouts: ((extraction.gdt as any[]) ?? []).map((g: any) => ({
                    feature: g.feature_id,
                    type:    g.symbol,
                    value:   g.tolerance,
                    datum:   Array.isArray(g.datums) ? (g.datums as string[]).join("|") : "",
                  })),
                }
              : null,
          })
          .eq("id", analysis_id);

        const elapsed = Math.round((Date.now() - t0) / 10) / 100;
        send("done", {
          approach:      "freecad",
          total_minutes: cycleTimeResult.total_minutes,
          total_usd:     costResult.total_usd,
          elapsed_seconds: elapsed,
        });

      } catch (error) {
        const message = error instanceof Error ? error.message : "FreeCAD analysis failed";
        console.error("[FreeCAD SSE] error:", message);
        send("error", { message });
        await supabase
          .from("analyses")
          .update({ status: "error", error_message: message })
          .eq("id", analysis_id);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache",
      Connection:        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
