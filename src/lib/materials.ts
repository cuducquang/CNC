/**
 * Material Database — single source of truth for all material properties.
 *
 * Previously duplicated between recognize-features.ts (4 materials, no machinability)
 * and lookup-material.ts (9 materials, with machinability). This file consolidates both.
 *
 * Consumers: tools/recognize-features.ts, tools/lookup-material.ts
 */

export interface MaterialInfo {
  name: string;
  hardness_bhn: number;
  sfm_hss: number;
  sfm_carbide: number;
  feed_factor: number;
  density_lb_in3: number;
  cost_per_lb: number;
  machinability: string;
}

export const MATERIALS: Record<string, MaterialInfo> = {
  "6061-T6":   { name: "6061-T6 Aluminum",       hardness_bhn: 95,  sfm_hss: 300, sfm_carbide: 900,  feed_factor: 1.00, density_lb_in3: 0.098, cost_per_lb: 3.0,  machinability: "excellent" },
  "7075-T6":   { name: "7075-T6 Aluminum",       hardness_bhn: 150, sfm_hss: 200, sfm_carbide: 700,  feed_factor: 0.90, density_lb_in3: 0.101, cost_per_lb: 5.0,  machinability: "good" },
  "2024-T3":   { name: "2024-T3 Aluminum",       hardness_bhn: 120, sfm_hss: 250, sfm_carbide: 800,  feed_factor: 0.95, density_lb_in3: 0.100, cost_per_lb: 4.5,  machinability: "good" },
  "1018":      { name: "1018 Mild Steel",         hardness_bhn: 126, sfm_hss: 80,  sfm_carbide: 450,  feed_factor: 0.70, density_lb_in3: 0.284, cost_per_lb: 1.5,  machinability: "good" },
  "4140":      { name: "4140 Alloy Steel",        hardness_bhn: 197, sfm_hss: 60,  sfm_carbide: 350,  feed_factor: 0.60, density_lb_in3: 0.284, cost_per_lb: 2.5,  machinability: "fair" },
  "304_ss":    { name: "304 Stainless Steel",     hardness_bhn: 170, sfm_hss: 50,  sfm_carbide: 300,  feed_factor: 0.50, density_lb_in3: 0.289, cost_per_lb: 4.0,  machinability: "poor" },
  "316_ss":    { name: "316 Stainless Steel",     hardness_bhn: 175, sfm_hss: 45,  sfm_carbide: 280,  feed_factor: 0.45, density_lb_in3: 0.290, cost_per_lb: 5.0,  machinability: "poor" },
  "C360":      { name: "C360 Free-Cutting Brass", hardness_bhn: 78,  sfm_hss: 400, sfm_carbide: 1000, feed_factor: 1.20, density_lb_in3: 0.307, cost_per_lb: 4.0,  machinability: "excellent" },
  "Ti-6Al-4V": { name: "Ti-6Al-4V Titanium",      hardness_bhn: 334, sfm_hss: 25,  sfm_carbide: 150,  feed_factor: 0.30, density_lb_in3: 0.160, cost_per_lb: 25.0, machinability: "difficult" },
};

export const DEFAULT_MATERIAL: MaterialInfo = {
  name: "Unknown Material (assumed Aluminum)",
  hardness_bhn: 100, sfm_hss: 250, sfm_carbide: 800,
  feed_factor: 0.9,  density_lb_in3: 0.098, cost_per_lb: 3.0,
  machinability: "unknown",
};

/** Match a free-text material spec to the closest entry in MATERIALS. */
export function matchMaterial(spec: string): MaterialInfo {
  if (!spec) return DEFAULT_MATERIAL;
  const s = spec.toLowerCase().replace(/-/g, "");
  for (const [key, mat] of Object.entries(MATERIALS)) {
    if (s.includes(key.toLowerCase().replace(/-/g, ""))) return mat;
  }
  if (s.includes("aluminum") || s.includes("aluminium")) return MATERIALS["6061-T6"];
  if (s.includes("stainless")) return MATERIALS["304_ss"];
  if (s.includes("steel"))     return MATERIALS["1018"];
  if (s.includes("brass"))     return MATERIALS["C360"];
  if (s.includes("titanium"))  return MATERIALS["Ti-6Al-4V"];
  return DEFAULT_MATERIAL;
}
