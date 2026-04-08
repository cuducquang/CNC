"""
Deterministic CNC Process Mapper.

Maps recognized 3D features (from BrepMFR or FreeCAD) + 2D dimensional/GD&T data
(from VLM extraction) to CNC machining operations with cutting parameters.

All units are metric (mm) internally.
"""
from __future__ import annotations

import math
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Material cutting parameters
# sfm = surface m/min (carbide), sfm_hss = surface m/min (HSS), fpt_mm = mm/tooth
# ---------------------------------------------------------------------------

MATERIAL_PARAMS: Dict[str, Dict[str, Any]] = {
    "Al6061":  {"sfm": 150.0, "sfm_hss": 30.5, "fpt_mm": 0.08, "hardness_bhn": 95},
    "Al7075":  {"sfm": 135.0, "sfm_hss": 24.4, "fpt_mm": 0.07, "hardness_bhn": 150},
    "SS304":   {"sfm": 27.5,  "sfm_hss": 4.6,  "fpt_mm": 0.04, "hardness_bhn": 170},
    "SS316":   {"sfm": 24.4,  "sfm_hss": 3.7,  "fpt_mm": 0.03, "hardness_bhn": 180},
    "Ti6Al4V": {"sfm": 13.7,  "sfm_hss": 2.4,  "fpt_mm": 0.025,"hardness_bhn": 320},
    "C1018":   {"sfm": 42.7,  "sfm_hss": 7.6,  "fpt_mm": 0.06, "hardness_bhn": 126},
    "C4140":   {"sfm": 36.6,  "sfm_hss": 6.1,  "fpt_mm": 0.05, "hardness_bhn": 197},
    "Delrin":  {"sfm": 106.7, "sfm_hss": 21.3, "fpt_mm": 0.10, "hardness_bhn": 70},
    "PEEK":    {"sfm": 91.4,  "sfm_hss": 18.3, "fpt_mm": 0.08, "hardness_bhn": 85},
}
_DEFAULT_MAT = MATERIAL_PARAMS["Al6061"]

# Material name aliases for drawing extraction strings
_MAT_ALIASES: Dict[str, str] = {
    "6061": "Al6061", "al6061": "Al6061", "6061-t6": "Al6061", "al 6061": "Al6061",
    "7075": "Al7075", "al7075": "Al7075", "7075-t6": "Al7075",
    "304":  "SS304",  "ss304":  "SS304",  "304 ss":  "SS304",  "stainless": "SS304",
    "316":  "SS316",  "ss316":  "SS316",
    "ti6al4v": "Ti6Al4V", "titanium": "Ti6Al4V", "ti-6al-4v": "Ti6Al4V",
    "1018": "C1018",  "mild steel": "C1018",
    "4140": "C4140",  "alloy steel": "C4140",
    "delrin": "Delrin", "acetal": "Delrin",
    "peek": "PEEK",
}


def resolve_material(raw: Optional[str], default: str = "Al6061") -> str:
    """Normalise a material string to a known MATERIAL_PARAMS key."""
    if not raw:
        return default
    key = raw.strip().lower()
    if key in _MAT_ALIASES:
        return _MAT_ALIASES[key]
    for alias, canon in _MAT_ALIASES.items():
        if alias in key:
            return canon
    return default


# ---------------------------------------------------------------------------
# Tool definitions (diameters set from feature at runtime, all in mm)
# ---------------------------------------------------------------------------

TOOLS: Dict[str, Dict[str, Any]] = {
    "center_drill":  {"type": "center_drill",  "diameter_mm": 3.175, "teeth": 2, "material": "HSS"},
    "twist_drill":   {"type": "twist_drill",   "diameter_mm": None,  "teeth": 2, "material": "HSS"},
    "reamer":        {"type": "reamer",        "diameter_mm": None,  "teeth": 6, "material": "HSS"},
    "end_mill_2f":   {"type": "end_mill_2f",   "diameter_mm": None,  "teeth": 2, "material": "Carbide"},
    "end_mill_4f":   {"type": "end_mill_4f",   "diameter_mm": None,  "teeth": 4, "material": "Carbide"},
    "ball_end_mill": {"type": "ball_end_mill", "diameter_mm": None,  "teeth": 2, "material": "Carbide"},
    "chamfer_mill":  {"type": "chamfer_mill",  "diameter_mm": None,  "teeth": 2, "material": "Carbide"},
    "thread_mill":   {"type": "thread_mill",   "diameter_mm": None,  "teeth": 1, "material": "Carbide"},
}

# ---------------------------------------------------------------------------
# Feature → operation template
# rel_dia: tool diameter = feature_ref_dim × rel_dia  (0.0 = use fixed diameter)
# ---------------------------------------------------------------------------

FEATURE_OPS: Dict[str, List[Dict[str, Any]]] = {
    "hole": [
        {"op": "center_drill",   "tool": "center_drill",  "rel_dia": 0.0},  # fixed 3.175 mm
        {"op": "drilling",       "tool": "twist_drill",   "rel_dia": 1.0},  # matches hole dia
    ],
    "boss": [
        {"op": "milling_rough",  "tool": "end_mill_4f",   "rel_dia": 0.5},
        {"op": "milling_finish", "tool": "end_mill_4f",   "rel_dia": 0.4},
    ],
    "pocket": [
        {"op": "milling_rough",  "tool": "end_mill_4f",   "rel_dia": 0.4},
        {"op": "milling_finish", "tool": "end_mill_4f",   "rel_dia": 0.3},
    ],
    "slot": [
        {"op": "milling_rough",  "tool": "end_mill_2f",   "rel_dia": 1.0},  # = slot width
    ],
    "fillet": [
        {"op": "milling_finish", "tool": "ball_end_mill", "rel_dia": 2.0},  # = 2×radius
    ],
    "chamfer": [
        {"op": "chamfering",     "tool": "chamfer_mill",  "rel_dia": 1.0},
    ],
    "step": [
        {"op": "milling_rough",  "tool": "end_mill_4f",   "rel_dia": 0.5},
        {"op": "milling_finish", "tool": "end_mill_4f",   "rel_dia": 0.375},
    ],
    "countersink": [
        {"op": "chamfering",     "tool": "chamfer_mill",  "rel_dia": 1.0},
    ],
}

# ---------------------------------------------------------------------------
# Tolerance classification
# ---------------------------------------------------------------------------

def classify_tolerance(tol_plus: Optional[float], tol_minus: Optional[float]) -> str:
    """Return 'precision' | 'close' | 'medium' | 'general'."""
    if tol_plus is None and tol_minus is None:
        return "general"
    band = (tol_plus or 0.0) + (tol_minus or 0.0)
    if band <= 0.025:  return "precision"
    if band <= 0.127:  return "close"
    if band <= 0.254:  return "medium"
    return "general"


# ---------------------------------------------------------------------------
# Cutting parameter helpers
# ---------------------------------------------------------------------------

def calc_rpm(sfm_m_min: float, diameter_mm: float) -> int:
    """RPM from surface speed (m/min) and tool diameter (mm)."""
    if diameter_mm <= 0:
        return 500
    return max(100, int(round((sfm_m_min * 1000.0) / (math.pi * diameter_mm))))


def calc_feed_mmpm(rpm: int, fpt_mm: float, teeth: int) -> float:
    """Feed rate in mm/min."""
    return round(rpm * fpt_mm * teeth, 2)


def toolpath_distance_mm(
    op: str, ftype: str,
    tool_dia: float, depth: float, length: float,
) -> float:
    """Estimate toolpath distance in mm."""
    if op in ("center_drill", "drilling", "reaming"):
        return depth
    if op == "threading":
        pitch = max(tool_dia / 10.0, 0.5)
        return math.pi * tool_dia * (depth / pitch)
    if op in ("milling_rough", "milling_finish"):
        if ftype in ("pocket", "step", "boss"):
            passes = max(1, int(depth / max(tool_dia * 0.25, 0.1)))
            return math.pi * tool_dia * passes
        if ftype == "slot":
            return length
        return math.pi * tool_dia * 2
    if op == "chamfering":
        return math.pi * tool_dia
    return max(tool_dia, depth, 1.0)


# ---------------------------------------------------------------------------
# Matching helpers
# ---------------------------------------------------------------------------

def _parse_mm(val: Any) -> float:
    if val is None:
        return 0.0
    try:
        return float(str(val).replace("mm", "").replace("in", "").strip())
    except (ValueError, TypeError):
        return 0.0


def _match_tolerance(
    nominal_mm: float,
    dims: List[Dict[str, Any]],
) -> Tuple[Optional[float], Optional[float]]:
    """Find closest matching dimension and return its tolerance values."""
    if nominal_mm <= 0 or not dims:
        return None, None
    best: Optional[Dict[str, Any]] = None
    best_diff = float("inf")
    for d in dims:
        try:
            n = float(d.get("nominal") or 0)
        except (TypeError, ValueError):
            continue
        diff = abs(n - nominal_mm)
        if diff < best_diff and diff <= max(nominal_mm * 0.15, 0.5):
            best_diff = diff
            best = d
    if best is None:
        return None, None
    tp = best.get("tolerance_plus")
    tm = best.get("tolerance_minus")
    return (
        float(tp) if tp is not None else None,
        float(tm) if tm is not None else None,
    )


def _customer_label(op: str, ftype: str, feat_id: str) -> str:
    """
    Translate internal operation + feature type to customer process vocabulary.

    Vocabulary:
      "Drilling"              — hole drilling ops (center_drill, drilling, reaming)
      "Taping"                — thread cutting (threading)
      "Boring"                — large hole ops (boring)
      "End Milling - Roughing"  — rough pass on pocket / slot
      "End Milling - Finishing" — finish pass on pocket / slot
      "Side Milling"          — contour/profile: step, boss, fillet, chamfer (outer)
      "End Milling"           — default milling (fillet in pocket, single-pass features)
    """
    f = ftype.lower()
    o = op.lower()

    # Hole-making ops
    if o in ("center_drill", "drilling", "reaming"):
        return "Drilling"

    # Thread cutting
    if o == "threading":
        return "Taping"

    # Boring (large holes)
    if o == "boring":
        return "Boring"

    # Pocket / slot — two-pass
    if f in ("pocket", "slot"):
        if o == "milling_rough":
            return "End Milling - Roughing"
        if o == "milling_finish":
            return "End Milling - Finishing"

    # Outer-profile features → Side Milling
    if f in ("step", "boss", "fillet", "chamfer"):
        return "Side Milling"

    # Countersink is a drilling/chamfering op
    if f == "countersink":
        return "Drilling"

    # Default: End Milling
    return "End Milling"


# ---------------------------------------------------------------------------
# Thread spec parsers
# ---------------------------------------------------------------------------

def parse_thread_dia_mm(spec: str) -> float:
    """Nominal diameter in mm from thread spec string."""
    m = re.match(r"[Mm](\d+(?:\.\d+)?)", spec)
    if m:
        return float(m.group(1))
    m = re.match(r"(\d+)/(\d+)", spec)
    if m:
        return float(m.group(1)) / float(m.group(2)) * 25.4
    m = re.match(r"#(\d+)", spec)
    if m:
        n = int(m.group(1))
        return (0.060 + 0.013 * n) * 25.4
    return 6.35  # fallback: 1/4"


def parse_thread_pitch_mm(spec: str) -> float:
    """Pitch in mm from thread spec string."""
    m = re.match(r"[Mm]\d+(?:\.\d+)?[xX×](\d+(?:\.\d+)?)", spec)
    if m:
        return float(m.group(1))
    m = re.search(r"-(\d+)", spec)
    if m:
        tpi = float(m.group(1))
        return round(25.4 / tpi, 4) if tpi > 0 else 1.0
    return 1.0


# ---------------------------------------------------------------------------
# Main public function
# ---------------------------------------------------------------------------

def map_processes(
    features: List[Dict[str, Any]],
    extraction: Dict[str, Any],
    material: str = "Al6061",
) -> List[Dict[str, Any]]:
    """
    Map 3D features + 2D extraction to machining operations.

    Args:
        features:   Recognised feature dicts from BrepMFR / FreeCAD step_analyzer
        extraction: VLM extraction {dimensions, gdt, threads, material, …}
        material:   Resolved material key (e.g. "Al6061")

    Returns:
        List of operation dicts matching ProcessOperation schema.
    """
    mat = MATERIAL_PARAMS.get(material, _DEFAULT_MAT)
    sfm_carbide = mat["sfm"]
    sfm_hss     = mat["sfm_hss"]
    fpt_base    = mat["fpt_mm"]

    dims       = extraction.get("dimensions", []) or []
    threads_2d = extraction.get("threads",    []) or []

    ops: List[Dict[str, Any]] = []
    seq = 1

    # ── 3D feature → operations ───────────────────────────────────────────────
    for feat in features:
        ftype   = (feat.get("type") or "").lower()
        feat_id = feat.get("id", "?")
        fdims   = feat.get("dimensions", {}) or {}

        dia_mm    = _parse_mm(fdims.get("diameter_mm") or fdims.get("diameter"))
        depth_mm  = _parse_mm(fdims.get("depth_mm")    or fdims.get("depth"))
        width_mm  = _parse_mm(fdims.get("width_mm")    or fdims.get("width"))
        length_mm = _parse_mm(fdims.get("length_mm")   or fdims.get("length"))
        radius_mm = _parse_mm(fdims.get("radius_mm")   or fdims.get("radius"))

        if dia_mm <= 0 and radius_mm > 0:
            dia_mm = radius_mm * 2.0

        ref_dim = dia_mm or width_mm or 6.0

        # Match tolerance from 2D extraction
        tol_plus, tol_minus = _match_tolerance(ref_dim, dims)
        tol_class = classify_tolerance(tol_plus, tol_minus)

        template = FEATURE_OPS.get(ftype, [])
        if not template:
            logger.debug("No template for feature type '%s' (%s) — skipping", ftype, feat_id)
            continue

        for step in template:
            tool_key = step["tool"]
            tool_def = dict(TOOLS[tool_key])  # shallow copy

            # Resolve tool diameter
            if tool_def["diameter_mm"] is None:
                rel = step["rel_dia"]
                tool_def["diameter_mm"] = round(ref_dim * rel, 3) if rel > 0 else 3.175

            tool_dia = tool_def["diameter_mm"]
            teeth    = tool_def["teeth"]
            use_hss  = tool_def["material"] == "HSS"
            sfm_use  = sfm_hss if use_hss else sfm_carbide
            fpt_use  = fpt_base * (0.8 if use_hss else 1.0)

            rpm  = calc_rpm(sfm_use, tool_dia)
            feed = calc_feed_mmpm(rpm, fpt_use, teeth)
            dist = toolpath_distance_mm(
                step["op"], ftype, tool_dia,
                depth_mm or (ref_dim * 2.0),
                length_mm or ref_dim,
            )

            ops.append({
                "id":           f"OP{seq:03d}",
                "feature_id":   feat_id,
                "sequence":     seq,
                "operation":    step["op"],
                "label":        _customer_label(step["op"], ftype, feat_id),
                "tool":         tool_def,
                "params": {
                    "spindle_rpm":    rpm,
                    "feed_rate_mmpm": feed,
                    "depth_mm":       round(depth_mm or ref_dim * 2.0, 3),
                    "width_mm":       round(width_mm or ref_dim, 3),
                },
                "toolpath_distance_mm": round(dist, 3),
            })
            seq += 1

        # Reaming for tight-tolerance holes
        if ftype == "hole" and tol_class in ("precision", "close") and dia_mm > 0:
            ream = dict(TOOLS["reamer"])
            ream["diameter_mm"] = dia_mm
            r_rpm  = calc_rpm(sfm_hss * 0.3, dia_mm)
            r_feed = calc_feed_mmpm(r_rpm, 0.02, 6)
            r_dist = depth_mm or dia_mm * 2.0
            ops.append({
                "id":           f"OP{seq:03d}",
                "feature_id":   feat_id,
                "sequence":     seq,
                "operation":    "reaming",
                "label":        "Drilling",
                "tool":         ream,
                "params": {
                    "spindle_rpm":    r_rpm,
                    "feed_rate_mmpm": r_feed,
                    "depth_mm":       round(r_dist, 3),
                    "width_mm":       round(dia_mm, 3),
                },
                "toolpath_distance_mm": round(r_dist, 3),
            })
            seq += 1

    # ── 2D threads (not reliably detectable from pure geometry) ──────────────
    for t in threads_2d:
        spec     = t.get("spec") or "M8x1.25"
        depth_mm = float(t.get("depth_mm") or 0)
        qty      = max(int(t.get("quantity") or 1), 1)
        t_id     = t.get("id", "T?")

        tap_dia  = parse_thread_dia_mm(spec)
        pitch    = parse_thread_pitch_mm(spec)
        if depth_mm <= 0:
            depth_mm = tap_dia * 1.5
        drill_dia = round(tap_dia - pitch, 3)

        for _q in range(qty):
            # 1) Center drill
            cd = dict(TOOLS["center_drill"])
            cd_rpm  = calc_rpm(sfm_hss, cd["diameter_mm"])
            cd_feed = calc_feed_mmpm(cd_rpm, 0.02, 2)
            ops.append({
                "id": f"OP{seq:03d}", "feature_id": t_id, "sequence": seq,
                "operation": "center_drill",
                "label": "Drilling",
                "tool": cd,
                "params": {"spindle_rpm": cd_rpm, "feed_rate_mmpm": cd_feed, "depth_mm": 3.0},
                "toolpath_distance_mm": 3.0,
            })
            seq += 1

            # 2) Tap drill
            td = dict(TOOLS["twist_drill"])
            td["diameter_mm"] = drill_dia
            td_rpm  = calc_rpm(sfm_hss, drill_dia)
            td_fpt  = fpt_base * 0.4 * max(drill_dia / 10.0, 0.3)
            td_feed = calc_feed_mmpm(td_rpm, td_fpt, 2)
            td_dist = depth_mm + tap_dia
            ops.append({
                "id": f"OP{seq:03d}", "feature_id": t_id, "sequence": seq,
                "operation": "drilling",
                "label": "Drilling",
                "tool": td,
                "params": {"spindle_rpm": td_rpm, "feed_rate_mmpm": td_feed, "depth_mm": round(td_dist, 2)},
                "toolpath_distance_mm": round(td_dist, 3),
            })
            seq += 1

            # 3) Thread mill
            tm = dict(TOOLS["thread_mill"])
            tm["diameter_mm"] = round(tap_dia * 0.7, 3)
            tm_rpm  = calc_rpm(sfm_carbide, tm["diameter_mm"])
            tm_feed = calc_feed_mmpm(tm_rpm, 0.025, 1)
            tm_dist = round(math.pi * tap_dia * (depth_mm / max(pitch, 0.1)), 3)
            ops.append({
                "id": f"OP{seq:03d}", "feature_id": t_id, "sequence": seq,
                "operation": "threading",
                "label": "Taping",
                "tool": tm,
                "params": {
                    "spindle_rpm": tm_rpm, "feed_rate_mmpm": tm_feed,
                    "depth_mm": round(depth_mm, 2), "pitch_mm": round(pitch, 3),
                },
                "toolpath_distance_mm": tm_dist,
            })
            seq += 1

    # Sort by tool type to minimise tool changes, preserve feature order within same tool
    ops.sort(key=lambda o: (o["tool"]["type"], o["sequence"]))
    for i, op in enumerate(ops, 1):
        op["sequence"] = i

    return ops
