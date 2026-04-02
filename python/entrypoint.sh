#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CNCapp RunPod entrypoint
# Starts Ollama (GPU, port 11434) + Python FreeCAD microservice (CPU, port 8001)
# ─────────────────────────────────────────────────────────────────────────────
set -e

# ── Model storage: use RunPod network volume when available ──────────────────
# Mount your network volume at /workspace in the RunPod pod settings.
# The model (~5 GB) is downloaded once and cached across restarts.
export OLLAMA_MODELS="${OLLAMA_MODELS:-/workspace/ollama}"
export OLLAMA_HOST="0.0.0.0"

echo "[startup] OLLAMA_MODELS=$OLLAMA_MODELS"

# ── Start Ollama ─────────────────────────────────────────────────────────────
echo "[startup] Starting Ollama..."
ollama serve &
OLLAMA_PID=$!

# Wait until Ollama API responds (up to 120 s)
echo "[startup] Waiting for Ollama to be ready..."
for i in $(seq 1 60); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "[startup] Ollama ready (${i}x2 s)."
        break
    fi
    if ! kill -0 "$OLLAMA_PID" 2>/dev/null; then
        echo "[startup] ERROR: Ollama process died."
        exit 1
    fi
    sleep 2
done

# ── Pull model if not already cached ─────────────────────────────────────────
if ollama list 2>/dev/null | grep -q "qwen3-vl:8b"; then
    echo "[startup] qwen3-vl:8b already cached — skipping pull."
else
    echo "[startup] Pulling qwen3-vl:8b (~5 GB). This takes 5-10 min on first boot..."
    ollama pull qwen3-vl:8b
    echo "[startup] Pull complete."
fi

# ── Start Python FastAPI microservice ────────────────────────────────────────
echo "[startup] Starting Python FreeCAD microservice on :8001..."
cd /app
python3 -m uvicorn server:app --host 0.0.0.0 --port 8001 &
UVICORN_PID=$!

echo "[startup] All services running."
echo "[startup]   Ollama  PID=$OLLAMA_PID  → http://0.0.0.0:11434"
echo "[startup]   FastAPI PID=$UVICORN_PID → http://0.0.0.0:8001"

# ── Keep container alive; exit if either service dies ────────────────────────
wait -n "$OLLAMA_PID" "$UVICORN_PID"
EXIT_CODE=$?
echo "[startup] A service exited with code $EXIT_CODE — shutting down."
kill "$OLLAMA_PID" "$UVICORN_PID" 2>/dev/null || true
exit "$EXIT_CODE"
