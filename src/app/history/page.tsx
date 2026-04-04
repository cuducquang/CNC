"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowRight,
  Trash2,
  Clock,
  FileBox,
  AlertCircle,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Analysis {
  id: string;
  created_at: string;
  file_name: string;
  file_3d_path?: string;
  file_2d_path?: string;
  status: string;
  error_message?: string;
  cycle_time?: { total_minutes: number };
  cost_estimation?: { total_cost_usd: number };
}

function basename(filePath?: string): string {
  if (!filePath) return "";
  return filePath.split("/").pop() || filePath;
}

// A record stuck in "processing" for longer than this is considered timed out
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function isStuck(a: Analysis): boolean {
  if (a.status !== "processing") return false;
  return Date.now() - new Date(a.created_at).getTime() > STUCK_THRESHOLD_MS;
}

export default function HistoryPage() {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingStuck, setMarkingStuck] = useState<Set<string>>(new Set());
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAnalyses = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/analyses");
      if (res.ok) {
        const data = await res.json();
        setAnalyses(data.data || data.analyses || []);
      }
    } catch (e) {
      console.error("Failed to fetch analyses:", e);
    }
    if (!silent) setLoading(false);
  }, []);

  // Auto-mark stuck records as error
  const cleanupStuck = useCallback(async (list: Analysis[]) => {
    const stuck = list.filter(isStuck);
    if (stuck.length === 0) return;

    await Promise.allSettled(
      stuck.map((a) =>
        fetch(`/api/analyses/${a.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "error",
            error_message: "Analysis timed out — the job exceeded the maximum run time.",
          }),
        })
      )
    );

    // Refresh list to reflect updated statuses
    await fetchAnalyses(true);
  }, [fetchAnalyses]);

  // Initial load + auto-refresh while any records are processing
  useEffect(() => {
    fetchAnalyses();
  }, [fetchAnalyses]);

  useEffect(() => {
    const hasProcessing = analyses.some((a) => a.status === "processing");

    if (hasProcessing) {
      // Auto-clean any stuck records immediately
      cleanupStuck(analyses);

      // Refresh every 5s
      refreshTimerRef.current = setInterval(() => fetchAnalyses(true), 5000);
    } else {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [analyses, fetchAnalyses, cleanupStuck]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/analyses/${id}`, { method: "DELETE" });
      if (res.ok) setAnalyses((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  const handleMarkFailed = async (id: string) => {
    setMarkingStuck((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/analyses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "error",
          error_message: "Manually marked as failed.",
        }),
      });
      await fetchAnalyses(true);
    } finally {
      setMarkingStuck((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Derive badge config — includes a special "timed_out" display state
  const getStatusDisplay = (a: Analysis) => {
    if (isStuck(a)) {
      return { variant: "destructive" as const, icon: AlertTriangle, label: "timed out" };
    }
    switch (a.status) {
      case "completed": return { variant: "success" as const, icon: CheckCircle2, label: "completed" };
      case "error":     return { variant: "destructive" as const, icon: AlertCircle, label: "error" };
      case "processing": return { variant: "warning" as const, icon: Loader2, label: "processing" };
      default:           return { variant: "secondary" as const, icon: Clock, label: a.status };
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analysis History</h1>
          <p className="text-muted-foreground text-sm mt-1">
            View and manage your previous CNC costing analyses.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchAnalyses()}
          className="gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : analyses.length === 0 ? (
            <div className="py-16 text-center">
              <FileBox className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No analyses yet.</p>
              <Link href="/">
                <Button variant="outline" size="sm" className="mt-3">
                  Start New Analysis
                </Button>
              </Link>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Files</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Cycle Time</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {analyses.map((a) => {
                  const { variant, icon: Icon, label } = getStatusDisplay(a);
                  const stuck = isStuck(a);
                  const canView = a.status === "completed" || a.status === "error" || stuck;
                  const errorMsg = a.error_message;

                  return (
                    <TableRow key={a.id}>
                      <TableCell className="text-sm max-w-[240px]">
                        <div className="font-medium truncate" title={basename(a.file_3d_path)}>
                          {basename(a.file_3d_path) || a.file_name}
                        </div>
                        {a.file_2d_path && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5" title={basename(a.file_2d_path)}>
                            {basename(a.file_2d_path)}
                          </div>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant={variant} className="gap-1 text-[10px] w-fit">
                            <Icon className={`w-3 h-3 ${a.status === "processing" && !stuck ? "animate-spin" : ""}`} />
                            {label}
                          </Badge>
                          {errorMsg && (
                            <span className="text-[10px] text-muted-foreground max-w-[180px] truncate" title={errorMsg}>
                              {errorMsg}
                            </span>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="text-right font-mono text-xs">
                        {a.cycle_time?.total_minutes
                          ? `${a.cycle_time.total_minutes.toFixed(1)} min`
                          : "\u2014"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {a.cost_estimation?.total_cost_usd
                          ? `$${a.cost_estimation.total_cost_usd.toFixed(2)}`
                          : "\u2014"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {new Date(a.created_at).toLocaleDateString()}
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {stuck && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              title="Mark as failed"
                              disabled={markingStuck.has(a.id)}
                              onClick={() => handleMarkFailed(a.id)}
                            >
                              {markingStuck.has(a.id)
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <AlertTriangle className="w-3.5 h-3.5" />
                              }
                            </Button>
                          )}
                          {canView && (
                            <Link href={`/analysis/${a.id}`}>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="View details"
                              >
                                <ArrowRight className="w-3.5 h-3.5" />
                              </Button>
                            </Link>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => handleDelete(a.id)}
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
