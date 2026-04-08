"""
Cycle time estimation — port of src/lib/tools/estimate-cycle-time.ts.

formula: cutting_time = toolpath_distance / feed_rate
Works for both mm/mm-per-min (Python process maps) and in/ipm (legacy TypeScript maps).
"""
from __future__ import annotations
import json
import math
from typing import Any

SETUP_MIN       = 10.0
TOOL_CHANGE_MIN = 0.5
RAPID_MMPM      = 5080.0
APPROACH_MM     = 6.35

# Legacy inch heuristic constants
_REF_DIM: dict[str, float] = {
    "hole": 0.34, "fillet": 0.1, "chamfer": 0.02, "thread": 0.19,
    "radius": 0.01, "step": 0.125, "slot": 0.25, "pocket": 0.5, "bore": 0.5, "face": 1.0,
}
_BASE_TIME: dict[str, float] = {
    "fillet": 3, "step": 2, "chamfer": 0.5, "slot": 2,
    "pocket_rough": 2, "pocket_finish": 1.5,
    "hole_rough": 1.5, "hole_finish": 1,
    "thread_drill": 0.75, "thread_cut": 1,
    "radius_per_unit": 0.125, "bore": 2, "face": 1,
}


def _r2(n: float) -> float:
    return round(n * 100) / 100


def _r3(n: float) -> float:
    return round(n * 1000) / 1000


def _scale(actual: float, ref: float) -> float:
    if ref <= 0 or actual <= 0:
        return 1.0
    return max(0.3, min(math.pow(actual / ref, 0.7), 5.0))


def _feat_procs(feat: dict) -> list[dict]:
    t    = (feat.get("type") or "").lower()
    desc = feat.get("description") or t
    dim  = float((feat.get("dimensions") or {}).get("primary_value") or 0)
    s    = _scale(dim, _REF_DIM.get(t, 0.25))
    procs: list[dict] = []

    if t == "hole":
        procs += [
            {"process": f"Rough Milling - {desc}", "minutes": _r2(_BASE_TIME["hole_rough"] * s)},
            {"process": f"Finish Milling - {desc}", "minutes": _r2(_BASE_TIME["hole_finish"] * s)},
        ]
    elif t == "thread":
        procs += [
            {"process": "Drilling - Thread Hole", "minutes": _r2(_BASE_TIME["thread_drill"] * s)},
            {"process": f"Thread Cut - {desc}",   "minutes": _r2(_BASE_TIME["thread_cut"]   * s)},
        ]
    elif t == "pocket":
        procs += [
            {"process": f"Rough Milling - {desc}",  "minutes": _r2(_BASE_TIME["pocket_rough"]  * s)},
            {"process": f"Finish Milling - {desc}", "minutes": _r2(_BASE_TIME["pocket_finish"] * s)},
        ]
    else:
        procs.append({"process": f"Milling - {desc}", "minutes": _r2(_BASE_TIME.get(t, 1.0) * s)})

    return procs


def estimate_cycle_time(args: dict) -> dict:
    """
    Estimate cycle time from process map (from_processes) or VLM extraction (from_features).
    Accepts both Python mm process maps and legacy TypeScript inch process maps.
    """
    method = args.get("method") or "from_processes"

    # ── Precise path: process map ────────────────────────────────────────────
    if method == "from_processes" and args.get("process_map_json"):
        pm_raw = args["process_map_json"]
        pm = json.loads(pm_raw) if isinstance(pm_raw, str) else pm_raw

        # Support both Python (operations list) and legacy TS (process_map list)
        ops: list[dict] = pm if isinstance(pm, list) else (pm.get("operations") or pm.get("process_map") or [])
        bd: list[dict] = [{"process": "Setup", "minutes": SETUP_MIN, "category": "setup"}]
        prev_tool: str | None = None
        tool_changes = 0

        for op in ops:
            dist_mm = (
                op.get("toolpath_distance_mm")
                or ((op.get("toolpath_distance_in") or 0) * 25.4)
            )
            params = op.get("params") or {}
            feed_mmpm = (
                params.get("feed_rate_mmpm")
                or ((params.get("feed_rate_ipm") or 0) * 25.4)
                or 1.0
            )

            tool = op.get("tool") or {}
            tool_key = tool.get("type") or tool.get("key") or "unknown"

            if prev_tool is not None and tool_key != prev_tool:
                tool_changes += 1
            prev_tool = tool_key

            cut_min   = (dist_mm / feed_mmpm) if (feed_mmpm > 0 and dist_mm > 0) else 0.5
            rapid_min = (2 * APPROACH_MM) / RAPID_MMPM
            bd.append({
                "process":  op.get("label") or op.get("operation") or tool_key,
                "minutes":  _r3(cut_min + rapid_min),
                "category": "machining",
            })

        if tool_changes > 0:
            bd.append({
                "process":  f"Tool Changes ({tool_changes}x)",
                "minutes":  _r2(tool_changes * TOOL_CHANGE_MIN),
                "category": "tool_change",
            })

        total = _r2(sum(r["minutes"] for r in bd))
        return {"method": "cutting_parameter_based", "total_minutes": total, "breakdown": bd}

    # ── Sheet metal process path ──────────────────────────────────────────────
    if method == "from_sheet_metal_processes" and args.get("process_map_json"):
        pm_raw = args["process_map_json"]
        pm = json.loads(pm_raw) if isinstance(pm_raw, str) else pm_raw
        procs: list[dict] = pm if isinstance(pm, list) else (pm.get("processes") or [])

        bd: list[dict] = [{"process": "Material Handling / Setup", "minutes": 5.0, "category": "setup"}]

        # Laser speed: default 3000 mm/min (2mm Al), scales with thickness
        _LASER_SPEED_MMPM = 3000.0

        for proc in procs:
            ptype = proc.get("process_type", "")
            label = proc.get("label") or ptype.replace("_", " ").title()
            op_count = int(proc.get("operation_count") or 1)
            cut_mm = float(proc.get("cut_length_mm") or 0.0)
            n_bends = int(proc.get("bend_count") or 0)

            if ptype in ("laser_cutting", "plasma_cutting", "waterjet_cutting", "fine_blanking"):
                minutes = (cut_mm / _LASER_SPEED_MMPM) if cut_mm > 0 else 1.0
                bd.append({"process": label, "minutes": _r3(minutes), "category": "machining"})

            elif ptype == "punching":
                # ~6 seconds per punch
                minutes = op_count * 0.1
                bd.append({"process": label, "minutes": _r2(minutes), "category": "machining"})

            elif ptype == "drilling":
                # ~30 seconds per hole (sheet metal drill)
                minutes = op_count * 0.5
                bd.append({"process": label, "minutes": _r2(minutes), "category": "machining"})

            elif ptype == "press_brake_bending":
                # ~45 seconds per bend (setup + execute)
                minutes = n_bends * 0.75 if n_bends > 0 else op_count * 0.75
                bd.append({"process": label, "minutes": _r2(minutes), "category": "machining"})

            elif ptype == "deburring":
                bd.append({"process": label, "minutes": 2.0, "category": "finishing"})

            else:
                # Generic: 1 min per operation
                minutes = op_count * 1.0
                bd.append({"process": label, "minutes": _r2(minutes), "category": "machining"})

        total = _r2(sum(r["minutes"] for r in bd))
        return {"method": "sheet_metal_process_based", "total_minutes": total, "breakdown": bd}

    # ── Tube/pipe process path ────────────────────────────────────────────────
    if method == "from_tube_processes" and args.get("process_map_json"):
        pm_raw = args["process_map_json"]
        pm = json.loads(pm_raw) if isinstance(pm_raw, str) else pm_raw
        procs = pm if isinstance(pm, list) else (pm.get("processes") or [])

        bd = [{"process": "Setup", "minutes": 5.0, "category": "setup"}]

        for proc in procs:
            ptype = proc.get("process_type", "")
            label = proc.get("label") or ptype.replace("_", " ").title()
            n_bends = int(proc.get("bend_count") or 0)

            if ptype == "tube_laser_cutting":
                bd.append({"process": label, "minutes": 3.0, "category": "machining"})
            elif ptype == "tube_bending":
                minutes = n_bends * 1.5 if n_bends > 0 else 1.5
                bd.append({"process": label, "minutes": _r2(minutes), "category": "machining"})
            else:
                bd.append({"process": label, "minutes": 1.0, "category": "machining"})

        total = _r2(sum(r["minutes"] for r in bd))
        return {"method": "tube_process_based", "total_minutes": total, "breakdown": bd}

    # ── Heuristic path: legacy 2D extraction ─────────────────────────────────
    ext_raw = args.get("extraction_json") or {}
    ext = json.loads(ext_raw) if isinstance(ext_raw, str) else ext_raw

    feats:   list = ext.get("features")   or []
    dims:    list = ext.get("dimensions") or []
    threads: list = ext.get("threads")    or []
    bd = [{"process": "Setup", "minutes": SETUP_MIN, "category": "setup"}]
    tool_types: set[str] = set()

    if feats:
        for f in feats:
            for p in _feat_procs(f):
                bd.append({**p, "category": "machining"})
            tool_types.add(f.get("type") or "")
    else:
        if dims:
            bd.append({"process": "Machining (dimension-based estimate)", "minutes": _r2(len(dims) * 1.5), "category": "machining"})
            tool_types.add("mill")
        for t in threads:
            bd.append({"process": f"Thread {t.get('spec') or '?'}", "minutes": 3.0, "category": "machining"})
            tool_types.add("thread_mill")

    if len(tool_types) > 1:
        tc = len(tool_types) - 1
        bd.append({"process": f"Tool Changes ({tc}x)", "minutes": _r2(tc * TOOL_CHANGE_MIN), "category": "tool_change"})

    total = _r2(sum(r["minutes"] for r in bd))
    return {"method": "feature_based_heuristic", "total_minutes": total, "breakdown": bd}
