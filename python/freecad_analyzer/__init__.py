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


def is_freecad_available() -> bool:
    if step_analyzer.FREECAD_AVAILABLE:
        return True
    return load_freecad()


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
]
