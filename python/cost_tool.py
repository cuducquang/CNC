"""
Cost estimation — port of src/lib/tools/estimate-cost.ts.

Calculates: Raw Material + Setup + Machining Labor + Overhead.
"""
from __future__ import annotations
import json


def _r2(n: float) -> float:
    return round(n * 100) / 100


def estimate_cost(args: dict) -> dict:
    """
    Estimate fabrication cost from cycle time result.

    args:
      cycle_time_json     : JSON string or dict from estimate_cycle_time
      shop_rate_per_hour  : USD/hr  (default 60)
      raw_material_usd    : USD     (default 15)
      overhead_pct        : %       (default 15)
    """
    ct_raw = args.get("cycle_time_json") or {}
    ct = json.loads(ct_raw) if isinstance(ct_raw, str) else ct_raw

    shop_rate = float(args.get("shop_rate_per_hour") or 60)
    raw_mat   = float(args.get("raw_material_usd")   or 15)
    overhead  = float(args.get("overhead_pct")        or 15)
    usd_per_min = shop_rate / 60.0

    breakdown: list[dict] = [
        {"line": "Raw Material", "amount_usd": _r2(raw_mat), "category": "material"},
    ]
    mach_sub = 0.0

    for row in (ct.get("breakdown") or []):
        minutes = row.get("minutes") or 0.0
        amt     = _r2(minutes * usd_per_min)
        if (row.get("process") or "").lower() == "setup":
            breakdown.append({"line": "Setup", "amount_usd": amt, "minutes_basis": minutes, "category": "setup"})
        else:
            breakdown.append({"line": row.get("process"), "amount_usd": amt, "minutes_basis": minutes, "category": "machining"})
        mach_sub += amt

    if overhead > 0:
        breakdown.append({"line": f"Overhead ({overhead}%)", "amount_usd": _r2(mach_sub * overhead / 100), "category": "overhead"})

    total = _r2(sum(i["amount_usd"] for i in breakdown))
    return {"currency": "USD", "total_usd": total, "shop_rate_per_hour": shop_rate, "overhead_pct": overhead, "breakdown": breakdown}
