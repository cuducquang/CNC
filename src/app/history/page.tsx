"use client";

import { useEffect, useState } from "react";
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
} from "lucide-react";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Analysis {
  id: string;
  created_at: string;
  file_name: string;
  file_3d_path?: string;
  file_2d_path?: string;
  status: string;
  cycle_time?: { total_minutes: number };
  cost_estimation?: { total_cost_usd: number };
}

function basename(filePath?: string): string {
  if (!filePath) return "";
  return filePath.split("/").pop() || filePath;
}

const STATUS_MAP: Record<
  string,
  {
    variant: "success" | "warning" | "destructive" | "secondary";
    icon: typeof CheckCircle2;
  }
> = {
  completed: { variant: "success", icon: CheckCircle2 },
  processing: { variant: "warning", icon: Loader2 },
  error: { variant: "destructive", icon: AlertCircle },
  pending: { variant: "secondary", icon: Clock },
};

export default function HistoryPage() {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAnalyses = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/analyses");
      if (res.ok) {
        const data = await res.json();
        setAnalyses(data.data || data.analyses || []);
      }
    } catch (e) {
      console.error("Failed to fetch analyses:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAnalyses();
  }, []);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/analyses?id=${id}`, { method: "DELETE" });
      if (res.ok) setAnalyses((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analysis History</h1>
        <p className="text-muted-foreground text-sm mt-1">
          View and manage your previous CNC costing analyses.
        </p>
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
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {analyses.map((a) => {
                  const sm = STATUS_MAP[a.status] || STATUS_MAP.pending;
                  const Icon = sm.icon;
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
                        <Badge
                          variant={sm.variant}
                          className="gap-1 text-[10px]"
                        >
                          <Icon
                            className={`w-3 h-3 ${a.status === "processing" ? "animate-spin" : ""}`}
                          />
                          {a.status}
                        </Badge>
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
                          {(a.status === "completed" || a.status === "error") && (
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
