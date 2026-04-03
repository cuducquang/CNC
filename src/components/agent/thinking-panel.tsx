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
    <div className="rounded-lg border border-amber-200/60 bg-amber-50/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100/50 transition-colors"
      >
        <Brain className="w-4 h-4" />
        <span className="flex-1 text-left">
          {label}
          {iteration && <span className="text-amber-600/60 text-xs ml-1.5">Step {iteration}</span>}
        </span>
        {isLive && <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />}
        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre
          ref={ref}
          className="px-3 py-2 text-xs leading-relaxed max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-amber-900/70 border-t border-amber-200/40"
        >
          {content}
          {isLive && <span className="animate-pulse text-amber-500">|</span>}
        </pre>
      )}
    </div>
  );
}
