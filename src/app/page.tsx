"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { FileDropzone } from "@/components/upload/file-dropzone";
import { AgentStream, type AgentStreamMessage } from "@/components/agent/agent-stream";
import { FeatureTable } from "@/components/results/feature-table";
import { ProcessTable } from "@/components/results/process-table";
import { CostBreakdownCard } from "@/components/results/cost-breakdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
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
  Sparkles,
} from "lucide-react";

// ---------------------------------------------------------------------------
// SSE parser
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
// Pipeline step definitions
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = [
  { icon: Eye,         label: "GD&T Extraction",    tool: "analyze_drawing"    },
  { icon: Layers,      label: "3D Analysis",         tool: "analyze_step_file"  },
  { icon: ShieldCheck, label: "Feature Recognition", tool: "recognize_features" },
  { icon: Wrench,      label: "Process Mapping",     tool: "map_cnc_processes"  },
  { icon: Timer,       label: "Cycle Time",          tool: "estimate_cycle_time"},
  { icon: DollarSign,  label: "Cost Estimation",     tool: "estimate_cost"      },
];

const TOOL_TO_STATUS_TITLE: Record<string, string> = {
  analyze_drawing: "GD&T Extraction",
  analyze_step_file: "3D Analysis",
  recognize_features: "Feature Recognition",
  map_cnc_processes: "Process Mapping",
  estimate_cycle_time: "Cycle Time",
  estimate_cost: "Cost Estimation",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function HomePage() {
  const router = useRouter();
  const [file3d, setFile3d] = useState<File | null>(null);
  const [file2d, setFile2d] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentStreamMessage[]>([]);
  const [liveThinking, setLiveThinking] = useState("");
  const [pipelineDone, setPipelineDone] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [completedTools, setCompletedTools] = useState<Set<string>>(new Set());
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Final results
  const [results, setResults] = useState<Record<string, any> | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const addMsg = (type: string, data: Record<string, unknown>) => {
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(),
      type,
      data,
      timestamp: Date.now(),
    }]);
  };

  const handleAnalyze = async () => {
    if (!file3d && !file2d) {
      setError("Both a 3D STEP/STP file and a 2D engineering drawing are required.");
      return;
    }
    if (!file3d) {
      setError("A 3D STEP or STP file is required. The pipeline uses the CAD model for precise feature geometry.");
      return;
    }
    if (!file2d) {
      setError("A 2D engineering drawing (PDF, PNG, JPG, or TIFF) is required for GD&T and tolerance extraction.");
      return;
    }

    setLoading(true);
    setError(null);
    setMessages([]);
    setLiveThinking("");
    setPipelineDone(false);
    setHasError(false);
    setCompletedTools(new Set());
    setActiveTool(null);
    setResults(null);

    try {
      // Upload files
      const formData = new FormData();
      if (file3d) formData.append("file_3d", file3d);
      if (file2d) formData.append("file_2d", file2d);

      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const d = await uploadRes.json();
        throw new Error(d.error || "Upload failed");
      }

      const uploadResult = await uploadRes.json();
      setAnalysisId(uploadResult.analysis_id);

      // Start agent SSE stream
      setLoading(false);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let localThinking = "";

      const resp = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysis_id: uploadResult.analysis_id }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) throw new Error(`Server error: ${resp.status}`);

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
              case "agent_start":
              case "agent_message":
                addMsg(event, parsed);
                break;

              case "status":
                // Mark all previous pending status rows as completed before
                // adding a new one — "Agent Iteration X" rows have no other
                // mechanism to get their completed flag set.
                setMessages((prev) => {
                  const updated = prev.map((m) => {
                    if (
                      m.type === "status" &&
                      !(m.data as Record<string, unknown>).completed &&
                      !(m.data as Record<string, unknown>).failed
                    ) {
                      return { ...m, data: { ...m.data, completed: true } };
                    }
                    return m;
                  });
                  return [...updated, {
                    id: crypto.randomUUID(),
                    type: "status",
                    data: parsed,
                    timestamp: Date.now(),
                  }];
                });
                break;

              case "thinking":
                localThinking += parsed.content || "";
                setLiveThinking(localThinking);
                break;

              case "tool_call":
                // Freeze thinking
                if (localThinking) {
                  addMsg("thinking", { content: localThinking, iteration: parsed.iteration });
                  setLiveThinking("");
                  localThinking = "";
                }
                setActiveTool(parsed.tool);
                addMsg("tool_call", parsed);
                break;

              case "tool_result":
                // Freeze VLM thinking panel once the drawing analysis finishes
                if (parsed.tool === "analyze_drawing" && localThinking) {
                  addMsg("thinking", { content: localThinking, iteration: 1 });
                  setLiveThinking("");
                  localThinking = "";
                }
                setActiveTool(null);
                setCompletedTools((prev) => new Set(prev).add(parsed.tool));
                setMessages((prev) => {
                  const tool = parsed.tool as string;
                  const hasError = !!(parsed.result as Record<string, unknown>)?.error;
                  const statusTitle = TOOL_TO_STATUS_TITLE[tool];
                  let replacedCall = false;

                  const next = prev.map((m) => {
                    // Finalize ALL pending status rows for this tool title.
                    if (
                      statusTitle &&
                      m.type === "status" &&
                      (m.data as Record<string, unknown>).title === statusTitle &&
                      !(m.data as Record<string, unknown>).completed &&
                      !(m.data as Record<string, unknown>).failed
                    ) {
                      return {
                        ...m,
                        data: { ...m.data, completed: !hasError, failed: hasError },
                      };
                    }

                    // Finalize ALL pending tool_call rows for this tool.
                    if (m.type === "tool_call" && (m.data as Record<string, unknown>).tool === tool) {
                      replacedCall = true;
                      return { ...m, type: "tool_result", data: { ...m.data, ...parsed } };
                    }
                    return m;
                  });

                  if (!replacedCall) {
                    next.push({
                      id: crypto.randomUUID(),
                      type: "tool_result",
                      data: parsed,
                      timestamp: Date.now(),
                    });
                  }

                  return next;
                });
                break;

              case "final_answer":
                if (localThinking) {
                  addMsg("thinking", { content: localThinking });
                  setLiveThinking("");
                  localThinking = "";
                }
                setResults(parsed.results || null);
                addMsg("final_answer", parsed);
                break;

              case "done":
                addMsg("done", parsed);
                setPipelineDone(true);
                break;

              case "error":
                if (localThinking) {
                  addMsg("thinking", { content: localThinking });
                  setLiveThinking("");
                  localThinking = "";
                }
                setHasError(true);
                addMsg("error", parsed);
                break;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setError(msg);
        setHasError(true);
        addMsg("error", { message: msg });
      }
    } finally {
      setLoading(false);
      setIsStreaming(false);
      setActiveTool(null);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    addMsg("error", { message: "Processing cancelled." });
    setLiveThinking("");
    setIsStreaming(false);
  };

  const handleReset = () => {
    setMessages([]);
    setAnalysisId(null);
    setPipelineDone(false);
    setHasError(false);
    setCompletedTools(new Set());
    setActiveTool(null);
    setResults(null);
    setFile3d(null);
    setFile2d(null);
    setError(null);
  };

  const showStream = isStreaming || messages.length > 0;

  // ---------------------------------------------------------------------------
  // Upload View
  // ---------------------------------------------------------------------------

  if (!showStream) {
    return (
      <div className="space-y-8 py-2">
        {/* Hero */}
        <div className="text-center space-y-4 pt-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 border border-primary/20 px-4 py-1.5 text-[11.5px]">
            <Sparkles className="w-3 h-3 text-primary" />
            <span className="font-semibold text-primary/90 tracking-wide uppercase">AI Pipeline</span>
          </div>
          <div className="space-y-3">
            <h1 className="text-4xl font-bold tracking-tight text-foreground leading-tight">
              CNC Part Costing<br className="hidden sm:block" /> Automation
            </h1>
            <p className="text-[14.5px] text-muted-foreground max-w-lg mx-auto leading-relaxed">
              Upload your engineering drawings and CAD files. The AI extracts features,
              maps CNC operations, and delivers a precise fabrication cost estimate.
            </p>
          </div>
        </div>

        {/* Pipeline stepper */}
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          {PIPELINE_STEPS.map((step, i) => (
            <div key={step.label} className="flex items-center gap-1.5">
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 shadow-[0_1px_2px_0_rgb(0,0,0,0.04)]">
                <step.icon className="w-3 h-3 text-muted-foreground/40" />
                <span className="text-[11px] font-semibold text-muted-foreground/60 tracking-wide">{step.label}</span>
              </div>
              {i < PIPELINE_STEPS.length - 1 && (
                <ArrowRight className="w-2.5 h-2.5 text-muted-foreground/20" />
              )}
            </div>
          ))}
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

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl p-3.5 text-[13px] leading-snug">
                {error}
              </div>
            )}

            <Button
              onClick={handleAnalyze}
              disabled={loading || !file2d || !file3d}
              className="w-full h-12 text-[14px] font-semibold rounded-xl shadow-[0_1px_3px_0_rgb(0,0,0,0.12)] hover:shadow-[0_3px_8px_0_rgb(0,0,0,0.15)] transition-shadow"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Uploading...
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

        {/* Feature highlights */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            {
              icon: Eye,
              title: "AI Vision",
              desc: "Qwen3-VL-32B reads engineering drawings and extracts all dimensions, GD&T callouts, and tolerances.",
            },
            {
              icon: Layers,
              title: "3D + 2D Fusion",
              desc: "FreeCAD parses the STEP file and merges 3D geometry with 2D drawing data for complete feature recognition.",
            },
            {
              icon: DollarSign,
              title: "Live Cost Stream",
              desc: "Watch the 6-step pipeline run in real time. Cycle time and cost estimate delivered automatically.",
            },
          ].map((f) => (
            <Card key={f.title} className="py-5 shadow-[0_1px_3px_0_rgb(0,0,0,0.05)]">
              <CardContent className="px-5 flex items-start gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0 mt-0.5">
                  <f.icon className="w-3.5 h-3.5 text-primary" />
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-foreground/90 mb-1">{f.title}</div>
                  <div className="text-[11.5px] text-muted-foreground leading-relaxed">{f.desc}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Agent Stream + Results View
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">
            {pipelineDone
              ? "Analysis Complete"
              : hasError && !isStreaming
                ? "Analysis Failed"
                : "Running Analysis"}
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5 font-mono truncate max-w-sm">
            {[file3d?.name, file2d?.name].filter(Boolean).join(" + ") || "Processing..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isStreaming && (
            <Button variant="destructive" size="sm" className="rounded-lg" onClick={handleCancel}>
              <X className="w-3.5 h-3.5" />
              Stop
            </Button>
          )}
          {pipelineDone && analysisId && (
            <Button size="sm" className="rounded-lg" onClick={() => router.push(`/analysis/${analysisId}`)}>
              View Details
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          )}
          {(pipelineDone || (hasError && !isStreaming)) && (
            <Button variant="outline" size="sm" className="rounded-lg" onClick={handleReset}>
              <Plus className="w-3.5 h-3.5" />
              New Analysis
            </Button>
          )}
        </div>
      </div>

      {/* Pipeline progress */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {PIPELINE_STEPS.map((step, i) => {
          const isDone   = completedTools.has(step.tool);
          const isActive = activeTool === step.tool;
          return (
            <div key={step.label} className="flex items-center gap-1.5">
              <div className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 border text-[11px] font-semibold transition-all ${
                isDone
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                  : isActive
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

      {/* Two-column layout: Agent Stream + Results */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Agent stream (left - wider) */}
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

        {/* Results panel (right - narrower) */}
        <div className="lg:col-span-2 space-y-4">
          {/* Summary metric cards */}
          {results && (
            <div className="grid grid-cols-2 gap-3">
              <Card className="py-5 border-cyan-200 bg-gradient-to-br from-cyan-50 to-sky-50 shadow-[0_1px_3px_0_rgb(0,0,0,0.05)]">
                <CardContent className="px-4 text-center">
                  <Timer className="w-4 h-4 mx-auto text-cyan-500 mb-2" />
                  <div className="text-2xl font-bold font-mono text-cyan-600">
                    {(results.total_minutes as number)?.toFixed(1)}
                  </div>
                  <div className="text-[10px] text-cyan-500/70 font-mono font-semibold uppercase tracking-wide mt-0.5">min</div>
                </CardContent>
              </Card>
              <Card className="py-5 border-emerald-200 bg-gradient-to-br from-emerald-50 to-green-50 shadow-[0_1px_3px_0_rgb(0,0,0,0.05)]">
                <CardContent className="px-4 text-center">
                  <DollarSign className="w-4 h-4 mx-auto text-emerald-500 mb-2" />
                  <div className="text-2xl font-bold font-mono text-emerald-600">
                    ${(results.total_usd as number)?.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-emerald-500/70 font-mono font-semibold uppercase tracking-wide mt-0.5">USD</div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Breakdowns */}
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

          {!results && !isStreaming && (pipelineDone || hasError) && (
            <Card className="py-10 shadow-[0_1px_3px_0_rgb(0,0,0,0.04)]">
              <CardContent className="text-center text-[13px] text-muted-foreground">
                {hasError
                  ? "Analysis encountered an error. Check the activity log."
                  : "No results available."}
              </CardContent>
            </Card>
          )}

          {!results && isStreaming && (
            <Card className="py-10 shadow-[0_1px_3px_0_rgb(0,0,0,0.04)]">
              <CardContent className="text-center">
                <Loader2 className="w-5 h-5 animate-spin mx-auto mb-3 text-primary/60" />
                <div className="text-[13px] text-muted-foreground">Waiting for results...</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Full results tabs (show after completion) */}
      {pipelineDone && results && (
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
