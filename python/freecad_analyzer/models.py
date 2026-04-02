"""
Pydantic models for the STEP analysis response.

Only geometry output is modelled here. VL extraction, process mapping,
cycle time and cost are handled entirely in the Next.js layer.
"""
from __future__ import annotations
from typing import Dict, List, Optional, Tuple
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Feature Recognition
# ---------------------------------------------------------------------------

class RecognizedFeature(BaseModel):
    """One detected machining feature from the 3D solid model."""
    id: str                              # e.g. "H1", "P2", "F3"
    name: str                            # e.g. "Blind Hole Ø8.5mm"
    type: str                            # "hole" | "pocket" | "slot" | "fillet" | ...
    description: str
    dimensions: Dict[str, str] = Field(default_factory=dict)

    # Internal geometry — NOT serialised to the API consumer
    _center_mm: Optional[Tuple[float, float, float]] = None
    _axis: Optional[Tuple[float, float, float]] = None
    _radius_mm: Optional[float] = None
    _depth_mm: Optional[float] = None
    _is_through: bool = False

    class Config:
        underscore_attrs_are_private = True


class FeatureRecognitionResult(BaseModel):
    features: List[RecognizedFeature]


# ---------------------------------------------------------------------------
# Shape Summary
# ---------------------------------------------------------------------------

class ShapeSummary(BaseModel):
    shape_type: str
    n_solids: int
    n_faces: int
    n_edges: int
    n_vertices: int
    bbox_x_mm: float
    bbox_y_mm: float
    bbox_z_mm: float
    volume_mm3: float
    area_mm2: float


# ---------------------------------------------------------------------------
# API response
# ---------------------------------------------------------------------------

class AnalysisResponse(BaseModel):
    success: bool
    shape_summary: Optional[ShapeSummary] = None
    feature_recognition: Optional[FeatureRecognitionResult] = None
    error: Optional[str] = None
