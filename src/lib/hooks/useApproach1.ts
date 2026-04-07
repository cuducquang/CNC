"use client";

/**
 * useApproach1 — Approach 1 (LLM-per-step) pipeline logic.
 *
 * Extracted from src/app/v1/page.tsx. All API calls live here;
 * the analyze page is pure UI.
 */

import { useState, useRef, useCallback } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import {
  parseSSEBuffer,
  v1GdtStream,
  v1Step3d,
  v1Features,
  v1Processes,
  v1CycleTime,
  v1Cost,
} from "@/lib/api";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type StepStatus = "idle" | "running" | "done" | "error";

export interface StepState {
  status: StepStatus;
  result: any;
  error: string | null;
  thinking: string;
  elapsedMs: number | null;
}

export const STEPS = [
  { key: "gdt",       label: "GD&T Extraction",    desc: "VLM reads 2D PDF — extracts dimensions, GD&T, threads" },
  { key: "step3d",    label: "3D Analysis",          desc: "Regex parses STEP geometry; text LLM classifies features" },
  { key: "features",  label: "Feature Recognition",  desc: "Text LLM matches 2D annotations to 3D CAD features" },
  { key: "processes", label: "Process Mapping",       desc: "Text LLM maps features to CNC operations" },
  { key: "cycletime", label: "Cycle Time",            desc: "Text LLM estimates per-operation machining time" },
  { key: "cost",      label: "Cost Estimation",       desc: "Deterministic formula — no LLM, instant" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

function makeInitialSteps(): Record<StepKey, StepState> {
  return Object.fromEntries(
    STEPS.map((s) => [
      s.key,
      { status: "idle" as StepStatus, result: null, error: null, thinking: "", elapsedMs: null },
    ])
  ) as Record<StepKey, StepState>;
}

export type Approach1PipelineStatus = "idle" | "running" | "done" | "error";

export function useApproach1() {
  const [pipelineStatus, setPipelineStatus] = useState<Approach1PipelineStatus>("idle");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(makeInitialSteps());
  const [expanded, setExpanded] = useState<Set<StepKey>>(new Set());

  const abortRef  = useRef<AbortController | null>(null);
  const startRef  = useRef<Partial<Record<StepKey, number>>>({});
  // Persisted across the async run() so the finally-block save can access them
  const runIdRef  = useRef<string>("");
  const path3dRef = useRef<string>("");
  const path2dRef = useRef<string>("");

  const patchStep = useCallback((key: StepKey, patch: Partial<StepState>) =>
    setSteps((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } })), []);

  const startStep = useCallback((key: StepKey) => {
    startRef.current[key] = Date.now();
    patchStep(key, { status: "running" });
  }, [patchStep]);

  const finishStep = useCallback((key: StepKey, result: unknown, thinking?: string) => {
    const inferredThinking = thinking ?? (result as any)?.thinking ?? "";
    // Strip the `thinking` field from the displayed result so the RESPONSE
    // block shows clean JSON without raw escape sequences.
    const cleanResult = (() => {
      if (result && typeof result === "object" && "thinking" in (result as object)) {
        const { thinking: _t, ...rest } = result as Record<string, unknown>;
        void _t;
        return rest;
      }
      return result;
    })();
    setSteps((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        status: "done",
        result: cleanResult,
        thinking: inferredThinking || prev[key].thinking,
        elapsedMs: startRef.current[key] ? Date.now() - startRef.current[key]! : null,
      },
    }));
  }, []);

  const failStep = useCallback((key: StepKey, msg: string) =>
    setSteps((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        status: "error",
        error: msg,
        elapsedMs: startRef.current[key] ? Date.now() - startRef.current[key]! : null,
      },
    })), []);

  const toggleExpand = useCallback((key: StepKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    }), []);

  const run = useCallback(async (file3d: File, file2d: File) => {
    setPipelineStatus("running");
    setGlobalError(null);
    setSteps(makeInitialSteps());
    setExpanded(new Set());
    startRef.current = {};

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Upload to Supabase, get signed URLs
      const sbClient = createSupabaseBrowserClient();
      const runId  = crypto.randomUUID();
      const path3d = `uploads/v1test/${runId}/3d_${file3d.name}`;
      const path2d = `uploads/v1test/${runId}/2d_${file2d.name}`;
      // Stash in refs so the post-pipeline save block can access them
      runIdRef.current  = runId;
      path3dRef.current = path3d;
      path2dRef.current = path2d;

      const [up3d, up2d] = await Promise.all([
        sbClient.storage.from("parts").upload(path3d, file3d, { upsert: true }),
        sbClient.storage.from("parts").upload(path2d, file2d, { upsert: true }),
      ]);
      if (up3d.error) throw new Error(`3D upload failed: ${up3d.error.message}`);
      if (up2d.error) throw new Error(`2D upload failed: ${up2d.error.message}`);

      const [sign3d, sign2d] = await Promise.all([
        sbClient.storage.from("parts").createSignedUrl(path3d, 3600),
        sbClient.storage.from("parts").createSignedUrl(path2d, 3600),
      ]);
      if (sign3d.error) throw new Error(sign3d.error.message);
      if (sign2d.error) throw new Error(sign2d.error.message);

      const drawingUrl = sign2d.data!.signedUrl;
      const stepUrl    = sign3d.data!.signedUrl;
      const fileName   = file3d.name;

      // Step 1: GD&T (SSE stream)
      startStep("gdt");
      let gdtResult: Record<string, any> | null = null;

      {
        const resp = await v1GdtStream(
          { drawing_url: drawingUrl, file_name: fileName },
          controller.signal
        );
        const reader = resp.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const { events, remaining } = parseSSEBuffer(buf);
          buf = remaining;

          for (const { event, data } of events) {
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(data); }
            catch { continue; }

            if (event === "thinking") {
              setSteps((prev) => ({
                ...prev,
                gdt: {
                  ...prev.gdt,
                  thinking: prev.gdt.thinking + ((parsed.content as string) ?? ""),
                },
              }));
            } else if (event === "gdt_result") {
              gdtResult = parsed;
            } else if (event === "error") {
              throw new Error((parsed.message as string) || "GD&T step failed");
            } else if (event === "done") {
              break outer;
            }
          }
        }
      }

      if (!gdtResult) throw new Error("GD&T step returned no result");
      finishStep("gdt", gdtResult);

      // Step 2: STEP 3D
      startStep("step3d");
      const step3dData = await v1Step3d({ step_url: stepUrl, file_name: fileName }, controller.signal);
      finishStep("step3d", step3dData);

      // Step 3: Features
      startStep("features");
      const featData = await v1Features({ extraction: gdtResult, step_analysis: step3dData }, controller.signal);
      finishStep("features", featData);

      // Step 4: Processes
      startStep("processes");
      const procData = await v1Processes(
        { features: (featData as any).features, material: (featData as any).material },
        controller.signal
      );
      finishStep("processes", procData);

      // Step 5: Cycle time
      startStep("cycletime");
      const ctData = await v1CycleTime(
        {
          operations: (procData as any).operations,
          material_spec: ((featData as any).material?.spec as string) ?? "AL6061-T6",
        },
        controller.signal
      );
      finishStep("cycletime", ctData);

      // Step 6: Cost
      startStep("cost");
      const costData = await v1Cost(
        {
          cycle_time: ctData,
          material_spec: ((featData as any).material?.spec as string) ?? "AL6061-T6",
        },
        controller.signal
      );
      finishStep("cost", costData);

      // ── Persist to DB so /history shows Approach 1 results ──────────────
      try {
        await fetch("/api/upload/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            analysis_id:  runIdRef.current,
            file_3d_path: path3dRef.current,
            file_2d_path: path2dRef.current,
            file_name:    file3d.name,
            approach:     1,
          }),
        });

        await fetch("/api/save-result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            analysis_id: runIdRef.current,
            results: {
              extraction:    gdtResult,
              features:      (featData as any).features,
              processes:     procData,
              cycle_time:    ctData,
              cost:          costData,
              total_minutes: (ctData  as any).total_minutes,
              total_usd:     (costData as any).total_usd,
            },
          }),
        });
      } catch (saveErr) {
        // Non-fatal — pipeline succeeded; just log
        console.warn("[useApproach1] DB save failed:", saveErr);
      }
      // ────────────────────────────────────────────────────────────────────

      setPipelineStatus("done");

    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Analysis failed";
      setGlobalError(msg);
      setPipelineStatus("error");
      // Mark any still-running steps as failed
      setSteps((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next) as StepKey[]) {
          if (next[k].status === "running") {
            next[k] = {
              ...next[k],
              status: "error",
              error: msg,
              elapsedMs: startRef.current[k] ? Date.now() - startRef.current[k]! : null,
            };
          }
        }
        return next;
      });
    } finally {
      abortRef.current = null;
    }
  }, [startStep, finishStep]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    setPipelineStatus("idle");
    setGlobalError(null);
    setSteps(makeInitialSteps());
    setExpanded(new Set());
    startRef.current = {};
  }, []);

  const costResult = steps.cost.result;
  const ctResult   = steps.cycletime.result;

  return {
    pipelineStatus,
    globalError,
    steps,
    expanded,
    toggleExpand,
    run,
    cancel,
    reset,
    costResult,
    ctResult,
    isRunning: pipelineStatus === "running",
    isDone:    pipelineStatus === "done",
    hasError:  pipelineStatus === "error",
  };
}
