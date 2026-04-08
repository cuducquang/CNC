# CNCapp — Technical Report

> **Document purpose:** Complete architectural and functional specification of the CNCapp AI-powered CNC machining cost estimator. Intended for engineering review, customer trust-building, and onboarding of new contributors.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Features and API Reference](#2-features-and-api-reference)
3. [Analysis Pipelines — Approach 1 vs Approach 2](#3-analysis-pipelines)

---

## 1. System Architecture

### 1.1 Overview

CNCapp is a full-stack web application that accepts a 2D engineering drawing (PDF) and a 3D CAD file (STEP) and returns:

- Identified machining features (holes, pockets, threads, fillets, chamfers, etc.)
- A CNC operation sequence
- Estimated cycle time (minutes)
- Estimated fabrication cost (USD)
- Extracted GD&T callouts and dimensional tolerances

Two independent pipelines handle the same job via different strategies. Results from both approaches are stored in a shared database and shown side-by-side in the history view.

---

### 1.2 Frontend

| Attribute | Detail |
|---|---|
| Framework | **Next.js 14** (App Router) |
| Language | **TypeScript** |
| Styling | **Tailwind CSS** |
| Component library | **Shadcn UI** (Radix UI primitives) |
| State management | React hooks only — no Redux/Zustand |
| Routing | Next.js App Router (`/app` directory) |
| Hosting | **Vercel** (production: `cnc-snowy-ebon.vercel.app`) |

**Key pages:**

| Route | Purpose |
|---|---|
| `/` | Landing — choose approach |
| `/analyze?approach=1` | Approach 1 (LLM-per-step) upload + live progress |
| `/analyze?approach=2` | Approach 2 (FreeCAD) upload + agent stream |
| `/history` | All past analyses with status, cost, cycle time |
| `/analysis/[id]` | Full result detail for one analysis |
| `/v1` | Legacy Approach 1 test page |

**Environment variables injected at build time (Vercel):**

```
NEXT_PUBLIC_SUPABASE_URL          — Supabase project REST endpoint
NEXT_PUBLIC_SUPABASE_ANON_KEY     — Supabase anon key (public, row-level security)
NEXT_PUBLIC_PYTHON_SERVICE_URL    — Railway Python service URL (Approach 2)
NEXT_PUBLIC_PYTHON_V1_URL         — Railway Python service URL (Approach 1, same host)
```

Both Python URL vars point to the **same Railway deployment** (`https://<service>.railway.app`).  
Server-side Next.js routes also use `SUPABASE_SERVICE_ROLE_KEY` (never sent to the browser).

---

### 1.3 Backend (Python Microservice)

| Attribute | Detail |
|---|---|
| Framework | **FastAPI** (async, ASGI) |
| Language | **Python 3.10** |
| Server | **Uvicorn** (`0.0.0.0:8001`) |
| Container | **Docker** — Ubuntu 22.04 base image |
| Hosting | **Railway** (auto-deploy from `main` branch via `railway.json`) |
| Dockerfile | `Dockerfile.python` — includes FreeCAD, poppler-utils, system fonts |

A **single unified server** (`python/server.py`) exposes all endpoints for both approaches. Approach 2 uses the FreeCAD-based deterministic pipeline; Approach 1 uses the LLM-per-step pipeline. Both run in the same process on the same Railway container.

**System packages installed in the Docker image:**

```
freecad              — headless 3D solid geometry analysis
poppler-utils        — pdftoppm for PDF→PNG rasterization
fonts-freefont-ttf   — font coverage for engineering drawings (prevents blank renders)
fonts-liberation     —  ↑
fonts-dejavu-core    —  ↑
fontconfig           — font cache rebuild (fc-cache -f) at image build time
python3-pip          — package manager
```

**Python packages (key):**

```
fastapi / uvicorn    — ASGI web server
httpx                — async HTTP client (LLM calls, file downloads)
pillow               — image resize for VLM page capping
pypdfium2            — fallback PDF renderer (if pdftoppm fails)
python-dotenv        — local .env.local loading
```

---

### 1.4 AI / VLM Inference

| Attribute | Detail |
|---|---|
| Model | **Qwen3-VL-32B-Thinking-FP8** |
| Quantization | FP8 (fits in ~24 GB VRAM) |
| Inference engine | **vLLM** (OpenAI-compatible `/v1/chat/completions`) |
| Hosting | **RunPod** serverless GPU pod (A100 / H100) |
| Endpoint | `https://rlnp01b095y6lf-19123.proxy.runpod.net` (proxied via nginx on port 19123) |
| Model path on pod | `/workspace/models/Qwen3-VL-32B-Thinking-FP8` |

**Env vars read by the Python service:**

```
VISION_MODEL_URL     — vLLM base URL (preferred)
LOCAL_OLLAMA_URL     — fallback alias
VISION_MODEL_NAME    — model path (preferred)
VISION_MODEL         — fallback alias
```

The model is invoked in two modes:

- **Vision mode** (`collect_ollama_vision_chat`): base64 PNG image + text prompt → JSON extraction of dimensions and GD&T.
- **Text mode** (`_call_text_llm`): text-only reasoning — feature recognition, process mapping, cycle time estimation.

Both modes use **streaming** (`"stream": true`) to avoid Cloudflare/RunPod 524 proxy timeouts on long inference runs. Thinking tokens arrive continuously, keeping the connection alive. The model's `thinking_budget_tokens` is set per call (default 1024 for text, unlimited for vision).

**Thinking format handling** — three variants are normalised:

| Case | Format | Handler |
|---|---|---|
| A | `delta.reasoning_content` field (vLLM ≥ 0.7) | Accumulated separately |
| B | Inline `<think>…</think>{answer}` | Split at `</think>` boundary |
| C | Qwen3-VL template — content starts mid-think, ends at `</think>` | Split at `</think>` without opening tag |

---

### 1.5 Database

| Attribute | Detail |
|---|---|
| Provider | **Supabase** (PostgreSQL) |
| Auth | Supabase Auth (email + password) |
| File storage | Supabase Storage (`parts` bucket) |
| Client (browser) | `@supabase/supabase-js` (anon key, RLS-enforced) |
| Client (server) | `@supabase/supabase-js` (service-role key, Next.js API routes only) |

**`analyses` table schema:**

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` NOT NULL | Primary key — also used as the storage folder name |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Last update time |
| `file_name` | `text` | Original 3D filename |
| `file_3d_path` | `text` | Supabase storage path for STEP file |
| `file_2d_path` | `text` | Supabase storage path for PDF drawing |
| `status` | `text` | `processing` → `completed` / `error` |
| `approach` | `smallint` | `1` = LLM-per-step, `2` = FreeCAD |
| `feature_recognition` | `jsonb` | Features list + source |
| `process_mapping` | `jsonb` | CNC operations list |
| `cycle_time` | `jsonb` | Per-operation times + total minutes |
| `cost_estimation` | `jsonb` | Cost breakdown + total USD |
| `dimension_gdt` | `jsonb` | Dimensions and GD&T callouts from 2D drawing |
| `error_message` | `text` | Set on failure |
| `agent_log` | `jsonb` | Raw SSE event log (Approach 2 only) |

**File storage layout:**

```
parts/
  uploads/
    {analysis_id}/          ← Approach 2
      3d_{filename}.stp
      2d_{filename}.pdf
  uploads/v1test/
    {analysis_id}/          ← Approach 1
      3d_{filename}.stp
      2d_{filename}.pdf
```

Files are uploaded by the browser directly to Supabase Storage using the anon key. The Python service accesses them via 1-hour signed URLs.

---

---

## 2. Features and API Reference

### 2.1 User-Facing Features

| Feature | Description |
|---|---|
| File upload | Upload STEP (3D) + PDF (2D drawing) pair |
| Approach selection | Choose Approach 1 (LLM) or Approach 2 (FreeCAD) |
| Live progress | Real-time per-step status with elapsed time and thinking display |
| GD&T extraction | Dimensions, tolerances, GD&T symbols, thread specs from 2D drawing |
| Feature list | Recognized machining features with type, geometry, and tolerance class |
| Process plan | Ordered CNC operation sequence with tool specs |
| Cycle time | Per-operation and total machining time in minutes |
| Cost estimate | USD breakdown: material + setup + machining + overhead |
| History | Paginated list of all analyses; filter by approach |
| Analysis detail | Full result view with all pipeline stages |
| Stuck job cleanup | Auto-mark jobs in `processing` > 10 minutes as `error` |

---

### 2.2 Next.js API Routes

These run inside the Vercel deployment (server-side, service-role key).

#### `POST /api/upload/register`

Called by the browser after files are uploaded to Supabase Storage. Creates the `analyses` row in `processing` state.

**Request body:**
```json
{
  "analysis_id": "uuid",
  "file_3d_path": "uploads/v1test/{id}/3d_part.stp",
  "file_2d_path": "uploads/v1test/{id}/2d_drawing.pdf",
  "file_name": "part.stp",
  "approach": 1
}
```

**Response:** `{ "ok": true, "id": "uuid" }`

---

#### `POST /api/save-result`

Called by the browser after the Python pipeline completes. Updates the `analyses` row with all results and sets `status = "completed"`.

**Request body:**
```json
{
  "analysis_id": "uuid",
  "results": {
    "extraction":    { /* GD&T extraction dict */ },
    "features":      [ /* feature list */ ],
    "processes":     { /* operations dict */ },
    "cycle_time":    { /* cycle time dict */ },
    "cost":          { /* cost dict */ },
    "total_minutes": 14.7,
    "total_usd":     28.70
  }
}
```

**Response:** `{ "ok": true }`

---

#### `GET /api/analyses`

Returns a paginated list of analyses for the authenticated user.

**Query params:** `?approach=1|2` (optional filter), `?offset=0&limit=20`

**Response:** `{ "data": [ AnalysisRow, … ] }`

---

#### `GET /api/analyses/[id]`

Returns the full analysis record including all JSONB columns.

---

#### `PATCH /api/analyses/[id]`

Updates `status` and `error_message`. Used by the history page to mark timed-out jobs as `error`.

---

#### `DELETE /api/analyses/[id]`

Hard-deletes the analysis row. Does **not** delete files from Supabase Storage.

---

### 2.3 Python Service Endpoints

Base URL: `https://<railway-service>.railway.app` (production) or `http://localhost:8001` (local).

#### Approach 2

| Method | Path | Description |
|---|---|---|
| `POST` | `/analyze-stream` | Full 6-step pipeline, **SSE stream** |
| `POST` | `/analyze` | Full pipeline, single JSON response (legacy) |
| `POST` | `/analyze/step` | STEP-only geometry (no VLM) |
| `POST` | `/convert-pdf` | PDF → base64 PNG pages |
| `GET` | `/health` | FreeCAD availability check |

**`POST /analyze-stream` — request body:**
```json
{
  "analysis_id": "uuid",
  "drawing_url": "https://…/2d_part.pdf?token=…",
  "step_url":    "https://…/3d_part.stp?token=…",
  "file_name":   "part.stp"
}
```

**SSE event types emitted:**

| Event | Payload | Meaning |
|---|---|---|
| `status` | `{"step": "analyze_drawing", "message": "…"}` | Step started |
| `tool_call` | `{"tool": "analyze_drawing", "input": {}}` | Tool invocation |
| `tool_result` | `{"tool": "…", "result": {…}}` | Tool returned |
| `thinking` | `{"content": "…"}` | VLM reasoning token |
| `heartbeat` | `{}` | Keep-alive (no tokens for 15 s) |
| `final_answer` | `{"text": "…", "results": {…}}` | Pipeline complete |
| `error` | `{"message": "…"}` | Step failed |
| `done` | `{}` | Stream closed |

---

#### Approach 1

Each step is a **separate HTTP request**. The browser calls them sequentially; each returns immediately after the step completes.

| Method | Path | Input | Output |
|---|---|---|---|
| `POST` | `/v1/gdt` | `{ drawing_url, file_name }` | **SSE stream** — `thinking`, `gdt_result`, `done` |
| `POST` | `/v1/step3d` | `{ step_url, file_name }` | JSON `{ ok, features_3d, shape_summary, thinking }` |
| `POST` | `/v1/features` | `{ extraction, step_analysis }` | JSON `{ ok, features, material, feature_count }` |
| `POST` | `/v1/processes` | `{ features, material }` | JSON `{ ok, operations, setup_count, operation_count }` |
| `POST` | `/v1/cycletime` | `{ operations, material_spec }` | JSON `{ ok, total_minutes, setup_minutes, operations }` |
| `POST` | `/v1/cost` | `{ cycle_time, material_spec }` | JSON `{ ok, total_usd, breakdown }` |
| `GET` | `/v1/health` | — | JSON `{ ok: true }` |

---

### 2.4 Browser → Backend Call Flow

#### Approach 1

```
Browser                         Supabase Storage       Railway Python
  │                                    │                      │
  ├─ Upload STEP + PDF ──────────────► │                      │
  ├─ Create signed URLs ◄───────────── │                      │
  ├─ POST /api/upload/register                               │
  │   (creates analyses row, status=processing)              │
  │                                                          │
  ├─ POST /v1/gdt (SSE) ────────────────────────────────────►│
  │   ◄── thinking tokens ──────────────────────────────────  │
  │   ◄── gdt_result ───────────────────────────────────────  │
  │   ◄── done ─────────────────────────────────────────────  │
  │                                                          │
  ├─ POST /v1/step3d ───────────────────────────────────────►│
  │   ◄── { features_3d, shape_summary } ──────────────────   │
  │                                                          │
  ├─ POST /v1/features ────────────────────────────────────►│
  │   ◄── { features, material } ──────────────────────────   │
  │                                                          │
  ├─ POST /v1/processes ───────────────────────────────────►│
  ├─ POST /v1/cycletime ───────────────────────────────────►│
  ├─ POST /v1/cost ────────────────────────────────────────►│
  │                                                          │
  ├─ POST /api/upload/register  (update with approach=1)     │
  └─ POST /api/save-result  (writes completed results to DB) │
```

#### Approach 2

```
Browser                         Supabase Storage       Railway Python
  │                                    │                      │
  ├─ Upload STEP + PDF ──────────────► │                      │
  ├─ Create signed URLs ◄───────────── │                      │
  ├─ POST /api/upload/register                               │
  │   (creates analyses row, status=processing)              │
  │                                                          │
  ├─ POST /analyze-stream (SSE) ────────────────────────────►│
  │   ◄── status: analyze_drawing ─────────────────────────   │ step 1
  │   ◄── thinking tokens (VLM) ───────────────────────────   │
  │   ◄── tool_result: analyze_drawing ────────────────────   │
  │   ◄── status: analyze_step_file ───────────────────────   │ step 2
  │   ◄── tool_result: analyze_step_file ──────────────────   │
  │   ◄── … steps 3-6 ─────────────────────────────────────   │
  │   ◄── final_answer ────────────────────────────────────   │
  │   ◄── done ─────────────────────────────────────────────  │
  │                                                          │
  └─ POST /api/save-result  (writes completed results to DB) │
```

---

## 3. Analysis Pipelines

### 3.1 Shared Step: PDF Rasterization

Before VLM vision analysis, the 2D drawing PDF is converted to base64 PNG pages. This is shared by both approaches.

**Algorithm:**

1. Download PDF bytes from Supabase signed URL.
2. Run `pdftoppm -png -r 150` (150 DPI) to render each page to PNG.
3. If `pdftoppm` fails (missing binary), fall back to `pypdfium2`.
4. Resize each PNG so the longest side ≤ 2000 px (Lanczos resampling, Pillow).
5. Base64-encode each PNG.
6. Cap at **4 pages** (`MAX_VLM_PAGES`) to bound total inference time.

**Why 150 DPI?** Engineering drawings have dense fine text (dimension leaders, tolerance callouts). Below 120 DPI the VLM misses tiny numbers. Above 200 DPI produces unnecessarily large images that slow streaming.

**Font requirement:** Ubuntu 22.04 minimal Docker images carry no system fonts. PDFs whose text is not embedded (common with CAD exporters) render as blank pages. The Docker image explicitly installs `fonts-freefont-ttf`, `fonts-liberation`, `fonts-dejavu-core` and runs `fc-cache -f` at build time to ensure every common engineering font has a system substitute.

---

## 3.2 Approach 2 — FreeCAD Deterministic Pipeline

**Philosophy:** Use FreeCAD's solid geometry kernel to measure the part exactly. No LLM is involved in the geometry or process planning stages — only the GD&T vision step uses a model. This makes steps 2–6 fast, reproducible, and free of hallucination risk.

**Pipeline diagram:**

```
PDF drawing ──► VLM (Qwen3-VL) ──► GD&T extraction
STEP file   ──► FreeCAD         ──► 3D feature list
                                          │
                        Python merge ─────┘
                                          │
                        Process Mapper (deterministic)
                                          │
                        Cycle Time (formula)
                                          │
                        Cost (formula)
```

All six steps run inside a single SSE streaming response (`POST /analyze-stream`). The browser receives progress events as each step completes.

---

### Step 1 — GD&T Extraction (`analyze_drawing`)

**Algorithm:**

1. Rasterize PDF to base64 PNG pages (see §3.1).
2. For each page (up to 4), send to `Qwen3-VL-32B` with the extraction system prompt.
3. Model classifies the page:
   - `"ok"` — technical drawing, extract data
   - `"non_technical_page"` — cover/blank/title only
   - `"not_a_drawing"` — photo or artwork
4. Parse the model's JSON response (`parse_model_json` — handles markdown fences, trailing text, malformed JSON).
5. Merge all "ok" pages with `merge_vision_results`: union dimensions by `id`, deduplicate GD&T callouts, prefer non-null material.
6. Emit `gdt_result` event with the merged extraction.

**VLM system prompt (abridged):**
> "You are a metrology specialist reading a 2D engineering drawing. Extract dimensions, tolerances, GD&T callouts, and thread specifications. Output ONLY the JSON result — nothing else."

**Output schema:**
```json
{
  "dimensions": [
    {
      "id": "D001",
      "label": "Bore diameter",
      "nominal": 6.731,
      "unit": "in",
      "tolerance_plus": 0.0005,
      "tolerance_minus": 0.0005,
      "quantity": 8
    }
  ],
  "gdt": [
    {
      "id": "G001",
      "symbol": "position",
      "tolerance": 0.003,
      "unit": "in",
      "datums": ["A", "B"]
    }
  ],
  "threads": [
    {
      "id": "T001",
      "spec": ".190-32 UNF-2B",
      "depth_mm": 15.0,
      "quantity": 4
    }
  ],
  "material": "AL6061-T6",
  "surface_finish": "Ra 1.6",
  "feature_count": 24,
  "gdt_count": 6,
  "pages_analyzed": 2
}
```

**Source of truth:** The 2D engineering drawing as rendered. Values are what is explicitly labeled — the model is instructed never to infer or guess unlabeled dimensions.

**Resilience against VLM failure:** If the RunPod endpoint drops the connection mid-stream (e.g. `peer closed connection` on a multi-page PDF), the pipeline substitutes an empty extraction — `{"dimensions":[], "gdt":[], "threads":[], "feature_count":0}` — emits a `status` warning event, and continues to Step 2. FreeCAD STEP analysis is entirely independent of the drawing extraction and always runs regardless. The cost of a missing GD&T extraction is that tolerance classes default to `"general"` and material defaults to `AL6061-T6`; geometry, features, operations, and cycle time are still produced from the 3D solid.

---

### Step 2 — 3D Geometry Analysis (`analyze_step_file`)

**Algorithm:**

1. Open STEP file in FreeCAD (`Part.Shape().read()`).
2. Run `STEPAnalyzer.analyze()`:
   - Enumerate all solid faces (Shell → Faces).
   - Classify cylindrical faces as holes by normal vector (vertical axis = through/blind hole).
   - Group holes by diameter (±0.001 mm tolerance): count identical holes as `quantity`.
   - Detect pockets by planar floor + vertical walls.
   - Detect fillets (toroidal faces), chamfers (conical faces), bosses, slots, steps, grooves.
   - Compute bounding box from `Shape.BoundBox`.
   - Compute volume from `Shape.Volume`.
3. Run `_detect_sheet_metal()` in parallel: check thickness uniformity, detect bends (cylindrical faces with small radius), flanges, relief cuts.
4. Convert FreeCAD feature list to `features_3d` format.

**Output schema:**
```json
{
  "features_3d": [
    {
      "id": "F001",
      "type": "through_hole",
      "diameter_mm": 6.731,
      "depth_mm": 31.75,
      "quantity": 8,
      "operation": "drill",
      "description": "8× Ø6.731mm through holes"
    },
    {
      "id": "F002",
      "type": "pocket",
      "width_mm": 73.3,
      "length_mm": 73.3,
      "depth_mm": 18.4,
      "quantity": 1,
      "operation": "mill",
      "description": "Circular pocket Ø73.30mm"
    }
  ],
  "shape_summary": {
    "bbox_x_mm": 466.5,
    "bbox_y_mm": 466.5,
    "bbox_z_mm": 31.75,
    "volume_mm3": 3870409.5
  },
  "sheet_metal": {
    "is_sheet_metal": false
  },
  "geometry_source": "freecad"
}
```

**Source of truth:** FreeCAD's OpenCASCADE geometry kernel reads the STEP B-rep (Boundary Representation) directly. Hole diameters are derived from the cylindrical face radius, which is the exact designed dimension — no measurement uncertainty. This is the most reliable step in the pipeline.

---

**Part type classification (`part_classifier.py`):**

After STEPAnalyzer completes, a geometry heuristic scorer (`classify_part`) classifies the part into one of 8 manufacturing types: `sheet_metal`, `cnc_machined`, `tube_pipe`, `hardware`, `casting`, `weldment`, `additive`, `turned_lathe`. Each type receives a raw score, all scores are normalised to sum to 1.0, and the highest-scoring type wins (minimum threshold 0.15 to avoid spurious classifications).

The scorer derives five primary geometry ratios from the bounding box and volume:

```
bbox_vol   = length × width × height
vol_ratio  = volume / bbox_vol        # fill factor: 1.0 = solid block, <0.2 = thin shell / hollow
flatness   = min_dim / max_dim        # 1.0 = cube, 0.03 = very flat plate
aspect_ratio = max_dim / min_dim      # inverse of flatness
plane_frac = plane_faces / total_faces
cyl_frac   = cylinder_faces / total_faces
```

**Key discriminating rules by part type:**

| Type | Primary signal | Score drivers |
|---|---|---|
| `sheet_metal` | `flatness < 0.1` (+3.0), `vol_ratio < 0.15` (+2.5) | uniform thickness (+2.5), bend features (+2.0 each), thin mean thickness (+2.0) |
| `cnc_machined` | `0.3 < vol_ratio < 0.85` (+2.0) | holes + pockets + slots > 3 (+2.5), pocket present (+1.5), high plane_frac (+0.5) |
| `tube_pipe` | `cyl_frac > 0.4` (+2.5) | aspect_ratio > 3 (+1.5), uniform thickness (+1.0) |
| `hardware` | `max_dim < 50 mm` (+2.0) | thread features (+3.0), high cyl_frac (+1.0) |
| `turned_lathe` | `cyl_frac > 0.5` (+3.0) | approx_circular (cyl+cone+torus) > 0.6 (+2.0) |
| `casting` | `bspline_frac > 0.2` (+2.5) | draft angles (+2.0), fillets > 3 (+1.5) |

**Sheet metal vs CNC flat plate disambiguation:**

The hardest classification boundary is a large flat CNC-machined aluminum plate vs. true sheet metal — both can have `flatness < 0.1` and `vol_ratio < 0.15` (deep pockets hollow out the fill ratio). The discriminating physical fact is thickness: real sheet metal is 0.5–12 mm thick, while a CNC plate is typically 12–50 mm thick. The classifier applies minimum-dimension penalties to the `sheet_metal` score:

```python
if min_dim > 12:   score -= 3.5   # too thick to be sheet metal
elif min_dim > 6:  score -= 1.5   # borderline — mild penalty
if pocket_count > 0: score -= 2.0  # pockets are machined, not formed
```

And adds a reciprocal bonus to `cnc_machined` for flat-but-thick parts:

```python
if min_dim > 12 and flatness < 0.15:
    score += 2.0   # flat plate ≥ 12mm → CNC machined
```

The `vol_ratio` penalty for `cnc_machined` is also relaxed when pockets or holes are present, because a deeply pocketed plate legitimately has a low fill ratio despite being CNC work:

```python
elif vol_ratio < 0.15:
    if pocket_count > 0 or hole_count > 0:
        score += 0.5   # low fill is expected for pocketed plates
    else:
        score -= 2.0   # genuinely low density → not CNC
```

If no type scores above 0.15 after normalisation, the part is labelled `unknown` and the pipeline falls back to conservative process assumptions.

---

### Step 3 — Feature Recognition (`recognize_features`)

**Algorithm (Approach 2 — deterministic Python):**

1. For each 3D feature, find any matching 2D dimension by type and size.
2. Apply tolerance from 2D drawing to the 3D geometry.
3. Resolve tolerance class: `precision` (±≤0.001 in), `close` (±≤0.005), `medium` (±≤0.010), `general` (>0.010).
4. Cross-reference GD&T callouts (position, flatness, cylindricity) to the matched feature.
5. Emit a unified `RecognizedFeature` object for each feature.

**Output schema (per feature):**
```json
{
  "id": "F001",
  "type": "through_hole",
  "description": "8× Ø6.731mm precision reamed holes",
  "quantity": 8,
  "geometry": { "diameter_mm": 6.731, "depth_mm": 31.75 },
  "tolerance": { "plus": 0.0005, "minus": 0.0005 },
  "tolerance_class": "precision",
  "gdt_callouts": [{ "symbol": "position", "tolerance": 0.003, "datums": ["A","B"] }],
  "source": "3d+2d"
}
```

`source` is `"3d"` (geometry only), `"2d"` (drawing only), or `"3d+2d"` (both matched).

---

### Step 4 — CNC Process Mapping (`map_cnc_processes`)

**Algorithm (Approach 2 — deterministic Python `ProcessMapper`):**

1. Resolve material from drawing string (e.g., `"AL6061-T6"` → `"Al6061"`).
2. Look up `MATERIAL_PARAMS` for cutting speeds (`sfm`), feed per tooth (`fpt_mm`), and hardness.
3. For each recognized feature, emit the operation template:
   - `through_hole` / `blind_hole`: `center_drill` → `drill` → (if precision) `ream`
   - `threaded_hole`: `center_drill` → `drill` → `tap`
   - `pocket` / `slot`: `rough_mill` → `finish_mill`
   - `fillet`: `ball_end_mill`
   - `chamfer`: `chamfer_mill`
   - `face`: `face_mill`
4. Calculate feed rate: `F = RPM × n_teeth × fpt_mm` where `RPM = (sfm × 1000) / (π × D)`.
5. Calculate cutting time: `t = toolpath_length / F`.
6. Add setup time (10 min flat) and tool-change overhead (0.5 min per unique tool).

**Material cutting parameters used:**

| Material | Surface speed (m/min) | Feed/tooth (mm) |
|---|---|---|
| Al 6061 | 150 | 0.080 |
| Al 7075 | 135 | 0.070 |
| SS 304 | 27.5 | 0.040 |
| SS 316 | 24.4 | 0.030 |
| Ti 6Al-4V | 13.7 | 0.025 |
| 1018 Steel | 42.7 | 0.060 |
| 4140 Steel | 36.6 | 0.050 |
| Delrin | 106.7 | 0.100 |
| PEEK | 91.4 | 0.080 |

**Output schema:**
```json
{
  "processes": [
    {
      "id": "OP001",
      "feature_id": "F001",
      "operation": "center_drill",
      "tool": "Center Drill Ø3.175mm",
      "quantity": 8,
      "feed_mmpm": 381.0,
      "spindle_rpm": 15000,
      "time_minutes": 0.020,
      "note": "Pilot holes for Ø6.731mm bore"
    },
    {
      "id": "OP002",
      "feature_id": "F001",
      "operation": "drill",
      "tool": "Twist Drill Ø6.731mm",
      "quantity": 8,
      "feed_mmpm": 500.0,
      "spindle_rpm": 7100,
      "time_minutes": 0.040,
      "note": ""
    },
    {
      "id": "OP003",
      "feature_id": "F001",
      "operation": "ream",
      "tool": "Reamer Ø6.731mm",
      "quantity": 8,
      "feed_mmpm": 120.0,
      "spindle_rpm": 2000,
      "time_minutes": 0.134,
      "note": "Precision bore — tolerance ±0.0005 in"
    }
  ],
  "total_minutes": 33.26,
  "setup_minutes": 10.0
}
```

---

### Step 5 — Cycle Time Estimation (`estimate_cycle_time`)

**Algorithm (Approach 2 — deterministic formula):**

```
For each operation:
  toolpath_distance = approach_distance + feature_length
  cutting_time      = toolpath_distance / feed_rate
  rapid_time        = approach_distance / RAPID_MMPM   (5080 mm/min)

total = setup_time + Σ(cutting_time + rapid_time) + n_tool_changes × 0.5 min
```

Constants:
- `SETUP_MIN = 10.0` — fixture + zero once per job
- `TOOL_CHANGE_MIN = 0.5` — ATC on a standard VMC
- `RAPID_MMPM = 5080` — 200 in/min rapid traverse
- `APPROACH_MM = 6.35` — 0.25 in clearance plane

**Process map input format:** The cycle time estimator (`estimate_cycle_time`) accepts the process map in two shapes:
- **Approach 2** passes a raw Python `list` of operation dicts directly from the FreeCAD `ProcessMapper`.
- **Approach 1 (legacy TypeScript maps)** passes a dict with an `"operations"` or `"process_map"` key, or inch-unit `feed_rate_ipm` / `toolpath_distance_in` fields that are converted to mm internally.

The resolver handles both without the caller specifying a flag:

```python
ops = pm if isinstance(pm, list) else (pm.get("operations") or pm.get("process_map") or [])
```

Inch feeds and distances are up-converted: `feed_mmpm = feed_ipm × 25.4`, `dist_mm = dist_in × 25.4`, so the same formula works for both unit systems. If both `toolpath_distance_mm` and `feed_rate_mmpm` are missing or zero, the operation falls back to 0.5 min (a conservative floor for short facing passes).

**Sample output** (from real 0041 STEP file, Approach 2):
```
Setup:                     10.000 min
Center Drill H1 Ø3.17mm:   0.018 min × 24 holes
Drill Ø6.73mm (×8):         0.040 min
Ream Ø6.73mm (×8):          0.134 min  ← precision bore
Rough Mill P2 Ø116.87mm:    2.808 min  ← large pocket
Finish Mill P2 Ø87.66mm:    1.581 min
Tool Changes (5×):           2.500 min
─────────────────────────────────────
Total:                      33.26 min
```

---

### Step 6 — Cost Estimation (`estimate_cost`)

**Algorithm (shared by both approaches — deterministic formula, no LLM):**

```
machining_cost = (total_minutes / 60) × shop_rate
overhead       = machining_cost × overhead_pct
total          = raw_material + machining_cost + overhead
```

Default rates:
- `shop_rate = $60.00 / hr` — US job shop benchmark
- `raw_material = $15.00` — flat stock allowance
- `overhead_pct = 15%` — tooling wear, electricity, facility

**Sample output** (same 0041 job):
```
Raw Material:    $15.00
Setup:           $10.00
Machining:       $24.26  (24.26 min @ $1.00/min)
Overhead (15%):  $ 5.00
─────────────────────────
Total:           $53.35
```

**Source of truth for cost:** The cycle time total from step 5. The formula is transparent and deterministic — given the same cycle time and the same rates, the result is always identical. Rates are configurable at the API call level via `shop_rate_per_hour`, `raw_material_usd`, and `overhead_pct` parameters.

---

## 3.3 Approach 1 — LLM-Per-Step Pipeline

**Philosophy:** Every reasoning step is a separate LLM invocation. No FreeCAD dependency. The model sees both the drawing pixels (step 1) and geometry text (steps 2–5) and is responsible for all feature classification and process planning. This gives maximum flexibility and reasoning depth at the cost of higher latency and potential variability.

**Pipeline diagram:**

```
PDF drawing ──► VLM (Qwen3-VL) ──────────────────────────► Step 1: GD&T extraction
STEP file   ──► FreeCAD (fast path) OR text LLM ──────────► Step 2: 3D geometry
                   GD&T + 3D features ──► text LLM ────────► Step 3: unified features
                   Features + material ──► text LLM ────────► Step 4: process plan
                   Operations + material ──► text LLM ──────► Step 5: cycle time
                   Cycle time ──► deterministic formula ────► Step 6: cost
```

Each step runs as an independent HTTP request. The browser orchestrates the sequence via `useApproach1.ts` and drives the next call as soon as the previous one returns.

---

### Step 1 — GD&T Extraction (`POST /v1/gdt`)

Identical algorithm to Approach 2 Step 1. Both approaches share the same `analyze_gdt()` generator function, the same VLM prompt, and the same JSON schema.

**Difference from Approach 2:** The endpoint returns an SSE stream (same `thinking` / `gdt_result` / `done` events). The browser reads the stream incrementally and renders thinking tokens in real time.

---

### Step 2 — 3D Analysis (`POST /v1/step3d`)

**Algorithm:**

1. Download STEP file.
2. **FreeCAD fast path** (preferred): run `STEPAnalyzer` — if FreeCAD extracts features AND shape summary, convert directly to `features_3d` and return immediately. No LLM call.
3. **Fallback — no FreeCAD features:** build a text geometry summary from either:
   - FreeCAD shape data (bounding box, face counts), or
   - Regex parsing of raw STEP text (`CYLINDRICAL_SURFACE`, `PLANE`, `CONICAL_SURFACE`, `TOROIDAL_SURFACE`, `CARTESIAN_POINT`)
4. Pass geometry summary to `_call_text_llm` (text-only Qwen3) — model classifies features and estimates dimensions.

**STEP regex parser extracts:**
- `CYLINDRICAL_SURFACE(…, radius)` → diameter = radius × 2, counted by unique size
- `PLANE(…)` → total planar face count
- `CONICAL_SURFACE(…, semi_angle)` → chamfer angle (radians → degrees)
- `TOROIDAL_SURFACE(…, minor_radius)` → fillet radius
- `CARTESIAN_POINT(x, y, z)` → bounding box (max−min on each axis)

**Output schema:** same as Approach 2 Step 2 (`features_3d` list + `shape_summary`). Additionally includes:
- `geometry_source: "freecad" | "regex"` — which path was used
- `thinking: string` — model's reasoning (only populated in fallback LLM path)

---

### Step 3 — Feature Recognition (`POST /v1/features`)

**Algorithm:** Text LLM (`_call_text_llm`) receives the full GD&T extraction and the 3D feature list, then reasons to produce a unified list.

**LLM system prompt:**
> "You are a manufacturing feature recognition specialist. Match 2D drawing data to 3D features. Output ONLY valid JSON."

**Matching rules given to the model:**
- Match by type + size: `Ø8.86mm cylinder + .190-32 UNF thread → threaded_hole`
- Assign tolerances from 2D dimensions to matched 3D features
- If no 3D match, use 2D data alone (`source: "2d"`)
- Tolerance class: `precision` (≤0.001 in), `close` (≤0.005), `medium` (≤0.010), `general` (>0.010)
- Prefer material from 2D drawing; fallback to `AL6061-T6`

**Output schema:** same as Approach 2 Step 3. Includes `thinking` field.

**Reliability note:** This step benefits from the model's natural language understanding of engineering shorthand (e.g. mapping a drawing note "8× Ø.265 THRU" to 8 through-holes of diameter 6.731 mm). The tradeoff is that the model may occasionally misidentify a feature if the drawing note is ambiguous — the thinking field exposes its reasoning so discrepancies can be audited.

---

### Step 4 — Process Mapping (`POST /v1/processes`)

**Algorithm:** Text LLM receives the feature list and material, produces a CNC operation sequence.

**Rules given to the model:**
- `through_hole` / `blind_hole`: `center_drill → drill`
- `threaded_hole`: `center_drill → drill → tap`
- `pocket` / `slot`: `rough_mill → finish_mill`
- `chamfer`: `chamfer_mill`; `fillet`: `ball_end_mill`; `face`: `face_mill`
- Operations listed in logical machining order
- One entry per operation per feature; quantity carried on the feature

**Sample LLM output:**
```json
{
  "operations": [
    { "id": "OP001", "feature_id": "F001", "operation": "center_drill",
      "tool": "Center Drill Ø3.17mm", "quantity": 8, "note": "Pilot for Ø6.73mm" },
    { "id": "OP002", "feature_id": "F001", "operation": "drill",
      "tool": "Twist Drill Ø6.731mm", "quantity": 8, "note": "" },
    { "id": "OP003", "feature_id": "F002", "operation": "rough_mill",
      "tool": "End Mill Ø12mm", "quantity": 1, "note": "Roughing pocket P1" }
  ],
  "setup_count": 1,
  "operation_count": 3
}
```

---

### Step 5 — Cycle Time (`POST /v1/cycletime`)

**Algorithm:** Text LLM receives the operation list and material spec; estimates time based on standard speeds/feeds for the material class.

**Assumptions given to the model:**
```
Al6061: spindle 8000–12000 RPM, feed 2000–3000 mm/min for end mills
        3000–5000 RPM, 500 mm/min for drills
Tool change: 0.05 min each new tool
Setup (fixture + zeroing): 5.0 min flat
```

**Sample LLM output:**
```json
{
  "total_minutes": 14.7,
  "setup_minutes": 5.0,
  "machining_minutes": 9.7,
  "operations": [
    { "operation_id": "OP001", "minutes": 0.05,
      "note": "Center drill 8× pilot holes" },
    { "operation_id": "OP002", "minutes": 0.15,
      "note": "Drill 8× Ø6.731mm through" },
    { "operation_id": "OP003", "minutes": 2.80,
      "note": "Rough mill pocket 116.87mm dia" }
  ]
}
```

**Reliability note:** The LLM estimates are based on general machining knowledge. They will be less precise than Approach 2's formula-driven times for complex multi-feature parts, but they handle unusual features or edge cases more gracefully because the model can reason from context.

---

### Step 6 — Cost Estimation (`POST /v1/cost`)

Identical to Approach 2 Step 6. Pure deterministic formula — no LLM involved.

```
total_usd = raw_material ($15) + (total_minutes / 60) × shop_rate ($60/hr)
```

**Sample output:**
```json
{
  "total_usd": 28.70,
  "currency": "USD",
  "shop_rate_per_hour": 60,
  "material_cost": 15.0,
  "machining_cost": 13.70,
  "breakdown": [
    { "item": "Raw Material", "usd": 15.00 },
    { "item": "Setup",        "usd":  5.00 },
    { "item": "Machining",    "usd":  8.70 }
  ]
}
```

---

## 3.4 Approach Comparison

| Criterion | Approach 1 — LLM Steps | Approach 2 — FreeCAD |
|---|---|---|
| **GD&T extraction** | Qwen3-VL (identical) | Qwen3-VL (identical) |
| **3D geometry** | FreeCAD (fast path) + text LLM fallback | FreeCAD only (deterministic) |
| **Process planning** | Qwen3-VL text reasoning | Python `ProcessMapper` (rule-based) |
| **Cycle time** | LLM estimates from operations | Deterministic formula (speeds/feeds tables) |
| **Cost** | Deterministic formula (identical) | Deterministic formula (identical) |
| **Total latency** | ~15–25 min (4 LLM calls) | ~5–10 min (1 VLM + deterministic steps) |
| **Result variability** | LLM may differ slightly per run | Identical output for the same STEP |
| **Handles novel parts** | Better — LLM reasons flexibly | Requires standard machining feature types |
| **Reasoning transparency** | `thinking` field exposes model reasoning | No thinking — code is the explanation |
| **Failure mode** | Silent degradation if LLM hallucinates | Missing features if FreeCAD mis-classifies |
| **Best for** | Complex drawings, uncommon materials | Standard machined parts, batch pricing |

---

*End of technical report.*
