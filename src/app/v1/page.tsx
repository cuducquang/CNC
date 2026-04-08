"use client";

/**
 * Approach 1 — LLM-per-step pipeline test page.
 *
 * Calls Python server.py (port 8001) directly from the browser.
 * CORS is open on the Python side so no Next.js proxy is needed.
 *
 * Set NEXT_PUBLIC_PYTHON_V1_URL to override the default http://localhost:8001.
 */

import { useState, useRef } from "react";
import { FileDropzone } from "@/components/upload/file-dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import {
  Eye, Layers, ShieldCheck, Wrench, Timer, DollarSign,
  Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Bot, Sparkles, Plus,
} from "lucide-react";

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

function parseSSEBuffer(buffer: string) {
  const events: Array<{ event: string; data: string }> = [];
  const parts = buffer.split("\n\n");
  const remaining = parts.pop() ?? "";
  for (const block of parts) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) events.push({ event, data });
  }
  return { events, remaining };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepStatus = "idle" | "running" | "done" | "error";

interface StepState {
  status: StepStatus;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  error: string | null;
  thinking: string;
  elapsedMs: number | null;
}

const STEPS = [
  { key: "gdt",       icon: Eye,         label: "GD&T Extraction",    desc: "VLM reads 2D PDF — extracts dimensions, GD&T, threads" },
  { key: "step3d",    icon: Layers,      label: "3D Analysis",         desc: "Regex parses STEP geometry; text LLM classifies features" },
  { key: "features",  icon: ShieldCheck, label: "Feature Recognition", desc: "Text LLM matches 2D annotations to 3D CAD features" },
  { key: "processes", icon: Wrench,      label: "Process Mapping",     desc: "Text LLM maps features to CNC operations" },
  { key: "cycletime", icon: Timer,       label: "Cycle Time",          desc: "Text LLM estimates per-operation machining time" },
  { key: "cost",      icon: DollarSign,  label: "Cost Estimation",     desc: "Deterministic formula — no LLM, instant" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

function makeInitialSteps(): Record<StepKey, StepState> {
  return Object.fromEntries(
    STEPS.map((s) => [s.key, { status: "idle" as StepStatus, result: null, error: null, thinking: "", elapsedMs: null }])
  ) as Record<StepKey, StepState>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: StepStatus }) {
  if (status === "idle") return <span className="text-[10px] font-mono text-muted-foreground/40">idle</span>;
  if (status === "running") return <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />;
  if (status === "done")  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
  return <XCircle className="w-3.5 h-3.5 text-red-500" />;
}

function StepSummary({ stepKey, result }: { stepKey: StepKey; result: unknown }) {
  if (!result) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;

  const chips: string[] = [];
  switch (stepKey) {
    case "gdt":
      if (r.feature_count != null) chips.push(`${r.feature_count} dims`);
      if (r.gdt_count      != null) chips.push(`${r.gdt_count} GD&T`);
      if (r.threads?.length)        chips.push(`${r.threads.length} threads`);
      if (r.material)               chips.push(String(r.material));
      break;
    case "step3d":
      if (r.features_3d?.length)      chips.push(`${r.features_3d.length} 3D features`);
      if (r.shape_summary?.bbox_x_mm) chips.push(`${r.shape_summary.bbox_x_mm}×${r.shape_summary.bbox_y_mm}×${r.shape_summary.bbox_z_mm} mm`);
      break;
    case "features":
      if (r.feature_count != null)    chips.push(`${r.feature_count} features`);
      if (r.material?.spec)           chips.push(r.material.spec);
      break;
    case "processes":
      if (r.operation_count != null)  chips.push(`${r.operation_count} ops`);
      if (r.setup_count     != null)  chips.push(`${r.setup_count} setup(s)`);
      break;
    case "cycletime":
      if (r.total_minutes   != null)  chips.push(`${Number(r.total_minutes).toFixed(1)} min total`);
      if (r.setup_minutes   != null)  chips.push(`${Number(r.setup_minutes).toFixed(1)} min setup`);
      break;
    case "cost":
      if (r.total_usd != null) chips.push(`$${Number(r.total_usd).toFixed(2)}`);
      if (r.machining_cost != null) chips.push(`machining $${Number(r.machining_cost).toFixed(2)}`);
      break;
  }

  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {chips.map((c) => (
        <span key={c} className="text-[10.5px] font-mono bg-muted/60 rounded px-1.5 py-0.5 text-muted-foreground">
          {c}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function V1TestPage() {
  const [file3d, setFile3d] = useState<File | null>(null);
  const [file2d, setFile2d] = useState<File | null>(null);
  const [running,     setRunning]     = useState(false);
  const [done,        setDone]        = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [steps,       setSteps]       = useState<Record<StepKey, StepState>>(makeInitialSteps());
  const [expanded,    setExpanded]    = useState<Set<StepKey>>(new Set());
  const abortRef  = useRef<AbortController | null>(null);
  const startRef  = useRef<Partial<Record<StepKey, number>>>({});

  const pythonUrl = (process.env.NEXT_PUBLIC_PYTHON_V1_URL ?? "http://localhost:8001").replace(/\/$/, "");

  const patchStep = (key: StepKey, patch: Partial<StepState>) =>
    setSteps((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const startStep = (key: StepKey) => {
    startRef.current[key] = Date.now();
    patchStep(key, { status: "running" });
  };

  const finishStep = (key: StepKey, result: unknown, thinking?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inferredThinking = thinking ?? (result as any)?.thinking ?? "";
    // Strip the `thinking` field from the displayed result so the RESPONSE
    // block shows clean JSON without raw escape sequences.
    const cleanResult = (() => {
      if (result && typeof result === "object" && "thinking" in (result as object)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { thinking: _t, ...rest } = result as Record<string, unknown>;
        return rest;
      }
      return result;
    })();
    setSteps((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        status:    "done",
        result:    cleanResult,
        // For SSE steps (gdt), keep the accumulated stream thinking; for JSON steps, use the response field.
        thinking:  inferredThinking || prev[key].thinking,
        elapsedMs: startRef.current[key] ? Date.now() - startRef.current[key]! : null,
      },
    }));
  };

  const failStep = (key: StepKey, msg: string) =>
    setSteps((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        status:    "error",
        error:     msg,
        elapsedMs: startRef.current[key] ? Date.now() - startRef.current[key]! : null,
      },
    }));

  const toggleExpand = (key: StepKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // ── Main run handler ──────────────────────────────────────────────────────

  const handleRun = async () => {
    if (!file2d || !file3d) return;

    setRunning(true);
    setDone(false);
    setGlobalError(null);
    setSteps(makeInitialSteps());
    setExpanded(new Set());
    startRef.current = {};

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // ── Upload files to Supabase, get signed URLs ──────────────────────
      const sbClient = createSupabaseBrowserClient();
      const runId    = crypto.randomUUID();
      const path3d   = `uploads/v1test/${runId}/3d_${file3d.name}`;
      const path2d   = `uploads/v1test/${runId}/2d_${file2d.name}`;

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

      // ── Step 1: GD&T extraction (SSE stream) ──────────────────────────
      startStep("gdt");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let gdtResult: Record<string, any> | null = null;

      {
        const resp = await fetch(`${pythonUrl}/v1/gdt`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ drawing_url: drawingUrl, file_name: fileName }),
          signal:  controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`/v1/gdt HTTP ${resp.status}`);

        const reader = resp.body.getReader();
        const dec    = new TextDecoder();
        let   buf    = "";

        outer: while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
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
                gdt: { ...prev.gdt, thinking: prev.gdt.thinking + ((parsed.content as string) ?? "") },
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

      // ── Step 2: STEP 3D analysis (JSON) ───────────────────────────────
      startStep("step3d");
      const step3dResp = await fetch(`${pythonUrl}/v1/step3d`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ step_url: stepUrl, file_name: fileName }),
        signal:  controller.signal,
      });
      const step3dData = await step3dResp.json();
      if (!step3dData.ok) throw new Error(step3dData.error ?? "step3d failed");
      finishStep("step3d", step3dData);

      // ── Step 3: Feature recognition (JSON) ────────────────────────────
      startStep("features");
      const featResp = await fetch(`${pythonUrl}/v1/features`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ extraction: gdtResult, step_analysis: step3dData }),
        signal:  controller.signal,
      });
      const featData = await featResp.json();
      if (!featData.ok) throw new Error(featData.error ?? "features failed");
      finishStep("features", featData);

      // ── Step 4: Process mapping (JSON) ────────────────────────────────
      startStep("processes");
      const procResp = await fetch(`${pythonUrl}/v1/processes`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ features: featData.features, material: featData.material }),
        signal:  controller.signal,
      });
      const procData = await procResp.json();
      if (!procData.ok) throw new Error(procData.error ?? "processes failed");
      finishStep("processes", procData);

      // ── Step 5: Cycle time (JSON) ─────────────────────────────────────
      startStep("cycletime");
      const ctResp = await fetch(`${pythonUrl}/v1/cycletime`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          operations:    procData.operations,
          material_spec: (featData.material?.spec as string) ?? "AL6061-T6",
        }),
        signal:  controller.signal,
      });
      const ctData = await ctResp.json();
      if (!ctData.ok) throw new Error(ctData.error ?? "cycletime failed");
      finishStep("cycletime", ctData);

      // ── Step 6: Cost formula (JSON) ───────────────────────────────────
      startStep("cost");
      const costResp = await fetch(`${pythonUrl}/v1/cost`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          cycle_time:    ctData,
          material_spec: (featData.material?.spec as string) ?? "AL6061-T6",
        }),
        signal:  controller.signal,
      });
      const costData = await costResp.json();
      if (!costData.ok) throw new Error(costData.error ?? "cost failed");
      finishStep("cost", costData);

      setDone(true);

    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Analysis failed";
      setGlobalError(msg);
      setSteps((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next) as StepKey[]) {
          if (next[k].status === "running") failStep(k, msg);
        }
        return next;
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleStop  = () => { abortRef.current?.abort(); };
  const handleReset = () => {
    setFile2d(null);
    setFile3d(null);
    setRunning(false);
    setDone(false);
    setGlobalError(null);
    setSteps(makeInitialSteps());
    setExpanded(new Set());
  };

  const showStream = running || done || globalError;
  const costResult = steps.cost.result;
  const ctResult   = steps.cycletime.result;

  // ---------------------------------------------------------------------------
  // Upload view
  // ---------------------------------------------------------------------------

  if (!showStream) {
    return (
      <div className="space-y-6 py-2 max-w-2xl mx-auto">
        <div className="text-center space-y-2 pt-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 border border-primary/20 px-4 py-1.5 text-[11.5px]">
            <Sparkles className="w-3 h-3 text-primary" />
            <span className="font-semibold text-primary/90 tracking-wide uppercase">Approach 1 — LLM Steps</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">LLM Pipeline Test</h1>
          <p className="text-[13.5px] text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Each pipeline step runs as a separate HTTP call to{" "}
            <code className="text-[12px] font-mono bg-muted px-1 rounded">server.py :8001</code>.
            No single long-running connection — no CDN timeout.
          </p>
        </div>

        <Card className="shadow-[0_2px_12px_0_rgb(0,0,0,0.06)] border-border/80">
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Upload Files</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FileDropzone
                label="3D CAD File"
                description="STEP / STP — required"
                accept={{ "application/step": [".stp", ".step"], "application/octet-stream": [".stp", ".step"] }}
                file={file3d}
                onFileSelect={setFile3d}
                icon="3d"
                required
              />
              <FileDropzone
                label="2D Engineering Drawing"
                description="PDF, PNG, JPG — required"
                accept={{ "application/pdf": [".pdf"], "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] }}
                file={file2d}
                onFileSelect={setFile2d}
                icon="2d"
                required
              />
            </div>

            <Button
              onClick={handleRun}
              disabled={!file2d || !file3d}
              className="w-full h-11 text-[14px] font-semibold rounded-xl"
              size="lg"
            >
              <Bot className="w-4 h-4" />
              Run Approach 1
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Pipeline view
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-5 max-w-2xl mx-auto py-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            {done ? "Analysis Complete" : globalError ? "Analysis Failed" : "Running…"}
          </h2>
          <p className="text-[12px] text-muted-foreground font-mono mt-0.5 truncate">
            {[file3d?.name, file2d?.name].filter(Boolean).join(" + ")}
          </p>
        </div>
        <div className="flex gap-2">
          {running && (
            <Button variant="destructive" size="sm" className="rounded-lg" onClick={handleStop}>
              Stop
            </Button>
          )}
          {(done || globalError) && (
            <Button variant="outline" size="sm" className="rounded-lg" onClick={handleReset}>
              <Plus className="w-3.5 h-3.5" />
              New
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards — show once cost is done */}
      {done && ctResult && costResult && (
        <div className="grid grid-cols-2 gap-3">
          <Card className="py-4 border-cyan-200 bg-gradient-to-br from-cyan-50 to-sky-50">
            <CardContent className="px-4 text-center">
              <Timer className="w-4 h-4 mx-auto text-cyan-500 mb-1.5" />
              <div className="text-2xl font-bold font-mono text-cyan-600">
                {Number(ctResult.total_minutes).toFixed(1)}
              </div>
              <div className="text-[10px] text-cyan-500/70 font-mono font-semibold uppercase tracking-wide">min</div>
            </CardContent>
          </Card>
          <Card className="py-4 border-emerald-200 bg-gradient-to-br from-emerald-50 to-green-50">
            <CardContent className="px-4 text-center">
              <DollarSign className="w-4 h-4 mx-auto text-emerald-500 mb-1.5" />
              <div className="text-2xl font-bold font-mono text-emerald-600">
                ${Number(costResult.total_usd).toFixed(2)}
              </div>
              <div className="text-[10px] text-emerald-500/70 font-mono font-semibold uppercase tracking-wide">USD</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Global error */}
      {globalError && (
        <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl p-3.5 text-[13px]">
          {globalError}
        </div>
      )}

      <Separator />

      {/* Step cards */}
      <div className="space-y-2">
        {STEPS.map((step) => {
          const s      = steps[step.key];
          const isOpen = expanded.has(step.key);
          const hasDetails = s.thinking.length > 0 || s.result !== null || s.error !== null;

          return (
            <Card key={step.key} className={`overflow-hidden transition-all ${
              s.status === "running"
                ? "border-primary/30 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]"
                : s.status === "error"
                  ? "border-red-200"
                  : "border-border"
            }`}>
              {/* Header row */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
                onClick={() => hasDetails && toggleExpand(step.key)}
                disabled={!hasDetails}
              >
                <div className={`flex items-center justify-center w-7 h-7 rounded-md shrink-0 ${
                  s.status === "done"    ? "bg-emerald-100"  :
                  s.status === "running" ? "bg-primary/10"   :
                  s.status === "error"   ? "bg-red-100"      :
                  "bg-muted/40"
                }`}>
                  <step.icon className={`w-3.5 h-3.5 ${
                    s.status === "done"    ? "text-emerald-600" :
                    s.status === "running" ? "text-primary"     :
                    s.status === "error"   ? "text-red-500"     :
                    "text-muted-foreground/30"
                  }`} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">{step.label}</span>
                    {s.elapsedMs !== null && (
                      <span className="text-[10px] font-mono text-muted-foreground/50">
                        {(s.elapsedMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  {s.status === "idle" && (
                    <span className="text-[11px] text-muted-foreground/50">{step.desc}</span>
                  )}
                  {s.status === "running" && (
                    <span className="text-[11px] text-primary/70 animate-pulse">{step.desc}</span>
                  )}
                  {s.status === "done" && <StepSummary stepKey={step.key} result={s.result} />}
                  {s.status === "error" && (
                    <span className="text-[11px] text-red-500">{s.error}</span>
                  )}
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <StatusBadge status={s.status} />
                  {hasDetails && (
                    isOpen
                      ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/40" />
                      : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40" />
                  )}
                </div>
              </button>

              {/* Expanded details */}
              {isOpen && hasDetails && (
                <div className="border-t border-border bg-muted/10 px-4 py-3 space-y-3">
                  {/* Model Thinking — shown for all steps; grayed out when empty */}
                  {s.status === "done" && (
                    <div>
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Model Thinking
                      </div>
                      {s.thinking ? (
                        <pre className="text-[10.5px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap overflow-y-auto max-h-48 bg-background rounded-lg border border-border p-3">
                          {s.thinking}
                        </pre>
                      ) : (
                        <p className="text-[10.5px] text-muted-foreground/40 italic px-3 py-2 bg-background rounded-lg border border-border/50">
                          No reasoning output — model returned structured JSON directly.
                        </p>
                      )}
                    </div>
                  )}

                  {/* JSON result */}
                  {s.result !== null && (
                    <div>
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Response
                      </div>
                      <pre className="text-[10.5px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap overflow-y-auto max-h-64 bg-background rounded-lg border border-border p-3">
                        {JSON.stringify(s.result, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
