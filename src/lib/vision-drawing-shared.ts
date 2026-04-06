/**
 * Shared prompts and merge helpers for VLM drawing extraction.
 * RunPod pod: rlnp01b095y6lf (RTX PRO 6000 Blackwell, vLLM 0.19.0)
 * Model: Qwen3-VL-32B-Thinking-FP8
 *
 * The VLM has ONE job: extract dimensions, tolerances, GD&T callouts,
 * and thread specifications from the 2D drawing.
 *
 * Feature recognition is handled deterministically by Python/BrepMFR.
 * Process mapping is handled by Python/FreeCAD Path rules.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Walk forward through `s` starting at index 0 (must be '{') to find the
 * matching closing '}', respecting nested braces and strings.
 * Returns -1 if no balanced close is found.
 */
function findMatchingBrace(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc)                    { esc = false; continue; }
    if (c === "\\" && inStr)    { esc = true;  continue; }
    if (c === '"')              { inStr = !inStr; continue; }
    if (inStr)                  continue;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// System prompt — concise role definition.
export const SYSTEM_PROMPT = `You are a metrology specialist reading a 2D engineering drawing. \
Extract dimensions, tolerances, GD&T callouts, and thread specifications. \
Output ONLY the JSON result — nothing else. Think briefly, then output JSON immediately.`;

export const EXTRACTION_PROMPT = `Extract all visible dimensions, GD&T callouts, threads, and material from this 2D engineering drawing page.

NON-DRAWING PAGES — return immediately without further analysis:
- Cover page / logo / blank / title block only → {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["non_technical_page"]}
- Photo or artwork (not a drawing) → {"dimensions":[],"gdt":[],"threads":[],"material":null,"surface_finish":null,"notes":["not_a_drawing"]}

DRAWING PAGES — output this JSON schema:
{
  "dimensions": [{"id":"D001","label":"Overall length","nominal":12.5,"unit":"mm","tolerance_plus":0.02,"tolerance_minus":0.02,"quantity":1}],
  "gdt": [{"id":"G001","symbol":"position","tolerance":0.05,"unit":"mm","datums":["A"]}],
  "threads": [{"id":"T001","spec":"M8x1.25","depth_mm":15.0,"quantity":2}],
  "material": "AL6061-T6 or null",
  "surface_finish": "Ra 1.6 or null",
  "notes": []
}

RULES (read carefully):
1. Extract ONLY explicitly labeled values — never infer or guess.
2. UNCERTAIN SYMBOL OR CALLOUT → STOP thinking about it immediately. Output nothing for that symbol and move to the next item.
3. Omit tolerance_plus/tolerance_minus if no tolerance is shown. Zero is a valid tolerance value.
4. Bilateral ±X → tolerance_plus=X, tolerance_minus=X. Unilateral +A/−B → tolerance_plus=A, tolerance_minus=B.
5. R prefix = RADIUS always (R2.34, 4X R4.50). Never a thread. Threads have pitch: M8x1.25, 1/4-20 UNC, TAP, THRU.
6. A dot/circle at a leader line end = arrowhead, not a GD&T diameter symbol.
7. Parenthesized values () = reference only — same entry, not a second one.
8. BOM table (ITEM/QTY/PART NO./DESCRIPTION) = parts list. Ignore ALL cells including part numbers.
9. Assembly view with BOM and no dimension lines → empty dimensions array.
10. Same nominal in N locations = ONE entry with quantity=N.
11. Thread depth_mm always in mm (inches × 25.4). Omit if not shown.
12. notes must be [] for drawing pages.
13. Response MUST be ONLY the JSON object. No text before or after.`;

/**
 * Adapt the extraction prompt when sending N pages in one API call.
 * The model sees all images at once and must return a single merged JSON.
 */
export function buildMultiPagePrompt(pageCount: number): string {
  return EXTRACTION_PROMPT
    .replace(
      "from this 2D engineering drawing page.",
      `from ALL ${pageCount} pages shown above. Merge all findings into a single JSON.`,
    )
    .replace("If this page is ONLY", "If a page is ONLY")
    .replace("If the image is completely unrelated", "If a page is completely unrelated");
}

export function parseModelJson(rawText: string): Record<string, unknown> {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.split("\n").slice(1).join("\n");
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf("```"));
  }
  cleaned = cleaned.trim().replace(/`+$/, "").trim();
  // Direct parse — works when model outputs pure JSON
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  // Model may prefix JSON with explanation text, or append trailing text after the JSON.
  // Use findMatchingBrace to extract just the balanced JSON object.
  const braceIdx = cleaned.indexOf("{");
  if (braceIdx !== -1) {
    // First try simple slice (fast path — handles prefix text with clean trailing JSON)
    try { return JSON.parse(cleaned.slice(braceIdx)); } catch { /* fall through */ }
    // Robust path: find the matching closing brace, ignoring any trailing text
    const fromBrace = cleaned.slice(braceIdx);
    const closeIdx  = findMatchingBrace(fromBrace);
    if (closeIdx !== -1) {
      try { return JSON.parse(fromBrace.slice(0, closeIdx + 1)); } catch { /* fall through */ }
    }
  }
  return { raw_model_output: rawText, dimensions: [], gdt: [], threads: [] };
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
  // The 32B thinking model is reliable enough that empty valid JSON = nothing to extract.
  // Treat as soft_skip rather than retrying — a retry won't produce features that aren't there.
  return "soft_skip";
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
