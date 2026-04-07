/**
 * POST /api/save-result
 *
 * Called by the browser after the Python pipeline emits the `done` SSE event.
 * Persists analysis results to Supabase (requires service-role key — Next.js only).
 *
 * Body: { analysis_id: string, results: object, summary: string }
 */

import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function POST(request: NextRequest) {
  let analysis_id: string;
  let results: Record<string, any>;
  let summary: string;

  try {
    const body  = await request.json();
    analysis_id = body.analysis_id;
    results     = body.results     || {};
    summary     = body.summary     || "";
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
      processes: ((results.processes?.operations || []) as any[]).map((op: any) => ({
        name: op.operation, category: op.operation, description: op.note || op.operation,
      })),
    },
    cycle_time: {
      // Approach 1 returns "operations"; Approach 2 may return "breakdown"
      items: ((results.cycle_time?.operations || results.cycle_time?.breakdown || []) as any[]).map((b: any) => ({
        process: b.note || b.process || b.operation_id, time_minutes: b.minutes ?? b.time_minutes,
      })),
      total_minutes: results.total_minutes || 0,
    },
    cost_estimation: {
      // Approach 1 cost breakdown uses { item, usd }; Approach 2 uses { line, amount_usd }
      items: ((results.cost?.breakdown || []) as any[]).map((b: any) => ({
        process: b.item ?? b.line, cost_usd: b.usd ?? b.amount_usd,
      })),
      total_cost_usd: results.total_usd || 0,
    },
    dimension_gdt: dimensionGdt,
  };

  try {
    const { error } = await supabase
      .from("analyses")
      .update(payload)
      .eq("id", analysis_id);

    if (error) {
      console.error("[save-result] DB update error:", error.message);
      // Minimal fallback save
      await supabase.from("analyses").update({
        status:          "completed",
        cycle_time:      { total_minutes: results.total_minutes || 0, items: [] },
        cost_estimation: { total_cost_usd: results.total_usd || 0, items: [] },
      }).eq("id", analysis_id);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[save-result] Failed:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
