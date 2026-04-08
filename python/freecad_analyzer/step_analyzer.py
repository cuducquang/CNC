"""
STEPAnalyzer — headless FreeCAD feature recognition for CNC machined parts.

Run as a module to smoke-test:
    FreeCADCmd step_analyzer.py /path/to/part.stp
    # or, if FreeCAD is on sys.path:
    python step_analyzer.py /path/to/part.stp
"""
from __future__ import annotations

import math
import sys
import os
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FreeCAD bootstrap — import once, guard everywhere
# ---------------------------------------------------------------------------

FREECAD_AVAILABLE = False
App = Part = None   # type: ignore

def load_freecad() -> bool:
    """
    Try to import FreeCAD.  Returns True on success.
    Searches FREECAD_SEARCH_PATHS from config, then sys.path as-is.
    """
    global FREECAD_AVAILABLE, App, Part

    if FREECAD_AVAILABLE:
        return True

    # Pull search paths from config (avoids circular import at module level)
    try:
        from config import FREECAD_SEARCH_PATHS
        search_paths = FREECAD_SEARCH_PATHS
    except ImportError:
        search_paths = []

    # Try each candidate path
    for path in search_paths:
        if path and os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)

    try:
        import FreeCAD as _App   # noqa: F401
        import Part as _Part     # noqa: F401
        App = _App
        Part = _Part
        FREECAD_AVAILABLE = True
        logger.info("FreeCAD loaded successfully")
        return True
    except ImportError as exc:
        logger.warning("FreeCAD not available: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Internal geometry helpers
# ---------------------------------------------------------------------------

@dataclass
class Vec3:
    x: float
    y: float
    z: float

    def dot(self, other: "Vec3") -> float:
        return self.x * other.x + self.y * other.y + self.z * other.z

    def length(self) -> float:
        return math.sqrt(self.x ** 2 + self.y ** 2 + self.z ** 2)

    def normalized(self) -> "Vec3":
        l = self.length()
        if l < 1e-12:
            return Vec3(0, 0, 0)
        return Vec3(self.x / l, self.y / l, self.z / l)

    def sub(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def scale(self, s: float) -> "Vec3":
        return Vec3(self.x * s, self.y * s, self.z * s)

    def __repr__(self) -> str:
        return f"Vec3({self.x:.3f}, {self.y:.3f}, {self.z:.3f})"


def _vec(fc_vec) -> Vec3:
    """Convert a FreeCAD App.Vector to our Vec3."""
    return Vec3(fc_vec.x, fc_vec.y, fc_vec.z)


def _axes_parallel(a: Vec3, b: Vec3, tol: float = 0.02) -> bool:
    """True if two unit vectors are parallel (or anti-parallel)."""
    d = abs(a.normalized().dot(b.normalized()))
    return d > (1.0 - tol)


def _points_close(a: Vec3, b: Vec3, tol: float = 0.5) -> bool:
    return a.sub(b).length() < tol


def _classify_cylinder_concavity(face) -> str:
    """
    Returns "hole" (concave / inner surface) or "boss" (convex / outer surface).

    Method: sample the outward face normal at mid-parametric point and compare
    with the radial direction from the cylinder axis.  If they oppose → concave.
    """
    surf = face.Surface
    prange = face.ParameterRange           # (uMin, uMax, vMin, vMax)
    u = (prange[0] + prange[1]) / 2.0
    v = (prange[2] + prange[3]) / 2.0

    try:
        pt     = _vec(face.valueAt(u, v))
        normal = _vec(face.normalAt(u, v))
        center = _vec(surf.Center)
        axis   = _vec(surf.Axis).normalized()

        # Radial = vector from axis to surface point (perpendicular to axis)
        cp = pt.sub(center)
        axial = axis.scale(cp.dot(axis))
        radial = cp.sub(axial)

        if radial.length() < 1e-10:
            return "unknown"

        radial = radial.normalized()
        return "hole" if normal.dot(radial) < 0 else "boss"
    except Exception:
        return "unknown"


def _angular_span(face) -> float:
    """
    Return the angular span (in radians) of a cylindrical or conical face.
    Uses the U-parameter range; full cylinder = 2π.
    """
    prange = face.ParameterRange
    return abs(prange[1] - prange[0])


def _is_full_cylinder(face, tol: float = 0.15) -> bool:
    """True if the face spans a full 360° rotation."""
    return abs(_angular_span(face) - 2 * math.pi) < tol


def _cylinder_depth(face) -> float:
    """Approximate axial length of a cylindrical face from its bounding box."""
    surf = face.Surface
    axis = _vec(surf.Axis).normalized()
    # Project all vertices onto axis to get axial extent
    verts = [_vec(v.Point) for v in face.Vertexes]
    if not verts:
        bb = face.BoundBox
        return max(bb.XLength, bb.YLength, bb.ZLength)
    axial_vals = [v.dot(axis) for v in verts]
    return max(axial_vals) - min(axial_vals)


def _face_horizontal(face, tol: float = 0.05) -> Optional[str]:
    """
    Returns "up" / "down" if face normal is near-vertical, else None.
    Samples normal at face centroid.
    """
    try:
        prange = face.ParameterRange
        u = (prange[0] + prange[1]) / 2.0
        v = (prange[2] + prange[3]) / 2.0
        n = _vec(face.normalAt(u, v)).normalized()
        if n.z > (1.0 - tol):
            return "up"
        if n.z < -(1.0 - tol):
            return "down"
    except Exception:
        pass
    return None


def _face_normal_angle_to_z(face) -> Optional[float]:
    """Returns angle (degrees) between face normal and Z-axis, or None on error."""
    try:
        prange = face.ParameterRange
        u = (prange[0] + prange[1]) / 2.0
        v = (prange[2] + prange[3]) / 2.0
        n = _vec(face.normalAt(u, v)).normalized()
        z = Vec3(0, 0, 1)
        dot = max(-1.0, min(1.0, n.dot(z)))
        return math.degrees(math.acos(abs(dot)))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Per-face data container
# ---------------------------------------------------------------------------

@dataclass
class FaceInfo:
    index: int
    surf_type: str            # "Plane" | "Cylinder" | "Cone" | "Sphere" | "Toroid" | "BSpline" | ...
    area_mm2: float
    face: object              # the Part.Face object

    # Cylinder-specific
    radius_mm: float = 0.0
    concavity: str = ""       # "hole" | "boss" | ""
    angular_span_rad: float = 0.0
    depth_mm: float = 0.0
    cyl_center: Optional[Vec3] = None
    cyl_axis: Optional[Vec3] = None

    # Plane-specific
    plane_normal: Optional[Vec3] = None
    plane_z_level: float = 0.0   # Z of face center-of-mass

    # Cone-specific
    cone_half_angle_deg: float = 0.0   # 0 = cylinder, 45 = countersink

    bbox: object = None   # FreeCAD BoundBox


# ---------------------------------------------------------------------------
# Main Analyzer
# ---------------------------------------------------------------------------

class STEPAnalyzer:
    """
    Loads a STEP/STP file with FreeCAD (headless) and extracts machining features.

    Usage:
        load_freecad()
        a = STEPAnalyzer("part.stp")
        result = a.analyze()   # returns dict matching AnalysisResponse schema
    """

    def __init__(self, filepath: str):
        self.filepath = filepath
        self._shape = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def load(self):
        """Load the STEP file. Raises RuntimeError if FreeCAD unavailable."""
        if not FREECAD_AVAILABLE:
            raise RuntimeError(
                "FreeCAD is not available. Install FreeCAD and set FREECAD_PATH."
            )
        if not os.path.isfile(self.filepath):
            raise FileNotFoundError(f"STEP file not found: {self.filepath}")

        shape = Part.Shape()
        shape.read(self.filepath)

        # If compound (assembly), merge into one shell for analysis
        if shape.ShapeType == "Compound":
            solids = shape.Solids
            if solids:
                # Analyse largest solid (the main part body)
                solids_by_vol = sorted(solids, key=lambda s: s.Volume, reverse=True)
                self._shape = solids_by_vol[0]
            else:
                self._shape = shape
        else:
            self._shape = shape

        logger.info(
            "Loaded %s: %s, %d faces, %d edges",
            os.path.basename(self.filepath),
            self._shape.ShapeType,
            len(self._shape.Faces),
            len(self._shape.Edges),
        )
        return self._shape

    def analyze(self) -> dict:
        """
        Run full feature-recognition pipeline.
        Returns a dict ready to be validated as AnalysisResponse.
        """
        if self._shape is None:
            self.load()

        shape = self._shape
        bb = shape.BoundBox

        shape_summary = {
            "shape_type": shape.ShapeType,
            "n_solids":   len(shape.Solids),
            "n_faces":    len(shape.Faces),
            "n_edges":    len(shape.Edges),
            "n_vertices": len(shape.Vertexes),
            "bbox_x_mm":  round(bb.XLength, 4),
            "bbox_y_mm":  round(bb.YLength, 4),
            "bbox_z_mm":  round(bb.ZLength, 4),
            "volume_mm3": round(shape.Volume, 4),
            "area_mm2":   round(shape.Area, 4),
            "bbox_x_min": round(bb.XMin, 4),
            "bbox_y_min": round(bb.YMin, 4),
            "bbox_z_min": round(bb.ZMin, 4),
            "bbox_x_max": round(bb.XMax, 4),
            "bbox_y_max": round(bb.YMax, 4),
            "bbox_z_max": round(bb.ZMax, 4),
        }
        logger.info(
            "Shape summary: type=%s  solids=%d  faces=%d  edges=%d  "
            "bbox=%.2f×%.2f×%.2f mm  vol=%.1f mm³",
            shape_summary["shape_type"],
            shape_summary["n_solids"],
            shape_summary["n_faces"],
            shape_summary["n_edges"],
            shape_summary["bbox_x_mm"],
            shape_summary["bbox_y_mm"],
            shape_summary["bbox_z_mm"],
            shape_summary["volume_mm3"],
        )

        # Step 1 — collect per-face info
        face_infos = self._collect_faces(shape)

        # Summarise surface types found
        surf_counts: Dict[str, int] = defaultdict(int)
        for fi in face_infos:
            surf_counts[fi.surf_type] += 1
        logger.info("Surface-type breakdown: %s", dict(surf_counts))

        # Normalize FreeCAD surface type names → customer vocab
        _SURF_NORM = {
            "Plane": "plane", "Cylinder": "cylinder", "Cone": "cone",
            "Sphere": "sphere", "Toroid": "torus", "BSplineSurface": "bspline",
        }
        ftc: Dict[str, int] = {"plane": 0, "cylinder": 0, "cone": 0, "sphere": 0, "torus": 0, "bspline": 0, "other": 0}
        for stype, cnt in surf_counts.items():
            key = _SURF_NORM.get(stype, "other")
            ftc[key] += cnt
        ftc["total"] = sum(ftc.values())
        shape_summary["face_type_counts"] = ftc

        # Step 2 — run detectors in order
        features = []
        counter: Dict[str, int] = defaultdict(int)

        holes    = self._detect_holes(face_infos, bb, counter)
        bosses   = self._detect_bosses(face_infos, counter)
        pocks    = self._detect_pockets(face_infos, bb, counter)
        slots    = self._detect_slots(face_infos, counter)
        fillets  = self._detect_fillets(face_infos, counter)
        chamfers = self._detect_chamfers(face_infos, counter)
        steps    = self._detect_steps(face_infos, bb, counter)
        cones    = self._detect_countersinks(face_infos, counter)

        features = holes + bosses + pocks + slots + fillets + chamfers + steps + cones

        logger.info(
            "Feature extraction complete: %d total  "
            "(holes=%d  bosses=%d  pockets=%d  slots=%d  "
            "fillets=%d  chamfers=%d  steps=%d  countersinks=%d)",
            len(features),
            len(holes), len(bosses), len(pocks), len(slots),
            len(fillets), len(chamfers), len(steps), len(cones),
        )

        return {
            "success": True,
            "shape_summary": shape_summary,
            "features": features,
        }

    # ------------------------------------------------------------------
    # Face collection
    # ------------------------------------------------------------------

    def _collect_faces(self, shape) -> List[FaceInfo]:
        infos: List[FaceInfo] = []
        for i, face in enumerate(shape.Faces):
            try:
                info = self._describe_face(i, face)
                infos.append(info)
            except Exception as exc:
                logger.debug("Face %d skipped: %s", i, exc)
        return infos

    def _describe_face(self, index: int, face) -> FaceInfo:
        surf = face.Surface
        stype = type(surf).__name__

        info = FaceInfo(
            index=index,
            surf_type=stype,
            area_mm2=face.Area,
            face=face,
            bbox=face.BoundBox,
        )

        if stype == "Cylinder":
            info.radius_mm       = surf.Radius
            info.angular_span_rad = _angular_span(face)
            info.depth_mm        = _cylinder_depth(face)
            info.cyl_center      = _vec(surf.Center)
            info.cyl_axis        = _vec(surf.Axis).normalized()
            info.concavity       = _classify_cylinder_concavity(face)

        elif stype == "Plane":
            prange = face.ParameterRange
            u = (prange[0] + prange[1]) / 2.0
            v = (prange[2] + prange[3]) / 2.0
            try:
                info.plane_normal = _vec(face.normalAt(u, v)).normalized()
            except Exception:
                pass
            info.plane_z_level = face.BoundBox.ZMin + face.BoundBox.ZLength / 2.0

        elif stype == "Cone":
            try:
                info.cone_half_angle_deg = math.degrees(surf.HalfAngle)
                info.cyl_center = _vec(surf.Center)
                info.cyl_axis   = _vec(surf.Axis).normalized()
                info.concavity  = _classify_cylinder_concavity(face)
            except Exception:
                pass

        return info

    # ------------------------------------------------------------------
    # Hole detection
    # ------------------------------------------------------------------

    def _detect_holes(
        self,
        face_infos: List[FaceInfo],
        shape_bb,
        counter: Dict[str, int],
    ) -> List[dict]:
        """
        Group concave full-cylinder faces by axis + center proximity → holes.
        Distinguishes through-holes from blind holes via depth vs part Z-span.
        """
        from config import (
            CAXIS_TOL_MM, MIN_HOLE_DEPTH_MM, RADIUS_GROUP_TOL_MM
        )

        candidates = [
            fi for fi in face_infos
            if fi.surf_type == "Cylinder"
            and fi.concavity == "hole"
            and _is_full_cylinder(fi.face)
            and fi.depth_mm >= MIN_HOLE_DEPTH_MM
        ]
        logger.debug("Hole detector: %d full-cylinder concave candidates", len(candidates))

        # Group by (axis direction, center projected on axis-perp plane)
        groups: List[List[FaceInfo]] = []
        used = set()

        for i, fi in enumerate(candidates):
            if i in used:
                continue
            group = [fi]
            used.add(i)
            for j, fj in enumerate(candidates):
                if j in used:
                    continue
                if (
                    _axes_parallel(fi.cyl_axis, fj.cyl_axis)
                    and _points_close(fi.cyl_center, fj.cyl_center, CAXIS_TOL_MM)
                ):
                    group.append(fj)
                    used.add(j)
            groups.append(group)

        logger.debug("Hole detector: %d groups after co-axis clustering", len(groups))

        features = []
        for group in groups:
            # Primary face = largest area (main bore surface)
            primary = max(group, key=lambda fi: fi.area_mm2)
            radius  = primary.radius_mm
            depth   = max(fi.depth_mm for fi in group)

            # Through-hole check: depth ≈ part Z-span along hole axis
            part_span = _part_span_along_axis(shape_bb, primary.cyl_axis)
            is_through = depth >= part_span * 0.9

            counter["H"] += 1
            hid = f"H{counter['H']}"

            # Format for display (prefer inch if > 6.35 mm → 0.25")
            dia_mm    = round(radius * 2, 4)
            depth_rnd = round(depth, 3)

            logger.info(
                "  [%s] %s hole  Ø%.4f mm (%.4f in)  depth=%.3f mm  axis=%s  "
                "part_span=%.2f mm  faces_merged=%d",
                hid,
                "through" if is_through else "blind",
                dia_mm, _mm_to_in(dia_mm),
                depth_rnd,
                _axis_label(primary.cyl_axis),
                part_span,
                len(group),
            )

            features.append({
                "id":   hid,
                "name": f"{'Through' if is_through else 'Blind'} Hole Ø{dia_mm}mm",
                "type": "hole",
                "description": (
                    f"{'Through' if is_through else 'Blind'} hole, "
                    f"diameter {dia_mm}mm ({_mm_to_in(dia_mm):.4f}in)"
                    + (f", depth {depth_rnd}mm" if not is_through else "")
                ),
                "dimensions": {
                    "diameter_mm":  f"{dia_mm}",
                    "diameter_in":  f"{_mm_to_in(dia_mm):.4f}",
                    "depth_mm":     f"{depth_rnd}",
                    "type":         "through" if is_through else "blind",
                    "axis":         _axis_label(primary.cyl_axis),
                },
                # Internal fields for later process mapping / tagging
                "_center": (
                    round(primary.cyl_center.x, 3),
                    round(primary.cyl_center.y, 3),
                    round(primary.cyl_center.z, 3),
                ),
                "_radius_mm": radius,
                "_depth_mm":  depth,
                "_is_through": is_through,
                "_axis": (
                    round(primary.cyl_axis.x, 3),
                    round(primary.cyl_axis.y, 3),
                    round(primary.cyl_axis.z, 3),
                ),
            })

        return features

    # ------------------------------------------------------------------
    # Boss / pin / stud detection
    # ------------------------------------------------------------------

    def _detect_bosses(
        self, face_infos: List[FaceInfo], counter: Dict[str, int]
    ) -> List[dict]:
        """Convex full-cylinder faces = bosses / pins / posts."""
        candidates = [
            fi for fi in face_infos
            if fi.surf_type == "Cylinder"
            and fi.concavity == "boss"
            and _is_full_cylinder(fi.face)
        ]
        logger.debug("Boss detector: %d full-cylinder convex candidates", len(candidates))
        features = []
        for fi in candidates:
            counter["B"] += 1
            dia = round(fi.radius_mm * 2, 4)
            dep = round(fi.depth_mm, 3)
            logger.info(
                "  [B%d] boss  Ø%.4f mm  height=%.3f mm  axis=%s",
                counter["B"], dia, dep, _axis_label(fi.cyl_axis),
            )
            features.append({
                "id":   f"B{counter['B']}",
                "name": f"Boss Ø{dia}mm",
                "type": "boss",
                "description": f"Cylindrical boss/pin, diameter {dia}mm, height {dep}mm",
                "dimensions": {
                    "diameter_mm": f"{dia}",
                    "height_mm":   f"{dep}",
                    "axis": _axis_label(fi.cyl_axis),
                },
                "_center":    (round(fi.cyl_center.x,3), round(fi.cyl_center.y,3), round(fi.cyl_center.z,3)),
                "_radius_mm": fi.radius_mm,
                "_depth_mm":  fi.depth_mm,
            })
        return features

    # ------------------------------------------------------------------
    # Pocket detection
    # ------------------------------------------------------------------

    def _detect_pockets(
        self, face_infos: List[FaceInfo], shape_bb, counter: Dict[str, int]
    ) -> List[dict]:
        """
        Pocket floor = horizontal planar face below the part's top Z level,
        with enough area and depth to be a real pocket.
        """
        from config import MIN_POCKET_DEPTH_MM, MIN_POCKET_AREA_MM2

        top_z = shape_bb.ZMax
        features = []
        _pocket_candidates = 0

        for fi in face_infos:
            if fi.surf_type != "Plane":
                continue
            if fi.plane_normal is None:
                continue
            horiz = _face_horizontal(fi.face)
            if horiz != "up":    # pocket floor normal points up
                continue
            depth = top_z - fi.plane_z_level
            if depth < MIN_POCKET_DEPTH_MM:
                continue
            if fi.area_mm2 < MIN_POCKET_AREA_MM2:
                continue

            _pocket_candidates += 1
            # Estimate pocket XY extents from bounding box
            bb = fi.bbox
            w  = round(bb.XLength, 3)
            h  = round(bb.YLength, 3)
            dep = round(depth, 3)

            counter["P"] += 1
            pid = f"P{counter['P']}"

            logger.info(
                "  [%s] pocket  floor %.1f mm²  %.3f×%.3f mm  depth=%.3f mm  z=%.3f mm",
                pid, fi.area_mm2, w, h, dep, fi.plane_z_level,
            )

            features.append({
                "id":   pid,
                "name": f"Pocket {w}×{h}mm depth {dep}mm",
                "type": "pocket",
                "description": (
                    f"Milled pocket, floor area {round(fi.area_mm2,1)}mm², "
                    f"approx {w}×{h}mm, depth {dep}mm"
                ),
                "dimensions": {
                    "width_mm":  f"{w}",
                    "length_mm": f"{h}",
                    "depth_mm":  f"{dep}",
                    "area_mm2":  f"{round(fi.area_mm2,2)}",
                },
                "_depth_mm": depth,
            })
        return features

    # ------------------------------------------------------------------
    # Slot detection
    # ------------------------------------------------------------------

    def _detect_slots(
        self, face_infos: List[FaceInfo], counter: Dict[str, int]
    ) -> List[dict]:
        """
        Slots = partial cylindrical endcaps (~π span) paired with parallel planar walls.
        Uses angular span ≈ π as the discriminator.
        """
        half_cyl = [
            fi for fi in face_infos
            if fi.surf_type == "Cylinder"
            and fi.concavity == "hole"
            and abs(_angular_span(fi.face) - math.pi) < 0.3   # ~180°
        ]
        logger.debug("Slot detector: %d ~180° cylinder candidates", len(half_cyl))

        # Group endcap pairs by similar radius and co-axial direction
        from config import CAXIS_TOL_MM
        used = set()
        features = []

        for i, fi in enumerate(half_cyl):
            if i in used:
                continue
            pair = [fi]
            for j, fj in enumerate(half_cyl):
                if j <= i or j in used:
                    continue
                if (
                    _axes_parallel(fi.cyl_axis, fj.cyl_axis)
                    and abs(fi.radius_mm - fj.radius_mm) < 0.1
                ):
                    pair.append(fj)
                    used.add(j)
            used.add(i)

            if len(pair) < 2:
                continue   # need at least 2 endcaps to define a slot

            r  = round(pair[0].radius_mm, 3)
            w  = round(r * 2, 3)   # slot width = endcap diameter
            # Slot length ≈ distance between endcap centers
            c0 = pair[0].cyl_center
            c1 = pair[1].cyl_center
            length = round(c0.sub(c1).length(), 3)
            dep = round(pair[0].depth_mm, 3)

            counter["SL"] += 1
            logger.info(
                "  [SL%d] slot  W=%.3f mm  L=%.3f mm  depth=%.3f mm  axis=%s",
                counter["SL"], w, length, dep, _axis_label(pair[0].cyl_axis),
            )
            features.append({
                "id":   f"SL{counter['SL']}",
                "name": f"Slot W{w}mm × L{length}mm",
                "type": "slot",
                "description": f"Milled slot, width {w}mm, length {length}mm, depth {dep}mm",
                "dimensions": {
                    "width_mm":  f"{w}",
                    "length_mm": f"{length}",
                    "depth_mm":  f"{dep}",
                },
            })
        return features

    # ------------------------------------------------------------------
    # Fillet / radius detection
    # ------------------------------------------------------------------

    def _detect_fillets(
        self, face_infos: List[FaceInfo], counter: Dict[str, int]
    ) -> List[dict]:
        """
        Fillets = partial concave cylinders with radius ≤ MAX_FILLET_RADIUS_MM.
        Group by radius value to report "N × R2.5mm fillets".
        """
        from config import MAX_FILLET_RADIUS_MM, RADIUS_GROUP_TOL_MM

        candidates = [
            fi for fi in face_infos
            if fi.surf_type == "Cylinder"
            and fi.concavity == "hole"
            and fi.radius_mm <= MAX_FILLET_RADIUS_MM
            and not _is_full_cylinder(fi.face)   # partial = fillet/round
        ]
        logger.debug(
            "Fillet detector: %d partial concave cylinders (r ≤ %.1f mm)",
            len(candidates), MAX_FILLET_RADIUS_MM,
        )

        # Group by rounded radius
        by_radius: Dict[float, List[FaceInfo]] = defaultdict(list)
        for fi in candidates:
            rkey = round(fi.radius_mm / RADIUS_GROUP_TOL_MM) * RADIUS_GROUP_TOL_MM
            by_radius[rkey].append(fi)

        features = []
        for r_mm, group in sorted(by_radius.items()):
            count = len(group)
            r_in  = _mm_to_in(r_mm)
            counter["F"] += 1
            logger.info(
                "  [F%d] fillets  r=%.3f mm (%.4f in)  count=%d",
                counter["F"], r_mm, r_in, count,
            )
            features.append({
                "id":   f"F{counter['F']}",
                "name": f"{count}× Fillet R{round(r_mm,3)}mm",
                "type": "fillet",
                "description": (
                    f"{count} internal fillet(s), radius {round(r_mm,3)}mm "
                    f"({r_in:.4f}in)"
                ),
                "dimensions": {
                    "radius_mm":  f"{round(r_mm,3)}",
                    "radius_in":  f"{r_in:.4f}",
                    "count":      f"{count}",
                },
                "_radius_mm": r_mm,
                "_count": count,
            })
        return features

    # ------------------------------------------------------------------
    # Chamfer detection
    # ------------------------------------------------------------------

    def _detect_chamfers(
        self, face_infos: List[FaceInfo], counter: Dict[str, int]
    ) -> List[dict]:
        """
        Chamfers = planar faces whose normal is at ~45° to Z-axis.
        Group by angle bucket.
        """
        from config import CHAMFER_ANGLE_DEG, CHAMFER_ANGLE_TOL_DEG

        candidates = []
        for fi in face_infos:
            if fi.surf_type != "Plane":
                continue
            angle = _face_normal_angle_to_z(fi.face)
            if angle is None:
                continue
            dist = abs(angle - CHAMFER_ANGLE_DEG)
            if dist <= CHAMFER_ANGLE_TOL_DEG:
                candidates.append((fi, angle))

        logger.debug(
            "Chamfer detector: %d planar faces at ~%.0f° ± %.0f° to Z",
            len(candidates), CHAMFER_ANGLE_DEG, CHAMFER_ANGLE_TOL_DEG,
        )

        if not candidates:
            return []

        # Group by angle bucket (± tol)
        by_angle: Dict[int, List[FaceInfo]] = defaultdict(list)
        for fi, angle in candidates:
            bucket = round(angle / 5) * 5   # nearest 5°
            by_angle[bucket].append(fi)

        features = []
        for angle_deg, group in sorted(by_angle.items()):
            count = len(group)
            # Estimate chamfer size from face area and perimeter
            avg_area = sum(fi.area_mm2 for fi in group) / count
            # size ≈ width of chamfer strip (very rough)
            size_mm = round(math.sqrt(avg_area / 10), 3)   # heuristic

            counter["C"] += 1
            logger.info(
                "  [C%d] chamfers  angle=%d°  count=%d  avg_area=%.2f mm²  est_size=%.3f mm",
                counter["C"], angle_deg, count, avg_area, size_mm,
            )
            features.append({
                "id":   f"C{counter['C']}",
                "name": f"{count}× Chamfer {angle_deg}°",
                "type": "chamfer",
                "description": (
                    f"{count} chamfer face(s) at {angle_deg}° to vertical, "
                    f"approx size {size_mm}mm"
                ),
                "dimensions": {
                    "angle_deg": f"{angle_deg}",
                    "count":     f"{count}",
                    "size_mm":   f"{size_mm}",
                    "size_in":   f"{_mm_to_in(size_mm):.4f}",
                },
                "_count": count,
                "_angle_deg": angle_deg,
            })
        return features

    # ------------------------------------------------------------------
    # Step detection
    # ------------------------------------------------------------------

    def _detect_steps(
        self, face_infos: List[FaceInfo], shape_bb, counter: Dict[str, int]
    ) -> List[dict]:
        """
        Steps = horizontal planar faces at distinct Z levels (neither top nor bottom),
        typically large enough to be machined shoulders.
        """
        top_z = shape_bb.ZMax
        bot_z = shape_bb.ZMin

        step_faces = []
        for fi in face_infos:
            if fi.surf_type != "Plane":
                continue
            horiz = _face_horizontal(fi.face)
            if not horiz:
                continue
            z = fi.plane_z_level
            # Exclude top and bottom faces
            if abs(z - top_z) < 0.5 or abs(z - bot_z) < 0.5:
                continue
            # Must be reasonably large (not just a pocket floor from above)
            if fi.area_mm2 < 50.0:
                continue
            step_faces.append(fi)

        logger.debug(
            "Step detector: %d horizontal faces between top (%.2f mm) and bottom (%.2f mm)",
            len(step_faces), top_z, bot_z,
        )

        if not step_faces:
            return []

        # Cluster by Z level
        z_clusters: Dict[float, List[FaceInfo]] = defaultdict(list)
        for fi in step_faces:
            z_key = round(fi.plane_z_level, 1)
            z_clusters[z_key].append(fi)

        features = []
        for z_key, group in sorted(z_clusters.items()):
            depth = round(top_z - z_key, 3)
            total_area = sum(fi.area_mm2 for fi in group)

            counter["ST"] += 1
            logger.info(
                "  [ST%d] step  z=%.2f mm  depth_from_top=%.3f mm  total_area=%.1f mm²  faces=%d",
                counter["ST"], z_key, depth, total_area, len(group),
            )
            features.append({
                "id":   f"ST{counter['ST']}",
                "name": f"Step at Z={z_key:.2f}mm (depth {depth}mm)",
                "type": "step",
                "description": (
                    f"Machined shoulder/step at Z={z_key:.2f}mm, "
                    f"depth from top {depth}mm, area {round(total_area,1)}mm²"
                ),
                "dimensions": {
                    "z_level_mm":  f"{z_key:.2f}",
                    "depth_mm":    f"{depth}",
                    "area_mm2":    f"{round(total_area,2)}",
                },
                "_depth_mm": depth,
                "_z_level": z_key,
            })
        return features

    # ------------------------------------------------------------------
    # Countersink / counterbore detection (conical faces)
    # ------------------------------------------------------------------

    def _detect_countersinks(
        self, face_infos: List[FaceInfo], counter: Dict[str, int]
    ) -> List[dict]:
        """
        Conical concave faces = countersinks or countersink chamfers.
        Half-angle ≈ 45° → 90° included angle countersink (most common).
        """
        cones = [
            fi for fi in face_infos
            if fi.surf_type == "Cone"
            and fi.concavity == "hole"
        ]
        logger.debug("Countersink detector: %d concave cone faces", len(cones))

        features = []
        for fi in cones:
            ha = round(fi.cone_half_angle_deg, 1)
            included = round(ha * 2, 1)
            # Diameter at widest point from bounding box
            bb = fi.bbox
            dia = round(max(bb.XLength, bb.YLength), 3)

            counter["CS"] += 1
            logger.info(
                "  [CS%d] countersink  Ø=%.3f mm (%.4f in)  included_angle=%.1f°  half_angle=%.1f°",
                counter["CS"], dia, _mm_to_in(dia), included, ha,
            )
            features.append({
                "id":   f"CS{counter['CS']}",
                "name": f"Countersink Ø{dia}mm {included}°",
                "type": "countersink",
                "description": (
                    f"Countersink, included angle {included}°, "
                    f"max diameter {dia}mm ({_mm_to_in(dia):.4f}in)"
                ),
                "dimensions": {
                    "diameter_mm":   f"{dia}",
                    "included_angle": f"{included}",
                    "half_angle":    f"{ha}",
                },
                "_radius_mm": dia / 2,
            })
        return features


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _mm_to_in(mm: float) -> float:
    from config import MM_PER_INCH
    return mm / MM_PER_INCH


def _axis_label(axis: Vec3) -> str:
    if axis is None:
        return "?"
    ax = axis.normalized()
    if abs(ax.z) > 0.95:
        return "+Z" if ax.z > 0 else "-Z"
    if abs(ax.x) > 0.95:
        return "+X" if ax.x > 0 else "-X"
    if abs(ax.y) > 0.95:
        return "+Y" if ax.y > 0 else "-Y"
    return f"({ax.x:.2f},{ax.y:.2f},{ax.z:.2f})"


def _part_span_along_axis(shape_bb, axis: Optional[Vec3]) -> float:
    """Bounding-box diagonal along the given axis direction."""
    if axis is None:
        return shape_bb.ZLength
    a = axis.normalized()
    # Project the 8 BB corners onto axis and take span
    xmin, xmax = shape_bb.XMin, shape_bb.XMax
    ymin, ymax = shape_bb.YMin, shape_bb.YMax
    zmin, zmax = shape_bb.ZMin, shape_bb.ZMax
    corners = [
        Vec3(x, y, z)
        for x in (xmin, xmax)
        for y in (ymin, ymax)
        for z in (zmin, zmax)
    ]
    projections = [c.dot(a) for c in corners]
    return max(projections) - min(projections)


# ---------------------------------------------------------------------------
# CLI smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import json
    logging.basicConfig(level=logging.INFO)
    fp = sys.argv[1] if len(sys.argv) > 1 else "part.stp"

    if not load_freecad():
        print("ERROR: FreeCAD not found. Set FREECAD_PATH environment variable.")
        sys.exit(1)

    analyzer = STEPAnalyzer(fp)
    result = analyzer.analyze()
    print(json.dumps(result, indent=2, default=str))
