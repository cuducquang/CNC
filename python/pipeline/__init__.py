"""
CNCapp pipeline package.

Approach 1 (LLM-per-step): pipeline.approach1
Approach 2 (FreeCAD deterministic): pipeline.approach2
Shared utilities: pipeline.shared
"""

# Expose the two top-level entry points used by server.py
from pipeline.approach2 import run_pipeline
from pipeline.approach1 import (
    analyze_gdt,
    analyze_step3d,
    recognize_features,
    map_processes,
    estimate_cycle_time_llm,
    estimate_cost_formula,
)

__all__ = [
    # Approach 2
    "run_pipeline",
    # Approach 1
    "analyze_gdt",
    "analyze_step3d",
    "recognize_features",
    "map_processes",
    "estimate_cycle_time_llm",
    "estimate_cost_formula",
]
