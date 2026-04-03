"""
Pydantic models for the CNCapp Python microservice API.

Covers:
  - Geometry output from FreeCAD / BrepMFR (feature recognition)
  - VLM drawing extraction (dimensions, GD&T, threads)
  - Process mapping output
  - Full analysis response
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Feature Recognition
# ---------------------------------------------------------------------------

class RecognizedFeature(BaseModel):
    """One detected machining feature from the 3D solid model."""
    id:          str
    name:        str
    type:        str          # "hole" | "pocket" | "slot" | "fillet" | "chamfer" | …
    description: str
    dimensions:  Dict[str, str] = Field(default_factory=dict)
    source:      str = "freecad"    # "freecad" | "brepMFR"

    # Internal geometry — NOT serialised
    _center_mm:  Optional[Tuple[float, float, float]] = None
    _axis:       Optional[Tuple[float, float, float]] = None
    _radius_mm:  Optional[float] = None
    _depth_mm:   Optional[float] = None
    _is_through: bool = False

    class Config:
        underscore_attrs_are_private = True


class FeatureRecognitionResult(BaseModel):
    features: List[RecognizedFeature]


# ---------------------------------------------------------------------------
# Shape Summary
# ---------------------------------------------------------------------------

class ShapeSummary(BaseModel):
    shape_type:  str
    n_solids:    int
    n_faces:     int
    n_edges:     int
    n_vertices:  int
    bbox_x_mm:   float
    bbox_y_mm:   float
    bbox_z_mm:   float
    volume_mm3:  float
    area_mm2:    float


# ---------------------------------------------------------------------------
# VLM Drawing Extraction (sent from Next.js to Python)
# ---------------------------------------------------------------------------

class DimensionItem(BaseModel):
    """One dimension extracted from the 2D drawing by the VLM."""
    id:              str
    label:           str
    nominal:         float
    unit:            str = "mm"
    tolerance_plus:  Optional[float] = None
    tolerance_minus: Optional[float] = None
    quantity:        int = 1


class GdtItem(BaseModel):
    """One GD&T frame control callout."""
    id:        str
    symbol:    str
    tolerance: float
    unit:      str = "mm"
    datums:    List[str] = Field(default_factory=list)


class ThreadItem(BaseModel):
    """One thread specification from the 2D drawing."""
    id:       str
    spec:     str           # e.g. "M8x1.25" or "1/4-20 UNC"
    depth_mm: float = 0.0
    quantity: int   = 1


class DrawingExtraction(BaseModel):
    """Full VLM extraction result passed to the /analyze endpoint."""
    dimensions:     List[DimensionItem] = Field(default_factory=list)
    gdt:            List[GdtItem]       = Field(default_factory=list)
    threads:        List[ThreadItem]    = Field(default_factory=list)
    material:       Optional[str]       = None
    surface_finish: Optional[str]       = None
    notes:          List[str]           = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Process Mapping Output
# ---------------------------------------------------------------------------

class ProcessTool(BaseModel):
    type:        str    # "twist_drill" | "end_mill_4f" | "thread_mill" | …
    diameter_mm: float
    material:    str    # "HSS" | "Carbide"
    teeth:       int


class ProcessOperation(BaseModel):
    """One CNC machining operation in the process plan."""
    id:                   str
    feature_id:           str
    sequence:             int
    operation:            str   # "center_drill" | "drilling" | "milling_rough" | …
    label:                str
    tool:                 Dict[str, Any]
    params:               Dict[str, Any]   # spindle_rpm, feed_rate_mmpm, depth_mm, …
    toolpath_distance_mm: float


# ---------------------------------------------------------------------------
# Full Analysis Response  (/analyze endpoint)
# ---------------------------------------------------------------------------

class FullAnalysisResponse(BaseModel):
    """Response from POST /analyze — full pipeline output."""
    success:        bool
    shape_summary:  Optional[ShapeSummary]    = None
    features:       List[RecognizedFeature]   = Field(default_factory=list)
    process_map:    List[Dict[str, Any]]       = Field(default_factory=list)
    feature_source: str                        = "freecad"   # "freecad" | "brepMFR"
    error:          Optional[str]              = None


# ---------------------------------------------------------------------------
# Legacy STEP-only response  (/analyze/step endpoint — kept for compatibility)
# ---------------------------------------------------------------------------

class AnalysisResponse(BaseModel):
    success:           bool
    shape_summary:     Optional[ShapeSummary]          = None
    feature_recognition: Optional[FeatureRecognitionResult] = None
    error:             Optional[str]                   = None
