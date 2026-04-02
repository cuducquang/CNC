/**
 * Agent configuration — reads env vars and returns a typed AgentConfig.
 *
 * URL resolution order for agentModelUrl:
 *   1. Model's dedicated env var (e.g. LOCAL_OLLAMA_URL for qwen3-vl:8b)
 *   2. Model's hard-coded baseUrl (local dev default, e.g. http://localhost:11434)
 *   3. Global AGENT_MODEL_URL / VL_MODEL_API_URL env vars
 *   4. Hard fallback: http://localhost:11434
 *
 * This lets each model route to a different endpoint via env vars:
 *   235B cloud  → AGENT_MODEL_URL=https://api.ollama.com
 *   8B local    → LOCAL_OLLAMA_URL=https://<runpod-id>-11434.proxy.runpod.net
 */

import type { AgentConfig } from "./types";
import { getModelById } from "@/lib/models";

export function getAgentConfig(agentModelOverride?: string, agentUrlOverride?: string): AgentConfig {
  // Resolve the model's dedicated env var (e.g. LOCAL_OLLAMA_URL for qwen3-vl:8b).
  // A non-empty value here means the user picked a local/self-hosted model.
  const modelDef = agentModelOverride ? getModelById(agentModelOverride) : undefined;
  const perModelEnvUrl = modelDef?.baseUrlEnv ? (process.env[modelDef.baseUrlEnv] || "") : "";

  const resolvedAgentUrl = (
    perModelEnvUrl ||
    agentUrlOverride ||
    process.env.AGENT_MODEL_URL ||
    process.env.VL_MODEL_API_URL ||
    "http://localhost:11434"
  ).trim();

  // Model-specific API key (e.g. TOGETHER_AI_API_KEY, GROQ_API_KEY), else global key
  const modelApiKey = modelDef?.apiKeyEnv
    ? (process.env[modelDef.apiKeyEnv] || "").trim()
    : "";
  const resolvedApiKey = (modelApiKey || process.env.AGENT_API_KEY || process.env.VL_MODEL_API_KEY || "").trim();

  const agentApiFormat: "ollama" | "openai" = modelDef?.apiFormat ?? "ollama";
  const supportsThinking = modelDef?.supportsThinking !== false; // default true
  const chatPath = modelDef?.chatPath; // undefined = use default /v1/chat/completions

  return {
    agentModelUrl:  resolvedAgentUrl,
    agentModelName: (agentModelOverride
                    || process.env.AGENT_MODEL_NAME
                    || process.env.VL_MODEL_NAME
                    || "qwen3-vl:235b-cloud").trim(),
    agentApiKey:    resolvedApiKey,
    agentApiFormat,
    supportsThinking,
    ...(chatPath ? { agentChatPath: chatPath } : {}),

    // Vision model routing:
    //   Explicit model selected → use the same model/endpoint/key/path for vision
    //   No model selected (default qwen3-vl:235b) → use VL_MODEL_* env vars
    ...(agentModelOverride
      ? {
          visionModelUrl:   resolvedAgentUrl,
          visionModelName:  agentModelOverride.replace(/-cloud$/, ""),
          visionApiKey:     resolvedApiKey,
          visionApiFormat:  agentApiFormat,
          ...(chatPath ? { visionChatPath: chatPath } : {}),
        }
      : {
          visionModelUrl:   (process.env.VL_MODEL_API_URL  || "http://localhost:11434").trim(),
          visionModelName:  (process.env.VL_MODEL_NAME     || "qwen3-vl:235b-cloud").trim(),
          visionApiKey:     (process.env.VL_MODEL_API_KEY  || "").trim(),
          visionApiFormat:  "ollama" as const,
        }),

    maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || "12"),
    temperature:   parseFloat(process.env.AGENT_TEMPERATURE  || "0.2"),
  };
}
