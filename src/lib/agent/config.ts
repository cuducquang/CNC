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
  const isLocalModel = !!perModelEnvUrl; // true = local Ollama, false = cloud

  const resolvedAgentUrl =
    perModelEnvUrl ||
    agentUrlOverride ||
    process.env.AGENT_MODEL_URL ||
    process.env.VL_MODEL_API_URL ||
    "http://localhost:11434";

  return {
    agentModelUrl:  resolvedAgentUrl,
    agentModelName: agentModelOverride
                    || process.env.AGENT_MODEL_NAME
                    || process.env.VL_MODEL_NAME
                    || "qwen3-vl:235b-cloud", // internal model ID, not shown directly
    agentApiKey:    process.env.AGENT_API_KEY || process.env.VL_MODEL_API_KEY || "",

    // When a local model is selected, route vision to the SAME local Ollama endpoint
    // so the pipeline does not depend on the cloud at all.
    // When a cloud model is selected, use the VL_MODEL_* env vars (api.ollama.com).
    visionModelUrl:  isLocalModel ? resolvedAgentUrl  : (process.env.VL_MODEL_API_URL  || "http://localhost:11434"),
    visionModelName: isLocalModel ? (agentModelOverride || "qwen3-vl:8b")
                                  : (process.env.VL_MODEL_NAME || "qwen3-vl:235b-cloud"),
    visionApiKey:    isLocalModel ? "" : (process.env.VL_MODEL_API_KEY || ""),

    maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || "12"),
    temperature:   parseFloat(process.env.AGENT_TEMPERATURE  || "0.2"),
  };
}
