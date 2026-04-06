/**
 * Agent configuration — reads env vars and returns a typed AgentConfig.
 *
 * URL resolution order:
 *   1. Model's dedicated env var (LOCAL_OLLAMA_URL) — set to RunPod proxy URL
 *   2. agentUrlOverride passed from route.ts (model's hardcoded baseUrl)
 *   3. LOCAL_OLLAMA_URL global fallback
 *   4. Hard fallback: http://localhost:11434
 *
 * Both agent and vision use the same vLLM endpoint and model.
 */

import type { AgentConfig } from "./types";
import { getModelById, DEFAULT_MODEL_ID } from "@/lib/models";

export function getAgentConfig(agentModelOverride?: string, agentUrlOverride?: string): AgentConfig {
  const modelDef = agentModelOverride ? getModelById(agentModelOverride) : undefined;
  const perModelEnvUrl = modelDef?.baseUrlEnv ? (process.env[modelDef.baseUrlEnv] || "") : "";

  const resolvedUrl = (
    perModelEnvUrl ||
    agentUrlOverride ||
    process.env.LOCAL_OLLAMA_URL ||
    "http://localhost:11434"
  ).trim();

  const envModelName = process.env.VISION_MODEL || "";
  const modelName = (
    agentModelOverride ||
    (getModelById(envModelName) ? envModelName : "") ||
    DEFAULT_MODEL_ID
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
