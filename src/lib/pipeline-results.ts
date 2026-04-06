/**
 * Pipeline results builder — used by fallback-pipeline.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PipelineToolResults {
  analyze_drawing?:    Record<string, unknown> | null;
  analyze_step_file?:  Record<string, unknown> | null;
  recognize_features?: Record<string, unknown> | null;
  map_cnc_processes?:  Record<string, unknown> | null;
  estimate_cycle_time?: Record<string, unknown> | null;
  estimate_cost?:      Record<string, unknown> | null;
}

export function buildPipelineResults(r: PipelineToolResults): Record<string, unknown> {
  const extraction   = r.analyze_drawing    as any;
  const stepAnalysis = r.analyze_step_file  as any;
  const recognition  = r.recognize_features as any;
  const processes    = r.map_cnc_processes  as any;
  const cycleTime    = r.estimate_cycle_time as any;
  const cost         = r.estimate_cost      as any;

  return {
    extraction:    extraction   || null,
    step_analysis: stepAnalysis || null,
    recognition:   recognition  || null,
    processes:     processes    || null,
    cycle_time:    cycleTime    || null,
    cost:          cost         || null,
    // Flat accessors used by the frontend
    features:      recognition?.features || extraction?.features || [],
    gdt_callouts:  extraction?.gdt       || [],
    material:      recognition?.material || null,
    shape_summary: stepAnalysis?.shape_summary || recognition?.shape_summary || null,
    total_minutes: cycleTime?.total_minutes || 0,
    total_usd:     cost?.total_usd         || 0,
  };
}
