"""
Configuration for CNCapp Python microservice.
All values override-able via environment variables.

This service only performs FreeCAD STEP geometry analysis.
VL extraction, process mapping and cost estimation run in Next.js.
"""
import os

_LOCALAPPDATA = os.environ.get("LOCALAPPDATA", "")

# ---------------------------------------------------------------------------
# FreeCAD installation paths (tried in order)
# ---------------------------------------------------------------------------
FREECAD_SEARCH_PATHS = [
    p for p in [
        os.environ.get("FREECAD_PATH", ""),
        # Linux (apt install freecad / freecad AppImage)
        "/usr/lib/freecad/lib",
        "/usr/lib/freecad-python3/lib",
        "/usr/local/lib/freecad/lib",
        "/opt/freecad/lib",
        # macOS
        "/Applications/FreeCAD.app/Contents/Resources/lib",
        # Windows
        os.path.join(_LOCALAPPDATA, "Programs", "FreeCAD 1.1", "bin") if _LOCALAPPDATA else "",
        r"C:\Program Files\FreeCAD 1.0\bin",
        r"C:\Program Files\FreeCAD 1.1\bin",
        r"C:\Program Files\FreeCAD 0.21\bin",
        r"C:\Program Files\FreeCAD 0.20\bin",
    ] if p
]

# ---------------------------------------------------------------------------
# FastAPI server
# ---------------------------------------------------------------------------
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8001"))

# ---------------------------------------------------------------------------
# Unit / geometry thresholds (FreeCAD always uses mm internally)
# ---------------------------------------------------------------------------
MM_PER_INCH = 25.4

# Feature classification thresholds (in mm)
MAX_FILLET_RADIUS_MM   = 8.0    # Cylinders smaller than this = fillet candidate
MIN_HOLE_DEPTH_MM      = 1.0    # Ignore very shallow blind holes
MIN_POCKET_DEPTH_MM    = 0.5    # Ignore surface nicks
MIN_POCKET_AREA_MM2    = 5.0    # Ignore tiny pockets
CHAMFER_ANGLE_DEG      = 45.0   # Expected chamfer angle from Z-axis normal
CHAMFER_ANGLE_TOL_DEG  = 10.0   # ±10° tolerance
COPLANAR_TOL_MM        = 0.05   # Tolerance for grouping co-planar faces
CAXIS_TOL_MM           = 0.2    # Tolerance for grouping cylinders on same axis
RADIUS_GROUP_TOL_MM    = 0.05   # Tolerance for grouping fillets by radius
