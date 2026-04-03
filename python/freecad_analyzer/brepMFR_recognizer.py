"""
BrepMFR feature recogniser with FreeCAD geometric fallback.

BrepMFR (https://github.com/zhangshuming0668/BrepMFR) is a graph neural network
that recognises machining features from B-rep topology.

Installation (when ready):
    git clone https://github.com/zhangshuming0668/BrepMFR
    cd BrepMFR && pip install -e .
    # download pretrained weights → place in BrepMFR/weights/

This module tries to import BrepMFR at runtime.  If unavailable it falls back
to the deterministic FreeCAD geometric analyser (step_analyzer.py).

Standardised output for both paths:
    [
        {
            "id":          "H1",
            "type":        "hole",           # BrepMFR label or FreeCAD detection
            "name":        "Through Hole Ø12.5mm",
            "description": "Through Hole Ø12.5mm",
            "dimensions":  {"diameter_mm": "12.50", "depth_mm": "25.00"},
            "source":      "brepMFR" | "freecad",
        },
        ...
    ]
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# BrepMFR feature label mapping to internal types
# ---------------------------------------------------------------------------

# Map BrepMFR class names → internal canonical type names
_BREPМFR_LABEL_MAP: Dict[str, str] = {
    # Common BrepMFR class names (adjust if model uses different labels)
    "through_hole":     "hole",
    "blind_hole":       "hole",
    "rectangular_pocket": "pocket",
    "circular_pocket":  "pocket",
    "triangular_pocket": "pocket",
    "rectangular_slot": "slot",
    "circular_end_slot": "slot",
    "chamfer":          "chamfer",
    "fillet":           "fillet",
    "round":            "fillet",
    "step":             "step",
    "boss":             "boss",
    "countersink":      "countersink",
    "counterbore":      "hole",
    "o_ring":           "slot",
    "triangular_passage": "slot",
    "rectangular_passage": "slot",
}


def _map_brepMFR_label(label: str) -> str:
    return _BREPМFR_LABEL_MAP.get(label.lower(), label.lower())


# ---------------------------------------------------------------------------
# BrepMFR integration (only used if installed)
# ---------------------------------------------------------------------------

def _try_brepMFR(step_path: str) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Attempt BrepMFR inference.  Returns (feature_list, success).
    feature_list is empty and success=False if BrepMFR is not installed.

    To integrate, BrepMFR must expose:
        from brepMFR.inference import predict_step
        results = predict_step(step_path)  # returns list of {label, faces, bbox}
    Adjust the import path below if your installation differs.
    """
    try:
        # Try to import BrepMFR inference module
        from brepMFR.inference import predict_step  # type: ignore  # noqa: F401
    except ImportError:
        return [], False
    except Exception as exc:
        logger.warning("BrepMFR import succeeded but inference setup failed: %s", exc)
        return [], False

    try:
        raw_results = predict_step(step_path)
        features: List[Dict[str, Any]] = []
        type_counters: Dict[str, int] = {}

        for i, r in enumerate(raw_results or []):
            raw_label = r.get("label", "unknown")
            ftype = _map_brepMFR_label(raw_label)
            type_counters[ftype] = type_counters.get(ftype, 0) + 1
            prefix = ftype[0].upper() if ftype else "F"
            feat_id = f"{prefix}{type_counters[ftype]}"

            # Extract dimensions from BrepMFR bounding-box or explicit dims
            bbox = r.get("bbox", {}) or {}
            dims: Dict[str, str] = {}
            if bbox:
                for k, v in bbox.items():
                    dims[k] = f"{float(v):.3f}"

            features.append({
                "id":          feat_id,
                "type":        ftype,
                "name":        f"{ftype.replace('_', ' ').title()} {feat_id}",
                "description": f"{ftype.replace('_', ' ').title()} {feat_id}",
                "dimensions":  dims,
                "source":      "brepMFR",
            })

        logger.info("BrepMFR recognised %d features in %s", len(features), step_path)
        return features, True

    except Exception as exc:
        logger.warning("BrepMFR inference failed: %s", exc)
        return [], False


# ---------------------------------------------------------------------------
# FreeCAD geometric fallback
# ---------------------------------------------------------------------------

def _freecad_fallback(step_path: str) -> List[Dict[str, Any]]:
    """Run FreeCAD geometric feature recognition and return normalised list."""
    try:
        from freecad_analyzer.step_analyzer import STEPAnalyzer, load_freecad
        load_freecad()
        result = STEPAnalyzer(step_path).analyze()
        raw = result.get("features", [])
        # step_analyzer already returns the same dict shape; just tag source
        for f in raw:
            f["source"] = "freecad"
        return raw
    except Exception as exc:
        logger.error("FreeCAD fallback also failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def recognize_features(step_path: str) -> Tuple[List[Dict[str, Any]], str]:
    """
    Recognise machining features from a STEP file.

    Returns:
        (features, source) where source is "brepMFR" or "freecad".
    """
    if not os.path.isfile(step_path):
        raise FileNotFoundError(f"STEP file not found: {step_path}")

    # 1. Try BrepMFR
    brepMFR_features, ok = _try_brepMFR(step_path)
    if ok and brepMFR_features:
        return brepMFR_features, "brepMFR"

    if ok:
        logger.warning("BrepMFR returned zero features — falling back to FreeCAD")

    # 2. FreeCAD geometric analyser
    features = _freecad_fallback(step_path)
    return features, "freecad"
