/**
 * POST /api/upload
 *
 * Accepts exactly one STEP/STP file AND one 2D drawing (PDF/PNG/JPG/TIFF).
 * Both files are required — the pipeline cannot run without either.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { randomUUID } from "crypto";

const ALLOWED_2D_EXT  = ["pdf", "png", "jpg", "jpeg", "tiff", "tif"];
const ALLOWED_3D_EXT  = ["stp", "step"];

function ext(filename: string): string {
  return (filename.split(".").pop() ?? "").toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file3d = formData.get("file_3d") as File | null;
    const file2d = formData.get("file_2d") as File | null;

    // ── Hard validation: both files are required ──────────────────────────────
    if (!file3d && !file2d) {
      return NextResponse.json(
        { error: "Both a 3D STEP/STP file and a 2D engineering drawing (PDF, PNG, JPG, or TIFF) are required." },
        { status: 400 },
      );
    }
    if (!file3d) {
      return NextResponse.json(
        { error: "A 3D STEP or STP file is required alongside the 2D drawing. The pipeline uses the CAD model for precise feature geometry." },
        { status: 400 },
      );
    }
    if (!file2d) {
      return NextResponse.json(
        { error: "A 2D engineering drawing (PDF, PNG, JPG, or TIFF) is required alongside the STEP file. The pipeline uses it for GD&T, tolerances, and material specification." },
        { status: 400 },
      );
    }

    // ── File-type validation ───────────────────────────────────────────────────
    const ext3d = ext(file3d.name);
    if (!ALLOWED_3D_EXT.includes(ext3d)) {
      return NextResponse.json(
        { error: `3D file must be .stp or .step format. Received: .${ext3d}` },
        { status: 400 },
      );
    }

    const ext2d = ext(file2d.name);
    if (!ALLOWED_2D_EXT.includes(ext2d)) {
      return NextResponse.json(
        { error: `2D drawing must be PDF or image format (PDF, PNG, JPG, TIFF). Received: .${ext2d}` },
        { status: 400 },
      );
    }

    // ── Upload both files to Supabase Storage ─────────────────────────────────
    const analysisId = randomUUID();

    const file3dPath = `uploads/${analysisId}/3d_${file3d.name}`;
    const file2dPath = `uploads/${analysisId}/2d_${file2d.name}`;

    const [upload3d, upload2d] = await Promise.all([
      supabase.storage.from("parts").upload(
        file3dPath,
        Buffer.from(await file3d.arrayBuffer()),
        { contentType: "application/step" },
      ),
      supabase.storage.from("parts").upload(
        file2dPath,
        Buffer.from(await file2d.arrayBuffer()),
        { contentType: file2d.type || "application/octet-stream" },
      ),
    ]);

    if (upload3d.error) throw new Error(`3D upload failed: ${upload3d.error.message}`);
    if (upload2d.error) throw new Error(`2D upload failed: ${upload2d.error.message}`);

    // ── Create analysis record ────────────────────────────────────────────────
    const { error: dbError } = await supabase
      .from("analyses")
      .insert({
        id:           analysisId,
        file_name:    file3d.name,
        file_3d_path: file3dPath,
        file_2d_path: file2dPath,
        status:       "pending",
      });

    if (dbError) throw dbError;

    return NextResponse.json({
      analysis_id:  analysisId,
      file_3d_path: file3dPath,
      file_2d_path: file2dPath,
      message: "Files uploaded. Ready for analysis.",
    });
  } catch (err) {
    console.error("[Upload] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 },
    );
  }
}
