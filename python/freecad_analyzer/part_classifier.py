"""Part type classification using geometry heuristics.

Classifies CNC components into one of 8 part types using weighted scoring
across geometry metrics from FreeCAD STEPAnalyzer output.

Ported from CoFab CAD_Analyser/part_classifier.py — imports updated for
freecad_analyzer.models.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

from freecad_analyzer.models import (
    BoundingBoxFull,
    FaceTypeCounts,
    FeatureDetail,
    FeatureType,
    PartType,
    ThicknessStats,
)

logger = logging.getLogger(__name__)


def classify_part(
    volume_mm3: float,
    surface_area_mm2: float,
    bbox: BoundingBoxFull,
    face_counts: FaceTypeCounts,
    thickness_stats: Optional[ThicknessStats],
    features: list[FeatureDetail],
) -> tuple[PartType, float, list[dict]]:
    """
    Classify a component into a part type using geometry heuristics.

    Returns:
        (best_type, confidence, candidates) where candidates is a list
        of {type, confidence} for top-3 results.
    """
    scores: dict[PartType, float] = {}

    for pt in PartType:
        if pt == PartType.UNKNOWN:
            continue
        scores[pt] = _score_part_type(
            pt, volume_mm3, surface_area_mm2, bbox, face_counts,
            thickness_stats, features,
        )

    total = sum(scores.values())
    if total > 0:
        for pt in scores:
            scores[pt] /= total
    else:
        return PartType.UNKNOWN, 0.0, []

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    best_type, best_score = ranked[0]

    candidates = [
        {"type": pt.value, "confidence": round(conf, 4)}
        for pt, conf in ranked[:3]
        if conf > 0.05
    ]

    if best_score < 0.15:
        return PartType.UNKNOWN, best_score, candidates

    return best_type, round(best_score, 4), candidates


def _score_part_type(
    part_type: PartType,
    volume: float,
    surface_area: float,
    bbox: BoundingBoxFull,
    face_counts: FaceTypeCounts,
    thickness: Optional[ThicknessStats],
    features: list[FeatureDetail],
) -> float:
    bbox_vol = bbox.length * bbox.width * bbox.height
    vol_ratio = volume / bbox_vol if bbox_vol > 0 else 0
    dims = sorted([bbox.length, bbox.width, bbox.height])
    min_dim, mid_dim, max_dim = dims[0], dims[1], dims[2]
    aspect_ratio = max_dim / min_dim if min_dim > 0 else 0
    flatness = min_dim / max_dim if max_dim > 0 else 0

    total_faces = face_counts.total or 1
    plane_frac   = face_counts.plane    / total_faces
    cyl_frac     = face_counts.cylinder / total_faces
    bspline_frac = face_counts.bspline  / total_faces
    cone_frac    = face_counts.cone     / total_faces
    torus_frac   = face_counts.torus    / total_faces

    hole_count = sum(
        f.count for f in features
        if f.feature_type in {FeatureType.THROUGH_HOLE, FeatureType.BLIND_HOLE,
                               FeatureType.COUNTERBORE, FeatureType.COUNTERSINK}
    )
    pocket_count  = sum(f.count for f in features if f.feature_type == FeatureType.POCKET)
    slot_count    = sum(f.count for f in features if f.feature_type == FeatureType.SLOT)
    bend_count    = sum(f.count for f in features if f.feature_type == FeatureType.BEND)
    fillet_count  = sum(f.count for f in features if f.feature_type == FeatureType.FILLET)
    draft_count   = sum(f.count for f in features if f.feature_type == FeatureType.DRAFT)
    thread_count  = sum(f.count for f in features if f.feature_type == FeatureType.THREAD)
    boss_count    = sum(f.count for f in features if f.feature_type == FeatureType.BOSS)

    is_uniform_thickness = thickness.is_uniform if thickness else False
    mean_thickness       = thickness.mean_mm    if thickness else 0

    score = 0.0

    if part_type == PartType.SHEET_METAL:
        if flatness < 0.1:
            score += 3.0
        elif flatness < 0.2:
            score += 1.5
        if is_uniform_thickness:
            score += 2.5
        if mean_thickness > 0 and mean_thickness < 10:
            score += 2.0
        if bend_count > 0:
            score += 2.0 * min(bend_count, 5)
        if plane_frac > 0.4:
            score += 1.0
        if vol_ratio < 0.15:
            score += 2.5
        elif vol_ratio < 0.25:
            score += 1.5
        if cyl_frac > 0.2 and plane_frac > 0.3:
            score += 1.0
        if boss_count > 0:
            score -= 0.5
        if bspline_frac > 0.2:
            score -= 1.0
        # Sheet metal is thin — min_dim > 12mm means CNC plate, not sheet metal
        if min_dim > 12:
            score -= 3.5
        elif min_dim > 6:
            score -= 1.5
        # Pockets indicate CNC machining, not sheet metal forming
        if pocket_count > 0:
            score -= 2.0

    elif part_type == PartType.CNC_MACHINED:
        if 0.3 < vol_ratio < 0.85:
            score += 2.0
        elif vol_ratio < 0.15:
            # Low vol_ratio is OK for flat machined plates with pockets/holes
            if pocket_count > 0 or hole_count > 0:
                score += 0.5
            else:
                score -= 2.0
        if hole_count + pocket_count + slot_count > 3:
            score += 2.5
        if pocket_count > 0:
            score += 1.5
        if slot_count > 0:
            score += 1.0
        if plane_frac > 0.3:
            score += 0.5
        if fillet_count > 0:
            score += 0.5
        if bend_count > 0:
            score -= 2.0
        if is_uniform_thickness and flatness < 0.1:
            score -= 1.5
        if flatness < 0.05:
            score -= 1.0
        # Flat plates > 12mm thick are CNC machined, not sheet metal
        if min_dim > 12 and flatness < 0.15:
            score += 2.0

    elif part_type == PartType.TUBE_PIPE:
        if cyl_frac > 0.4:
            score += 2.5
        if aspect_ratio > 3:
            score += 1.5
        if is_uniform_thickness:
            score += 1.0
        if vol_ratio < 0.5 and cyl_frac > 0.3:
            score += 1.0
        if plane_frac > 0.5:
            score -= 1.0

    elif part_type == PartType.HARDWARE:
        if max_dim < 50:
            score += 2.0
        elif max_dim < 100:
            score += 1.0
        if thread_count > 0:
            score += 3.0
        if cyl_frac > 0.3:
            score += 1.0
        if 2.5 <= max_dim <= 60 and cyl_frac > 0.2:
            score += 0.5

    elif part_type == PartType.CASTING:
        if bspline_frac > 0.2:
            score += 2.5
        if draft_count > 0:
            score += 2.0
        if fillet_count > 3:
            score += 1.5
        if vol_ratio < 0.6:
            score += 0.5
        if plane_frac > 0.6:
            score -= 1.0

    elif part_type == PartType.WELDMENT:
        if aspect_ratio > 5:
            score += 1.5
        if plane_frac > 0.5:
            score += 1.0
        if hole_count < 3 and pocket_count == 0 and bend_count == 0:
            score += 0.5
        if vol_ratio < 0.3:
            score += 0.5
        if pocket_count > 2:
            score -= 1.0

    elif part_type == PartType.ADDITIVE:
        if bspline_frac > 0.4:
            score += 2.0
        if vol_ratio < 0.3:
            score += 1.0
        if total_faces > 50 and bspline_frac > 0.3:
            score += 1.5
        if pocket_count > 2 or hole_count > 5:
            score -= 1.0

    elif part_type == PartType.TURNED_LATHE:
        if cyl_frac > 0.5:
            score += 3.0
        elif cyl_frac > 0.3:
            score += 1.5
        if cone_frac > 0.1:
            score += 0.5
        approx_circular = cyl_frac + cone_frac + torus_frac
        if approx_circular > 0.6:
            score += 2.0
        if plane_frac > 0.5:
            score -= 1.0
        if bend_count > 0:
            score -= 2.0

    return max(score, 0.0)
