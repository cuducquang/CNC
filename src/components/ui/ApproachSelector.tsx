"use client";

/**
 * ApproachSelector — landing page approach card UI.
 *
 * Pure UI: renders two clickable cards. Parent handles navigation.
 */

import { cn } from "@/lib/utils";
import { ArrowRight, Brain, Wrench } from "lucide-react";

export interface ApproachCard {
  id: 1 | 2;
  title: string;
  subtitle: string;
  description: string;
  badge: string;
  features: string[];
  accent: string;
  icon: typeof Brain;
}

const APPROACHES: ApproachCard[] = [
  {
    id: 1,
    title: "AI-Powered",
    subtitle: "Approach 1",
    badge: "LLM Steps",
    description:
      "Each pipeline step runs as a separate LLM call. Qwen3-VL-32B handles GD&T extraction, feature recognition, process mapping, and cost estimation step-by-step.",
    features: [
      "6 discrete LLM calls",
      "Full thinking trace per step",
      "Transparent reasoning",
      "No CDN timeout risk",
    ],
    accent: "from-violet-50 to-purple-50 border-violet-200/60 hover:border-violet-300",
    icon: Brain,
  },
  {
    id: 2,
    title: "FreeCAD-Powered",
    subtitle: "Approach 2",
    badge: "Deterministic",
    description:
      "FreeCAD STEPAnalyzer handles 3D geometry deterministically. The AI agent orchestrates 6 tools in a single streaming session, with live thinking output.",
    features: [
      "FreeCAD 3D geometry engine",
      "Single streaming session",
      "Live pipeline activity log",
      "Agentic orchestration",
    ],
    accent: "from-emerald-50 to-teal-50 border-emerald-200/60 hover:border-emerald-300",
    icon: Wrench,
  },
];

interface ApproachSelectorProps {
  onSelect: (approach: 1 | 2) => void;
}

export function ApproachSelector({ onSelect }: ApproachSelectorProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
      {APPROACHES.map((a) => {
        const Icon = a.icon;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            className={cn(
              "group relative flex flex-col gap-5 rounded-2xl border bg-gradient-to-br p-6 text-left",
              "shadow-[0_2px_8px_0_rgb(0,0,0,0.05)]",
              "transition-all duration-200",
              "hover:shadow-[0_6px_20px_0_rgb(0,0,0,0.09)] hover:-translate-y-0.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              a.accent
            )}
          >
            {/* Badge */}
            <div className="flex items-start justify-between">
              <span className="inline-flex items-center rounded-full border border-current/20 bg-white/70 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-foreground/60">
                {a.badge}
              </span>
              <ArrowRight className="w-4 h-4 text-foreground/20 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground/40" />
            </div>

            {/* Icon + title */}
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/80 border border-white/60 shadow-sm shrink-0">
                <Icon className="w-5 h-5 text-foreground/60" />
              </div>
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-widest">
                  {a.subtitle}
                </div>
                <div className="text-[20px] font-bold text-foreground leading-tight">{a.title}</div>
              </div>
            </div>

            {/* Description */}
            <p className="text-[13px] text-muted-foreground leading-relaxed">{a.description}</p>

            {/* Feature list */}
            <ul className="space-y-1.5">
              {a.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-[12px] text-foreground/70">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
