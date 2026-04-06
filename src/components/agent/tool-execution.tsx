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

const TOOL_META: Record<string, { icon: typeof Eye; label: string; accent: string }> = {
  analyze_drawing:    { icon: Eye,         label: "Vision Extraction",   accent: "text-violet-400 bg-violet-500/10 border-violet-500/20" },
  recognize_features: { icon: Layers,      label: "Feature Recognition", accent: "text-blue-400   bg-blue-500/10   border-blue-500/20"   },
  analyze_step_file:  { icon: Layers,      label: "3D Analysis",         accent: "text-sky-400    bg-sky-500/10    border-sky-500/20"    },
  lookup_material:    { icon: Search,      label: "Material Lookup",     accent: "text-amber-400  bg-amber-500/10  border-amber-500/20"  },
  map_cnc_processes:  { icon: Wrench,      label: "Process Mapping",     accent: "text-orange-400 bg-orange-500/10 border-orange-500/20" },
  estimate_cycle_time:{ icon: Timer,       label: "Cycle Time",          accent: "text-cyan-400   bg-cyan-500/10   border-cyan-500/20"   },
  estimate_cost:      { icon: DollarSign,  label: "Cost Estimation",     accent: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  validate_estimate:  { icon: ShieldCheck, label: "Validation",          accent: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20" },
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
  const meta = TOOL_META[tool] || { icon: CircleDot, label: tool, accent: "text-slate-400 bg-slate-500/10 border-slate-500/20" };
  const Icon = meta.icon;

  return (
    <div className={cn("rounded-lg border overflow-hidden", meta.accent)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-all"
      >
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span className="text-[13px] font-medium flex-1">{meta.label}</span>

        {status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin opacity-60" />}
        {status === "complete" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
        {status === "error" && <XCircle className="w-3.5 h-3.5 text-red-400" />}

        {duration !== undefined && (
          <Badge variant="outline" className="text-[10px] font-mono border-current/20 text-current/60">
            {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`}
          </Badge>
        )}

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
          <Badge variant="secondary" className="text-[10px] font-mono">
            {(result.total_minutes as number)?.toFixed(1)} min
          </Badge>
        )}
        {result && tool === "estimate_cost" && (
          <Badge variant="secondary" className="text-[10px] font-mono">
            ${(result.total_usd as number)?.toFixed(2)}
          </Badge>
        )}

        <ChevronDown className={cn("w-3.5 h-3.5 opacity-40 transition-transform", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div className="border-t border-current/10 px-3 py-2.5 space-y-2 bg-black/20">
          {args && (
            <div>
              <div className="text-[10px] font-semibold text-current/50 uppercase tracking-wider mb-1.5">Input</div>
              <pre className="text-[11px] font-mono bg-black/25 text-slate-300 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] font-semibold text-current/50 uppercase tracking-wider mb-1.5">Output</div>
              <pre className="text-[11px] font-mono bg-black/25 text-slate-300 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
