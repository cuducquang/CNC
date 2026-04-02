/**
 * Tool: estimate_cost
 *
 * Calculates fabrication cost: Material + Setup + Machining + Overhead
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ToolDefinition } from "../agent/types";

// ---------------------------------------------------------------------------
// Schema — what the LLM sees when deciding to call this tool
// ---------------------------------------------------------------------------

export const schema: ToolDefinition = {
  type: "function",
  function: {
    name: "estimate_cost",
    description:
      "Calculate total fabrication cost including raw material, setup, machining labor (based on shop rate), and overhead. Requires cycle time breakdown as input.",
    parameters: {
      type: "object",
      properties: {
        cycle_time_json: {
          type: "string",
          description: "JSON string of the cycle time result from estimate_cycle_time",
        },
        shop_rate_per_hour: {
          type: "string",
          description: "Shop rate in USD per hour (default: 60.0)",
        },
        raw_material_usd: {
          type: "string",
          description: "Raw material cost in USD (default: 15.0)",
        },
        overhead_pct: {
          type: "string",
          description: "Overhead percentage (default: 15.0)",
        },
      },
      required: ["cycle_time_json"],
    },
  },
};

// ---------------------------------------------------------------------------
// Handler — runs when the LLM calls estimate_cost
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function estimateCost(
  args: Record<string, any>,
): Promise<Record<string, unknown>> {
  const ct       = typeof args.cycle_time_json === "string" ? JSON.parse(args.cycle_time_json) : args.cycle_time_json;
  const shopRate = parseFloat(args.shop_rate_per_hour || "60");
  const rawMat   = parseFloat(args.raw_material_usd   || "15");
  const overhead = parseFloat(args.overhead_pct       || "15");
  const usdPerMin = shopRate / 60;

  const breakdown: any[] = [
    { line: "Raw Material", amount_usd: r2(rawMat), category: "material" },
  ];
  let machSub = 0;

  for (const row of ct.breakdown || []) {
    const min = row.minutes || 0;
    const amt = r2(min * usdPerMin);
    if (row.process?.toLowerCase() === "setup") {
      breakdown.push({ line: "Setup", amount_usd: amt, minutes_basis: min, category: "setup" });
    } else {
      breakdown.push({ line: row.process, amount_usd: amt, minutes_basis: min, category: "machining" });
    }
    machSub += amt;
  }

  if (overhead > 0) {
    breakdown.push({ line: `Overhead (${overhead}%)`, amount_usd: r2(machSub * overhead / 100), category: "overhead" });
  }

  const total = r2(breakdown.reduce((s: number, i: any) => s + i.amount_usd, 0));

  return { currency: "USD", total_usd: total, shop_rate_per_hour: shopRate, overhead_pct: overhead, breakdown };
}
