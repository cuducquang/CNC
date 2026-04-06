"use client";

import { useRef, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ToolExecution } from "./tool-execution";
import { ThinkingPanel } from "./thinking-panel";
import {
  Bot,
  CheckCircle2,
  AlertCircle,
  Loader2,
  XCircle,
  Sparkles,
} from "lucide-react";

export interface AgentStreamMessage {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface AgentStreamProps {
  messages: AgentStreamMessage[];
  liveThinking: string;
  isStreaming: boolean;
}

export function AgentStream({ messages, liveThinking, isStreaming }: AgentStreamProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveThinking]);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-4">
        {messages.map((msg) => (
          <AgentMessage key={msg.id} msg={msg} />
        ))}

        {liveThinking && <ThinkingPanel content={liveThinking} isLive label="Vision Analysis — Reading Drawing" />}

        {isStreaming && !liveThinking && messages.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground/60 py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Processing...</span>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </ScrollArea>
  );
}

function AgentMessage({ msg }: { msg: AgentStreamMessage }) {
  const { type, data } = msg;

  switch (type) {
    case "agent_start":
      return (
        <div className="flex items-start gap-3 rounded-lg bg-primary/8 border border-primary/20 p-3">
          <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary/15 mt-0.5 shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-primary/90">Analysis Started</div>
            <div className="text-[11px] text-primary/50 mt-0.5">
              {data.message as string}
            </div>
          </div>
        </div>
      );

    case "status": {
      const d = data as { step?: number; title?: string; message?: string; completed?: boolean; failed?: boolean };
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground pl-1">
          {d.failed ? (
            <XCircle className="w-3.5 h-3.5 text-destructive" />
          ) : d.completed ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          )}
          <span className="font-medium text-foreground/80">{d.title}</span>
          <span className="text-muted-foreground/60">{d.message}</span>
        </div>
      );
    }

    case "thinking":
      return <ThinkingPanel content={data.content as string} iteration={data.iteration as number} />;

    case "tool_call":
      return (
        <ToolExecution
          tool={data.tool as string}
          args={data.args as Record<string, unknown>}
          status="running"
        />
      );

    case "tool_result":
      return (
        <ToolExecution
          tool={data.tool as string}
          result={data.result as Record<string, unknown>}
          duration={data.duration_ms as number}
          status={(data.result as Record<string, unknown>)?.error ? "error" : "complete"}
        />
      );

    case "agent_message":
      return (
        <div className="flex items-start gap-3 rounded-lg bg-card border border-border p-3">
          <div className="flex items-center justify-center w-7 h-7 rounded-md bg-muted mt-0.5 shrink-0">
            <Bot className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0 text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {data.content as string}
          </div>
        </div>
      );

    case "final_answer": {
      const results = data.results as Record<string, unknown>;
      return (
        <div className="flex items-start gap-3 rounded-lg bg-emerald-500/8 border border-emerald-500/25 p-4">
          <div className="flex items-center justify-center w-7 h-7 rounded-md bg-emerald-500/15 mt-0.5 shrink-0">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[13px] font-semibold text-emerald-400">Analysis Complete</span>
              {(results?.total_minutes as number) > 0 && (
                <Badge variant="success" className="text-[10px] font-mono">
                  {(results.total_minutes as number).toFixed(1)} min
                </Badge>
              )}
              {(results?.total_usd as number) > 0 && (
                <Badge variant="info" className="text-[10px] font-mono">
                  ${(results.total_usd as number).toFixed(2)}
                </Badge>
              )}
            </div>
            <div className="text-[12px] text-emerald-400/60 whitespace-pre-wrap leading-relaxed">
              {data.summary as string}
            </div>
          </div>
        </div>
      );
    }

    case "done": {
      const d = data as { total_minutes: number; total_usd: number; elapsed_seconds: number };
      return (
        <div className="flex items-center justify-center gap-3 border-t border-border mt-1 py-2.5 font-mono text-[11px] text-muted-foreground/60">
          <span>{d.elapsed_seconds}s elapsed</span>
          {d.total_minutes > 0 && <><span className="opacity-40">·</span><span>{d.total_minutes} min</span></>}
          {d.total_usd > 0 && <><span className="opacity-40">·</span><span>${d.total_usd}</span></>}
        </div>
      );
    }

    case "error":
      return (
        <div className="flex items-start gap-3 rounded-lg bg-red-500/8 border border-red-500/20 p-3">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
          <div className="text-[12px] text-red-400">
            {data.message as string}
          </div>
        </div>
      );

    default:
      return null;
  }
}
