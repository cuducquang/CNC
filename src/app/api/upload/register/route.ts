/**
 * POST /api/upload/register
 *
 * Lightweight endpoint called AFTER the browser has already uploaded both
 * files directly to Supabase Storage. Accepts JSON paths, creates the DB
 * record, and returns the analysis_id.
 *
 * This sidesteps Vercel's 4.5 MB serverless body limit — no file bytes
 * pass through this function.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const ALLOWED_2D_EXT = ["pdf", "png", "jpg", "jpeg", "tiff", "tif"];
const ALLOWED_3D_EXT = ["stp", "step"];

function ext(filename: string): string {
  return (filename.split(".").pop() ?? "").toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { analysis_id, file_3d_path, file_2d_path, file_name } = body as {
      analysis_id: string;
      file_3d_path: string;
      file_2d_path: string;
      file_name: string;
    };

    if (!analysis_id || !file_3d_path || !file_2d_path || !file_name) {
      return NextResponse.json(
        { error: "Missing required fields: analysis_id, file_3d_path, file_2d_path, file_name" },
        { status: 400 },
      );
    }

    // Basic path-extension validation
    const ext3d = ext(file_3d_path);
    const ext2d = ext(file_2d_path);

    if (!ALLOWED_3D_EXT.includes(ext3d)) {
      return NextResponse.json(
        { error: `3D file must be .stp or .step. Got: .${ext3d}` },
        { status: 400 },
      );
    }
    if (!ALLOWED_2D_EXT.includes(ext2d)) {
      return NextResponse.json(
        { error: `2D file must be PDF or image format. Got: .${ext2d}` },
        { status: 400 },
      );
    }

    const { error: dbError } = await supabase
      .from("analyses")
      .insert({
        id:           analysis_id,
        file_name,
        file_3d_path,
        file_2d_path,
        status:       "pending",
      });

    if (dbError) throw dbError;

    return NextResponse.json({
      analysis_id,
      file_3d_path,
      file_2d_path,
      message: "Files registered. Ready for analysis.",
    });
  } catch (err) {
    console.error("[Upload/Register] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Registration failed" },
      { status: 500 },
    );
  }
}
