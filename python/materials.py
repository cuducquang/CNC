"""
Material database — port of src/lib/materials.ts.
Single source of truth for CNC material properties.
"""
from __future__ import annotations
from typing import Optional

MATERIALS: dict[str, dict] = {
    "6061-T6":   {"name": "6061-T6 Aluminum",       "hardness_bhn": 95,  "sfm_hss": 300, "sfm_carbide": 900,  "feed_factor": 1.00, "density_lb_in3": 0.098, "cost_per_lb": 3.0,  "machinability": "excellent"},
    "7075-T6":   {"name": "7075-T6 Aluminum",       "hardness_bhn": 150, "sfm_hss": 200, "sfm_carbide": 700,  "feed_factor": 0.90, "density_lb_in3": 0.101, "cost_per_lb": 5.0,  "machinability": "good"},
    "2024-T3":   {"name": "2024-T3 Aluminum",       "hardness_bhn": 120, "sfm_hss": 250, "sfm_carbide": 800,  "feed_factor": 0.95, "density_lb_in3": 0.100, "cost_per_lb": 4.5,  "machinability": "good"},
    "1018":      {"name": "1018 Mild Steel",         "hardness_bhn": 126, "sfm_hss": 80,  "sfm_carbide": 450,  "feed_factor": 0.70, "density_lb_in3": 0.284, "cost_per_lb": 1.5,  "machinability": "good"},
    "4140":      {"name": "4140 Alloy Steel",        "hardness_bhn": 197, "sfm_hss": 60,  "sfm_carbide": 350,  "feed_factor": 0.60, "density_lb_in3": 0.284, "cost_per_lb": 2.5,  "machinability": "fair"},
    "304_ss":    {"name": "304 Stainless Steel",     "hardness_bhn": 170, "sfm_hss": 50,  "sfm_carbide": 300,  "feed_factor": 0.50, "density_lb_in3": 0.289, "cost_per_lb": 4.0,  "machinability": "poor"},
    "316_ss":    {"name": "316 Stainless Steel",     "hardness_bhn": 175, "sfm_hss": 45,  "sfm_carbide": 280,  "feed_factor": 0.45, "density_lb_in3": 0.290, "cost_per_lb": 5.0,  "machinability": "poor"},
    "C360":      {"name": "C360 Free-Cutting Brass", "hardness_bhn": 78,  "sfm_hss": 400, "sfm_carbide": 1000, "feed_factor": 1.20, "density_lb_in3": 0.307, "cost_per_lb": 4.0,  "machinability": "excellent"},
    "Ti-6Al-4V": {"name": "Ti-6Al-4V Titanium",      "hardness_bhn": 334, "sfm_hss": 25,  "sfm_carbide": 150,  "feed_factor": 0.30, "density_lb_in3": 0.160, "cost_per_lb": 25.0, "machinability": "difficult"},
}

DEFAULT_MATERIAL: dict = {
    "name": "Unknown Material (assumed Aluminum)",
    "hardness_bhn": 100, "sfm_hss": 250, "sfm_carbide": 800,
    "feed_factor": 0.9,  "density_lb_in3": 0.098, "cost_per_lb": 3.0,
    "machinability": "unknown",
}


def match_material(spec: Optional[str]) -> dict:
    """Match a free-text material spec to the closest entry in MATERIALS."""
    if not spec:
        return DEFAULT_MATERIAL
    s = spec.lower().replace("-", "")
    for key, mat in MATERIALS.items():
        if s.find(key.lower().replace("-", "")) != -1:
            return mat
    if "aluminum" in s or "aluminium" in s:
        return MATERIALS["6061-T6"]
    if "stainless" in s:
        return MATERIALS["304_ss"]
    if "steel" in s:
        return MATERIALS["1018"]
    if "brass" in s:
        return MATERIALS["C360"]
    if "titanium" in s:
        return MATERIALS["Ti-6Al-4V"]
    return DEFAULT_MATERIAL
