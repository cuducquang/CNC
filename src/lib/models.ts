/**
 * Model registry — all available agent/orchestrator models.
 */

export interface ModelDefinition {
  /** Ollama model tag or API model ID (passed to the API as `model`) */
  id: string;
  /** Short human-readable name */
  name: string;
  /** Parameter count label */
  params: string;
  /** One-line description shown under the dropdown */
  description: string;
  /**
   * Default base URL for this model's endpoint.
   * Empty string = fall through to AGENT_MODEL_URL env var (api.ollama.com).
   */
  baseUrl: string;
  /**
   * Env var that overrides baseUrl in production.
   *   Qwen3-VL → AGENT_MODEL_URL (api.ollama.com)
   *   Groq     → GROQ_URL
   *   Gemini   → GEMINI_URL
   */
  baseUrlEnv?: string;
  /**
   * API wire format:
   *   "ollama"  — POST /api/chat   (default)
   *   "openai"  — POST /v1/chat/completions (or chatPath override)
   */
  apiFormat?: "ollama" | "openai";
  /** Env var holding the API key for this model. Falls back to VL_MODEL_API_KEY. */
  apiKeyEnv?: string;
  /**
   * Whether this Ollama-format model supports extended thinking (think: true).
   * Defaults to true. OpenAI-format models never receive this flag.
   */
  supportsThinking?: boolean;
  /**
   * Override the OpenAI-format chat completions path.
   * Use when the provider's path differs from the standard /v1/chat/completions.
   * e.g. Google Gemini uses /chat/completions (no /v1/ prefix).
   */
  chatPath?: string;
  /** Whether this is the current default model */
  isDefault?: boolean;
}

export const AGENT_MODELS: ModelDefinition[] = [
  // ── Qwen3-VL on api.ollama.com ───────────────────────────────────────────────
  {
    id:               "qwen3-vl:235b-cloud",
    name:             "Qwen3-VL 235B",
    params:           "235B",
    description:      "Highest accuracy. Best for production costing — extended thinking, native tool calling.",
    baseUrl:          "",
    supportsThinking: true,
    isDefault:        true,
  },

  // ── Free Cloud — OpenAI-compatible APIs ─────────────────────────────────────
  {
    id:        "gemini-2.5-flash",
    name:      "Gemini 2.5 Flash",
    params:    "—",
    description: "Google's fast multimodal model",
    baseUrl:   "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlEnv: "GEMINI_URL",
    apiFormat: "openai",
    apiKeyEnv: "GEMINI_API_KEY",
    chatPath:  "/chat/completions",   // Google omits /v1/ prefix vs standard OpenAI path
  },
  {
    id:        "meta-llama/llama-4-scout-17b-16e-instruct",
    name:      "Llama 4 Scout",
    params:    "17B",
    description: "Ultra-fast inference on Groq hardware.",
    baseUrl:   "https://api.groq.com/openai",
    baseUrlEnv: "GROQ_URL",
    apiFormat: "openai",
    apiKeyEnv: "GROQ_API_KEY",
  },
];

export const DEFAULT_MODEL_ID = "qwen3-vl:235b-cloud";

export function getModelById(id: string): ModelDefinition | undefined {
  return AGENT_MODELS.find((m) => m.id === id);
}
