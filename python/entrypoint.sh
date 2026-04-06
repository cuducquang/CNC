#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# CNCapp Python microservice entrypoint
# Starts the FastAPI FreeCAD microservice (CPU, port 8001).
# The vision model (Qwen3-VL-32B-Thinking-FP8) is served separately by vLLM
# on the RunPod pod — this script does NOT start Ollama or any GPU service.
# ─────────────────────────────────────────────────────────────────────────────
set -e

# ── Start Python FastAPI microservice ────────────────────────────────────────
echo "[startup] Starting Python FreeCAD microservice on :8001..."
cd /app
exec python3 -m uvicorn server:app --host 0.0.0.0 --port 8001
