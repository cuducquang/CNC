/**
 * POST /api/benchmark
 *
 * Runs the agent pipeline with a specific model against an existing analysis
 * and streams back SSE events + timing metrics.
 *
 * Does NOT write results back to the analyses table — results exist only
 * in the stream so multiple model runs on the same analysis don't overwrite
 * each other.
 *
 * Body: { analysis_id: string; model: string }
 *
 * Extra SSE events (on top of standard agent events):
 *   metrics  — { model, elapsed_seconds, features, gdt, total_minutes, total_usd,
 *                tools_completed, iterations, completed: true|false }
 */

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { runAgent } from "@/lib/agent/orchestrator";
import { runFallbackPipeline } from "@/lib/agent/fallback-pipeline";
import { drawingBufferToBase64Pages } from "@/lib/pdf-to-image";
import { AGENT_MODELS, DEFAULT_MODEL_ID } from "@/lib/models";

/* eslint-disable @typescript-eslint/no-explicit-any */

function sse(event: string, data: any): string {
  try {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch {
    return `event: error\ndata: ${JSON.stringify({ message: "Serialization error" })}\n\n`;
  }
}

export async function POST(request: NextRequest) {
  let analysis_id: string;
  let model: string;
  try {
    const body = await request.json();
    analysis_id = body.analysis_id;
    model       = body.model || DEFAULT_MODEL_ID;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  if (!analysis_id) {
    return new Response(JSON.stringify({ error: "analysis_id is required" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // Validate the model is in our registry
  const modelDef = AGENT_MODELS.find((m) => m.id === model);
  if (!modelDef) {
    return new Response(JSON.stringify({ error: `Unknown model: ${model}` }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const { data: analysis, error: fetchError } = await supabase
    .from("analyses")
    .select("*")
    .eq("id", analysis_id)
    .single();

  if (fetchError || !analysis) {
    return new Response(JSON.stringify({ error: "Analysis not found" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  if (!analysis.file_3d_path || !analysis.file_2d_path) {
    return new Response(
      JSON.stringify({ error: "Analysis must have both a STEP file and a 2D drawing." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send    = (event: string, data: any) => {
        try { controller.enqueue(encoder.encode(sse(event, data))); } catch { /* closed */ }
      };

      const t0 = Date.now();
      const elapsed = () => Math.round((Date.now() - t0) / 10) / 100;

      // Counters accumulated while streaming
      let toolsCompleted = 0;
      let iterations     = 0;
      let finalResults: Record<string, unknown> = {};

      send("benchmark_start", { model, model_name: modelDef.name });

      try {
        // Download both files in parallel (reusing existing analysis record)
        const [result3d, result2d] = await Promise.all([
          supabase.storage.from("parts").download(analysis.file_3d_path),
          supabase.storage.from("parts").download(analysis.file_2d_path),
        ]);

        if (result3d.error || !result3d.data) throw new Error(`Failed to load STEP: ${result3d.error?.message}`);
        if (result2d.error || !result2d.data) throw new Error(`Failed to load drawing: ${result2d.error?.message}`);

        const stepFileContent  = await result3d.data.text();
        const drawingBuffer    = Buffer.from(await result2d.data.arrayBuffer());
        const imageBase64Pages = await drawingBufferToBase64Pages(drawingBuffer);

        if (!stepFileContent.trim()) throw new Error("STEP file is empty.");
        if (imageBase64Pages.length === 0) throw new Error("Failed to convert drawing to images.");

        const agentParams = {
          analysisId:       analysis_id,
          imageBase64:      imageBase64Pages[0],
          imageBase64Pages,
          stepFileContent,
          fileName:         analysis.file_name || "part",
          agentModel:       model,
        };

        let succeeded = false;

        const runAndStream = async (gen: AsyncGenerator<any>) => {
          for await (const event of gen) {
            // Count tool completions + iterations for metrics
            if (event.type === "tool_result" && !event.data?.result?.error) toolsCompleted++;
            if (event.type === "thinking") iterations++;
            if (event.type === "final_answer") {
              succeeded = true;
              finalResults = (event.data?.results as Record<string, unknown>) || {};
            }
            send(event.type, event.data);
          }
        };

        try {
          await runAndStream(runAgent(agentParams));
        } catch (agentErr) {
          send("status", { step: 0, title: "Direct Pipeline", message: "Agent unavailable — running direct pipeline..." });
          try {
            await runAndStream(runFallbackPipeline({ ...agentParams, reason: (agentErr as Error).message }));
          } catch (fbErr) {
            throw new Error(`Both agent and fallback failed: ${(fbErr as Error).message}`);
          }
        }

        // Emit final benchmark metrics
        send("metrics", {
          model,
          model_name:       modelDef.name,
          elapsed_seconds:  elapsed(),
          features:         Array.isArray(finalResults.features) ? finalResults.features.length : 0,
          gdt:              Array.isArray(finalResults.gdt_callouts) ? finalResults.gdt_callouts.length : 0,
          total_minutes:    typeof finalResults.total_minutes === "number" ? finalResults.total_minutes : 0,
          total_usd:        typeof finalResults.total_usd === "number" ? finalResults.total_usd : 0,
          tools_completed:  toolsCompleted,
          iterations,
          completed:        succeeded,
        });

        send("done", { model, elapsed_seconds: elapsed() });

      } catch (err) {
        const message = err instanceof Error ? err.message : "Benchmark failed";
        console.error(`[Benchmark:${model}] Error:`, message);
        send("error", { message });
        send("metrics", {
          model,
          model_name:      modelDef.name,
          elapsed_seconds: elapsed(),
          features: 0, gdt: 0, total_minutes: 0, total_usd: 0,
          tools_completed: toolsCompleted, iterations,
          completed: false,
          error: message,
        });
        send("done", { model, elapsed_seconds: elapsed() });
      }

      try { controller.close(); } catch { /**/ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache, no-transform",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
