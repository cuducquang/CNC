/**
 * Model registry — vLLM OpenAI-compatible endpoint.
 * Model served via vLLM on RunPod (RTX PRO 6000 Blackwell).
 */

export interface ModelDefinition {
  /** Model identifier passed to the API */
  id: string;
  /** Short human-readable name */
  name: string;
  /** Parameter count label */
  params: string;
  /** One-line description shown in the UI */
  description: string;
  /** Hard-coded base URL for the inference endpoint */
  baseUrl: string;
  /** Env var that overrides baseUrl */
  baseUrlEnv?: string;
  /** Whether this is the current default model */
  isDefault?: boolean;
}

export const AGENT_MODELS: ModelDefinition[] = [
  {
    id:          "/workspace/models/Qwen3-VL-32B-Thinking-FP8",
    name:        "Qwen3-VL 32B Thinking",
    params:      "32B",
    description: "State-of-the-art vision-language model with extended reasoning for complex engineering drawings.",
    baseUrl:     "http://localhost:11434",
    baseUrlEnv:  "LOCAL_OLLAMA_URL",
    isDefault:   true,
  },
];

export const DEFAULT_MODEL_ID = "/workspace/models/Qwen3-VL-32B-Thinking-FP8";

export function getModelById(id: string): ModelDefinition | undefined {
  return AGENT_MODELS.find((m) => m.id === id);
}
