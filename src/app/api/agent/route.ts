/**
 * POST /api/agent — SSE streaming endpoint for the CNC costing pipeline.
 *
 * Streams events: agent_start, status, thinking, tool_call, tool_result,
 *                 agent_message, final_answer, error, done
 *
 * Guarantees:
 *   - Stream ALWAYS closes (try/finally)
 *   - `done` event is ALWAYS the last event sent
 *   - DB status is ALWAYS updated
 *   - Tool result payloads are trimmed before streaming (large JSON stays server-side)
 *   - Hard fails early if either the 3D or 2D file is missing
 */

// Allow up to 5 minutes for the agent SSE stream on Vercel Pro.
// Hobby plan is capped at 60 s — upgrade to Pro for demo deployments.
export const maxDuration = 300;

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { runAgent, ModelUnavailableError } from "@/lib/agent/orchestrator";
import { runFallbackPipeline } from "@/lib/agent/fallback-pipeline";
import { drawingBufferToBase64Pages } from "@/lib/pdf-to-image";
import { getModelById } from "@/lib/models";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sse(event: string, data: any): string {
  try {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch {
    return `event: error\ndata: ${JSON.stringify({ message: "Serialization error" })}\n\n`;
  }
}

/**
 * Trim tool result payloads before sending over SSE.
 * Full results are accumulated server-side; the stream only sends summaries
 * so we don't push megabytes of feature JSON to the browser.
 */
function trimResultForStream(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
  if (result.error) return { error: result.error }; // always send errors verbatim

  switch (toolName) {
    case "analyze_drawing":
      return {
        feature_count:  result.feature_count,
        gdt_count:      result.gdt_count,
        pages_analyzed: result.pages_analyzed,
        material:       (result as any).material ?? null,
      };
    case "analyze_step_file":
      return {
        feature_count_3d: result.feature_count_3d,
        volume_mm3:       result.volume_mm3  ?? null,
        bbox_x_mm:        result.bbox_x_mm   ?? null,
        bbox_y_mm:        result.bbox_y_mm   ?? null,
        bbox_z_mm:        result.bbox_z_mm   ?? null,
      };
    case "recognize_features":
      return {
        feature_count: result.feature_count,
        source:        result.source,
        material:      (result as any).material ?? null,
      };
    case "map_cnc_processes":
      return {
        operation_count: result.operation_count,
      };
    case "estimate_cycle_time":
      return {
        total_minutes: result.total_minutes,
        method:        result.method,
      };
    case "estimate_cost":
      return {
        total_usd:          result.total_usd,
        currency:           result.currency,
        shop_rate_per_hour: result.shop_rate_per_hour,
      };
    default:
      // For optional tools (lookup_material, validate_estimate) send as-is
      return result;
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let analysis_id: string;
  let agentModel: string | undefined;
  try {
    const body = await request.json();
    analysis_id = body.analysis_id;
    agentModel  = body.model || undefined;
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

  // Fetch analysis record
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

  // Mark as processing
  await supabase.from("analyses").update({ status: "processing" }).eq("id", analysis_id);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder  = new TextEncoder();
      const agentLog: Array<{ type: string; data: any; ts: number }> = [];
      let doneSent   = false;

      const send = (event: string, data: any) => {
        try { controller.enqueue(encoder.encode(sse(event, data))); } catch { /* closed */ }
        if (event !== "thinking") agentLog.push({ type: event, data, ts: Date.now() });
      };

      const sendDone = (metrics: { total_minutes: number; total_usd: number; elapsed_seconds: number }) => {
        if (doneSent) return;
        doneSent = true;
        send("done", metrics);
      };

      const fail = async (msg: string) => {
        send("error", { message: msg });
        sendDone({ total_minutes: 0, total_usd: 0, elapsed_seconds: elapsed() });
        await supabase.from("analyses").update({
          status: "error", error_message: msg, agent_log: agentLog,
        }).eq("id", analysis_id);
      };

      const pipelineStart = Date.now();
      const elapsed = () => Math.round((Date.now() - pipelineStart) / 10) / 100;

      try {
        // ── Hard validate: both files must be present ──────────────────────
        if (!analysis.file_3d_path) {
          await fail("No STEP file found. Both a 3D STEP/STP file and a 2D engineering drawing are required. Please re-upload.");
          return;
        }
        if (!analysis.file_2d_path) {
          await fail("No 2D drawing found. Both a 3D STEP/STP file and a 2D engineering drawing are required. Please re-upload.");
          return;
        }

        // ── Download both files in parallel ────────────────────────────────
        const [result3d, result2d] = await Promise.all([
          supabase.storage.from("parts").download(analysis.file_3d_path),
          supabase.storage.from("parts").download(analysis.file_2d_path),
        ]);

        if (result3d.error || !result3d.data) {
          await fail(`Failed to load the 3D STEP file: ${result3d.error?.message ?? "unknown error"}. Please re-upload.`);
          return;
        }
        if (result2d.error || !result2d.data) {
          await fail(`Failed to load the 2D drawing: ${result2d.error?.message ?? "unknown error"}. Please re-upload.`);
          return;
        }

        const stepFileContent    = await result3d.data.text();
        const drawingBuffer      = Buffer.from(await result2d.data.arrayBuffer());
        const imageBase64Pages   = await drawingBufferToBase64Pages(drawingBuffer);
        console.log(`[Agent] PDF converted: ${imageBase64Pages.length} page(s) available for VL`);

        if (!stepFileContent.trim()) {
          await fail("The STEP file appears to be empty. Please re-upload a valid .stp or .step file.");
          return;
        }
        if (imageBase64Pages.length === 0) {
          await fail("Failed to convert the 2D drawing to images. The file may be corrupted or in an unsupported format. Please re-upload a valid PDF, PNG, JPG, or TIFF.");
          return;
        }

        // ── Run the agent ──────────────────────────────────────────────────
        let succeeded = false;

        // Resolve the base URL for the selected model (empty string = use env var)
        const modelDef = agentModel ? getModelById(agentModel) : undefined;
        const agentModelUrl = modelDef?.baseUrl || undefined;

        const agentParams = {
          analysisId:       analysis_id,
          imageBase64:      imageBase64Pages[0],
          imageBase64Pages,
          stepFileContent,
          fileName:         analysis.file_name,
          agentModel,
          agentModelUrl,
        };

        try {
          for await (const event of runAgent(agentParams)) {
            // Trim large results before streaming; full data goes to final_answer
            if (event.type === "tool_result") {
              const trimmed = trimResultForStream(
                (event.data as any).tool,
                (event.data as any).result,
              );
              send(event.type, { ...(event.data as any), result: trimmed });
            } else {
              send(event.type, event.data);
            }

            if (event.type === "final_answer") {
              succeeded = true;
              await saveResults(analysis_id, event.data as any, agentLog);
              sendDone({
                total_minutes: (event.data as any).results?.total_minutes || 0,
                total_usd:     (event.data as any).results?.total_usd     || 0,
                elapsed_seconds: elapsed(),
              });
            }
          }
        } catch (agentErr) {
          const reason = agentErr instanceof Error ? agentErr.message : "Agent error";

          // Model is unreachable / returned a hard HTTP error.
          if (agentErr instanceof ModelUnavailableError) {
            console.error("[Agent] Model unavailable, not falling back:", reason);
            await fail(`The selected model is unavailable: ${reason}. Please select a different agent model and try again.`);
            return;
          }

          // User explicitly chose a model — don't silently fall back to the
          // default vision model. Show the error so they can pick another model.
          if (agentModel) {
            const label = agentModel.split("/").pop()?.replace(/-cloud$/, "") ?? agentModel;
            console.error(`[Agent] Chosen model "${label}" failed, not falling back:`, reason);
            await fail(`Model "${label}" did not complete the analysis: ${reason}. Please try a different agent model.`);
            return;
          }

          console.error("[Agent] Agent loop failed, switching to fallback:", reason);

          send("status", {
            step: 0, title: "Direct Pipeline",
            message: "Agent did not complete — running direct analysis pipeline...",
          });

          try {
            for await (const event of runFallbackPipeline({ ...agentParams, reason })) {
              if (event.type === "tool_result") {
                const trimmed = trimResultForStream(
                  (event.data as any).tool,
                  (event.data as any).result,
                );
                send(event.type, { ...(event.data as any), result: trimmed });
              } else {
                send(event.type, event.data);
              }

              if (event.type === "final_answer") {
                succeeded = true;
                await saveResults(analysis_id, event.data as any, agentLog);
                sendDone({
                  total_minutes: (event.data as any).results?.total_minutes || 0,
                  total_usd:     (event.data as any).results?.total_usd     || 0,
                  elapsed_seconds: elapsed(),
                });
              }
            }
          } catch (fallbackErr) {
            const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : "Pipeline failed";
            console.error("[Agent] Fallback pipeline also failed:", fbMsg);
            send("error", { message: `Analysis failed: ${fbMsg}` });
          }
        }

        if (!succeeded) {
          await supabase.from("analyses").update({
            status: "error", error_message: "Analysis did not produce results", agent_log: agentLog,
          }).eq("id", analysis_id);
        }

        sendDone({ total_minutes: 0, total_usd: 0, elapsed_seconds: elapsed() });

      } catch (outerErr) {
        console.error("[Agent] Unexpected outer error:", outerErr);
        const msg = outerErr instanceof Error ? outerErr.message : "Unexpected error";
        try { send("error", { message: msg }); sendDone({ total_minutes: 0, total_usd: 0, elapsed_seconds: elapsed() }); } catch { /**/ }
        try {
          await supabase.from("analyses").update({
            status: "error", error_message: msg, agent_log: agentLog,
          }).eq("id", analysis_id);
        } catch { /**/ }
      } finally {
        try { controller.close(); } catch { /**/ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":    "text/event-stream",
      "Cache-Control":   "no-cache, no-transform",
      "Connection":      "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Persist results to Supabase
// ---------------------------------------------------------------------------

async function saveResults(
  analysisId: string,
  finalAnswerData: { results?: Record<string, any>; summary?: string },
  agentLog: Array<{ type: string; data: any; ts: number }>,
) {
  const results    = finalAnswerData.results || {};
  const extraction = results.extraction || {};

  const dimensionGdt = {
    dimensions: ((extraction.features || []) as any[]).map((f: any) => ({
      feature:         f.description,
      nominal:         f.dimensions?.primary_value,
      tolerance_plus:  f.tolerance?.plus,
      tolerance_minus: f.tolerance?.minus,
      unit:            f.dimensions?.unit,
    })),
    gdt_callouts: ((extraction.gdt || []) as any[]).map((g: any) => ({
      feature: g.feature_id,
      type:    g.symbol,
      value:   g.tolerance,
      datum:   Array.isArray(g.datums) ? g.datums.join("|") : "",
    })),
  };

  const payload = {
    status: "completed",
    feature_recognition: {
      features:     results.features || [],
      source:       results.recognition?.source || "2d",
      shape_summary: results.shape_summary || null,
    },
    process_mapping: {
      processes: (results.processes?.operations || []).map((op: any) => ({
        name: op.label, category: op.operation, description: op.label,
      })),
    },
    cycle_time: {
      items:         (results.cycle_time?.breakdown || []).map((b: any) => ({
        process: b.process, time_minutes: b.minutes,
      })),
      total_minutes: results.total_minutes || 0,
    },
    cost_estimation: {
      items:          (results.cost?.breakdown || []).map((b: any) => ({
        process: b.line, cost_usd: b.amount_usd,
      })),
      total_cost_usd: results.total_usd || 0,
    },
    dimension_gdt: dimensionGdt,
    agent_log:     agentLog.slice(-200),
  };

  const { error } = await supabase.from("analyses").update(payload).eq("id", analysisId);

  if (error) {
    console.error("[Agent] Failed to save results:", error.message);
    // Minimal save as fallback
    try {
      await supabase.from("analyses").update({
        status:          "completed",
        cycle_time:      { total_minutes: results.total_minutes || 0, items: [] },
        cost_estimation: { total_cost_usd: results.total_usd || 0, items: [] },
      }).eq("id", analysisId);
    } catch { /**/ }
  }
}
