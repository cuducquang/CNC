/**
 * Agent type definitions for the CNC Costing Agentic AI system.
 *
 * Two-model architecture:
 *   - Agent/Orchestrator model: Text-based with tool calling (e.g., qwen2.5:72b)
 *   - Vision model: Qwen3-VL for image analysis (used by analyze_drawing tool)
 */

// ---------------------------------------------------------------------------
// Tool calling types (OpenAI/Ollama compatible)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameter>;
      required?: string[];
    };
  };
}

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
}

// ---------------------------------------------------------------------------
// Chat message types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  images?: string[];
}

// ---------------------------------------------------------------------------
// Agent event stream types (sent via SSE to frontend)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent_start"; data: { message: string } }
  | { type: "thinking"; data: { content: string; iteration: number } }
  | { type: "tool_call"; data: { tool: string; args: Record<string, unknown>; iteration: number } }
  | { type: "tool_result"; data: { tool: string; result: Record<string, unknown>; duration_ms: number } }
  | { type: "agent_message"; data: { content: string; iteration: number } }
  | { type: "final_answer"; data: { summary: string; results: Record<string, unknown> } }
  | { type: "status"; data: { step: number; title: string; message: string } }
  | { type: "error"; data: { message: string } };

// ---------------------------------------------------------------------------
// Agent results (structured output from the agent)
// ---------------------------------------------------------------------------

export interface AgentResults {
  features: ExtractedFeature[];
  gdt_callouts: GDTCallout[];
  material: MaterialInfo | null;
  processes: MappedProcess[];
  cycle_time: CycleTimeBreakdown;
  cost: CostBreakdown;
  agent_reasoning: string;
}

export interface ExtractedFeature {
  id: string;
  type: string;
  mfg_type: string;
  description: string;
  quantity: number;
  dimensions: Record<string, number | string>;
  tolerance?: {
    type: string;
    plus: number;
    minus: number;
  };
  tolerance_class: string;
  geometry: Record<string, number>;
}

export interface GDTCallout {
  feature_id: string;
  symbol: string;
  tolerance: number;
  unit: string;
  datums: string[];
}

export interface MaterialInfo {
  name: string;
  specification: string;
  hardness_bhn: number;
  sfm_hss: number;
  sfm_carbide: number;
  feed_factor: number;
  density_lb_in3: number;
  cost_per_lb: number;
}

export interface MappedProcess {
  id: string;
  operation: string;
  label: string;
  feature_id: string;
  quantity: number;
  tool: {
    key: string;
    type: string;
    diameter: number;
    material: string;
    teeth: number;
  };
  params: {
    spindle_rpm: number;
    feed_rate_ipm: number;
    feed_per_tooth: number;
  };
  toolpath_distance_in: number;
}

export interface CycleTimeBreakdown {
  method: string;
  total_minutes: number;
  breakdown: Array<{
    process: string;
    minutes: number;
    category: string;
  }>;
}

export interface CostBreakdown {
  currency: string;
  total_usd: number;
  shop_rate_per_hour: number;
  overhead_pct: number;
  breakdown: Array<{
    line: string;
    amount_usd: number;
    category: string;
  }>;
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  agentModelUrl: string;
  agentModelName: string;
  visionModelUrl: string;
  visionModelName: string;
  maxIterations: number;
  temperature: number;
}

// ---------------------------------------------------------------------------
// Tool execution context (passed from orchestrator/fallback to every tool handler)
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** First page / single image (base64) */
  imageBase64?: string;
  /** All rasterized PDF pages (base64) */
  imageBase64Pages?: string[];
  /** Raw text content of the STEP file */
  stepFileContent?: string;
  /** Supabase analysis record ID */
  analysisId: string;
  /** Vision model endpoint — overrides LOCAL_OLLAMA_URL env var when set */
  visionModelUrl?: string;
  /** Vision model name — overrides AGENT_MODEL_NAME env var when set */
  visionModelName?: string;
}

// ---------------------------------------------------------------------------
// Agent run parameters
// ---------------------------------------------------------------------------

export interface AgentRunParams {
  analysisId: string;
  /** First page / single image — optional if imageBase64Pages is set */
  imageBase64?: string;
  /** All rasterized PDF pages (or one entry for a single image upload) */
  imageBase64Pages?: string[];
  stepFileContent?: string;
  fileName: string;
  /** Override the agent/orchestrator model (leaves vision model unchanged) */
  agentModel?: string;
  /** Base URL for the selected model's endpoint (e.g. http://localhost:11434) */
  agentModelUrl?: string;
}
