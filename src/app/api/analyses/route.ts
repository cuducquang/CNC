import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (id) {
      const { data, error } = await supabase
        .from("analyses")
        .select("*")
        .eq("id", id)
        .single();

      if (error) throw error;
      return NextResponse.json(data);
    }

    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    const { data, error, count } = await supabase
      .from("analyses")
      .select("id, file_name, file_3d_path, file_2d_path, status, created_at, cycle_time, cost_estimation", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return NextResponse.json({ data, total: count });
  } catch (error) {
    console.error("Fetch analyses error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Fetch failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }

    // Get analysis to find file paths
    const { data: analysis } = await supabase
      .from("analyses")
      .select("file_3d_path, file_2d_path")
      .eq("id", id)
      .single();

    // Delete files from storage
    if (analysis) {
      const filesToDelete = [analysis.file_3d_path, analysis.file_2d_path].filter(
        Boolean
      ) as string[];
      if (filesToDelete.length > 0) {
        await supabase.storage.from("parts").remove(filesToDelete);
      }
    }

    // Delete analysis record
    const { error } = await supabase.from("analyses").delete().eq("id", id);

    if (error) throw error;

    return NextResponse.json({ message: "Analysis deleted" });
  } catch (error) {
    console.error("Delete error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 500 }
    );
  }
}
