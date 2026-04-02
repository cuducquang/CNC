"use client";

import { useState, useRef } from "react";
import { FileDropzone } from "@/components/upload/file-dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AGENT_MODELS } from "@/lib/models";
import {
  BarChart2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Layers,
  DollarSign,
  Timer,
  Wrench,
  Bot,
  Play,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// SSE parser (same as main page)
// ---------------------------------------------------------------------------

function parseSSEBuffer(buffer: string) {
  const events: Array<{ event: string; data: string }> = [];
  const parts = buffer.split("\n\n");
  const remaining = parts.pop() || "";
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

interface ModelMetrics {
  model: string;
  model_name: string;
  elapsed_seconds: number;
  features: number;
  gdt: number;
  total_minutes: number;
  total_usd: number;
  tools_completed: number;
  iterations: number;
  completed: boolean;
  error?: string;
}

type RunStatus = "idle" | "running" | "done" | "error";

interface ModelRun {
  modelId: string;
  status: RunStatus;
  metrics: ModelMetrics | null;
  log: string[];
  currentStep: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BenchmarkPage() {
  const [file3d, setFile3d] = useState<File | null>(null);
  const [file2d, setFile2d] = useState<File | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(
    new Set(AGENT_MODELS.map((m) => m.id))
  );
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Map<string, ModelRun>>(new Map());
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkDone, setBenchmarkDone] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const toggleModel = (id: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleLog = (id: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateRun = (modelId: string, patch: Partial<ModelRun>) => {
    setRuns((prev) => {
      const next = new Map(prev);
      const existing = next.get(modelId) ?? { modelId, status: "idle", metrics: null, log: [], currentStep: "" };
      next.set(modelId, { ...existing, ...patch });
      return next;
    });
  };

  const appendLog = (modelId: string, line: string) => {
    setRuns((prev) => {
      const next = new Map(prev);
      const existing = next.get(modelId);
      if (!existing) return prev;
      next.set(modelId, { ...existing, log: [...existing.log.slice(-49), line] });
      return next;
    });
  };

  // ── Upload step ────────────────────────────────────────────────────────────

  const handleUpload = async () => {
    if (!file3d || !file2d) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file_3d", file3d);
      formData.append("file_2d", file2d);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Upload failed");
      }
      const data = await res.json();
      setAnalysisId(data.analysis_id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // ── Run benchmark (sequential per model) ──────────────────────────────────

  const handleRunBenchmark = async () => {
    if (!analysisId || selectedModels.size === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setBenchmarkRunning(true);
    setBenchmarkDone(false);

    const modelsToRun = AGENT_MODELS.filter((m) => selectedModels.has(m.id));

    // Init all runs
    const initMap = new Map<string, ModelRun>();
    for (const m of modelsToRun) {
      initMap.set(m.id, { modelId: m.id, status: "idle", metrics: null, log: [], currentStep: "" });
    }
    setRuns(initMap);

    for (const model of modelsToRun) {
      if (controller.signal.aborted) break;

      updateRun(model.id, { status: "running", currentStep: "Starting..." });

      try {
        const resp = await fetch("/api/benchmark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysis_id: analysisId, model: model.id }),
          signal: controller.signal,
        });

        if (!resp.ok || !resp.body) {
          updateRun(model.id, { status: "error", currentStep: `HTTP ${resp.status}` });
          continue;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, remaining } = parseSSEBuffer(buffer);
          buffer = remaining;

          for (const { event, data } of events) {
            try {
              const parsed = JSON.parse(data);
              switch (event) {
                case "benchmark_start":
                  updateRun(model.id, { currentStep: `Starting ${parsed.model_name}...` });
                  break;
                case "status":
                  updateRun(model.id, { currentStep: parsed.message || parsed.title });
                  appendLog(model.id, `[status] ${parsed.title}: ${parsed.message}`);
                  break;
                case "tool_call":
                  updateRun(model.id, { currentStep: `Calling ${parsed.tool}...` });
                  appendLog(model.id, `[tool] ${parsed.tool}`);
                  break;
                case "tool_result":
                  appendLog(model.id, `[result] ${parsed.tool} — ${parsed.error ? "error" : "ok"}`);
                  break;
                case "thinking":
                  updateRun(model.id, { currentStep: "Agent reasoning..." });
                  break;
                case "error":
                  appendLog(model.id, `[error] ${parsed.message}`);
                  break;
                case "metrics":
                  updateRun(model.id, {
                    metrics: parsed as ModelMetrics,
                    status: parsed.completed ? "done" : "error",
                    currentStep: parsed.completed ? "Completed" : `Failed: ${parsed.error || "unknown"}`,
                  });
                  break;
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          updateRun(model.id, { status: "error", currentStep: (err as Error).message });
        }
      }
    }

    setBenchmarkRunning(false);
    setBenchmarkDone(true);
    abortRef.current = null;
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setBenchmarkRunning(false);
  };

  const handleReset = () => {
    setFile3d(null);
    setFile2d(null);
    setAnalysisId(null);
    setRuns(new Map());
    setBenchmarkDone(false);
    setUploadError(null);
  };

  // ── Derived metrics for bar charts ────────────────────────────────────────

  const completedRuns = [...runs.values()].filter((r) => r.metrics?.completed);
  const maxTime = Math.max(...completedRuns.map((r) => r.metrics!.elapsed_seconds), 1);
  const maxCost = Math.max(...completedRuns.map((r) => r.metrics!.total_usd), 0.01);
  const maxFeatures = Math.max(...completedRuns.map((r) => r.metrics!.features), 1);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <BarChart2 className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Model Benchmark</h1>
        </div>
        <p className="text-muted-foreground">
          Compare all agent models on the same CNC part. Upload files once, then run all models sequentially.
        </p>
      </div>

      {/* ── Step 1: Upload ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">1</span>
            Upload Part Files
          </CardTitle>
          <CardDescription>
            Files are uploaded once and reused for all model runs — no re-upload needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {analysisId ? (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-emerald-800">Files uploaded</div>
                <div className="text-xs text-emerald-700 truncate font-mono">{analysisId}</div>
              </div>
              {!benchmarkRunning && (
                <Button variant="outline" size="sm" onClick={handleReset}>
                  Reset
                </Button>
              )}
            </div>
          ) : (
            <>
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
                  description="PDF, PNG, JPG, or TIFF — required"
                  accept={{ "application/pdf": [".pdf"], "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/tiff": [".tiff"] }}
                  file={file2d}
                  onFileSelect={setFile2d}
                  icon="2d"
                  required
                />
              </div>
              {uploadError && (
                <div className="rounded-lg bg-destructive/10 text-destructive text-sm px-4 py-3">{uploadError}</div>
              )}
              <Button
                onClick={handleUpload}
                disabled={uploading || !file3d || !file2d}
                className="w-full"
              >
                {uploading ? <><Loader2 className="w-4 h-4 animate-spin" />Uploading...</> : "Upload Files"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Select models ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">2</span>
            Select Models to Benchmark
          </CardTitle>
          <CardDescription>
            Each selected model will run the full 6-step pipeline sequentially.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {AGENT_MODELS.map((m) => {
              const checked = selectedModels.has(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggleModel(m.id)}
                  disabled={benchmarkRunning}
                  className={`text-left rounded-xl border p-3.5 transition-all ${
                    checked
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border bg-muted/30 hover:bg-muted/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">{m.name}</div>
                      <div className="text-[11px] text-muted-foreground">{m.params}</div>
                    </div>
                    <div className={`w-4 h-4 rounded border-2 shrink-0 mt-0.5 flex items-center justify-center ${
                      checked ? "border-primary bg-primary" : "border-muted-foreground/40"
                    }`}>
                      {checked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground line-clamp-2">{m.description}</p>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex gap-3">
            <Button
              onClick={handleRunBenchmark}
              disabled={benchmarkRunning || !analysisId || selectedModels.size === 0}
              className="flex-1"
            >
              {benchmarkRunning ? (
                <><Loader2 className="w-4 h-4 animate-spin" />Running Benchmark...</>
              ) : (
                <><Play className="w-4 h-4" />Run Benchmark ({selectedModels.size} model{selectedModels.size !== 1 ? "s" : ""})</>
              )}
            </Button>
            {benchmarkRunning && (
              <Button variant="destructive" onClick={handleStop}>
                Stop
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Step 3: Live run status ── */}
      {runs.size > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold">Run Status</h2>
            {benchmarkRunning && <Badge variant="info" className="text-[10px]">Live</Badge>}
            {benchmarkDone && <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-300">Complete</Badge>}
          </div>

          <div className="space-y-2">
            {AGENT_MODELS.filter((m) => runs.has(m.id)).map((m) => {
              const run = runs.get(m.id)!;
              const isExpanded = expandedLogs.has(m.id);
              return (
                <Card key={m.id} className="py-0 overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3">
                    {run.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />}
                    {run.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                    {run.status === "error" && <XCircle className="w-4 h-4 text-destructive shrink-0" />}
                    {run.status === "idle" && <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30 shrink-0" />}

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{run.currentStep}</div>
                    </div>

                    {run.metrics && (
                      <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{run.metrics.elapsed_seconds}s</span>
                        <span className="flex items-center gap-1"><Layers className="w-3 h-3" />{run.metrics.features} feat</span>
                        <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" />${run.metrics.total_usd.toFixed(2)}</span>
                      </div>
                    )}

                    {run.log.length > 0 && (
                      <button
                        onClick={() => toggleLog(m.id)}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    )}
                  </div>

                  {isExpanded && run.log.length > 0 && (
                    <div className="border-t bg-muted/30 px-4 py-3">
                      <div className="font-mono text-[10px] text-muted-foreground space-y-0.5 max-h-40 overflow-y-auto">
                        {run.log.map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Step 4: Results comparison table ── */}
      {runs.size > 0 && [...runs.values()].some((r) => r.metrics) && (
        <>
          <Separator />
          <div className="space-y-4">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-primary" />
              Results Comparison
            </h2>

            {/* Table */}
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-muted-foreground text-xs">
                      <th className="text-left px-4 py-3 font-medium">Model</th>
                      <th className="text-right px-4 py-3 font-medium">Status</th>
                      <th className="text-right px-4 py-3 font-medium flex items-center justify-end gap-1"><Clock className="w-3 h-3" />Time (s)</th>
                      <th className="text-right px-4 py-3 font-medium">Features</th>
                      <th className="text-right px-4 py-3 font-medium">GD&T</th>
                      <th className="text-right px-4 py-3 font-medium"><Timer className="w-3 h-3 inline mr-1" />Cycle (min)</th>
                      <th className="text-right px-4 py-3 font-medium"><DollarSign className="w-3 h-3 inline" />Cost (USD)</th>
                      <th className="text-right px-4 py-3 font-medium"><Wrench className="w-3 h-3 inline mr-1" />Tools</th>
                      <th className="text-right px-4 py-3 font-medium">Iterations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {AGENT_MODELS.filter((m) => runs.has(m.id) && runs.get(m.id)!.metrics).map((m, i) => {
                      const run = runs.get(m.id)!;
                      const metrics = run.metrics!;
                      return (
                        <tr key={m.id} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                          <td className="px-4 py-3">
                            <div className="font-medium">{m.name}</div>
                            <div className="text-[10px] text-muted-foreground">{m.params}</div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {metrics.completed
                              ? <Badge variant="outline" className="text-emerald-600 border-emerald-300 text-[10px]">Passed</Badge>
                              : <Badge variant="destructive" className="text-[10px]">Failed</Badge>
                            }
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{metrics.elapsed_seconds.toFixed(1)}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{metrics.features}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{metrics.gdt}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{metrics.total_minutes.toFixed(1)}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs">${metrics.total_usd.toFixed(2)}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{metrics.tools_completed}</td>
                          <td className="px-4 py-3 text-right font-mono text-xs">{metrics.iterations}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Bar charts */}
            {completedRuns.length > 1 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Time chart */}
                <Card className="py-4">
                  <CardHeader className="px-4 pt-0 pb-3">
                    <CardTitle className="text-sm flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />Response Time</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 space-y-3">
                    {completedRuns.sort((a, b) => a.metrics!.elapsed_seconds - b.metrics!.elapsed_seconds).map((r) => {
                      const model = AGENT_MODELS.find((m) => m.id === r.modelId);
                      return (
                        <div key={r.modelId} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="font-medium truncate max-w-[120px]">{model?.name}</span>
                            <span className="text-muted-foreground">{r.metrics!.elapsed_seconds.toFixed(1)}s</span>
                          </div>
                          <Bar value={r.metrics!.elapsed_seconds} max={maxTime} color="bg-blue-400" />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {/* Cost chart */}
                <Card className="py-4">
                  <CardHeader className="px-4 pt-0 pb-3">
                    <CardTitle className="text-sm flex items-center gap-1.5"><DollarSign className="w-3.5 h-3.5" />Estimated Cost</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 space-y-3">
                    {completedRuns.sort((a, b) => a.metrics!.total_usd - b.metrics!.total_usd).map((r) => {
                      const model = AGENT_MODELS.find((m) => m.id === r.modelId);
                      return (
                        <div key={r.modelId} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="font-medium truncate max-w-[120px]">{model?.name}</span>
                            <span className="text-muted-foreground">${r.metrics!.total_usd.toFixed(2)}</span>
                          </div>
                          <Bar value={r.metrics!.total_usd} max={maxCost} color="bg-emerald-400" />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {/* Features chart */}
                <Card className="py-4">
                  <CardHeader className="px-4 pt-0 pb-3">
                    <CardTitle className="text-sm flex items-center gap-1.5"><Layers className="w-3.5 h-3.5" />Features Detected</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 space-y-3">
                    {completedRuns.sort((a, b) => b.metrics!.features - a.metrics!.features).map((r) => {
                      const model = AGENT_MODELS.find((m) => m.id === r.modelId);
                      return (
                        <div key={r.modelId} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="font-medium truncate max-w-[120px]">{model?.name}</span>
                            <span className="text-muted-foreground">{r.metrics!.features}</span>
                          </div>
                          <Bar value={r.metrics!.features} max={maxFeatures} color="bg-violet-400" />
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
