export interface ManufacturingProcess {
  name: string;
  category: "setup" | "milling" | "drilling" | "threading" | "finishing" | "other";
  description: string;
}

export interface CycleTimeItem {
  process: string;
  time_minutes: number;
}

export interface CostItem {
  process: string;
  cost_usd: number;
}

export interface FeatureRecognitionResult {
  features: {
    id: string;
    name: string;
    type: string;
    description: string;
    dimensions?: Record<string, string>;
  }[];
  raw_response?: string;
}

export interface ProcessMappingResult {
  processes: ManufacturingProcess[];
  raw_response?: string;
}

export interface CycleTimeResult {
  items: CycleTimeItem[];
  total_minutes: number;
  raw_response?: string;
}

export interface CostEstimationResult {
  items: CostItem[];
  total_cost_usd: number;
  raw_response?: string;
}

export interface DimensionGDTResult {
  dimensions: {
    feature: string;
    nominal: string;
    tolerance_plus?: string;
    tolerance_minus?: string;
    unit: string;
  }[];
  gdt_callouts: {
    feature: string;
    type: string;
    value: string;
    datum?: string;
  }[];
  raw_response?: string;
}

export interface AnalysisResult {
  id?: string;
  created_at?: string;
  file_name: string;
  file_3d_path?: string;
  file_2d_path?: string;
  status: "pending" | "processing" | "completed" | "error";
  feature_recognition?: FeatureRecognitionResult;
  process_mapping?: ProcessMappingResult;
  cycle_time?: CycleTimeResult;
  cost_estimation?: CostEstimationResult;
  dimension_gdt?: DimensionGDTResult;
  error_message?: string;
}

export interface UploadResponse {
  analysis_id: string;
  file_3d_url?: string;
  file_2d_url?: string;
}

export interface VLModelRequest {
  image_url?: string;
  file_content?: string;
  prompt: string;
  model?: string;
}

export interface VLModelResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}
