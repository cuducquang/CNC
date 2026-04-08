"""Process mapping for SHEET_METAL and TUBE_PIPE part types.

Returns simple process dicts (not Pydantic objects) compatible with
cycle_time_tool.py's new sheet_metal/tube cycle time methods.

Ported from CoFab CAD_Analyser/process_mapper.py — CNC_MACHINED branch
is intentionally omitted (handled by freecad_analyzer/process_mapper.py
with full cutting parameters for cycle time).
"""
from __future__ import annotations

import logging
from typing import Optional

from freecad_analyzer.models import (
    BoundingBoxFull,
    FeatureDetail,
    FeatureType,
    PartType,
    ThicknessStats,
)

logger = logging.getLogger(__name__)


def map_sheet_metal_processes(
    features: list[FeatureDetail],
    bbox: BoundingBoxFull,
    thickness_stats: Optional[ThicknessStats],
    perimeter_mm: float = 0.0,
) -> list[dict]:
    """
    Map SHEET_METAL features to process dicts for cycle time estimation.

    Each dict has:
      process_type    : str   — e.g. "laser_cutting", "press_brake_bending"
      label           : str   — customer display label
      operation_count : int
      cut_length_mm   : float (cutting processes)
      bend_count      : int   (bending processes)
      notes           : str
    """
    t = thickness_stats.mean_mm if thickness_stats else 2.0
    processes: list[dict] = []

    # ── Outer profile cutting ────────────────────────────────────────────────
    if perimeter_mm > 0:
        if t > 25:
            proc_type = "waterjet_cutting"
            label = "Waterjet Cutting"
        elif t > 6:
            proc_type = "plasma_cutting"
            label = "Plasma Cutting"
        else:
            proc_type = "laser_cutting"
            label = "Laser Cutting"

        processes.append({
            "process_type":    proc_type,
            "label":           label,
            "operation_count": 1,
            "cut_length_mm":   round(perimeter_mm, 3),
            "bend_count":      0,
            "notes":           f"Outer profile — thickness {t:.1f}mm",
        })

    # ── Holes ────────────────────────────────────────────────────────────────
    holes = [f for f in features if f.feature_type in {FeatureType.THROUGH_HOLE, FeatureType.BLIND_HOLE}]
    if holes:
        total_holes = sum(f.count for f in holes)
        if t <= 6:
            processes.append({
                "process_type":    "punching",
                "label":           "Punching",
                "operation_count": total_holes,
                "cut_length_mm":   0.0,
                "bend_count":      0,
                "notes":           f"{total_holes} punched holes",
            })
        else:
            processes.append({
                "process_type":    "drilling",
                "label":           "Drilling",
                "operation_count": total_holes,
                "cut_length_mm":   0.0,
                "bend_count":      0,
                "notes":           f"{total_holes} drilled holes (thick stock)",
            })

    # ── Bends ────────────────────────────────────────────────────────────────
    bends = [f for f in features if f.feature_type == FeatureType.BEND]
    if bends:
        total_bends = sum(f.count for f in bends)
        processes.append({
            "process_type":    "press_brake_bending",
            "label":           "Press Brake Bending",
            "operation_count": 1,
            "cut_length_mm":   0.0,
            "bend_count":      total_bends,
            "notes":           f"{total_bends} bends",
        })

    # ── Deburring (always) ────────────────────────────────────────────────────
    processes.append({
        "process_type":    "deburring",
        "label":           "Deburring",
        "operation_count": 1,
        "cut_length_mm":   0.0,
        "bend_count":      0,
        "notes":           "Post-cutting deburring",
    })

    logger.info("Sheet metal process map: %d processes", len(processes))
    return processes


def map_tube_processes(
    features: list[FeatureDetail],
    bbox: BoundingBoxFull,
) -> list[dict]:
    """
    Map TUBE_PIPE features to process dicts for cycle time estimation.
    """
    processes: list[dict] = []

    processes.append({
        "process_type":    "tube_laser_cutting",
        "label":           "Tube Laser Cutting",
        "operation_count": 1,
        "cut_length_mm":   0.0,
        "bend_count":      0,
        "notes":           "Tube cut to length",
    })

    bends = [f for f in features if f.feature_type == FeatureType.BEND]
    if bends:
        total_bends = sum(f.count for f in bends)
        processes.append({
            "process_type":    "tube_bending",
            "label":           "Tube Bending",
            "operation_count": 1,
            "cut_length_mm":   0.0,
            "bend_count":      total_bends,
            "notes":           f"{total_bends} tube bends",
        })

    logger.info("Tube process map: %d processes", len(processes))
    return processes
