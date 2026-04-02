/**
 * Tool: lookup_material
 *
 * Looks up material properties from the shared materials database.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";
import { MATERIALS, matchMaterial } from "../materials";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "lookup_material",
    description:
      "Look up material properties including cutting speeds (SFM for HSS and Carbide tools), feed factor, density, and cost per pound. Supports aluminum alloys (6061-T6, 7075-T6), mild steel (1018), stainless steel (304), and more.",
    parameters: {
      type: "object",
      properties: {
        material_spec: {
          type: "string",
          description: "Material specification string (e.g., '6061-T6 Aluminum', '304 Stainless Steel', '1018 Mild Steel')",
        },
      },
      required: ["material_spec"],
    },
  },
};

// ---------------------------------------------------------------------------
// Handler — runs when the LLM calls lookup_material
// ---------------------------------------------------------------------------

export async function lookupMaterial(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const spec = (args.material_spec || "") as string;
  const s    = spec.toLowerCase().replace(/-/g, "");

  // Try exact key match first
  for (const [key, mat] of Object.entries(MATERIALS)) {
    if (s.includes(key.toLowerCase().replace(/-/g, "")) || s.includes(mat.name.toLowerCase().split(" ")[0])) {
      return { found: true, ...mat };
    }
  }

  // Fuzzy keyword fallback via shared matchMaterial
  const matched = matchMaterial(spec);
  if (matched.name !== "Unknown Material (assumed Aluminum)") {
    return { found: true, ...matched };
  }

  return {
    found: false,
    message: `Material "${spec}" not found in database. Available: ${Object.values(MATERIALS).map((m) => m.name).join(", ")}`,
    default: MATERIALS["6061-T6"],
  };
}
