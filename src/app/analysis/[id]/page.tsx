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
import { SummaryCards } from "@/components/results/summary-cards";
import { FeatureTable } from "@/components/results/feature-table";
import { CostBreakdownCard } from "@/components/results/cost-breakdown";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, AlertCircle, Bot, CheckCircle2, Wrench, Clock, Loader2 } from "lucide-react";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUS_BADGE: Record<string, { variant: "success" | "destructive" | "warning" | "secondary"; label: string }> = {
  completed: { variant: "success", label: "Completed" },
  error: { variant: "destructive", label: "Error" },
  processing: { variant: "warning", label: "Processing" },
  pending: { variant: "secondary", label: "Pending" },
};

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_ATTEMPTS = 24; // ~60 seconds

export default function AnalysisDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

    pollRef.current = setInterval(async () => {
      pollCount.current += 1;

      // Stop after max attempts
      if (pollCount.current >= POLL_MAX_ATTEMPTS) {
        stopPolling();
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
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertCircle className="w-10 h-10 text-muted-foreground" />
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
            <h1 className="text-xl font-bold">{analysis.file_name}</h1>
            <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
            {polling && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Waiting for results...</span>
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground pl-9">
            {new Date(analysis.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Processing banner */}
      {isProcessing && (
        <div className="rounded-lg bg-warning/10 border border-warning/20 p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-warning animate-spin shrink-0" />
            <div className="text-sm text-warning-foreground">
              Analysis is still running. This page will update automatically when complete.
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {isError && analysis.error_message && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-destructive">Analysis Error</div>
              <div className="text-sm text-destructive/80 mt-1">{analysis.error_message}</div>
            </div>
          </div>
        </div>
      )}

      {/* Summary — show even with partial data */}
      <SummaryCards
        totalMinutes={totalMin}
        totalUsd={totalUsd}
        featureCount={features.length}
        operationCount={processes.length}
      />

      {/* Breakdowns — only show if we have data */}
      {(cycleItems.length > 0 || costItems.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cycleItems.length > 0 && (
            <CostBreakdownCard
              title="Cycle Time Breakdown"
              items={cycleItems.map((i: any) => ({ process: i.process, minutes: i.time_minutes, category: "machining" }))}
              total={totalMin.toFixed(1)}
              unit="min"
            />
          )}
          {costItems.length > 0 && (
            <CostBreakdownCard
              title="Cost Breakdown"
              items={costItems.map((i: any) => ({ line: i.process, amount_usd: i.cost_usd, category: "machining" }))}
              total={totalUsd.toFixed(2)}
              unit="USD"
            />
          )}
        </div>
      )}

      <Separator />

      {/* Detail tabs */}
      <Tabs defaultValue={features.length > 0 ? "features" : agentLog.length > 0 ? "activity" : "features"}>
        <TabsList>
          <TabsTrigger value="features">Features ({features.length})</TabsTrigger>
          <TabsTrigger value="processes">Processes ({processes.length})</TabsTrigger>
          <TabsTrigger value="dimensions">Dimensions & GD&T</TabsTrigger>
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
                    <TableRow>
                      <TableHead>Operation</TableHead>
                      <TableHead>Category</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {processes.map((p: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{p.name}</TableCell>
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
                <CardTitle className="text-sm">Dimensions</CardTitle>
              </CardHeader>
              <CardContent>
                {dimensions.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Feature</TableHead>
                        <TableHead className="text-right">Nominal</TableHead>
                        <TableHead className="text-right">Tol +</TableHead>
                        <TableHead className="text-right">Tol -</TableHead>
                        <TableHead>Unit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dimensions.map((d: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{d.feature}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{d.nominal ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{d.tolerance_plus ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{d.tolerance_minus ?? "—"}</TableCell>
                          <TableCell className="text-xs">{d.unit || "—"}</TableCell>
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
                <CardTitle className="text-sm">GD&T Callouts</CardTitle>
              </CardHeader>
              <CardContent>
                {gdtCallouts.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Feature</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                        <TableHead>Datum</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {gdtCallouts.map((g: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{g.feature}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px]">{g.type}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{g.value}</TableCell>
                          <TableCell className="text-xs">{g.datum || "—"}</TableCell>
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
        <div className="flex items-center gap-2 text-sm text-primary">
          <Bot className="w-3.5 h-3.5" />
          <span>{data.message || "Agent started"}</span>
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span className="font-medium">{data.title}</span>
          <span>{data.message}</span>
        </div>
      );
    case "tool_call":
      return (
        <div className="flex items-center gap-2 text-xs rounded bg-muted px-2 py-1">
          <Wrench className="w-3 h-3 text-blue-500" />
          <span className="font-mono font-medium">{data.tool}</span>
          <span className="text-muted-foreground">called</span>
        </div>
      );
    case "tool_result": {
      const hasErr = data.result?.error;
      return (
        <div className={`flex items-center gap-2 text-xs rounded px-2 py-1 ${hasErr ? "bg-destructive/5" : "bg-emerald-500/5"}`}>
          {hasErr ? <AlertCircle className="w-3 h-3 text-destructive" /> : <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
          <span className="font-mono font-medium">{data.tool}</span>
          <span className="text-muted-foreground">
            {hasErr ? `error: ${data.result.error}` : `completed (${data.duration_ms}ms)`}
          </span>
        </div>
      );
    }
    case "final_answer":
      return (
        <div className="flex items-start gap-2 text-sm rounded bg-emerald-500/5 border border-emerald-500/20 p-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5" />
          <div>
            <div className="font-medium text-emerald-700">Analysis Complete</div>
            <div className="text-xs text-muted-foreground mt-1 line-clamp-3">{data.summary}</div>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="flex items-start gap-2 text-sm rounded bg-destructive/5 border border-destructive/20 p-2">
          <AlertCircle className="w-4 h-4 text-destructive mt-0.5" />
          <span className="text-destructive text-xs">{data.message}</span>
        </div>
      );
    case "done":
      return (
        <div className="flex items-center gap-3 text-xs text-muted-foreground border-t pt-2 mt-2">
          <span>Completed in {data.elapsed_seconds}s</span>
          {data.total_minutes > 0 && <span className="font-medium text-foreground">{data.total_minutes} min</span>}
          {data.total_usd > 0 && <span className="font-medium text-foreground">USD {data.total_usd}</span>}
        </div>
      );
    default:
      return null;
  }
}
