"use client";

import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { StepStatus } from "@/lib/hooks/useApproach1";

export interface StepCardChip {
  label: string;
}

export interface StepCardProps {
  /** Unique key for this step */
  stepKey: string;
  /** Display label */
  label: string;
  /** Short description shown when idle or running */
  desc: string;
  /** Step status */
  status: StepStatus;
  /** Summary chips shown when done */
  chips?: StepCardChip[];
  /** Error message */
  error?: string | null;
  /** Elapsed time in ms */
  elapsedMs?: number | null;
  /** Whether the details panel is open */
  isExpanded: boolean;
  /** Called when header is clicked */
  onToggle: () => void;
  /** Content for the expanded details panel */
  children?: React.ReactNode;
}

/**
 * StepCard — a single pipeline step card for Approach 1.
 *
 * Pure UI: all state is passed via props.
 */
export function StepCard({
  label,
  desc,
  status,
  chips,
  error,
  elapsedMs,
  isExpanded,
  onToggle,
  children,
}: StepCardProps) {
  const hasDetails = !!children;

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden transition-all duration-200",
        status === "running"
          ? "border-primary/30 shadow-[0_0_0_2px_oklch(0.60_0.175_68_/_0.10)]"
          : status === "error"
          ? "border-red-200 bg-red-50/30"
          : status === "done"
          ? "border-emerald-200/60"
          : "border-border bg-card"
      )}
    >
      {/* Header row */}
      <button
        type="button"
        className={cn(
          "w-full flex items-center gap-3.5 px-4 py-3.5 text-left transition-colors",
          hasDetails ? "cursor-pointer hover:bg-muted/20" : "cursor-default"
        )}
        onClick={hasDetails ? onToggle : undefined}
        disabled={!hasDetails}
      >
        {/* Status icon */}
        <div
          className={cn(
            "flex items-center justify-center w-7 h-7 rounded-lg shrink-0 transition-colors",
            status === "done"    ? "bg-emerald-100"  :
            status === "running" ? "bg-primary/10"   :
            status === "error"   ? "bg-red-100"      :
            "bg-muted/50"
          )}
        >
          {status === "running" ? (
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
          ) : status === "done" ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          ) : status === "error" ? (
            <XCircle className="w-3.5 h-3.5 text-red-500" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-muted-foreground/20" />
          )}
        </div>

        {/* Label + summary */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn(
              "text-[13px] font-semibold",
              status === "idle" ? "text-foreground/50" : "text-foreground"
            )}>
              {label}
            </span>
            {elapsedMs !== null && elapsedMs !== undefined && (
              <span className="text-[10px] font-mono text-muted-foreground/40">
                {(elapsedMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {status === "idle" && (
            <p className="text-[11px] text-muted-foreground/40 mt-0.5 leading-snug">{desc}</p>
          )}
          {status === "running" && (
            <p className="text-[11px] text-primary/60 mt-0.5 leading-snug animate-pulse">{desc}</p>
          )}
          {status === "done" && chips && chips.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {chips.map((c) => (
                <span
                  key={c.label}
                  className="text-[10.5px] font-mono bg-muted/60 rounded px-1.5 py-0.5 text-muted-foreground"
                >
                  {c.label}
                </span>
              ))}
            </div>
          )}
          {status === "error" && error && (
            <p className="text-[11px] text-red-500 mt-0.5 leading-snug">{error}</p>
          )}
        </div>

        {/* Expand chevron */}
        {hasDetails && (
          <div className="shrink-0 text-muted-foreground/30">
            {isExpanded
              ? <ChevronDown className="w-3.5 h-3.5" />
              : <ChevronRight className="w-3.5 h-3.5" />
            }
          </div>
        )}
      </button>

      {/* Expanded body */}
      {isExpanded && hasDetails && (
        <div className="border-t border-border bg-muted/10 px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
