/**
 * SSE streaming analysis endpoint — mirrors backend/app/api/routes.py
 *
 * Streams pipeline events: status → thinking → extraction → features →
 * processes → cycle_time → cost → done
 */

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { extractFeaturesStreamFromPages } from "@/lib/vlmodel";
import { recognizeFeatures } from "@/lib/feature-recognition";
import { mapProcesses } from "@/lib/process-mapping";
import { estimateFromFeatures, estimateFromProcesses } from "@/lib/cycle-time";
import { estimateCost } from "@/lib/cost-estimator";
import { drawingBufferToBase64Pages } from "@/lib/pdf-to-image";

const _3D_EXTENSIONS = new Set(["step", "stp", "iges", "igs", "brep"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  const { analysis_id } = await request.json();

  if (!analysis_id) {
    return new Response(JSON.stringify({ error: "analysis_id is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get analysis record
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

  // Update status to processing
  await supabase
    .from("analyses")
    .update({ status: "processing" })
    .eq("id", analysis_id);

  // Determine if 3D file is present
  const is3D = analysis.file_3d_path
    ? _3D_EXTENSIONS.has(analysis.file_3d_path.split(".").pop()?.toLowerCase() || "")
    : false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };

      const pipelineStart = Date.now();

      try {
        // -- Download files from Supabase storage --
        let imageBase64Pages: string[] = [];
        let stepFileContent: string | undefined;

        // Get 3D file content
        if (analysis.file_3d_path) {
          const { data: file3dData } = await supabase.storage
            .from("parts")
            .download(analysis.file_3d_path);
          if (file3dData) {
            stepFileContent = await file3dData.text();
          }
        }

        // Get 2D file content
        if (analysis.file_2d_path) {
          const { data: file2dData } = await supabase.storage
            .from("parts")
            .download(analysis.file_2d_path);
          if (file2dData) {
            const buffer = Buffer.from(await file2dData.arrayBuffer());
            imageBase64Pages = await drawingBufferToBase64Pages(buffer);
          }
        }

        if (imageBase64Pages.length === 0) {
          send("error", { message: "No processable image file found. Upload a 2D drawing." });
          await supabase.from("analyses").update({ status: "error", error_message: "No processable file found" }).eq("id", analysis_id);
          controller.close();
          return;
        }

        // -- Step 0: Image loaded --
        send("status", {
          step: 0,
          title: "Image Processing",
          message: "Image loaded, preparing for analysis...",
        });

        // -- Step 1: VLM Extraction (streaming) --
        send("status", {
          step: 1,
          title: "Dimension & GD&T Extraction",
          message: "Analyzing drawing with Qwen VL...",
        });

        const t1 = Date.now();
        let extraction: Record<string, unknown> | null = null;

        for await (const event of extractFeaturesStreamFromPages(imageBase64Pages)) {
          if (event.type === "thinking") {
            send("thinking", event.data);
          } else if (event.type === "result") {
            extraction = event.data;
          }
        }

        if (!extraction) {
          send("error", { message: "Extraction returned no data. Please try again." });
          await supabase.from("analyses").update({ status: "error", error_message: "Extraction returned no data" }).eq("id", analysis_id);
          controller.close();
          return;
        }

        // Check if model returned raw unparsed output
        if ("raw_model_output" in extraction) {
          send("error", {
            message: "The model could not parse this file. Please upload a valid 2D engineering drawing (PDF or image) with dimensions and manufacturing features.",
          });
          await supabase.from("analyses").update({ status: "error", error_message: "Model returned non-JSON output" }).eq("id", analysis_id);
          controller.close();
          return;
        }

        const features = (extraction.features as unknown[]) || [];
        const gdtItems = (extraction.gdt as unknown[]) || [];
        const featCount = features.length;
        const gdtCount = gdtItems.length;
        console.log(`[SSE] Step 1: ${featCount} features, ${gdtCount} GD&T (${((Date.now() - t1) / 1000).toFixed(2)}s)`);

        // Validate: does this look like a CNC drawing?
        if (featCount === 0) {
          send("extraction", { features: [], gdt: [], material: null, feature_count: 0, gdt_count: 0 });
          send("error", {
            message: "No manufacturing features detected. This file does not appear to be a CNC engineering drawing. Please upload a 2D drawing with dimensions, holes, threads, fillets, or other machining features.",
          });
          await supabase.from("analyses").update({ status: "error", error_message: "No manufacturing features detected" }).eq("id", analysis_id);
          controller.close();
          return;
        }

        send("extraction", {
          features: extraction.features,
          gdt: extraction.gdt,
          material: extraction.material,
          feature_count: featCount,
          gdt_count: gdtCount,
        });

        // ----- Branch: 2D vs 3D pipeline -----
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cycleTime: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let recognitionResult: any = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let processMapResult: any = null;

        if (is3D && stepFileContent) {
          // -- 3D: Feature Recognition --
          send("status", { step: 2, title: "Feature Recognition", message: "Classifying manufacturing features..." });
          const t2 = Date.now();
          recognitionResult = recognizeFeatures(extraction as Record<string, unknown>);
          const matName = recognitionResult.material?.name || "Unknown";
          console.log(`[SSE] Step 2: ${recognitionResult.feature_count} features, material=${matName} (${((Date.now() - t2) / 1000).toFixed(2)}s)`);

          send("features", {
            feature_count: recognitionResult.feature_count,
            material: matName,
            features: recognitionResult.features.map((f: { id: string; mfg_type: string; description: string; tolerance_class: string; quantity: number }) => ({
              id: f.id, type: f.mfg_type, description: f.description,
              tolerance_class: f.tolerance_class, quantity: f.quantity,
            })),
          });

          // -- 3D: Process Mapping --
          send("status", { step: 3, title: "Process Mapping", message: "Mapping CNC operations..." });
          const t3 = Date.now();
          processMapResult = mapProcesses(recognitionResult);
          console.log(`[SSE] Step 3: ${processMapResult.operation_count} operations (${((Date.now() - t3) / 1000).toFixed(2)}s)`);

          send("processes", {
            operation_count: processMapResult.operation_count,
            operations: processMapResult.operations.map((op: { label: string; tool: { diameter: number; type: string }; params: { spindle_rpm: number; feed_rate_ipm: number } }) => ({
              label: op.label,
              tool: `${op.tool.diameter.toFixed(3)}" ${op.tool.type}`,
              rpm: op.params.spindle_rpm,
              feed: op.params.feed_rate_ipm,
            })),
          });

          // -- 3D: Cycle Time from cutting parameters --
          send("status", { step: 4, title: "Cycle Time Estimation", message: "Calculating from cutting parameters..." });
          cycleTime = estimateFromProcesses(processMapResult);
        } else {
          // -- 2D: Feature Recognition (still useful for display) --
          send("status", { step: 2, title: "Feature Recognition", message: "Classifying manufacturing features..." });
          recognitionResult = recognizeFeatures(extraction as Record<string, unknown>);
          const matName = recognitionResult.material?.name || "Unknown";

          send("features", {
            feature_count: recognitionResult.feature_count,
            material: matName,
            features: recognitionResult.features.map((f: { id: string; mfg_type: string; description: string; tolerance_class: string; quantity: number }) => ({
              id: f.id, type: f.mfg_type, description: f.description,
              tolerance_class: f.tolerance_class, quantity: f.quantity,
            })),
          });

          // -- 2D: Process Mapping --
          send("status", { step: 3, title: "Process Mapping", message: "Mapping CNC operations..." });
          processMapResult = mapProcesses(recognitionResult);

          send("processes", {
            operation_count: processMapResult.operation_count,
            operations: processMapResult.operations.map((op: { label: string; tool: { diameter: number; type: string }; params: { spindle_rpm: number; feed_rate_ipm: number } }) => ({
              label: op.label,
              tool: `${op.tool.diameter.toFixed(3)}" ${op.tool.type}`,
              rpm: op.params.spindle_rpm,
              feed: op.params.feed_rate_ipm,
            })),
          });

          // -- 2D: Cycle Time from features --
          send("status", { step: 4, title: "Cycle Time Estimation", message: "Estimating cycle time from features..." });
          cycleTime = estimateFromFeatures(extraction as Record<string, unknown>);
        }

        console.log(`[SSE] Cycle time: ${cycleTime.total_minutes} mins`);
        send("cycle_time", cycleTime);

        // -- Cost Estimation --
        send("status", { step: 5, title: "Cost Estimation", message: "Calculating fabrication cost..." });
        const cost = estimateCost(cycleTime);
        console.log(`[SSE] Cost: USD ${cost.total_usd}`);
        send("cost", cost);

        // -- Save results to Supabase --
        const dimensionGdt = {
          dimensions: (extraction.features as Array<Record<string, unknown>>)?.map(f => ({
            feature: f.description,
            nominal: (f.dimensions as Record<string, unknown>)?.primary_value,
            tolerance_plus: (f.tolerance as Record<string, unknown>)?.plus,
            tolerance_minus: (f.tolerance as Record<string, unknown>)?.minus,
            unit: (f.dimensions as Record<string, unknown>)?.unit,
          })) || [],
          gdt_callouts: (extraction.gdt as Array<Record<string, unknown>>)?.map(g => ({
            feature: g.feature_id,
            type: g.symbol,
            value: g.tolerance,
            datum: Array.isArray(g.datums) ? (g.datums as string[]).join("|") : "",
          })) || [],
        };

        await supabase.from("analyses").update({
          status: "completed",
          feature_recognition: {
            features: recognitionResult?.features || [],
            raw_response: JSON.stringify(extraction),
          },
          process_mapping: {
            processes: processMapResult?.operations?.map((op: { label: string; operation: string }) => ({
              name: op.label, category: op.operation, description: op.label,
            })) || [],
          },
          cycle_time: {
            items: cycleTime.breakdown.map((b: { process: string; minutes: number }) => ({
              process: b.process, time_minutes: b.minutes,
            })),
            total_minutes: cycleTime.total_minutes,
          },
          cost_estimation: {
            items: cost.breakdown.map((b: { line: string; amount_usd: number }) => ({
              process: b.line, cost_usd: b.amount_usd,
            })),
            total_cost_usd: cost.total_usd,
          },
          dimension_gdt: dimensionGdt,
        }).eq("id", analysis_id);

        // -- Done --
        const elapsed = Math.round((Date.now() - pipelineStart) / 10) / 100;
        console.log(`[SSE] Pipeline completed in ${elapsed}s`);
        send("done", {
          total_minutes: cycleTime.total_minutes,
          total_usd: cost.total_usd,
          elapsed_seconds: elapsed,
        });
      } catch (error) {
        console.error("[SSE] Pipeline error:", error);
        const message = error instanceof Error ? error.message : "Analysis failed";
        send("error", { message });
        await supabase.from("analyses").update({ status: "error", error_message: message }).eq("id", analysis_id);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
