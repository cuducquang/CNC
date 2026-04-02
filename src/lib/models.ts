/**
 * Model registry — all available agent/orchestrator models.
 *
 * These are the models offered in the agent model dropdown and benchmark page.
 * Each model must support:
 *   - Tool calling (function calling via Ollama/vLLM OpenAI-compat API)
 *   - Vision (images attached to user message for drawing context)
 *   - Streaming chat completions
 *
 * The vision model used by analyze_drawing is NOT changed here — it stays
 * fixed from env (VL_MODEL_NAME) so benchmark results are comparable across agents.
 */

export interface ModelDefinition {
  /** Ollama model tag (passed to the API as `model`) */
  id: string;
  /** Short human-readable name */
  name: string;
  /** Parameter count label */
  params: string;
  /** One-line description shown under the dropdown */
  description: string;
  /**
   * Default base URL for this model's Ollama endpoint (used in local dev).
   * Empty string = fall through to AGENT_MODEL_URL env var.
   */
  baseUrl: string;
  /**
   * Name of the env var that overrides baseUrl in production.
   * Lets each model route to a different endpoint without touching code.
   *   235B cloud → AGENT_MODEL_URL  (api.ollama.com)
   *   8B  local  → LOCAL_OLLAMA_URL (RunPod proxy URL)
   */
  baseUrlEnv?: string;
  /** Whether this is the current default model */
  isDefault?: boolean;
}

export const AGENT_MODELS: ModelDefinition[] = [
  {
    id:          "qwen3-vl:235b-cloud",
    name:        "Qwen3-VL 235B",
    params:      "235B",
    description: "Highest accuracy. Best for production costing — extended thinking, native tool calling.",
    baseUrl:     "",               // uses AGENT_MODEL_URL env var
    isDefault:   true,
  },
  // Local model temporarily disabled — IPv6/Docker networking issue pending fix
  // {
  //   id:          "qwen3-vl:8b",
  //   name:        "Qwen3-VL 8B (Local)",
  //   params:      "8B",
  //   description: "Fast local inference via Ollama. Set LOCAL_OLLAMA_URL for RunPod deployment.",
  //   baseUrl:     "http://localhost:11434",
  //   baseUrlEnv:  "LOCAL_OLLAMA_URL",
  // },
];

export const DEFAULT_MODEL_ID = "qwen3-vl:235b-cloud";

export function getModelById(id: string): ModelDefinition | undefined {
  return AGENT_MODELS.find((m) => m.id === id);
}
