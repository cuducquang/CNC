/**
 * Agent Orchestrator — the core agentic AI loop.
 *
 * Uses vLLM/Ollama with tool calling to orchestrate the CNC costing pipeline.
 *
 * IMPORTANT: This orchestrator is designed for production reliability.
 * Every external call (model API, tool execution) is wrapped in error
 * handling.  If the agentic loop fails for ANY reason the caller
 * (route.ts) catches the error and transparently falls back to the
 * deterministic pipeline — the user always gets results.
 */

import type { AgentEvent, AgentRunParams, ChatMessage, ToolCall } from "./types";
import { getAgentConfig } from "./config";
import { AGENT_SYSTEM_PROMPT, buildUserMessage } from "./prompts";
import { TOOL_DEFINITIONS, executeToolCall } from "../tools/index";
import { buildPipelineResults } from "../pipeline-results";
import { mapCncProcesses   } from "../tools/map-processes";
import { estimateCycleTime } from "../tools/estimate-cycle-time";
import { estimateCost      } from "../tools/estimate-cost";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the selected model cannot be reached or rejects the request
 * at the HTTP level (4xx/5xx other than recoverable 400/422 tool-format errors).
 * route.ts catches this and surfaces the error to the user instead of
 * falling back to the default vision model.
 */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Ollama chat API — with full error recovery
// ---------------------------------------------------------------------------

interface OllamaResponse {
  content:   string;
  toolCalls: ToolCall[];
  done:      boolean;
  streamInterrupted?: boolean;
}

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes per model call

function formatFetchError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; errno?: string; address?: string; port?: number } };
  const base = e?.message || "fetch failed";
  const code = e?.cause?.code || e?.cause?.errno;
  const addr = e?.cause?.address;
  const port = e?.cause?.port;
  if (code || addr || port) {
    return `${base} [${[code, addr, port].filter(Boolean).join(" ")}]`;
  }
  return base;
}

function buildCandidateBaseUrls(rawBaseUrl: string): string[] {
  const cleaned = rawBaseUrl.replace(/\/+$/, "");
  const candidates = [cleaned];

  try {
    const parsed = new URL(cleaned);
    if (parsed.hostname === "localhost") {
      const loopback = new URL(parsed.toString());
      loopback.hostname = "127.0.0.1";
      candidates.push(loopback.toString().replace(/\/+$/, ""));
    }
  } catch {
    // Keep only the original value when URL parsing fails.
  }

  return Array.from(new Set(candidates));
}

async function callOllamaWithTools(
  messages: ChatMessage[],
  tools: typeof TOOL_DEFINITIONS,
  config: ReturnType<typeof getAgentConfig>,
): Promise<OllamaResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const modelName = config.agentModelName;

  // Ollama format: tool_calls.arguments must be an object (not a JSON string).
  const sanitisedMessages = messages.map((m) => {
    const msg: Record<string, unknown> = {
      role:    m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 50_000) : (m.content ?? ""),
    };
    if (m.tool_calls) {
      msg.tool_calls = m.tool_calls.map((tc) => ({
        function: {
          name:      tc.function.name,
          arguments: (() => {
            try {
              const a = tc.function.arguments;
              return typeof a === "string" ? JSON.parse(a) : a;
            } catch { return {}; }
          })(),
        },
      }));
    }
    if (m.images) msg.images = m.images;
    return msg;
  });

  const payload = {
    model:    modelName,
    messages: sanitisedMessages,
    tools,
    think:    false,   // Disable chain-of-thought — small models waste context on thinking tokens
    stream:   true,
    options:  { temperature: config.temperature },
  };

  const apiPath = "/api/chat";

  const candidateBaseUrls = buildCandidateBaseUrls(config.agentModelUrl);
  let response: Response | undefined;
  let lastNetworkError: Error | undefined;

  for (const baseUrl of candidateBaseUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(`${baseUrl}${apiPath}`, {
        method:  "POST",
        headers,
        body:    JSON.stringify(payload),
        signal:  controller.signal,
      });
      if (baseUrl !== config.agentModelUrl) {
        console.warn(`[Agent] Connected to model via fallback URL: ${baseUrl}`);
      }
      break;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ModelUnavailableError("Agent model request timed out (120 s). The model may be overloaded or unreachable.");
      }
      lastNetworkError = new Error(formatFetchError(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!response) {
    const fallbackInfo = candidateBaseUrls.length > 1
      ? ` (also tried ${candidateBaseUrls.slice(1).join(", ")})`
      : "";
    throw new ModelUnavailableError(
      `Cannot reach agent model at ${config.agentModelUrl}${fallbackInfo}: ${lastNetworkError?.message || "fetch failed"}`,
    );
  }

  // 400/422 errors are typically caused by malformed tool call arguments.
  // Return a "done" response so the loop can finalise with partial results.
  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const status  = response.status;
    if (status === 400 || status === 422) {
      console.warn(`[Agent] Model returned ${status} (recoverable): ${errBody.slice(0, 200)}`);
      return {
        content:   "I encountered a model processing error. Let me provide results based on what I have gathered so far.",
        toolCalls: [],
        done: true,
      };
    }
    throw new ModelUnavailableError(`Agent model returned HTTP ${status}: ${errBody.slice(0, 300)}`);
  }

  if (!response.body) throw new Error("No response body from agent model");

  // ---- Stream-read the response ----
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer       = "";
  let fullContent  = "";
  let toolCalls: (ToolCall | undefined)[] = [];
  let streamInterrupted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const jsonStr = line.startsWith("data: ") ? line.slice(6) : line;
        if (jsonStr === "[DONE]") break;
        try {
          const chunk = JSON.parse(jsonStr);
          // Ollama streaming format
          const msg = chunk.message || {};
          if (msg.content) fullContent += msg.content;

          if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            const parsedCalls: ToolCall[] = [];
            for (let i = 0; i < msg.tool_calls.length; i++) {
              const tc = msg.tool_calls[i];
              try {
                const rawArgs = tc.function?.arguments;
                const argsStr = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
                if (typeof rawArgs === "string") JSON.parse(rawArgs); // validate
                parsedCalls.push({
                  id:       `call_${Date.now()}_${i}`,
                  function: { name: tc.function.name, arguments: argsStr },
                });
              } catch {
                console.warn(`[Agent] Skipping malformed tool call: ${tc.function?.name}`);
              }
            }
            if (parsedCalls.length > 0) toolCalls = parsedCalls;
          }
          if (chunk.done) break;
        } catch { /* skip malformed JSON chunks */ }
      }
    }
  } catch (streamErr) {
    console.warn("[Agent] Stream read error (returning partial):", streamErr);
    streamInterrupted = true;
  }

  const validToolCalls = toolCalls.filter((tc): tc is ToolCall => !!tc);
  return {
    content: fullContent,
    toolCalls: validToolCalls,
    done: validToolCalls.length === 0,
    streamInterrupted,
  };
}

// ---------------------------------------------------------------------------
// Deterministic tail — runs steps 4-6 without a model call.
//
// Once recognize_features is done the remaining steps are pure data
// transformations (no reasoning needed). Bypassing the model avoids the
// stream-close errors that occur when the hosted inference endpoint
// terminates long-running connections mid-generation.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
async function* runDeterministicTail(
  accum: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
  const recognition = accum.recognize_features as Record<string, unknown>;

  // ── Step 4: Process mapping ────────────────────────────────────────────────
  yield { type: "status",    data: { step: 4, title: "Process Mapping",  message: "Mapping CNC operations and tooling..." } };
  yield { type: "tool_call", data: { tool: "map_cnc_processes", args: {}, iteration: 4 } };
  let processMap: Record<string, unknown> = {};
  const t4 = Date.now();
  try {
    processMap = await mapCncProcesses({ recognition_json: JSON.stringify(recognition) });
    accum.map_cnc_processes = processMap;
  } catch (err) {
    processMap = { error: err instanceof Error ? err.message : "Process mapping failed" };
  }
  yield { type: "tool_result", data: { tool: "map_cnc_processes", result: processMap, duration_ms: Date.now() - t4 } };

  // ── Step 5: Cycle time ─────────────────────────────────────────────────────
  yield { type: "status",    data: { step: 5, title: "Cycle Time", message: "Estimating machining cycle time..." } };
  yield { type: "tool_call", data: { tool: "estimate_cycle_time", args: {}, iteration: 5 } };
  const cycleArgs = !(processMap as any).error
    ? { method: "from_processes", process_map_json: JSON.stringify(processMap) }
    : { method: "from_features",  extraction_json:  JSON.stringify(accum.analyze_drawing ?? {}) };
  let cycleTime: Record<string, unknown> = {};
  const t5 = Date.now();
  try {
    cycleTime = await estimateCycleTime(cycleArgs);
    accum.estimate_cycle_time = cycleTime;
  } catch (err) {
    cycleTime = { error: err instanceof Error ? err.message : "Cycle time estimation failed" };
  }
  yield { type: "tool_result", data: { tool: "estimate_cycle_time", result: cycleTime, duration_ms: Date.now() - t5 } };

  if ((cycleTime as any).error) {
    yield { type: "final_answer", data: { summary: "Cycle time estimation failed.", results: buildPipelineResults(accum) } };
    return;
  }

  // ── Step 6: Cost estimation ────────────────────────────────────────────────
  yield { type: "status",    data: { step: 6, title: "Cost Estimation", message: "Calculating fabrication cost..." } };
  yield { type: "tool_call", data: { tool: "estimate_cost", args: {}, iteration: 6 } };
  let cost: Record<string, unknown> = {};
  const t6 = Date.now();
  try {
    cost = await estimateCost({ cycle_time_json: JSON.stringify(cycleTime) });
    accum.estimate_cost = cost;
  } catch (err) {
    cost = { error: err instanceof Error ? err.message : "Cost estimation failed" };
  }
  yield { type: "tool_result", data: { tool: "estimate_cost", result: cost, duration_ms: Date.now() - t6 } };

  const featCount = (recognition.feature_count as number) || 0;
  const totalMin  = ((cycleTime as any).total_minutes as number) || 0;
  const totalUsd  = ((cost      as any).total_usd     as number) || 0;

  yield {
    type: "final_answer",
    data: {
      summary: `Analysis complete. ${featCount} feature${featCount !== 1 ? "s" : ""} detected. Cycle time: ${totalMin.toFixed(1)} min. Cost: USD ${totalUsd.toFixed(2)}.`,
      results: buildPipelineResults(accum),
    },
  };
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function* runAgent(params: AgentRunParams): AsyncGenerator<AgentEvent> {
  const config = getAgentConfig(params.agentModel, params.agentModelUrl);

  yield {
    type: "agent_start",
    data: { message: `Starting agentic analysis with ${config.agentModelName.replace(/-cloud$/, "")}. The AI will reason about each step and call tools as needed.` },
  };

  // Attach drawing images directly to the first user message so the vision
  // model can SEE the drawing, not just be told it exists. Cap at 2 pages to
  // keep the payload reasonable.
  const drawingImages: string[] =
    params.imageBase64Pages && params.imageBase64Pages.length > 0
      ? params.imageBase64Pages.slice(0, 2)
      : params.imageBase64
        ? [params.imageBase64]
        : [];
  const attachImagesToAgent = process.env.AGENT_ATTACH_IMAGES === "true";

  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserMessage({
        fileName:    params.fileName,
        hasImage:    drawingImages.length > 0,
        hasStepFile: !!params.stepFileContent,
      }),
      ...(attachImagesToAgent && drawingImages.length > 0 ? { images: drawingImages } : {}),
    },
  ];

  let iteration = 0;
  let consecutiveModelErrors = 0;
  let consecutiveInterruptedTurns = 0;
  const MAX_MODEL_ERRORS = 2;
  const MAX_INTERRUPTED_TURNS = 3;
  const toolResultsAccum: Record<string, unknown> = {};

  const hasCompletedPipeline = () =>
    !!toolResultsAccum.recognize_features &&
    !!toolResultsAccum.estimate_cycle_time &&
    !!toolResultsAccum.estimate_cost;

  while (iteration < config.maxIterations) {
    iteration++;

    yield {
      type: "status",
      data: {
        step:    iteration,
        title:   `Agent Iteration ${iteration}`,
        message: iteration === 1 ? "Agent is analyzing the task..." : "Agent is reasoning about next steps...",
      },
    };

    // ---- Call the model ----
    let response: OllamaResponse;
    try {
      response = await callOllamaWithTools(messages, TOOL_DEFINITIONS, config);
      consecutiveModelErrors = 0;
    } catch (modelErr) {
      // ModelUnavailableError means the endpoint is broken — don't retry, propagate immediately.
      if (modelErr instanceof ModelUnavailableError) throw modelErr;

      consecutiveModelErrors++;
      const errMsg = modelErr instanceof Error ? modelErr.message : String(modelErr);
      console.error(`[Agent] Model call failed (attempt ${consecutiveModelErrors}):`, errMsg);

      if (consecutiveModelErrors >= MAX_MODEL_ERRORS) {
        throw new Error(`Agent model failed after ${MAX_MODEL_ERRORS} attempts: ${errMsg}`);
      }
      yield { type: "status", data: { step: iteration, title: "Retrying", message: "Model returned an error, retrying..." } };
      continue;
    }

    // ---- Process tool calls ----
    if (response.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: response.content || "", tool_calls: response.toolCalls });

      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = { raw: toolCall.function.arguments };
        }

        // Override large JSON pipeline arguments with the actual accumulated results.
        // Models like Gemini attempt to copy prior tool outputs into the next tool's
        // arguments, which produces malformed JSON at ~10KB+ due to escaping errors
        // or token-limit truncation. The orchestrator already holds the real data.
        if (toolName === "recognize_features") {
          if (toolResultsAccum.analyze_drawing)
            toolArgs.extraction_json = JSON.stringify(toolResultsAccum.analyze_drawing);
          if (toolResultsAccum.analyze_step_file)
            toolArgs.step_analysis_json = JSON.stringify(toolResultsAccum.analyze_step_file);
        }
        if (toolName === "map_cnc_processes" && toolResultsAccum.recognize_features) {
          toolArgs.recognition_json = JSON.stringify(toolResultsAccum.recognize_features);
        }
        if (toolName === "estimate_cycle_time") {
          if (toolResultsAccum.map_cnc_processes)
            toolArgs.process_map_json = JSON.stringify(toolResultsAccum.map_cnc_processes);
          else if (toolResultsAccum.analyze_drawing)
            toolArgs.extraction_json = JSON.stringify(toolResultsAccum.analyze_drawing);
        }
        if (toolName === "estimate_cost" && toolResultsAccum.estimate_cycle_time) {
          toolArgs.cycle_time_json = JSON.stringify(toolResultsAccum.estimate_cycle_time);
        }

        yield { type: "tool_call", data: { tool: toolName, args: toolArgs, iteration } };

        const startTime = Date.now();
        let result: Record<string, unknown>;
        try {
          result = await executeToolCall(toolName, toolArgs, {
            imageBase64:      params.imageBase64,
            imageBase64Pages: params.imageBase64Pages,
            stepFileContent:  params.stepFileContent,
            analysisId:       params.analysisId,
            visionModelUrl:   config.visionModelUrl,
            visionModelName:  config.visionModelName,
          });
        } catch (toolErr) {
          result = { error: toolErr instanceof Error ? toolErr.message : "Tool execution failed" };
        }

        const duration = Date.now() - startTime;
        if (!result.error) toolResultsAccum[toolName] = result;

        yield { type: "tool_result", data: { tool: toolName, result, duration_ms: duration } };

        // Fatal-error guard: if analyze_drawing fails, nothing downstream will work
        if (toolName === "analyze_drawing") {
          const hasError     = !!result.error;
          const zeroFeatures = !hasError && ((result.feature_count as number) || 0) === 0;
          const unparseable  = !hasError && !!result.raw_model_output;

          if (hasError || zeroFeatures || unparseable) {
            const errorMsg = (result.error as string) ||
              (unparseable
                ? "The vision model could not parse the drawing. Please upload a clearer 2D engineering drawing."
                : "No manufacturing features were detected in the drawing. Please ensure it is a clear 2D technical drawing.");
            yield { type: "error", data: { message: errorMsg } };
            yield { type: "final_answer", data: { summary: errorMsg, results: buildPipelineResults(toolResultsAccum) } };
            return;
          }

          // Strip images from message history now that drawing analysis is done.
          // Keeping base64 images in every subsequent API call inflates the payload
          // by ~2-4 MB and causes the remote model endpoint to close the socket.
          for (const msg of messages) {
            if (msg.images) delete msg.images;
          }
        }

        // Cap tool result content at 20 KB per message. recognize_features and
        // analyze_drawing can return large feature arrays; the model only needs
        // the summary to continue — the full result is in toolResultsAccum.
        const toolResultStr = JSON.stringify(result);
        const cappedContent = toolResultStr.length > 20_000
          ? toolResultStr.slice(0, 20_000) + '… [truncated]'
          : toolResultStr;
        messages.push({ role: "tool", content: cappedContent, tool_call_id: toolCall.id });

        // Once recognize_features is done the remaining three steps are pure
        // data transformations. Run them directly instead of returning to the
        // model — this avoids the stream-close errors that occur when hosted
        // inference endpoints drop long-running connections mid-generation.
        if (toolName === "recognize_features" && !result.error) {
          yield* runDeterministicTail(toolResultsAccum);
          return;
        }
      }
    } else {
      // ---- Model is done ----
      // Handle transient socket closures from the model API without resetting
      // pipeline progress. Retry the next model turn in-place.
      if (!hasCompletedPipeline() && response.streamInterrupted) {
        consecutiveInterruptedTurns++;
        if (consecutiveInterruptedTurns <= MAX_INTERRUPTED_TURNS) {
          yield {
            type: "status",
            data: {
              step: iteration,
              title: "Recovering Stream",
              message: "Model stream interrupted — retrying from current pipeline state...",
            },
          };
          continue;
        }
        throw new Error("Agent stream interrupted repeatedly before completing required pipeline steps.");
      }

      // If the model stops early (common when STEP/FreeCAD fails), force fallback
      // so the deterministic pipeline can continue with 2D-only recognition.
      if (!hasCompletedPipeline()) {
        throw new Error("Agent stopped before completing required pipeline steps.");
      }

      consecutiveInterruptedTurns = 0;

      if (response.content) {
        yield { type: "agent_message", data: { content: response.content, iteration } };
      }
      yield { type: "final_answer", data: { summary: response.content, results: buildPipelineResults(toolResultsAccum) } };
      return;
    }
  }

  // Max iterations reached
  if (!hasCompletedPipeline()) {
    throw new Error("Agent reached max iterations before completing required pipeline steps.");
  }

  yield {
    type: "final_answer",
    data: { summary: "Analysis completed (max iterations reached).", results: buildPipelineResults(toolResultsAccum) },
  };
}
