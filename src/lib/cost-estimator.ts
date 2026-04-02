/**
 * Formula-based fabrication cost estimation — port of backend/app/services/cost_estimator.py
 *
 * Cost = Raw Material + Setup + Sum(process_minutes * shop_rate) + Overhead
 */

import type { CycleTimeResult } from "./cycle-time";

export interface CostBreakdownItem {
  line: string;
  amount_usd: number;
  minutes_basis?: number;
  category: string;
}

export interface CostResult {
  currency: string;
  total_usd: number;
  shop_rate_per_hour: number;
  overhead_pct: number;
  breakdown: CostBreakdownItem[];
  formatted_lines: string[];
}

export function estimateCost(
  cycleTime: CycleTimeResult,
  shopRatePerHour = 60.0,
  rawMaterialUsd = 15.0,
  overheadPct = 15.0,
  billSetup = true,
): CostResult {
  const usdPerMin = shopRatePerHour / 60.0;

  const breakdown: CostBreakdownItem[] = [
    { line: "Raw Material", amount_usd: round2(rawMaterialUsd), category: "material" },
  ];

  let machiningSubtotal = 0.0;

  for (const row of cycleTime.breakdown) {
    const process = row.process;
    const minutes = row.minutes;

    if (process.toLowerCase() === "setup") {
      if (billSetup) {
        const amount = round2(minutes * usdPerMin);
        breakdown.push({ line: "Setup", amount_usd: amount, minutes_basis: minutes, category: "setup" });
        machiningSubtotal += amount;
      }
      continue;
    }

    const amount = round2(minutes * usdPerMin);
    breakdown.push({ line: process, amount_usd: amount, minutes_basis: minutes, category: "machining" });
    machiningSubtotal += amount;
  }

  if (overheadPct > 0) {
    const overheadUsd = round2(machiningSubtotal * overheadPct / 100.0);
    breakdown.push({ line: `Overhead (${overheadPct}%)`, amount_usd: overheadUsd, category: "overhead" });
  }

  const total = round2(breakdown.reduce((sum, item) => sum + item.amount_usd, 0));

  const formatted = ["\u2756 Fabrication cost breakdown:"];
  for (const item of breakdown) {
    formatted.push(`\u2022 ${item.line} : USD ${item.amount_usd}`);
  }

  return {
    currency: "USD",
    total_usd: total,
    shop_rate_per_hour: shopRatePerHour,
    overhead_pct: overheadPct,
    breakdown,
    formatted_lines: formatted,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
