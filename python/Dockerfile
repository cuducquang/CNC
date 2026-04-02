# ─────────────────────────────────────────────────────────────────────────────
# CNCapp Python microservice + Ollama — RunPod GPU deployment
#
# Exposes:
#   :8001  FastAPI / FreeCAD STEP analysis
#   :11434 Ollama (qwen3-vl:8b)
#
# Build:
#   docker build -t yourname/cncapp-gpu:latest .
#   docker push yourname/cncapp-gpu:latest
#
# Run locally (no GPU):
#   docker run -p 8001:8001 -p 11434:11434 yourname/cncapp-gpu:latest
#
# Run on RunPod:
#   Use this image in a GPU pod with a network volume mounted at /workspace
#   The model is cached in /workspace/ollama and survives pod restarts.
# ─────────────────────────────────────────────────────────────────────────────

# Start from the official Ollama image (Ubuntu 22.04 + CUDA + Ollama binary)
FROM ollama/ollama:latest

ENV DEBIAN_FRONTEND=noninteractive
# Bind Ollama to all interfaces so RunPod's HTTP proxy can reach it
ENV OLLAMA_HOST=0.0.0.0

# ── System packages: Python 3 + FreeCAD Python bindings ─────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-dev \
        freecad \
        python3-freecad \
        curl \
    && rm -rf /var/lib/apt/lists/*

# ── Python microservice dependencies ────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# ── Application code ─────────────────────────────────────────────────────────
COPY . .

# ── Startup script ───────────────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8001 11434

ENTRYPOINT ["/entrypoint.sh"]
