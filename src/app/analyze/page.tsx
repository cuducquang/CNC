"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileUpload } from "@/components/ui/FileUpload";
import { ThinkingBlock } from "@/components/ui/ThinkingBlock";
import { StepCard } from "@/components/ui/StepCard";
import { AgentStream } from "@/components/agent/agent-stream";
import { FeatureTable } from "@/components/results/feature-table";
import { ProcessTable } from "@/components/results/process-table";
import { CostBreakdownCard } from "@/components/results/cost-breakdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApproach2 } from "@/lib/hooks/useApproach2";
import { useApproach1, STEPS } from "@/lib/hooks/useApproach1";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  X,
  Plus,
  Bot,
  Eye,
  Layers,
  Wrench,
  Timer,
  DollarSign,
  ShieldCheck,
  Brain,
  Cpu,
} from "lucide-react";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Pipeline step metadata (Approach 2 progress bar)
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = [
  { icon: Eye,         label: "GD&T",        tool: "analyze_drawing"    },
  { icon: Layers,      label: "3D Analysis",  tool: "analyze_step_file"  },
  { icon: ShieldCheck, label: "Features",     tool: "recognize_features" },
  { icon: Wrench,      label: "Processes",    tool: "map_cnc_processes"  },
  { icon: Timer,       label: "Cycle Time",   tool: "estimate_cycle_time"},
  { icon: DollarSign,  label: "Cost",         tool: "estimate_cost"      },
];

// ---------------------------------------------------------------------------
// Approach 1 step summary chips builder
// ---------------------------------------------------------------------------

function buildChips(stepKey: string, result: any) {
  if (!result) return [];
  const chips: string[] = [];
  switch (stepKey) {
    case "gdt":
      if (result.feature_count != null) chips.push(`${result.feature_count} dims`);
      if (result.gdt_count      != null) chips.push(`${result.gdt_count} GD&T`);
      if (result.threads?.length)        chips.push(`${result.threads.length} threads`);
      if (result.material)               chips.push(String(result.material));
      break;
    case "step3d":
      if (result.features_3d?.length)      chips.push(`${result.features_3d.length} 3D features`);
      if (result.shape_summary?.bbox_x_mm) chips.push(`${result.shape_summary.bbox_x_mm}×${result.shape_summary.bbox_y_mm}×${result.shape_summary.bbox_z_mm} mm`);
      break;
    case "features":
      if (result.feature_count != null) chips.push(`${result.feature_count} features`);
      if (result.material?.spec)        chips.push(result.material.spec);
      break;
    case "processes":
      if (result.operation_count != null) chips.push(`${result.operation_count} ops`);
      if (result.setup_count     != null) chips.push(`${result.setup_count} setup(s)`);
      break;
    case "cycletime":
      if (result.total_minutes != null) chips.push(`${Number(result.total_minutes).toFixed(1)} min`);
      if (result.setup_minutes != null) chips.push(`${Number(result.setup_minutes).toFixed(1)} min setup`);
      break;
    case "cost":
      if (result.total_usd     != null) chips.push(`$${Number(result.total_usd).toFixed(2)}`);
      if (result.machining_cost!= null) chips.push(`machining $${Number(result.machining_cost).toFixed(2)}`);
      break;
  }
  return chips.map((label) => ({ label }));
}

// ---------------------------------------------------------------------------
// Summary metric cards (shared between both approaches)
// ---------------------------------------------------------------------------

function SummaryCards({
  totalMinutes,
  totalUsd,
}: {
  totalMinutes?: number;
  totalUsd?: number;
}) {
  if (!totalMinutes && !totalUsd) return null;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Card className="py-5 border-cyan-200/80 bg-gradient-to-br from-cyan-50 to-sky-50 shadow-[0_1px_3px_0_rgb(0,0,0,0.05)]">
        <CardContent className="px-4 text-center">
          <Timer className="w-4 h-4 mx-auto text-cyan-500 mb-2" />
          <div className="text-2xl font-bold font-mono text-cyan-600">
            {totalMinutes?.toFixed(1) ?? "—"}
          </div>
          <div className="text-[10px] text-cyan-500/70 font-mono font-semibold uppercase tracking-wide mt-0.5">
            min
          </div>
        </CardContent>
      </Card>
      <Card className="py-5 border-emerald-200/80 bg-gradient-to-br from-emerald-50 to-green-50 shadow-[0_1px_3px_0_rgb(0,0,0,0.05)]">
        <CardContent className="px-4 text-center">
          <DollarSign className="w-4 h-4 mx-auto text-emerald-500 mb-2" />
          <div className="text-2xl font-bold font-mono text-emerald-600">
            ${totalUsd?.toFixed(2) ?? "—"}
          </div>
          <div className="text-[10px] text-emerald-500/70 font-mono font-semibold uppercase tracking-wide mt-0.5">
            USD
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload view (shared)
// ---------------------------------------------------------------------------

function UploadView({
  approach,
  file3d,
  file2d,
  loading,
  error,
  onFile3dChange,
  onFile2dChange,
  onAnalyze,
  onBack,
}: {
  approach: 1 | 2;
  file3d: File | null;
  file2d: File | null;
  loading: boolean;
  error: string | null;
  onFile3dChange: (f: File | null) => void;
  onFile2dChange: (f: File | null) => void;
  onAnalyze: () => void;
  onBack: () => void;
}) {
  const isApproach1 = approach === 1;

  return (
    <div className="space-y-8 py-2 max-w-2xl mx-auto">
      {/* Back + badge */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="gap-1.5 -ml-1 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
        <div className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 border text-[11px] font-semibold uppercase tracking-wider ${
          isApproach1
            ? "bg-violet-50 border-violet-200/60 text-violet-700"
            : "bg-emerald-50 border-emerald-200/60 text-emerald-700"
        }`}>
          {isApproach1 ? <Brain className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
          {isApproach1 ? "Approach 1 — LLM Steps" : "Approach 2 — FreeCAD"}
        </div>
      </div>

      {/* Heading */}
      <div className="text-center space-y-2">
        <h1 className="text-[28px] font-bold tracking-tight leading-tight">
          {isApproach1 ? "LLM Pipeline Analysis" : "FreeCAD + AI Analysis"}
        </h1>
        <p className="text-[13.5px] text-muted-foreground max-w-md mx-auto leading-relaxed">
          {isApproach1
            ? "Each pipeline step runs as a separate LLM call to server_llm.py. No single long-running connection — no CDN timeout."
            : "FreeCAD parses 3D geometry deterministically. The AI agent orchestrates all 6 steps in a single streaming session."}
        </p>
      </div>

      {/* Upload card */}
      <Card className="shadow-[0_2px_12px_0_rgb(0,0,0,0.06)] border-border/80">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Upload Files</CardTitle>
          <CardDescription className="text-[13px]">
            Both files are required. The STEP file provides 3D geometry; the drawing provides GD&amp;T, tolerances, and material specification.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FileUpload
            file3d={file3d}
            file2d={file2d}
            onFile3dChange={onFile3dChange}
            onFile2dChange={onFile2dChange}
          />

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl p-3.5 text-[13px] leading-snug">
              {error}
            </div>
          )}

          <Button
            onClick={onAnalyze}
            disabled={loading || !file2d || !file3d}
            className="w-full h-12 text-[14px] font-semibold rounded-xl shadow-[0_1px_3px_0_rgb(0,0,0,0.12)] hover:shadow-[0_3px_8px_0_rgb(0,0,0,0.15)] transition-shadow"
            size="lg"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Bot className="w-4 h-4" />
                Start Analysis
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approach 2 stream view
// ---------------------------------------------------------------------------

function Approach2StreamView({
  hook,
  file3d,
  file2d,
  analysisId,
}: {
  hook: ReturnType<typeof useApproach2>;
  file3d: File | null;
  file2d: File | null;
  analysisId: string | null;
}) {
  const router = useRouter();
  const { status, messages, liveThinking, completedTools, activeTool, results, cancel, reset } = hook;
  const isStreaming = status === "streaming";
  const isDone      = status === "done";
  const hasError    = status === "error";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            {isDone
              ? "Analysis Complete"
              : hasError && !isStreaming
              ? "Analysis Failed"
              : "Running Analysis"}
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5 font-mono truncate max-w-sm">
            {[file3d?.name, file2d?.name].filter(Boolean).join(" + ") || "Processing…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isStreaming && (
            <Button variant="destructive" size="sm" className="rounded-lg" onClick={cancel}>
              <X className="w-3.5 h-3.5" />
              Stop
            </Button>
          )}
          {isDone && analysisId && (
            <Button size="sm" className="rounded-lg" onClick={() => router.push(`/analysis/${analysisId}`)}>
              View Details
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          )}
          {(isDone || (hasError && !isStreaming)) && (
            <Button variant="outline" size="sm" className="rounded-lg" onClick={reset}>
              <Plus className="w-3.5 h-3.5" />
              New Analysis
            </Button>
          )}
        </div>
      </div>

      {/* Pipeline step pill bar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {PIPELINE_STEPS.map((step, i) => {
          const isDoneStep  = completedTools.has(step.tool);
          const isActiveTool = activeTool === step.tool;
          return (
            <div key={step.label} className="flex items-center gap-1.5">
              <div className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 border text-[11px] font-semibold transition-all ${
                isDoneStep
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                  : isActiveTool
                  ? "bg-primary/8 border-primary/25 text-primary animate-pulse"
                  : "bg-card border-border text-muted-foreground/50"
              }`}>
                <step.icon className="w-3 h-3" />
                <span>{step.label}</span>
              </div>
              {i < PIPELINE_STEPS.length - 1 && (
                <ArrowRight className="w-2.5 h-2.5 text-muted-foreground/20" />
              )}
            </div>
          );
        })}
      </div>

      <Separator />

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Agent stream */}
        <div className="lg:col-span-3">
          <Card className="py-0 overflow-hidden border-border rounded-xl shadow-[0_2px_8px_0_rgb(0,0,0,0.05)]">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-muted/15">
              <div className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/12">
                <Bot className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="text-[13px] font-semibold flex-1">Pipeline Activity</span>
              {isStreaming && (
                <Badge variant="info" className="text-[10px] rounded-full px-2.5">Live</Badge>
              )}
            </div>
            <div className="h-[520px]">
              <AgentStream
                messages={messages}
                liveThinking={liveThinking}
                isStreaming={isStreaming}
              />
            </div>
          </Card>
        </div>

        {/* Results panel */}
        <div className="lg:col-span-2 space-y-4">
          <SummaryCards
            totalMinutes={results?.total_minutes as number}
            totalUsd={results?.total_usd as number}
          />

          {results?.cycle_time && (
            <CostBreakdownCard
              title="Cycle Time"
              items={(results.cycle_time as any).breakdown || []}
              total={String((results.cycle_time as any).total_minutes?.toFixed(1))}
              unit="min"
            />
          )}

          {results?.cost && (
            <CostBreakdownCard
              title="Cost Breakdown"
              items={(results.cost as any).breakdown || []}
              total={String((results.cost as any).total_usd?.toFixed(2))}
              unit="USD"
            />
          )}

          {!results && !isStreaming && (isDone || hasError) && (
            <Card className="py-10 shadow-[0_1px_3px_0_rgb(0,0,0,0.04)]">
              <CardContent className="text-center text-[13px] text-muted-foreground">
                {hasError ? "Analysis encountered an error. Check the activity log." : "No results available."}
              </CardContent>
            </Card>
          )}

          {!results && isStreaming && (
            <Card className="py-10 shadow-[0_1px_3px_0_rgb(0,0,0,0.04)]">
              <CardContent className="text-center">
                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-3 text-primary/60" />
                <div className="text-[13px] text-muted-foreground">Waiting for results…</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Full results tabs */}
      {isDone && results && (
        <>
          <Separator />
          <Tabs defaultValue="features">
            <TabsList>
              <TabsTrigger value="features">
                Features ({(results.features as any[])?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="processes">
                Processes ({(results.processes as any)?.operations?.length || 0})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="features">
              <Card>
                <CardContent className="pt-4">
                  <FeatureTable features={(results.features as any[]) || []} />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="processes">
              <Card>
                <CardContent className="pt-4">
                  <ProcessTable processes={(results.processes as any)?.operations || []} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approach 1 stream view
// ---------------------------------------------------------------------------

function Approach1StreamView({
  hook,
  file3d,
  file2d,
}: {
  hook: ReturnType<typeof useApproach1>;
  file3d: File | null;
  file2d: File | null;
}) {
  const { steps, expanded, toggleExpand, cancel, reset, isDone, isRunning, hasError, costResult, ctResult } = hook;

  return (
    <div className="space-y-5 max-w-2xl mx-auto py-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            {isDone ? "Analysis Complete" : hasError ? "Analysis Failed" : "Running…"}
          </h2>
          <p className="text-[12px] text-muted-foreground font-mono mt-0.5 truncate">
            {[file3d?.name, file2d?.name].filter(Boolean).join(" + ")}
          </p>
        </div>
        <div className="flex gap-2">
          {isRunning && (
            <Button variant="destructive" size="sm" className="rounded-lg" onClick={cancel}>
              <X className="w-3.5 h-3.5" />
              Stop
            </Button>
          )}
          {(isDone || hasError) && (
            <Button variant="outline" size="sm" className="rounded-lg" onClick={reset}>
              <Plus className="w-3.5 h-3.5" />
              New Analysis
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      {isDone && ctResult && costResult && (
        <SummaryCards
          totalMinutes={Number(ctResult.total_minutes)}
          totalUsd={Number(costResult.total_usd)}
        />
      )}

      {/* Global error */}
      {hasError && hook.globalError && (
        <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl p-3.5 text-[13px]">
          {hook.globalError}
        </div>
      )}

      <Separator />

      {/* Step cards */}
      <div className="space-y-2">
        {STEPS.map((step) => {
          const s = steps[step.key];
          const isOpen = expanded.has(step.key);
          const hasThinking = s.thinking.length > 0;
          const hasResult   = s.result !== null;
          const hasDetails  = hasThinking || hasResult || !!s.error;

          return (
            <StepCard
              key={step.key}
              stepKey={step.key}
              label={step.label}
              desc={step.desc}
              status={s.status}
              chips={buildChips(step.key, s.result)}
              error={s.error}
              elapsedMs={s.elapsedMs}
              isExpanded={isOpen && hasDetails}
              onToggle={() => hasDetails && toggleExpand(step.key)}
            >
              {hasDetails ? (
                <div className="space-y-3">
                  {/* Always show thinking block when step is done */}
                  {s.status === "done" && (
                    hasThinking ? (
                      <ThinkingBlock
                        thinking={s.thinking}
                        status="done"
                        label="Model Thinking"
                        collapseWhenDone={true}
                      />
                    ) : (
                      <div>
                        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                          Model Thinking
                        </div>
                        <p className="text-[10.5px] text-muted-foreground/40 italic px-3 py-2 bg-background rounded-lg border border-border/50">
                          No reasoning output — model returned structured JSON directly.
                        </p>
                      </div>
                    )
                  )}
                  {s.status === "running" && hasThinking && (
                    <ThinkingBlock
                      thinking={s.thinking}
                      status="streaming"
                      label="Model Thinking"
                      collapseWhenDone={false}
                    />
                  )}
                  {hasResult && (
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
              ) : null}
            </StepCard>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page — reads ?approach= query param, delegates to the right hook + view
// ---------------------------------------------------------------------------

function AnalyzePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const approachParam = searchParams.get("approach");
  const approach = approachParam === "1" ? 1 : 2;

  const [file3d, setFile3d] = useState<File | null>(null);
  const [file2d, setFile2d] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const hook2 = useApproach2();
  const hook1 = useApproach1();

  const isActive = approach === 1
    ? hook1.pipelineStatus !== "idle"
    : hook2.status !== "idle";

  const handleAnalyze = () => {
    if (!file3d && !file2d) {
      setLocalError("Both a 3D STEP/STP file and a 2D engineering drawing are required.");
      return;
    }
    if (!file3d) {
      setLocalError("A 3D STEP or STP file is required.");
      return;
    }
    if (!file2d) {
      setLocalError("A 2D engineering drawing (PDF, PNG, JPG, or TIFF) is required.");
      return;
    }
    setLocalError(null);
    if (approach === 1) {
      hook1.run(file3d, file2d);
    } else {
      hook2.run(file3d, file2d);
    }
  };

  // Reset handler — clears both hooks + files + navigates back to upload
  const handleReset = () => {
    hook1.reset();
    hook2.reset();
    setFile3d(null);
    setFile2d(null);
    setLocalError(null);
  };

  const handleBack = () => {
    handleReset();
    router.push("/");
  };

  const loading = approach === 1
    ? false
    : hook2.status === "uploading";

  const error = approach === 1
    ? null
    : (hook2.error || localError);

  if (!isActive) {
    return (
      <UploadView
        approach={approach}
        file3d={file3d}
        file2d={file2d}
        loading={loading}
        error={error || localError}
        onFile3dChange={setFile3d}
        onFile2dChange={setFile2d}
        onAnalyze={handleAnalyze}
        onBack={handleBack}
      />
    );
  }

  if (approach === 1) {
    return (
      <Approach1StreamView
        hook={hook1}
        file3d={file3d}
        file2d={file2d}
      />
    );
  }

  return (
    <Approach2StreamView
      hook={hook2}
      file3d={file3d}
      file2d={file2d}
      analysisId={hook2.analysisId}
    />
  );
}

export default function AnalyzePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary/50" />
      </div>
    }>
      <AnalyzePageInner />
    </Suspense>
  );
}
