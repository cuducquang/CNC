/**
 * Shared prompts and merge helpers for VLM drawing extraction.
 *
 * The VLM has ONE job: extract dimensions, tolerances, GD&T callouts,
 * and thread specifications from the 2D drawing.
 *
 * Feature recognition is handled deterministically by Python/BrepMFR.
 * Process mapping is handled by Python/FreeCAD Path rules.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// System prompt — concise role only. /no_think goes in the USER message for Qwen3-VL.
export const SYSTEM_PROMPT = `You are a metrology specialist reading a 2D engineering drawing. \
Extract dimensions, tolerances, GD&T callouts, and thread specifications. \
Output JSON only.`;

// /no_think at the start of the USER message is the correct Qwen3 placement (not system prompt).
export const EXTRACTION_PROMPT = `/no_think
TASK: Extract all visible dimensions, GD&T callouts, threads, and material from this 2D engineering drawing page. Write the complete JSON answer NOW — before any verification or analysis. Output JSON first, then check if needed.

If this page is ONLY a company logo, blank page, or pure title/cover with zero drawing geometry (no dimension lines, no feature callouts, no measurement values anywhere on the page):
{"dimensions": [], "gdt": [], "threads": [], "material": null, "surface_finish": null, "notes": ["non_technical_page"]}

If the image is completely unrelated to engineering (photo, artwork):
{"dimensions": [], "gdt": [], "threads": [], "material": null, "surface_finish": null, "notes": ["not_a_drawing"]}

IMPORTANT: Pages that MIX content types are still drawing pages — extract from them. Examples: an isometric/3D view page that also has dimension callouts; a page with both a BOM table AND section views with measurements. If ANY dimension values, tolerances, or feature callouts are visible anywhere on the page, extract them.

If it IS an engineering drawing (or mixed page with drawing content), extract the clearly visible data:

{
  "dimensions": [
    {
      "id": "D001",
      "label": "short description e.g. 'Hole diameter', 'Overall length', 'Pocket depth'",
      "nominal": 12.5,
      "unit": "mm",
      "tolerance_plus": 0.02,
      "tolerance_minus": 0.02,
      "quantity": 1
    }
  ],
  "gdt": [
    {
      "id": "G001",
      "symbol": "position | flatness | perpendicularity | parallelism | concentricity | runout | circularity | cylindricity | profile | angularity | symmetry | total_runout | straightness",
      "tolerance": 0.05,
      "unit": "mm",
      "datums": ["A"]
    }
  ],
  "threads": [
    {
      "id": "T001",
      "spec": "M8x1.25 or 1/4-20 UNC",
      "depth_mm": 15.0,
      "quantity": 2
    }
  ],
  "material": "specification e.g. 'AL6061-T6' or null if not shown",
  "surface_finish": "e.g. 'Ra 1.6' or null if not shown",
  "notes": []
}

Rules:
- Extract ONLY what is explicitly labeled on the drawing. Do not infer or guess.
- For bilateral tolerance ±X: tolerance_plus = X, tolerance_minus = X.
- If no tolerance callout exists for a dimension, omit tolerance_plus and tolerance_minus.
- If no GD&T frame control symbols are visible, return empty gdt array.
- RADIUS vs THREAD: "R" prefix always means RADIUS (e.g., R2.340, R4.50, 4X R4.50, 3X R2.340 are all radius dimensions). Never classify an R-prefixed value as a thread. Threads always include a pitch and standard callout: M8x1.25, 1/4-20 UNC, 3/8 NPT, TAP, THRU, etc.
- REFERENCE DIMENSIONS: Values in parentheses () are reference (non-toleranced) dimensions. "2X 18.215 (17.362)" means 2 features, nominal 18.215, reference 17.362 — it is a hole/feature dimension, NOT a thread.
- BOM TABLES: A table with "ITEM / QTY / PART NO. / DESCRIPTION" columns is a parts list (BOM). The "DIMENSIONS" column in a BOM table contains part numbers, not engineering measurements. Skip BOM table entries entirely.
- The "notes" field must always be [] (empty array) for a drawing page. Do NOT put engineering text notes in this field.
- Return JSON only. No explanations.`;

export function parseModelJson(rawText: string): Record<string, unknown> {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n").slice(1).join("\n");
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf("```"));
  }
  cleaned = cleaned.trim().replace(/`+$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { raw_model_output: rawText, dimensions: [], gdt: [], threads: [] };
  }
}

function isHardRejectNotes(notes: string[]): boolean {
  return notes.some(
    (n) => typeof n === "string" && n.toLowerCase().includes("not_a_drawing"),
  );
}

export type PageOutcome = "ok" | "hard_reject" | "soft_skip" | "unparseable";

export function classifyPageParsed(parsed: Record<string, unknown>): PageOutcome {
  if (parsed.raw_model_output) return "unparseable";
  const dims    = (parsed.dimensions as any[]) || [];
  const threads = (parsed.threads   as any[]) || [];
  if (dims.length > 0 || threads.length > 0) return "ok";
  const notes = (parsed.notes as string[]) || [];
  if (isHardRejectNotes(notes)) return "hard_reject";
  if (notes.some((n) => typeof n === "string" &&
      (n.toLowerCase().includes("non_technical") ||
       n.toLowerCase().includes("not_a_drawing")))) {
    return "soft_skip";
  }
  // Model returned valid JSON with no features and no classification note.
  // This means the model couldn't extract anything (image quality issue or truly empty page).
  // Treat as unparseable so the caller knows extraction was attempted but produced nothing,
  // rather than silently skipping as if it were a cover sheet.
  return "unparseable";
}

/** Merge per-page VLM JSON objects into one result (renumbered IDs). */
export function mergeVisionParsedResults(
  parsedList: Record<string, unknown>[],
): Record<string, unknown> {
  const allDims:    any[] = [];
  const allGdt:     any[] = [];
  const allThreads: any[] = [];
  let material:      unknown = null;
  let surface_finish: unknown = null;
  const allNotes: string[] = [];
  let dCounter = 1, gCounter = 1, tCounter = 1;

  for (const parsed of parsedList) {
    if (parsed.raw_model_output) continue;

    for (const d of (parsed.dimensions as any[]) || []) {
      const { id: _d, ...rest } = d;
      allDims.push({ ...rest, id: `D${String(dCounter++).padStart(3, "0")}` });
    }
    for (const g of (parsed.gdt as any[]) || []) {
      const { id: _g, ...rest } = g;
      allGdt.push({ ...rest, id: `G${String(gCounter++).padStart(3, "0")}` });
    }
    for (const t of (parsed.threads as any[]) || []) {
      const { id: _t, ...rest } = t;
      allThreads.push({ ...rest, id: `T${String(tCounter++).padStart(3, "0")}` });
    }
    if (!material      && parsed.material)       material       = parsed.material;
    if (!surface_finish && parsed.surface_finish) surface_finish = parsed.surface_finish;
    for (const note of (parsed.notes as string[]) || []) {
      if (typeof note === "string" && note.trim()) allNotes.push(note);
    }
  }

  return { dimensions: allDims, gdt: allGdt, threads: allThreads, material, surface_finish, notes: allNotes };
}

export function summarizeOutcomes(outcomes: PageOutcome[]): {
  anyOk: boolean;
  allHardReject: boolean;
  allBad: boolean;
} {
  const anyOk        = outcomes.some((o) => o === "ok");
  const allHardReject = outcomes.length > 0 && outcomes.every((o) => o === "hard_reject");
  const allBad        = outcomes.length > 0 && outcomes.every((o) => o === "hard_reject" || o === "unparseable");
  return { anyOk, allHardReject, allBad };
}
