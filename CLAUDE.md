# CNCapp — Project Context for Claude Code Agent Teams

## Project Overview
AI-powered CNC machining cost estimator. User uploads a 2D drawing PDF + a 3D STEP file → gets back features, operations, cycle time, and cost estimate.

Two parallel approaches, both served by **one unified Python server** (`server.py`):
- **Approach 1 (LLM)**: LLM-per-step pipeline. UI at `/v1`. Endpoints: `POST /v1/gdt`, `/v1/step3d`, `/v1/features`, `/v1/processes`, `/v1/cycletime`, `/v1/cost`.
- **Approach 2 (FreeCAD)**: Deterministic pipeline (FreeCAD STEPAnalyzer → process_mapper → cycle_time_tool → cost formula). UI at `/`. Endpoint: `POST /analyze-stream`.

---

## Tech Stack
| Layer | Technology |
|---|---|
| Frontend | Next.js 14 App Router, TypeScript, Tailwind CSS |
| Backend | FastAPI (Python 3), single unified server |
| LLM | Qwen3-VL-32B via vLLM OpenAI-compat API (remote RunPod) |
| Storage | Supabase (file uploads → signed URLs) |
| Auth | Supabase Auth |
| Container | Docker Compose (2 services: python + Next.js) |

---

## Directory Structure
```
CNCapp/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Approach 2 main UI
│   │   ├── v1/page.tsx           # Approach 1 test page
│   │   ├── analyze/page.tsx      # Shared analysis page
│   │   └── api/                  # Next.js API routes
│   ├── components/
│   │   ├── layout/sidebar.tsx    # Navigation sidebar
│   │   └── ui/                   # Shadcn UI components
│   └── lib/
│       ├── supabase.ts           # Supabase client
│       └── pdf-to-image.ts       # PDF rasterization
├── python/
│   ├── server.py                 # Unified FastAPI server (port 8001) — both approaches
│   ├── pipeline/                 # Pipeline package
│   │   ├── __init__.py           # Re-exports all pipeline functions
│   │   ├── approach1.py          # Approach 1: LLM-per-step functions
│   │   ├── approach2.py          # Approach 2: FreeCAD streaming pipeline
│   │   └── shared.py             # Shared: LLM client, JSON utils, download helper
│   ├── vlm_stream.py             # VLM streaming helpers, SSE, JSON extraction
│   ├── freecad_analyzer/         # FreeCAD geometry analysis module
│   ├── config.py                 # Shared config constants
│   ├── materials.py              # Material lookup tables
│   ├── cost_tool.py              # Cost estimation formula
│   ├── cycle_time_tool.py        # Cycle time calculation
│   └── requirements.txt
├── docker-compose.yml
├── Dockerfile.web                # Next.js container
├── Dockerfile.python             # Python container (FreeCAD + server.py, port 8001)
└── .env.local                    # Local secrets (not committed)
```

---

## Environment Variables (.env.local)
```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...

# RunPod vLLM endpoint (used by both Next.js and Python server)
LOCAL_OLLAMA_URL=https://...runpod.net          # Python: base URL for LLM calls
VISION_MODEL=/workspace/models/Qwen3-VL-...     # Python: model name

# Python service URLs (same server handles both approaches)
NEXT_PUBLIC_PYTHON_SERVICE_URL=http://localhost:8001   # Approach 2 (browser)
NEXT_PUBLIC_PYTHON_V1_URL=http://localhost:8001        # Approach 1 (browser)
PYTHON_SERVICE_URL=http://localhost:8001               # Approach 2 (server-side)

# Vision settings
VISION_TIMEOUT_MS=0
PDF_MAX_PAGES_FOR_VISION=32
```

**In production (Vercel env vars):**
- `NEXT_PUBLIC_PYTHON_SERVICE_URL` → Railway service URL
- `NEXT_PUBLIC_PYTHON_V1_URL` → same Railway service URL
- `LOCAL_OLLAMA_URL` → must also be set on Railway for Python LLM calls
- `VISION_MODEL` → must also be set on Railway

---

## Docker Commands
```bash
# Full rebuild and start both services
docker compose --env-file .env.local up --build

# Rebuild only the Python service
docker compose --env-file .env.local up --build python-service

# Rebuild only the Next.js frontend
docker compose --env-file .env.local up --build cncapp

# View logs
docker compose logs -f python-service
docker compose logs -f cncapp
```

Services:
- `python-service` → port 8001 (unified: Approach 1 + Approach 2)
- `cncapp` → port 3000 (Next.js)

---

## Approach 1 Pipeline Steps (server.py /v1/* endpoints → pipeline/approach1.py)
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

## Approach 2 Pipeline Steps (server.py /analyze-stream → pipeline/approach2.py)
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

Three cases handled in `_call_text_llm` (pipeline/shared.py):
- Case A: `reasoning_content` field (vLLM ≥ 0.7)
- Case B: full `<think>...</think>` inline
- Case C: Qwen3-VL template — no `<think>` prefix, split at `</think>`

VLM temperature must be **0.15** (not higher — garbled JSON at 1.5+).

---

## Current Status (2026-04-08)
- Unified server.py handles both approaches on port 8001
- Railway: single service running Dockerfile.python → server.py
- Vercel: Next.js frontend, both NEXT_PUBLIC_PYTHON_*_URL point to Railway URL
- Testing with files named `0041`, `0022` (PDF drawing + STEP file)
