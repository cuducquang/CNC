"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureTable } from "@/components/results/feature-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ArrowLeft,
  AlertCircle,
  Bot,
  CheckCircle2,
  Wrench,
  Clock,
  Loader2,
  Timer,
  DollarSign,
  Layers,
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUS_BADGE: Record<string, { variant: "success" | "destructive" | "warning" | "secondary"; label: string }> = {
  completed: { variant: "success",     label: "Completed" },
  error:     { variant: "destructive", label: "Error"     },
  processing:{ variant: "warning",     label: "Processing"},
  pending:   { variant: "secondary",   label: "Pending"   },
};

const CHART_COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#8b5cf6", "#f97316", "#06b6d4", "#ec4899"];

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 100; // ~5 minutes — matches Vercel 300s function timeout

// ---------------------------------------------------------------------------
// Custom chart tooltip
// ---------------------------------------------------------------------------

function DarkTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#1d1f2c] border border-[oklch(0.255_0.010_260)] rounded-lg shadow-xl p-2 text-xs">
      {label && <div className="text-slate-400 mb-1">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.fill || p.color }} />
          <span className="text-slate-300">{p.name || p.dataKey}:</span>
          <span className="text-white font-mono font-medium">
            {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AnalysisDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCount = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAnalysis = async (signal?: AbortSignal) => {
    const res = await fetch(`/api/analyses?id=${id}`, { signal });
    if (!res.ok) throw new Error("Failed to fetch analysis");
    const json = await res.json();
    return json as Record<string, any>;
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
      elapsedRef.current = null;
    }
    setPolling(false);
    pollCount.current = 0;
  };

  // Initial load
  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        const data = await fetchAnalysis(ctrl.signal);
        setAnalysis(data);

        // If still processing, start polling
        if (data.status === "processing" || data.status === "pending") {
          setPolling(true);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load analysis");
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      ctrl.abort();
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Polling when status is processing/pending
  useEffect(() => {
    if (!polling) return;

    // Elapsed time counter (updates every second for the processing banner)
    setElapsedSeconds(0);
    elapsedRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);

    pollRef.current = setInterval(async () => {
      pollCount.current += 1;

      // Stop after max attempts — show "may be stuck" banner
      if (pollCount.current >= POLL_MAX_ATTEMPTS) {
        stopPolling();
        setPollTimedOut(true);
        return;
      }

      try {
        const data = await fetchAnalysis();
        setAnalysis(data);

        if (data.status === "completed" || data.status === "error") {
          stopPolling();
        }
      } catch {
        // Silently ignore poll errors — keep trying
      }
    }, POLL_INTERVAL_MS);

    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, id]);

  // ── Loading ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertCircle className="w-10 h-10 text-muted-foreground/40" />
        <p className="text-muted-foreground">{error || "Analysis not found"}</p>
        <Link href="/history">
          <Button variant="outline" size="sm">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to History
          </Button>
        </Link>
      </div>
    );
  }

  // ── Safely extract data with fallbacks ───────────────────────────────────

  const features = analysis.feature_recognition?.features || [];
  const processes = analysis.process_mapping?.processes || [];
  const cycleItems = analysis.cycle_time?.items || [];
  const costItems = analysis.cost_estimation?.items || [];
  const totalMin = analysis.cycle_time?.total_minutes || 0;
  const totalUsd = analysis.cost_estimation?.total_cost_usd || 0;
  const dimensions = analysis.dimension_gdt?.dimensions || [];
  const gdtCallouts = analysis.dimension_gdt?.gdt_callouts || [];
  const agentLog: any[] = analysis.agent_log || [];
  const statusInfo = STATUS_BADGE[analysis.status] || STATUS_BADGE.pending;
  const isError = analysis.status === "error";
  const isProcessing = analysis.status === "processing" || analysis.status === "pending";

  // Chart data
  const costChartData = costItems.map((item: any, i: number) => ({
    name: item.process || item.label || `Item ${i + 1}`,
    value: item.cost_usd || item.amount_usd || 0,
  }));

  const cycleChartData = cycleItems.map((item: any) => ({
    name: item.process || item.label || "Unknown",
    value: item.time_minutes || item.minutes || 0,
  }));

  const barChartHeight = cycleChartData.length > 4 ? 260 : 180;

  // KPI card definitions
  const kpiCards = [
    {
      label: "Cycle Time",
      value: totalMin.toFixed(1),
      unit: "min",
      icon: Timer,
      accent: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
    },
    {
      label: "Total Cost",
      value: `$${totalUsd.toFixed(2)}`,
      unit: "USD",
      icon: DollarSign,
      accent: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    },
    {
      label: "Features",
      value: String(features.length),
      unit: "detected",
      icon: Layers,
      accent: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    },
    {
      label: "Operations",
      value: String(processes.length),
      unit: "mapped",
      icon: Wrench,
      accent: "text-orange-400 bg-orange-500/10 border-orange-500/20",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link href="/history">
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <h1 className="text-xl font-bold text-foreground">{analysis.file_name}</h1>
            <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
            {polling && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground/60">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Waiting for results...</span>
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground/60 pl-9">
            {new Date(analysis.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Processing banner */}
      {isProcessing && !pollTimedOut && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/6 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              <div className="text-[13px] text-amber-300/80">
                Analysis is running — this page updates automatically.
                {elapsedSeconds >= 40 && (
                  <span className="block text-[11px] text-amber-400/50 mt-0.5">
                    If RunPod utilization is 0%, the model stopped. The UI will update within ~30s of that.
                  </span>
                )}
              </div>
            </div>
            {elapsedSeconds > 0 && (
              <span className="text-[11px] font-mono text-amber-400/50 shrink-0">
                {Math.floor(elapsedSeconds / 60) > 0
                  ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
                  : `${elapsedSeconds}s`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Polling timed out banner */}
      {isProcessing && pollTimedOut && (
        <div className="rounded-lg bg-red-500/8 border border-red-500/20 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium text-red-400">Analysis may be stuck</div>
              <div className="text-sm text-red-400/70 mt-1">
                The job is taking longer than expected and may have timed out. Check the History page and mark it as failed if it&apos;s no longer running.
              </div>
            </div>
            <Link href="/history">
              <Button variant="outline" size="sm" className="shrink-0">
                Go to History
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* Error banner */}
      {isError && analysis.error_message && (
        <div className="rounded-lg bg-red-500/8 border border-red-500/20 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-red-400">Analysis Error</div>
              <div className="text-sm text-red-400/70 mt-1">{analysis.error_message}</div>
            </div>
          </div>
        </div>
      )}

      {/* KPI Strip — 4 cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpiCards.map((c) => (
          <div
            key={c.label}
            className={`rounded-xl border p-4 flex items-start gap-3 ${c.accent}`}
          >
            <div className={`mt-0.5 shrink-0 ${c.accent.split(" ")[0]}`}>
              <c.icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-3xl font-bold font-mono leading-none tracking-tight">
                {c.value}
              </div>
              <div className="text-[10px] font-mono mt-1 opacity-60">{c.unit}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts — only render if data exists */}
      {(costChartData.length > 0 || cycleChartData.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Cost Donut Chart */}
          {costChartData.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-foreground/80">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  Cost Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={costChartData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={2}
                      >
                        {costChartData.map((_: any, index: number) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={CHART_COLORS[index % CHART_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <ChartTooltip
                        content={<DarkTooltip unit="USD" />}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center label */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-center">
                      <div className="text-lg font-bold font-mono text-foreground">
                        ${totalUsd.toFixed(0)}
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">total</div>
                    </div>
                  </div>
                </div>
                {/* Legend */}
                <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2 justify-center">
                  {costChartData.map((item: any, i: number) => (
                    <div key={item.name} className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      <span className="text-[10px] text-muted-foreground/70 truncate max-w-[100px]">
                        {item.name}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Cycle Time Bar Chart */}
          {cycleChartData.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-foreground/80">
                  <Timer className="w-4 h-4 text-cyan-400" />
                  Cycle Time by Operation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={barChartHeight}>
                  <BarChart
                    data={cycleChartData}
                    layout="vertical"
                    margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid
                      horizontal={false}
                      stroke="oklch(0.255 0.010 260)"
                      strokeDasharray="0"
                    />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10, fill: "oklch(0.54 0.015 260)", fontFamily: "var(--font-mono)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `${v}`}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={110}
                      tick={{ fontSize: 10, fill: "oklch(0.54 0.015 260)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: string) => v.length > 18 ? `${v.slice(0, 17)}…` : v}
                    />
                    <ChartTooltip
                      content={<DarkTooltip unit="min" />}
                      cursor={{ fill: "oklch(0.255 0.010 260 / 0.4)" }}
                    />
                    <Bar
                      dataKey="value"
                      name="Minutes"
                      fill="#f59e0b"
                      radius={[0, 3, 3, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Separator />

      {/* Detail tabs */}
      <Tabs defaultValue={features.length > 0 ? "features" : agentLog.length > 0 ? "activity" : "features"}>
        <TabsList>
          <TabsTrigger value="features">Features ({features.length})</TabsTrigger>
          <TabsTrigger value="processes">Processes ({processes.length})</TabsTrigger>
          <TabsTrigger value="dimensions">Dimensions &amp; GD&amp;T</TabsTrigger>
          {agentLog.length > 0 && (
            <TabsTrigger value="activity">Agent Activity ({agentLog.length})</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="features">
          <Card>
            <CardContent className="pt-4">
              {features.length > 0 ? (
                <FeatureTable features={features} />
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {isProcessing ? "Waiting for feature extraction..." : "No features found."}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="processes">
          <Card>
            <CardContent className="pt-4">
              {processes.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow className="border-border">
                      <TableHead className="text-muted-foreground/70">Operation</TableHead>
                      <TableHead className="text-muted-foreground/70">Category</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {processes.map((p: any, i: number) => (
                      <TableRow key={i} className="border-border">
                        <TableCell className="text-sm text-foreground/80">{p.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{p.category}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {isProcessing ? "Waiting for process mapping..." : "No processes mapped."}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="dimensions">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-foreground/80">Dimensions</CardTitle>
              </CardHeader>
              <CardContent>
                {dimensions.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-muted-foreground/70">Feature</TableHead>
                        <TableHead className="text-right text-muted-foreground/70">Nominal</TableHead>
                        <TableHead className="text-right text-muted-foreground/70">Tol +</TableHead>
                        <TableHead className="text-right text-muted-foreground/70">Tol -</TableHead>
                        <TableHead className="text-muted-foreground/70">Unit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dimensions.map((d: any, i: number) => (
                        <TableRow key={i} className="border-border">
                          <TableCell className="text-sm text-foreground/80">{d.feature}</TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground/80">{d.nominal ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground/80">{d.tolerance_plus ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground/80">{d.tolerance_minus ?? "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground/70">{d.unit || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {isProcessing ? "Waiting..." : "No dimensions extracted."}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-foreground/80">GD&amp;T Callouts</CardTitle>
              </CardHeader>
              <CardContent>
                {gdtCallouts.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="text-muted-foreground/70">Feature</TableHead>
                        <TableHead className="text-muted-foreground/70">Type</TableHead>
                        <TableHead className="text-right text-muted-foreground/70">Value</TableHead>
                        <TableHead className="text-muted-foreground/70">Datum</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {gdtCallouts.map((g: any, i: number) => (
                        <TableRow key={i} className="border-border">
                          <TableCell className="text-sm text-foreground/80">{g.feature}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px]">{g.type}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground/80">{g.value}</TableCell>
                          <TableCell className="text-xs text-muted-foreground/70">{g.datum || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {isProcessing ? "Waiting..." : "No GD&T callouts extracted."}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {agentLog.length > 0 && (
          <TabsContent value="activity">
            <Card>
              <CardContent className="pt-4 space-y-2">
                {agentLog.map((entry: any, i: number) => (
                  <AgentLogEntry key={i} entry={entry} />
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent log entry renderer for activity replay
// ---------------------------------------------------------------------------

function AgentLogEntry({ entry }: { entry: { type: string; data: any; ts: number } }) {
  const { type, data } = entry;

  switch (type) {
    case "agent_start":
      return (
        <div className="flex items-center gap-2 text-sm text-primary/80">
          <Bot className="w-3.5 h-3.5" />
          <span>{data.message || "Agent started"}</span>
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
          <Clock className="w-3 h-3" />
          <span className="font-medium text-foreground/70">{data.title}</span>
          <span>{data.message}</span>
        </div>
      );
    case "tool_call":
      return (
        <div className="flex items-center gap-2 text-xs rounded bg-muted/60 px-2 py-1">
          <Wrench className="w-3 h-3 text-blue-400" />
          <span className="font-mono font-medium text-foreground/80">{data.tool}</span>
          <span className="text-muted-foreground/60">called</span>
        </div>
      );
    case "tool_result": {
      const hasErr = data.result?.error;
      return (
        <div className={`flex items-center gap-2 text-xs rounded px-2 py-1 ${hasErr ? "bg-red-500/8" : "bg-emerald-500/8"}`}>
          {hasErr
            ? <AlertCircle className="w-3 h-3 text-red-400" />
            : <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          }
          <span className="font-mono font-medium text-foreground/80">{data.tool}</span>
          <span className="text-muted-foreground/60">
            {hasErr ? `error: ${data.result.error}` : `completed (${data.duration_ms}ms)`}
          </span>
        </div>
      );
    }
    case "final_answer":
      return (
        <div className="flex items-start gap-2 text-sm rounded bg-emerald-500/8 border border-emerald-500/20 p-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5" />
          <div>
            <div className="font-medium text-emerald-400">Analysis Complete</div>
            <div className="text-xs text-muted-foreground/60 mt-1 line-clamp-3">{data.summary}</div>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="flex items-start gap-2 text-sm rounded bg-red-500/8 border border-red-500/20 p-2">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5" />
          <span className="text-red-400/80 text-xs">{data.message}</span>
        </div>
      );
    case "done":
      return (
        <div className="flex items-center gap-3 text-xs text-muted-foreground/60 border-t border-border pt-2 mt-2 font-mono">
          <span>Completed in {data.elapsed_seconds}s</span>
          {data.total_minutes > 0 && <span className="font-medium text-foreground/70">{data.total_minutes} min</span>}
          {data.total_usd > 0 && <span className="font-medium text-foreground/70">USD {data.total_usd}</span>}
        </div>
      );
    default:
      return null;
  }
}
