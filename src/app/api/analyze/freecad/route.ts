/**
 * Deterministic CNC analysis endpoint.
 *
 * Flow:
 *   1. VLM (Ollama/qwen3-vl) — extract dimensions & GD&T from 2D drawing PDF
 *   2. Python /analyze       — BrepMFR (→ FreeCAD fallback) feature recognition
 *                              + deterministic process mapping
 *   3. Next.js               — cycle time calculation from process map (mm units)
 *   4. Next.js               — cost estimation
 *   5. Persist to Supabase + stream SSE events
 *
 * The local LLM has ONE job: structured D&GDT extraction from the drawing.
 * Feature recognition and process mapping are fully deterministic (Python).
 */

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { checkFreecadHealth, analyzeFull, type DrawingExtraction } from "@/lib/freecad-client";
import { extractFeaturesStreamFromPages } from "@/lib/vlmodel";
import { drawingBufferToBase64Pages } from "@/lib/pdf-to-image";
import { estimateCycleTime } from "@/lib/tools/estimate-cycle-time";
import { estimateCost } from "@/lib/tools/estimate-cost";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Material cost from 3D bounding box
// ---------------------------------------------------------------------------

const DENSITY_G_MM3: Record<string, number> = {
  Al6061: 0.0027, Al7075: 0.0028, SS304: 0.0079, SS316: 0.0080,
  Ti6Al4V: 0.0044, C1018: 0.00785, C4140: 0.00785, Delrin: 0.00142, PEEK: 0.00132,
};
const COST_USD_KG: Record<string, number> = {
  Al6061: 5.0, Al7075: 7.5, SS304: 10.0, SS316: 12.0,
  Ti6Al4V: 45.0, C1018: 3.0, C4140: 4.0, Delrin: 8.0, PEEK: 85.0,
};

function calcMaterialCost(
  bbox: { bbox_x_mm: number; bbox_y_mm: number; bbox_z_mm: number } | undefined,
  material: string,
): number {
  if (!bbox) return 15.0;
  const density = DENSITY_G_MM3[material] ?? 0.0027;
  const costKg  = COST_USD_KG[material]   ?? 5.0;
  const massG   = bbox.bbox_x_mm * bbox.bbox_y_mm * bbox.bbox_z_mm * 1.3 * density;
  return Math.round((massG / 1000) * costKg * 100) / 100;
}

// ---------------------------------------------------------------------------
// Collect VLM extraction result (non-streaming helper)
// ---------------------------------------------------------------------------

async function collectExtraction(
  pages: string[],
): Promise<DrawingExtraction | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = null;
  for await (const event of extractFeaturesStreamFromPages(pages)) {
    if (event.type === "result") result = event.data;
  }
  return result as DrawingExtraction | null;
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
      JSON.stringify({ error: "A STEP file is required for this analysis mode." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc  = new TextEncoder();
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
        send("status", { step: 0, title: "Service Check", message: "Checking Python microservice…" });
        const health = await checkFreecadHealth();
        if (!health.available) {
          throw new Error(
            "Python microservice is not reachable. " +
            "Start with: cd python && py -3.11 -m uvicorn server:app --port 8001",
          );
        }
        if (!health.freecad_available) {
          throw new Error("FreeCAD is not installed in the Python environment.");
        }

        // ── 2. Download files from Supabase ───────────────────────────────
        send("status", { step: 1, title: "Loading Files", message: "Downloading STEP and drawing…" });

        const [stepDl, drawingDl] = await Promise.all([
          supabase.storage.from("parts").download(analysis.file_3d_path),
          analysis.file_2d_path
            ? supabase.storage.from("parts").download(analysis.file_2d_path)
            : Promise.resolve({ data: null, error: null }),
        ]);

        if (stepDl.error || !stepDl.data) {
          throw new Error(`Failed to download STEP file: ${stepDl.error?.message}`);
        }

        const stepBlob     = stepDl.data as Blob;
        const stepFilename = analysis.file_3d_path.split("/").pop() || "part.stp";

        let imagePages: string[] = [];
        if (drawingDl.data) {
          const buf = Buffer.from(await (drawingDl.data as Blob).arrayBuffer());
          imagePages = await drawingBufferToBase64Pages(buf);
        }

        // ── 3. VLM: Dimension & GD&T extraction ──────────────────────────
        send("status", {
          step: 2,
          title: "Dimension & GD&T Extraction",
          message: "Extracting dimensions and GD&T from 2D drawing…",
        });

        let extraction: DrawingExtraction = {
          dimensions: [], gdt: [], threads: [], material: null,
        };

        if (imagePages.length > 0) {
          const raw = await collectExtraction(imagePages);
          if (raw && !("raw_model_output" in raw)) {
            extraction = raw;
          } else if (raw && "raw_model_output" in raw) {
            console.warn("[FreeCAD SSE] VLM returned unparseable output — continuing with geometry only");
          }
        } else {
          console.warn("[FreeCAD SSE] No 2D drawing — running geometry analysis only");
        }

        const dimCount    = (extraction.dimensions ?? []).length;
        const threadCount = (extraction.threads    ?? []).length;
        const gdtCount    = (extraction.gdt        ?? []).length;
        console.log(`[FreeCAD SSE] Extraction: ${dimCount} dims, ${gdtCount} GD&T, ${threadCount} threads`);

        send("extraction", {
          dimension_count: dimCount,
          gdt_count:       gdtCount,
          thread_count:    threadCount,
          material:        extraction.material ?? null,
        });

        // ── 4. Python: Feature recognition + Process mapping ──────────────
        send("status", {
          step: 3,
          title: "Feature Recognition & Process Mapping",
          message: "BrepMFR feature recognition and deterministic process mapping…",
        });

        const fullResult = await analyzeFull(
          stepBlob,
          stepFilename,
          extraction,
          String(material),
        );

        if (!fullResult.success) {
          throw new Error(fullResult.error || "Python analysis failed");
        }

        const features   = fullResult.features   ?? [];
        const processMap = fullResult.process_map ?? [];

        console.log(
          `[FreeCAD SSE] ${features.length} features (${fullResult.feature_source}), ` +
          `${processMap.length} operations`,
        );

        if (fullResult.shape_summary) {
          send("shape_summary", fullResult.shape_summary);
        }

        send("features", {
          feature_count:  features.length,
          feature_source: fullResult.feature_source,
          features: features.map((f) => ({
            id:          f.id,
            type:        f.type,
            description: f.description,
            dimensions:  f.dimensions,
          })),
        });

        send("processes", {
          operation_count: processMap.length,
          operations: processMap.map((op) => ({
            label:    op.label,
            tool:     `Ø${op.tool.diameter_mm.toFixed(2)}mm ${op.tool.type}`,
            rpm:      op.params.spindle_rpm,
            feed_mmpm: op.params.feed_rate_mmpm,
          })),
        });

        // ── 5. Cycle time (Next.js — deterministic from process map) ──────
        send("status", { step: 4, title: "Cycle Time", message: "Calculating machining time…" });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cycleResult = await estimateCycleTime({
          method:           "from_processes",
          process_map_json: JSON.stringify(processMap),
        }) as Record<string, any>;

        send("cycle_time", {
          total_minutes: cycleResult.total_minutes,
          breakdown:     cycleResult.breakdown,
        });

        // ── 6. Cost estimation ─────────────────────────────────────────────
        send("status", { step: 5, title: "Cost Estimation", message: "Calculating fabrication cost…" });

        const materialCostUsd = calcMaterialCost(fullResult.shape_summary, String(material));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const costResult = await estimateCost({
          cycle_time_json:    JSON.stringify(cycleResult),
          shop_rate_per_hour: String(shoprate),
          raw_material_usd:   String(materialCostUsd),
        }) as Record<string, any>;

        send("cost", {
          total_usd: costResult.total_usd,
          breakdown: costResult.breakdown,
        });

        // ── 7. Persist to Supabase ─────────────────────────────────────────
        await supabase
          .from("analyses")
          .update({
            status: "completed",
            dimension_gdt: {
              dimensions: (extraction.dimensions ?? []).map((d) => ({
                feature:         d.label,
                nominal:         d.nominal,
                tolerance_plus:  d.tolerance_plus  ?? null,
                tolerance_minus: d.tolerance_minus ?? null,
                unit:            d.unit,
              })),
              gdt_callouts: (extraction.gdt ?? []).map((g) => ({
                feature: g.id,
                type:    g.symbol,
                value:   g.tolerance,
                datum:   g.datums.join("|"),
              })),
              threads: (extraction.threads ?? []).map((t) => ({
                spec:     t.spec,
                depth_mm: t.depth_mm,
                quantity: t.quantity,
              })),
            },
            feature_recognition: {
              features: features.map((f) => ({
                id:          f.id,
                type:        f.type,
                description: f.description,
                source:      f.source,
              })),
              source: fullResult.feature_source,
            },
            process_mapping: {
              processes: processMap.map((op) => ({
                name:        op.label,
                category:    op.operation,
                tool_type:   op.tool.type,
                tool_dia_mm: op.tool.diameter_mm,
              })),
            },
            cycle_time: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              items: (cycleResult.breakdown as any[]).map((b) => ({
                process:      b.process,
                time_minutes: b.minutes,
              })),
              total_minutes: cycleResult.total_minutes,
            },
            cost_estimation: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              items: (costResult.breakdown as any[]).map((b) => ({
                process:  b.line,
                cost_usd: b.amount_usd,
              })),
              total_cost_usd: costResult.total_usd,
            },
          })
          .eq("id", analysis_id);

        const elapsed = Math.round((Date.now() - t0) / 10) / 100;
        send("done", {
          approach:        "deterministic",
          feature_source:  fullResult.feature_source,
          total_minutes:   cycleResult.total_minutes,
          total_usd:       costResult.total_usd,
          elapsed_seconds: elapsed,
        });

      } catch (error) {
        const message = error instanceof Error ? error.message : "Analysis failed";
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
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      Connection:          "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
