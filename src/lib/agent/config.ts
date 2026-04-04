/**
 * Agent configuration — reads env vars and returns a typed AgentConfig.
 *
 * URL resolution order:
 *   1. Model's dedicated env var (LOCAL_OLLAMA_URL) — set this to the ngrok URL
 *   2. agentUrlOverride passed from route.ts (model's hardcoded baseUrl)
 *   3. LOCAL_OLLAMA_URL global fallback
 *   4. AGENT_MODEL_URL global fallback
 *   5. Hard fallback: http://localhost:11434
 *
 * Both agent and vision always use the same local Ollama endpoint and model.
 */

import type { AgentConfig } from "./types";
import { getModelById } from "@/lib/models";

export function getAgentConfig(agentModelOverride?: string, agentUrlOverride?: string): AgentConfig {
  const modelDef = agentModelOverride ? getModelById(agentModelOverride) : undefined;
  const perModelEnvUrl = modelDef?.baseUrlEnv ? (process.env[modelDef.baseUrlEnv] || "") : "";

  const resolvedUrl = (
    perModelEnvUrl ||
    agentUrlOverride ||
    process.env.LOCAL_OLLAMA_URL ||
    process.env.AGENT_MODEL_URL ||
    "http://localhost:11434"
  ).trim();

  // Only use AGENT_MODEL_NAME if it's a known local model.
  // Old cloud model names (e.g. qwen3-vl:235b-cloud) are not valid Ollama models.
  const envModelName = process.env.AGENT_MODEL_NAME || "";
  const modelName = (
    agentModelOverride ||
    (getModelById(envModelName) ? envModelName : "") ||
    "qwen3-vl:8b"
  ).trim();

  return {
    agentModelUrl:   resolvedUrl,
    agentModelName:  modelName,
    visionModelUrl:  resolvedUrl,
    visionModelName: modelName,
    maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || "12"),
    temperature:   parseFloat(process.env.AGENT_TEMPERATURE  || "0.2"),
  };
}
