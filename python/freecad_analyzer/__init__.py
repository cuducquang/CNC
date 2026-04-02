"""
FreeCAD headless STEP analyzer — geometry feature recognition only.

Usage:
  from freecad_analyzer import STEPAnalyzer, load_freecad
  load_freecad()
  result = STEPAnalyzer("part.stp").analyze()
"""

import freecad_analyzer.step_analyzer as step_analyzer
from .step_analyzer import STEPAnalyzer, load_freecad, FREECAD_AVAILABLE


def is_freecad_available() -> bool:
    if step_analyzer.FREECAD_AVAILABLE:
        return True
    return load_freecad()


__all__ = [
    "STEPAnalyzer",
    "load_freecad",
    "FREECAD_AVAILABLE",
    "is_freecad_available",
]
