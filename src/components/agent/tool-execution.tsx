"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  Eye,
  Layers,
  Wrench,
  Timer,
  DollarSign,
  Search,
  ShieldCheck,
  Loader2,
  CheckCircle2,
  XCircle,
  CircleDot,
} from "lucide-react";

const TOOL_META: Record<string, { icon: typeof Eye; label: string; color: string }> = {
  analyze_drawing: { icon: Eye, label: "Vision Extraction", color: "text-violet-600 bg-violet-50 border-violet-200" },
  recognize_features: { icon: Layers, label: "Feature Recognition", color: "text-blue-600 bg-blue-50 border-blue-200" },
  lookup_material: { icon: Search, label: "Material Lookup", color: "text-amber-600 bg-amber-50 border-amber-200" },
  map_cnc_processes: { icon: Wrench, label: "Process Mapping", color: "text-orange-600 bg-orange-50 border-orange-200" },
  estimate_cycle_time: { icon: Timer, label: "Cycle Time", color: "text-cyan-600 bg-cyan-50 border-cyan-200" },
  estimate_cost: { icon: DollarSign, label: "Cost Estimation", color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  validate_estimate: { icon: ShieldCheck, label: "Validation", color: "text-indigo-600 bg-indigo-50 border-indigo-200" },
};

interface ToolExecutionProps {
  tool: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  duration?: number;
  status: "running" | "complete" | "error";
}

export function ToolExecution({ tool, args, result, duration, status }: ToolExecutionProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_META[tool] || { icon: CircleDot, label: tool, color: "text-gray-600 bg-gray-50 border-gray-200" };
  const Icon = meta.icon;

  return (
    <div className={cn("rounded-lg border overflow-hidden", meta.color)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:opacity-80 transition-opacity"
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="text-sm font-medium flex-1">{meta.label}</span>

        {status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {status === "complete" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
        {status === "error" && <XCircle className="w-3.5 h-3.5 text-destructive" />}

        {duration !== undefined && (
          <Badge variant="outline" className="text-[10px] font-mono">
            {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`}
          </Badge>
        )}

        {/* Summary badges based on tool type */}
        {result && tool === "analyze_drawing" && (
          <Badge variant="secondary" className="text-[10px]">
            {(result.feature_count as number) || 0} features
          </Badge>
        )}
        {result && tool === "recognize_features" && (
          <Badge variant="secondary" className="text-[10px]">
            {(result.feature_count as number) || 0} classified
          </Badge>
        )}
        {result && tool === "map_cnc_processes" && (
          <Badge variant="secondary" className="text-[10px]">
            {(result.operation_count as number) || 0} ops
          </Badge>
        )}
        {result && tool === "estimate_cycle_time" && (
          <Badge variant="secondary" className="text-[10px]">
            {(result.total_minutes as number)?.toFixed(1)} min
          </Badge>
        )}
        {result && tool === "estimate_cost" && (
          <Badge variant="secondary" className="text-[10px]">
            USD {(result.total_usd as number)?.toFixed(2)}
          </Badge>
        )}

        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div className="border-t px-3 py-2 bg-white/80 space-y-2">
          {args && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Input</div>
              <pre className="text-xs font-mono bg-muted/30 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Output</div>
              <pre className="text-xs font-mono bg-muted/30 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
