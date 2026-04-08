"""
FreeCAD headless STEP analyser + deterministic process mapper.

Usage:
  from freecad_analyzer import recognize_features, map_processes, load_freecad
  load_freecad()

  features, source = recognize_features("part.stp")
  ops = map_processes(features, extraction_dict, material="Al6061")
"""

import freecad_analyzer.step_analyzer as step_analyzer
from .step_analyzer import STEPAnalyzer, load_freecad, FREECAD_AVAILABLE
from .brepMFR_recognizer import recognize_features
from .process_mapper import map_processes, resolve_material
from .models import (
    BoundingBoxFull, FaceTypeCounts, FeatureDetail, FeatureType, PartType, ThicknessStats,
)


def is_freecad_available() -> bool:
    if step_analyzer.FREECAD_AVAILABLE:
        return True
    return load_freecad()


# Type mapping: our internal feature type strings → FeatureType enum
_FTYPE_MAP: dict[str, FeatureType] = {
    "hole":         FeatureType.BLIND_HOLE,
    "through_hole": FeatureType.THROUGH_HOLE,
    "blind_hole":   FeatureType.BLIND_HOLE,
    "pocket":       FeatureType.POCKET,
    "slot":         FeatureType.SLOT,
    "fillet":       FeatureType.FILLET,
    "chamfer":      FeatureType.CHAMFER,
    "boss":         FeatureType.BOSS,
    "step":         FeatureType.POCKET,       # step → closest is pocket
    "countersink":  FeatureType.COUNTERSINK,
    "counterbore":  FeatureType.COUNTERBORE,
    "thread":       FeatureType.THREAD,
    "threaded_hole":FeatureType.THREAD,
    "bend":         FeatureType.BEND,
    "flange":       FeatureType.FLANGE,
    "hem":          FeatureType.HEM,
}


def classify_part_type(
    shape_summary: dict,
    raw_features: list[dict],
    thickness_stats: "ThicknessStats | None" = None,
) -> tuple[PartType, float, list[dict]]:
    """
    Classify part type from STEPAnalyzer shape_summary and raw features list.

    Args:
        shape_summary : dict from STEPAnalyzer.analyze()["shape_summary"]
                        Must include face_type_counts (added in Phase 1).
        raw_features  : list of raw feature dicts from recognize_features()
        thickness_stats: optional ThicknessStats (improves SHEET_METAL accuracy)

    Returns:
        (PartType, confidence, candidates_list)
    """
    from .part_classifier import classify_part

    # Build BoundingBoxFull
    bbox = BoundingBoxFull.from_shape_summary(shape_summary)

    # Build FaceTypeCounts
    ftc_dict = shape_summary.get("face_type_counts") or {}
    face_counts = FaceTypeCounts(
        plane=ftc_dict.get("plane", 0),
        cylinder=ftc_dict.get("cylinder", 0),
        cone=ftc_dict.get("cone", 0),
        sphere=ftc_dict.get("sphere", 0),
        torus=ftc_dict.get("torus", 0),
        bspline=ftc_dict.get("bspline", 0),
        other=ftc_dict.get("other", 0),
        total=ftc_dict.get("total", shape_summary.get("n_faces", 0)),
    )

    # Convert raw feature dicts → FeatureDetail list
    feature_details: list[FeatureDetail] = []
    for i, f in enumerate(raw_features or []):
        ftype_str = (f.get("type") or "").lower()
        ftype = _FTYPE_MAP.get(ftype_str, FeatureType.UNKNOWN)
        dims_raw = f.get("dimensions") or {}
        dims: dict = {}
        for k, v in dims_raw.items():
            if k.startswith("_"):
                continue
            try:
                dims[k] = float(v)
            except (TypeError, ValueError):
                pass

        count = 1
        try:
            count = max(1, int(dims_raw.get("count") or f.get("_count") or 1))
        except (TypeError, ValueError):
            pass

        feature_details.append(FeatureDetail(
            feature_id=f.get("id", f"F{i+1:03d}"),
            feature_type=ftype,
            count=count,
            confidence=0.8,
            source=f.get("source", "freecad"),
            dimensions=dims,
        ))

    return classify_part(
        volume_mm3=float(shape_summary.get("volume_mm3") or 0),
        surface_area_mm2=float(shape_summary.get("area_mm2") or 0),
        bbox=bbox,
        face_counts=face_counts,
        thickness_stats=thickness_stats,
        features=feature_details,
    )


__all__ = [
    # FreeCAD geometry
    "STEPAnalyzer",
    "load_freecad",
    "FREECAD_AVAILABLE",
    "is_freecad_available",
    # Feature recognition (BrepMFR → FreeCAD fallback)
    "recognize_features",
    # Process mapping
    "map_processes",
    "resolve_material",
    # Part classification
    "classify_part_type",
    "PartType",
    "BoundingBoxFull",
    "FaceTypeCounts",
    "ThicknessStats",
    "FeatureDetail",
    "FeatureType",
]
