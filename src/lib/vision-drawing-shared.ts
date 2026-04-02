/**
 * Shared prompts and merge helpers for VLM drawing extraction (analyze_drawing + vlmodel).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const SYSTEM_PROMPT = `You are a CNC manufacturing engineer. Extract manufacturing features \
from 2D engineering drawings. Only extract what is clearly visible. \
If something is unclear or missing, skip it. Respond with JSON only.`;

export const EXTRACTION_PROMPT = `This is one page from a PDF drawing pack (or a single image). Return a JSON object.

If this page is NOT a technical drawing (cover sheet, logo/marketing only, blank, photo, or no part views/dimensions), return:
{"features": [], "gdt": [], "material": null, "notes": ["non_technical_page"]}

If the entire image is completely unrelated to machining (not a drawing at all), return:
{"features": [], "gdt": [], "material": null, "notes": ["Not an engineering drawing"]}

If it IS an engineering drawing, extract the clearly visible features:

{
  "features": [
    {
      "id": "F001",
      "type": "hole | fillet | radius | step | chamfer | thread | slot | pocket | bore | face",
      "description": "short label",
      "quantity": 1,
      "dimensions": {"primary_value": 0.0, "unit": "mm"},
      "tolerance": {"type": "bilateral", "plus": 0.0, "minus": 0.0}
    }
  ],
  "gdt": [
    {
      "feature_id": "F001",
      "symbol": "position",
      "tolerance": 0.0,
      "unit": "mm",
      "datums": ["A"]
    }
  ],
  "material": {"specification": "material if stated, otherwise null", "stock_dimensions": "if visible"},
  "notes": []
}

Rules:
- Only include features you can clearly identify. Do not guess.
- If material is not specified on the drawing, set material to null.
- If a tolerance is not shown, omit the tolerance field for that feature.
- If no GD&T callouts are visible, return an empty gdt array.
- Return the JSON immediately. Do not explain or repeat.`;

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
    return { raw_model_output: rawText, features: [], gdt: [] };
  }
}

function isHardRejectNotes(notes: string[]): boolean {
  return notes.some(
    (n) => typeof n === "string" && n.toLowerCase().includes("not an engineering"),
  );
}

export type PageOutcome = "ok" | "hard_reject" | "soft_skip" | "unparseable";

export function classifyPageParsed(parsed: Record<string, unknown>): PageOutcome {
  if (parsed.raw_model_output) return "unparseable";
  const feats = (parsed.features as any[]) || [];
  if (feats.length > 0) return "ok";
  const notes = (parsed.notes as string[]) || [];
  if (isHardRejectNotes(notes)) return "hard_reject";
  if (notes.some((n) => typeof n === "string" && n.toLowerCase().includes("non_technical"))) {
    return "soft_skip";
  }
  return "soft_skip";
}

/** Merge per-page VLM JSON objects into one result (new feature ids). */
export function mergeVisionParsedResults(parsedList: Record<string, unknown>[]): Record<string, unknown> {
  const allFeatures: any[] = [];
  const allGdt: any[] = [];
  let material: unknown = null;
  const allNotes: string[] = [];
  let idCounter = 1;

  for (const parsed of parsedList) {
    if (parsed.raw_model_output) continue;
    const feats = (parsed.features as any[]) || [];
    for (const f of feats) {
      const { id: _drop, ...rest } = f;
      allFeatures.push({
        ...rest,
        id: `F${String(idCounter++).padStart(3, "0")}`,
      });
    }
    allGdt.push(...((parsed.gdt as any[]) || []));
    if (!material && parsed.material) material = parsed.material;
    const n = (parsed.notes as string[]) || [];
    for (const note of n) {
      if (typeof note === "string" && note.trim()) allNotes.push(note);
    }
  }

  return {
    features: allFeatures,
    gdt: allGdt,
    material,
    notes: allNotes,
  };
}

export function summarizeOutcomes(outcomes: PageOutcome[]): {
  anyOk: boolean;
  allHardReject: boolean;
  allBad: boolean;
} {
  const anyOk = outcomes.some((o) => o === "ok");
  const allHardReject =
    outcomes.length > 0 && outcomes.every((o) => o === "hard_reject");
  const allBad =
    outcomes.length > 0 &&
    outcomes.every((o) => o === "hard_reject" || o === "unparseable");
  return { anyOk, allHardReject, allBad };
}
