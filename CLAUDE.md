# CNCapp — Project Context for Claude Code Agent Teams

## Project Overview
AI-powered CNC machining cost estimator. User uploads a 2D drawing PDF + a 3D STEP file → gets back features, operations, cycle time, and cost estimate.

Two parallel approaches:
- **Approach 1 (LLM)**: Qwen3-VL-32B handles every step via separate endpoint calls. Test page at `/v1`.
- **Approach 2 (FreeCAD)**: Deterministic Python pipeline (FreeCAD STEPAnalyzer → process_mapper → cycle_time_tool → cost formula). Main page at `/`.

---

## Tech Stack
| Layer | Technology |
|---|---|
| Frontend | Next.js 14 App Router, TypeScript, Tailwind CSS |
| Backend | FastAPI (Python 3), two separate servers |
| LLM | Qwen3-VL-32B via vLLM OpenAI-compat API (remote RunPod) |
| Storage | Supabase (file uploads → signed URLs) |
| Auth | Supabase Auth |
| Container | Docker Compose (3 services) |

---

## Directory Structure
```
CNCapp/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Approach 2 main UI
│   │   ├── v1/page.tsx           # Approach 1 test page
│   │   └── api/                  # Next.js API routes
│   ├── components/
│   │   ├── layout/sidebar.tsx    # Navigation sidebar
│   │   └── ui/                   # Shadcn UI components
│   └── lib/
│       ├── supabase.ts           # Supabase client
│       └── pdf-to-image.ts       # PDF rasterization
├── python/
│   ├── server.py                 # Approach 2 FastAPI server (port 8001)
│   ├── server_llm.py             # Approach 1 FastAPI server (port 8002)
│   ├── pipeline.py               # Approach 2 pipeline (FreeCAD-based)
│   ├── pipeline_llm.py           # Approach 1 pipeline (LLM-per-step)
│   ├── vlm_stream.py             # VLM streaming helpers, SSE, JSON extraction
│   └── requirements.txt
├── docker-compose.yml
├── Dockerfile.web                # Next.js container
├── Dockerfile.python             # Approach 2 Python (with FreeCAD, port 8001)
├── Dockerfile.python-llm         # Approach 1 Python (no FreeCAD, port 8002)
└── .env.local                    # Local secrets (not committed)
```

---

## Environment Variables (.env.local)
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_PYTHON_SERVICE_URL=http://localhost:8001   # Approach 2
NEXT_PUBLIC_PYTHON_V1_URL=http://localhost:8002        # Approach 1
VLLM_BASE_URL=https://...runpod.io/v1                  # Remote vLLM
VLLM_API_KEY=...
VLLM_MODEL=Qwen/Qwen3-VL-32B-Instruct
```

---

## Docker Commands
```bash
# Full rebuild and start all 3 services
docker compose --env-file .env.local up --build

# Rebuild only the Approach 1 Python service
docker compose --env-file .env.local up --build python-llm

# Rebuild only the Next.js frontend
docker compose --env-file .env.local up --build cncapp

# View logs for a specific service
docker compose logs -f python-llm
docker compose logs -f cncapp
```

Services:
- `python-service` → port 8001 (Approach 2, FreeCAD)
- `python-llm` → port 8002 (Approach 1, LLM-only)
- `cncapp` → port 3000 (Next.js)

---

## Approach 1 Pipeline Steps (server_llm.py / pipeline_llm.py)
| Step | Endpoint | Description |
|---|---|---|
| 1 | POST /v1/gdt | VLM PDF extraction → SSE stream |
| 2 | POST /v1/step3d | STEP geometry analysis → JSON |
| 3 | POST /v1/features | Feature recognition (merge 2D+3D) → JSON |
| 4 | POST /v1/processes | CNC process mapping → JSON |
| 5 | POST /v1/cycletime | Cycle time estimation → JSON |
| 6 | POST /v1/cost | Cost formula (no LLM) → JSON |

All LLM steps return a `thinking` field with the model's reasoning (Qwen3-VL thinking mode).

---

## Approach 2 Pipeline Steps (server.py / pipeline.py)
1. PDF rasterization (poppler/pdfjs)
2. VLM GD&T extraction (streaming SSE)
3. STEP file analysis (FreeCAD STEPAnalyzer)
4. Feature recognition (FreeCAD + LLM)
5. Process mapping
6. Cycle time estimation
7. Cost formula

---

## Key Qwen3-VL Thinking Format
The chat template prepends `<think>` silently. The `content` field starts directly with reasoning text, ends with `</think>{json_answer}`. No opening `<think>` tag in content.

Three cases handled in `_call_text_llm`:
- Case A: `reasoning_content` field (vLLM ≥ 0.7)
- Case B: full `<think>...</think>` inline
- Case C: Qwen3-VL template — no `<think>` prefix, split at `</think>`

---

## Current Status (2026-04-07)
- Approach 1 pipeline working end-to-end with thinking display
- Approach 2 pipeline working (older, more stable)
- Testing with files named `0041` (PDF drawing + STEP file)
- Build deadline: 2026-04-03 (passed), testing through 2026-04-10
