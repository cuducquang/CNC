/**
 * Model registry — local Ollama models only.
 * All models run on local Ollama (localhost:11434 or ngrok via LOCAL_OLLAMA_URL).
 */

export interface ModelDefinition {
  /** Ollama model tag (passed to Ollama API as `model`) */
  id: string;
  /** Short human-readable name */
  name: string;
  /** Parameter count label */
  params: string;
  /** One-line description shown under the dropdown */
  description: string;
  /**
   * Hard-coded base URL for local Ollama.
   * Overridden by the env var in baseUrlEnv (e.g. LOCAL_OLLAMA_URL for ngrok).
   */
  baseUrl: string;
  /**
   * Env var that overrides baseUrl (e.g. LOCAL_OLLAMA_URL=https://xxx.ngrok.io).
   */
  baseUrlEnv?: string;
  /** Whether this is the current default model */
  isDefault?: boolean;
}

export const AGENT_MODELS: ModelDefinition[] = [
  {
    id:          "qwen3-vl:4b",
    name:        "Qwen3-VL 4B — Thinking",
    params:      "4B",
    description: "Recommended. Thinking mode — streams reasoning live while reading the drawing.",
    baseUrl:     "http://localhost:11434",
    baseUrlEnv:  "LOCAL_OLLAMA_URL",
    isDefault:   true,
  },
  {
    id:          "qwen3-vl-nothink:4b",
    name:        "Qwen3-VL 4B — Fast",
    params:      "4B",
    description: "No thinking mode — writes JSON directly. Faster, no live reasoning stream.",
    baseUrl:     "http://localhost:11434",
    baseUrlEnv:  "LOCAL_OLLAMA_URL",
  },
];

export const DEFAULT_MODEL_ID = "qwen3-vl:4b";

export function getModelById(id: string): ModelDefinition | undefined {
  return AGENT_MODELS.find((m) => m.id === id);
}
