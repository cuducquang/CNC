"use client";

/**
 * useApproach2 — Approach 2 (FreeCAD) pipeline logic.
 *
 * Extracted from src/app/page.tsx. All API calls live here;
 * the analyze page is pure UI.
 */

import { useState, useRef, useCallback } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";
import {
  parseSSEBuffer,
  startApproach2Stream,
} from "@/lib/api";
import type { AgentStreamMessage } from "@/components/agent/agent-stream";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOOL_TO_STATUS_TITLE: Record<string, string> = {
  analyze_drawing:    "GD&T Extraction",
  analyze_step_file:  "3D Analysis",
  recognize_features: "Feature Recognition",
  map_cnc_processes:  "Process Mapping",
  estimate_cycle_time:"Cycle Time",
  estimate_cost:      "Cost Estimation",
};

export type PipelineStatus = "idle" | "uploading" | "streaming" | "done" | "error";

export interface Approach2State {
  status: PipelineStatus;
  error: string | null;
  analysisId: string | null;
  messages: AgentStreamMessage[];
  liveThinking: string;
  completedTools: Set<string>;
  activeTool: string | null;
  results: Record<string, any> | null;
}

export function useApproach2() {
  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentStreamMessage[]>([]);
  const [liveThinking, setLiveThinking] = useState("");
  const [completedTools, setCompletedTools] = useState<Set<string>>(new Set());
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any> | null>(null);

  const abortRef        = useRef<AbortController | null>(null);
  const finalResultsRef = useRef<Record<string, any> | null>(null);
  const finalSummaryRef = useRef<string>("");
  const uploadResultRef = useRef<Record<string, any> | null>(null);

  const addMsg = useCallback((type: string, data: Record<string, unknown>) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type, data, timestamp: Date.now() },
    ]);
  }, []);

  const run = useCallback(async (file3d: File, file2d: File) => {
    setStatus("uploading");
    setError(null);
    setMessages([]);
    setLiveThinking("");
    setCompletedTools(new Set());
    setActiveTool(null);
    setResults(null);
    finalResultsRef.current = null;
    finalSummaryRef.current = "";
    uploadResultRef.current = null;

    try {
      const sbClient = createSupabaseBrowserClient();
      const runId = crypto.randomUUID();
      const file3dPath = `uploads/${runId}/3d_${file3d.name}`;
      const file2dPath = `uploads/${runId}/2d_${file2d.name}`;

      const [up3d, up2d] = await Promise.all([
        sbClient.storage.from("parts").upload(file3dPath, file3d, {
          contentType: "application/step",
          upsert: true,
        }),
        sbClient.storage.from("parts").upload(file2dPath, file2d, {
          contentType: file2d.type || "application/octet-stream",
          upsert: true,
        }),
      ]);

      if (up3d.error) throw new Error(`3D upload failed: ${up3d.error.message}`);
      if (up2d.error) throw new Error(`2D upload failed: ${up2d.error.message}`);

      const registerRes = await fetch("/api/upload/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysis_id: runId,
          file_3d_path: file3dPath,
          file_2d_path: file2dPath,
          file_name: file3d.name,
          approach: 2,
        }),
      });
      if (!registerRes.ok) {
        const d = await registerRes.json();
        throw new Error(d.error || "Registration failed");
      }
      const uploadResult = await registerRes.json();
      uploadResultRef.current = uploadResult;
      setAnalysisId(uploadResult.analysis_id);

      const [sign3d, sign2d] = await Promise.all([
        sbClient.storage.from("parts").createSignedUrl(file3dPath, 3600),
        sbClient.storage.from("parts").createSignedUrl(file2dPath, 3600),
      ]);
      if (sign3d.error) throw new Error(`Signed URL for 3D failed: ${sign3d.error.message}`);
      if (sign2d.error) throw new Error(`Signed URL for 2D failed: ${sign2d.error.message}`);

      // Start streaming
      setStatus("streaming");
      const controller = new AbortController();
      abortRef.current = controller;

      const resp = await startApproach2Stream(
        {
          analysis_id: uploadResult.analysis_id,
          drawing_url: sign2d.data!.signedUrl,
          step_url: sign3d.data!.signedUrl,
          file_name: file3d.name,
        },
        controller.signal
      );

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let localThinking = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEBuffer(buffer);
        buffer = remaining;

        for (const { event, data } of events) {
          try {
            const parsed = JSON.parse(data);
            switch (event) {
              case "agent_start":
              case "agent_message":
                addMsg(event, parsed);
                break;

              case "status":
                setMessages((prev) => {
                  const updated = prev.map((m) => {
                    if (
                      m.type === "status" &&
                      !(m.data as Record<string, unknown>).completed &&
                      !(m.data as Record<string, unknown>).failed
                    ) {
                      return { ...m, data: { ...m.data, completed: true } };
                    }
                    return m;
                  });
                  return [
                    ...updated,
                    {
                      id: crypto.randomUUID(),
                      type: "status",
                      data: parsed,
                      timestamp: Date.now(),
                    },
                  ];
                });
                break;

              case "thinking":
                localThinking += parsed.content || "";
                setLiveThinking(localThinking);
                break;

              case "tool_call":
                if (localThinking) {
                  addMsg("thinking", { content: localThinking, iteration: parsed.iteration });
                  setLiveThinking("");
                  localThinking = "";
                }
                setActiveTool(parsed.tool);
                addMsg("tool_call", parsed);
                break;

              case "tool_result":
                if (parsed.tool === "analyze_drawing" && localThinking) {
                  addMsg("thinking", { content: localThinking, iteration: 1 });
                  setLiveThinking("");
                  localThinking = "";
                }
                setActiveTool(null);
                setCompletedTools((prev) => new Set(prev).add(parsed.tool));
                setMessages((prev) => {
                  const tool = parsed.tool as string;
                  const hasErr = !!(parsed.result as Record<string, unknown>)?.error;
                  const statusTitle = TOOL_TO_STATUS_TITLE[tool];
                  let replacedCall = false;

                  const next = prev.map((m) => {
                    if (
                      statusTitle &&
                      m.type === "status" &&
                      (m.data as Record<string, unknown>).title === statusTitle &&
                      !(m.data as Record<string, unknown>).completed &&
                      !(m.data as Record<string, unknown>).failed
                    ) {
                      return {
                        ...m,
                        data: { ...m.data, completed: !hasErr, failed: hasErr },
                      };
                    }
                    if (m.type === "tool_call" && (m.data as Record<string, unknown>).tool === tool) {
                      replacedCall = true;
                      return { ...m, type: "tool_result", data: { ...m.data, ...parsed } };
                    }
                    return m;
                  });

                  if (!replacedCall) {
                    next.push({
                      id: crypto.randomUUID(),
                      type: "tool_result",
                      data: parsed,
                      timestamp: Date.now(),
                    });
                  }
                  return next;
                });
                break;

              case "final_answer":
                if (localThinking) {
                  addMsg("thinking", { content: localThinking });
                  setLiveThinking("");
                  localThinking = "";
                }
                setResults(parsed.results || null);
                finalResultsRef.current = parsed.results || null;
                finalSummaryRef.current = parsed.summary || "";
                addMsg("final_answer", parsed);
                break;

              case "done":
                addMsg("done", parsed);
                setStatus("done");
                if (uploadResultRef.current?.analysis_id && finalResultsRef.current) {
                  fetch("/api/save-result", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      analysis_id: uploadResultRef.current.analysis_id,
                      results: finalResultsRef.current,
                      summary: finalSummaryRef.current || "",
                    }),
                  }).catch((e) => console.warn("[save-result] failed:", e));
                }
                break;

              case "error":
                if (localThinking) {
                  addMsg("thinking", { content: localThinking });
                  setLiveThinking("");
                  localThinking = "";
                }
                setStatus("error");
                addMsg("error", parsed);
                break;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setError(msg);
        setStatus("error");
        addMsg("error", { message: msg });
      }
    } finally {
      if (status !== "done") {
        setStatus((s) => (s === "uploading" || s === "streaming" ? "error" : s));
      }
      setActiveTool(null);
      abortRef.current = null;
    }
  }, [addMsg]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    addMsg("error", { message: "Processing cancelled." });
    setLiveThinking("");
    setStatus("error");
  }, [addMsg]);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setAnalysisId(null);
    setMessages([]);
    setLiveThinking("");
    setCompletedTools(new Set());
    setActiveTool(null);
    setResults(null);
    finalResultsRef.current = null;
    finalSummaryRef.current = "";
    uploadResultRef.current = null;
  }, []);

  return {
    status,
    error,
    analysisId,
    messages,
    liveThinking,
    completedTools,
    activeTool,
    results,
    run,
    cancel,
    reset,
    isStreaming: status === "streaming",
    isLoading: status === "uploading",
    isDone: status === "done",
    hasError: status === "error",
  };
}
