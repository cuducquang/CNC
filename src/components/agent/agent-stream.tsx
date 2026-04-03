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
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Agent is processing...</span>
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
        <div className="flex items-start gap-3 rounded-lg bg-primary/5 border border-primary/10 p-3">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 mt-0.5">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Agentic Analysis Started</div>
            <div className="text-xs text-muted-foreground mt-0.5">
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
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          ) : (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          )}
          <span className="font-medium text-foreground">{d.title}</span>
          <span className="text-muted-foreground">{d.message}</span>
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
        <div className="flex items-start gap-3 rounded-lg bg-card border p-3">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 mt-0.5">
            <Bot className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0 text-sm whitespace-pre-wrap">
            {data.content as string}
          </div>
        </div>
      );

    case "final_answer": {
      const results = data.results as Record<string, unknown>;
      return (
        <div className="flex items-start gap-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-4">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-emerald-500/10 mt-0.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-emerald-700">Analysis Complete</span>
              <Badge variant="success" className="text-[10px]">
                {(results?.total_minutes as number)?.toFixed(1)} min
              </Badge>
              <Badge variant="info" className="text-[10px]">
                USD {(results?.total_usd as number)?.toFixed(2)}
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {data.summary as string}
            </div>
          </div>
        </div>
      );
    }

    case "done": {
      const d = data as { total_minutes: number; total_usd: number; elapsed_seconds: number };
      return (
        <div className="flex items-center justify-center gap-4 py-3 text-sm text-muted-foreground border-t mt-2">
          <span>Completed in {d.elapsed_seconds}s</span>
          <span className="text-foreground font-medium">{d.total_minutes} min</span>
          <span className="text-foreground font-medium">USD {d.total_usd}</span>
        </div>
      );
    }

    case "error":
      return (
        <div className="flex items-start gap-3 rounded-lg bg-destructive/5 border border-destructive/20 p-3">
          <AlertCircle className="w-4 h-4 text-destructive mt-0.5" />
          <div className="text-sm text-destructive">
            {data.message as string}
          </div>
        </div>
      );

    default:
      return null;
  }
}
