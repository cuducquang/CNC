/**
 * GET    /api/analyses/:id  — full analysis detail
 * DELETE /api/analyses/:id  — delete analysis + storage files
 *
 * Dedicated per-resource endpoint. The generic /api/analyses route
 * handles list + bulk operations; this route owns the single-record contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Next.js 15+ makes params a Promise — must be awaited before use.
type RouteContext = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// GET — fetch one analysis by ID
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { id } = await params;

  const { data, error } = await supabase
    .from("analyses")
    .select(`
      id,
      created_at,
      updated_at,
      file_name,
      file_3d_path,
      file_2d_path,
      status,
      error_message,
      feature_recognition,
      process_mapping,
      cycle_time,
      cost_estimation,
      dimension_gdt,
      agent_log
    `)
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Analysis not found" },
      { status: 404 },
    );
  }

  // ---------------------------------------------------------------------------
  // Shape the response for the frontend — flatten the top-level summaries
  // so consumers don't have to dig into nested JSONB fields.
  // ---------------------------------------------------------------------------

  const features    = data.feature_recognition?.features    ?? [];
  const processes   = data.process_mapping?.processes       ?? [];
  const cycleItems  = data.cycle_time?.items                ?? [];
  const costItems   = data.cost_estimation?.items           ?? [];
  const dimensions  = data.dimension_gdt?.dimensions        ?? [];
  const gdtCallouts = data.dimension_gdt?.gdt_callouts      ?? [];

  return NextResponse.json({
    // Identity
    id:         data.id,
    created_at: data.created_at,
    updated_at: data.updated_at,
    file_name:  data.file_name,
    status:     data.status,
    error_message: data.error_message ?? null,

    // Top-level summaries (fast access for cards)
    total_minutes: data.cycle_time?.total_minutes    ?? 0,
    total_usd:     data.cost_estimation?.total_cost_usd ?? 0,
    feature_count: features.length,
    operation_count: processes.length,

    // Detail arrays
    features,
    processes,
    cycle_time_items:  cycleItems,
    cost_items:        costItems,
    dimensions,
    gdt_callouts:      gdtCallouts,

    // Agent activity log (for replay in the detail view)
    agent_log: data.agent_log ?? [],
  });
}

// ---------------------------------------------------------------------------
// PATCH — update status (used by UI to mark stuck records as error)
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const allowed = ["error", "completed"];
  if (!allowed.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { error } = await supabase
    .from("analyses")
    .update({ status: body.status, error_message: body.error_message ?? null })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ updated: true, id, status: body.status });
}

// ---------------------------------------------------------------------------
// DELETE — remove analysis record + its uploaded files from storage
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  const { id } = await params;

  // Fetch file paths before deleting the record
  const { data: analysis, error: fetchError } = await supabase
    .from("analyses")
    .select("file_3d_path, file_2d_path")
    .eq("id", id)
    .single();

  if (fetchError || !analysis) {
    return NextResponse.json(
      { error: "Analysis not found" },
      { status: 404 },
    );
  }

  // Remove uploaded files from Supabase Storage
  const paths = [analysis.file_3d_path, analysis.file_2d_path].filter(Boolean) as string[];
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from("parts").remove(paths);
    if (storageError) {
      console.warn("[DELETE /analyses/:id] Storage cleanup failed:", storageError.message);
      // Non-fatal — continue to delete the DB record
    }
  }

  const { error: deleteError } = await supabase
    .from("analyses")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ deleted: true, id });
}
