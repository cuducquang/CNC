/**
 * 2D-only analysis endpoint (no STEP file).
 *
 * Flow:
 *   1. VLM — extract dimensions & GD&T from 2D drawing (single focused prompt)
 *   2. Heuristic cycle time from dimension + thread count
 *   3. Cost estimation
 *   4. Persist + stream SSE
 *
 * For full analysis (with STEP), use POST /api/analyze/freecad which runs
 * BrepMFR feature recognition and deterministic process mapping.
 */

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { extractFeaturesStreamFromPages } from "@/lib/vlmodel";
import { estimateCycleTime } from "@/lib/tools/estimate-cycle-time";
import { estimateCost } from "@/lib/tools/estimate-cost";
import { drawingBufferToBase64Pages } from "@/lib/pdf-to-image";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  const { analysis_id, shoprate = 75 } = await request.json().catch(() => ({}));

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

  await supabase
    .from("analyses")
    .update({ status: "processing" })
    .eq("id", analysis_id);

  const stream = new ReadableStream({
    async start(controller) {
      const enc  = new TextEncoder();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = (event: string, data: any) =>
        controller.enqueue(enc.encode(sse(event, data)));

      const t0 = Date.now();

      try {
        // ── 1. Load 2D drawing ─────────────────────────────────────────────
        send("status", { step: 0, title: "Loading Drawing", message: "Preparing image pages…" });

        if (!analysis.file_2d_path) {
          throw new Error(
            "No 2D drawing found. Upload a PDF drawing. " +
            "For full analysis, upload a STEP file and use the FreeCAD endpoint.",
          );
        }

        const { data: drawingData, error: dlErr } = await supabase.storage
          .from("parts")
          .download(analysis.file_2d_path);

        if (dlErr || !drawingData) {
          throw new Error(`Failed to download drawing: ${dlErr?.message}`);
        }

        const buf        = Buffer.from(await (drawingData as Blob).arrayBuffer());
        const imagePages = await drawingBufferToBase64Pages(buf);

        if (imagePages.length === 0) {
          throw new Error("Could not rasterize the drawing PDF. Check that pdftoppm is installed.");
        }

        // ── 2. VLM: Dimension & GD&T extraction ───────────────────────────
        send("status", {
          step: 1,
          title: "Dimension & GD&T Extraction",
          message: "Extracting dimensions and GD&T from drawing…",
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let extraction: Record<string, any> | null = null;
        for await (const event of extractFeaturesStreamFromPages(imagePages)) {
          if (event.type === "result") extraction = event.data;
        }

        if (!extraction) {
          throw new Error("Extraction returned no data. Please try again.");
        }

        if ("raw_model_output" in extraction) {
          throw new Error(
            "The model could not parse this drawing. " +
            "Upload a valid 2D engineering drawing PDF with visible dimensions.",
          );
        }

        const dims    = (extraction.dimensions as unknown[]) ?? [];
        const threads = (extraction.threads    as unknown[]) ?? [];
        const gdt     = (extraction.gdt        as unknown[]) ?? [];

        if (dims.length === 0 && threads.length === 0) {
          throw new Error(
            "No dimensions or threads detected. " +
            "This does not appear to be a CNC engineering drawing.",
          );
        }

        send("extraction", {
          dimension_count: dims.length,
          gdt_count:       gdt.length,
          thread_count:    threads.length,
          material:        extraction.material ?? null,
        });

        // ── 3. Cycle time (heuristic from dimension/thread count) ──────────
        send("status", {
          step: 2,
          title: "Cycle Time Estimation",
          message: "Estimating machining time from drawing data…",
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cycleResult = await estimateCycleTime({
          method:          "from_features",
          extraction_json: JSON.stringify(extraction),
        }) as Record<string, any>;

        send("cycle_time", {
          total_minutes: cycleResult.total_minutes,
          breakdown:     cycleResult.breakdown,
        });

        // ── 4. Cost estimation ─────────────────────────────────────────────
        send("status", { step: 3, title: "Cost Estimation", message: "Calculating cost…" });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const costResult = await estimateCost({
          cycle_time_json:    JSON.stringify(cycleResult),
          shop_rate_per_hour: String(shoprate),
        }) as Record<string, any>;

        send("cost", {
          total_usd: costResult.total_usd,
          breakdown: costResult.breakdown,
        });

        // ── 5. Persist to Supabase ─────────────────────────────────────────
        await supabase
          .from("analyses")
          .update({
            status: "completed",
            dimension_gdt: {
              dimensions: (extraction.dimensions as Array<Record<string, unknown>> ?? []).map((d) => ({
                feature:         d.label,
                nominal:         d.nominal,
                tolerance_plus:  d.tolerance_plus  ?? null,
                tolerance_minus: d.tolerance_minus ?? null,
                unit:            d.unit,
              })),
              gdt_callouts: (extraction.gdt as Array<Record<string, unknown>> ?? []).map((g) => ({
                feature: g.id,
                type:    g.symbol,
                value:   g.tolerance,
                datum:   Array.isArray(g.datums) ? (g.datums as string[]).join("|") : "",
              })),
            },
            cycle_time: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              items: (cycleResult.breakdown as any[]).map((b) => ({
                process: b.process, time_minutes: b.minutes,
              })),
              total_minutes: cycleResult.total_minutes,
            },
            cost_estimation: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              items: (costResult.breakdown as any[]).map((b) => ({
                process: b.line, cost_usd: b.amount_usd,
              })),
              total_cost_usd: costResult.total_usd,
            },
          })
          .eq("id", analysis_id);

        const elapsed = Math.round((Date.now() - t0) / 10) / 100;
        send("done", {
          approach:        "2d_only",
          total_minutes:   cycleResult.total_minutes,
          total_usd:       costResult.total_usd,
          elapsed_seconds: elapsed,
          note:            "Upload a STEP file for full BrepMFR feature recognition.",
        });

      } catch (error) {
        const message = error instanceof Error ? error.message : "Analysis failed";
        console.error("[SSE 2D] error:", message);
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
