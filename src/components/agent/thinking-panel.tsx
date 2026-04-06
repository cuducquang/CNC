"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Brain } from "lucide-react";

interface ThinkingPanelProps {
  content: string;
  isLive?: boolean;
  iteration?: number;
  label?: string;
}

export function ThinkingPanel({ content, isLive, iteration, label = "Model Thinking" }: ThinkingPanelProps) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (isLive && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [content, isLive]);

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/6 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-amber-500/8 transition-colors"
      >
        <Brain className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
        <span className="flex-1 text-left text-[12px] font-medium text-amber-300/70">
          {label}
          {iteration && <span className="text-amber-500/50 ml-2">Step {iteration}</span>}
        </span>
        {isLive && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />}
        <ChevronDown className={cn("w-3.5 h-3.5 text-amber-500/40 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre
          ref={ref}
          className="px-3 py-2.5 text-[11px] leading-relaxed max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-muted-foreground/55 border-t border-amber-500/10"
        >
          {content}
          {isLive && <span className="animate-pulse text-amber-400">▋</span>}
        </pre>
      )}
    </div>
  );
}
