"""
Smoke-test: run FreeCAD STEP geometry analysis on a local file.

The Python service only performs geometry analysis now.
VL extraction, feature tagging, process mapping and cost run in Next.js.

Usage:
    python test_step.py path/to/part.stp
    python test_step.py path/to/part.stp --json
"""

import json
import logging
import sys
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

sys.path.insert(0, os.path.dirname(__file__))

from freecad_analyzer import load_freecad, STEPAnalyzer


def run_test(step_path: str):
    print(f"\n{'='*70}")
    print(f"  CNCapp — FreeCAD geometry analysis")
    print(f"  STEP: {step_path}")
    print(f"{'='*70}\n")

    if not load_freecad():
        print("ERROR: FreeCAD not available.")
        print("  Set FREECAD_PATH, e.g.:")
        print("    Windows: set FREECAD_PATH=C:\\Program Files\\FreeCAD 1.0\\bin")
        print("    Linux:   export FREECAD_PATH=/usr/lib/freecad/lib")
        sys.exit(1)

    print("✓ FreeCAD loaded")

    result = STEPAnalyzer(step_path).analyze()

    ss = result["shape_summary"]
    print(f"\n── Shape Summary ──────────────────────────────────────────────")
    print(f"  Type:        {ss['shape_type']}")
    print(f"  Dimensions:  {ss['bbox_x_mm']:.2f} × {ss['bbox_y_mm']:.2f} × {ss['bbox_z_mm']:.2f} mm")
    print(f"  Volume:      {ss['volume_mm3']:.2f} mm³  ({ss['volume_mm3'] / 16387.06:.4f} in³)")
    print(f"  Faces/Edges: {ss['n_faces']} / {ss['n_edges']}")

    features = result["features"]
    print(f"\n── Recognized Features ({len(features)}) ────────────────────────────────")
    for f in features:
        dims_str = "  ".join(
            f"{k}={v}" for k, v in f.get("dimensions", {}).items()
            if not k.startswith("_")
        )
        print(f"  [{f['id']:4s}] {f['type']:12s}  {f['name']}")
        if dims_str:
            print(f"         {dims_str}")

    print(f"\n{'='*70}")
    print(f"  {len(features)} features detected")
    print(f"{'='*70}\n")

    return {"shape_summary": ss, "features": features}


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else None

    if not step:
        sample_dir = os.path.join(
            os.path.dirname(__file__),
            "..", "Product Dev", "Costing Automation",
            "CNC Machine Automation", "CoFAB part Sample", "CoFAB part Sample",
        )
        candidates = []
        if os.path.isdir(sample_dir):
            for fn in os.listdir(sample_dir):
                if fn.lower().endswith((".stp", ".step")):
                    candidates.append(os.path.join(sample_dir, fn))
        if candidates:
            step = candidates[0]
            print(f"No STEP file specified — using sample: {os.path.basename(step)}")
        else:
            print("Usage: python test_step.py <part.stp> [--json]")
            sys.exit(1)

    result = run_test(step)

    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
