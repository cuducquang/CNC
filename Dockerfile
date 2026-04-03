# ============================================================
# CNCapp — single-image build
# Next.js (port 3000) + Python FastAPI/FreeCAD (port 8001)
# managed by supervisord
#
# Use docker compose — it handles build args + runtime vars automatically:
#   docker compose up --build
# ============================================================


# ────────────────────────────────────────────────────────────
# Stage 1: Install Node deps
# Separate layer so npm ci is cached unless package*.json changes
# ────────────────────────────────────────────────────────────
FROM node:20-slim AS node-deps

WORKDIR /build
COPY package*.json ./
RUN npm ci


# ────────────────────────────────────────────────────────────
# Stage 2: Build Next.js (standalone output)
# output: "standalone" gives us a self-contained server.js
# that needs NO node_modules from the host — Docker-friendly
# ────────────────────────────────────────────────────────────
FROM node:20-slim AS node-builder

WORKDIR /build
COPY --from=node-deps /build/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are baked into the JS bundle at build time.
# Pass them as build args so the compiled output has the real values.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone

RUN npm run build


# ────────────────────────────────────────────────────────────
# Stage 3: Final runtime image
# Ubuntu 22.04 chosen because FreeCAD 0.20 (apt) is built
# against Ubuntu 22.04's Python 3.10 — ABI must match.
# ────────────────────────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages (single RUN = single layer) ──────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        # FreeCAD headless + Python 3.10 bindings
        freecad \
        # Python runtime (3.10 matches FreeCAD ABI on Ubuntu 22.04)
        python3 python3-pip python3-dev \
        # PDF→image fallback (pypdfium2 is preferred but poppler is backup)
        poppler-utils \
        # curl: used by Node.js installer + HEALTHCHECK
        curl ca-certificates \
        # Multi-process manager
        supervisor \
    # Node.js 20 LTS via NodeSource
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # Clean up — keeps the image lean
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*


WORKDIR /app

# ── Python deps (cached layer — only reinstalls when requirements.txt changes)
COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --no-cache-dir -r python/requirements.txt

# ── Python source ─────────────────────────────────────────────
COPY python/ ./python/

# ── Next.js standalone build ──────────────────────────────────
# .next/standalone/ is a self-contained Node.js server:
#   server.js + its own bundled node_modules (~10 MB vs ~300 MB full install)
COPY --from=node-builder /build/.next/standalone ./
COPY --from=node-builder /build/.next/static     ./.next/static

# ── Supervisor config ─────────────────────────────────────────
COPY docker/supervisord.conf /etc/supervisor/conf.d/cncapp.conf

# ── Runtime environment ───────────────────────────────────────
# These are defaults — override at runtime via --env or --env-file
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    FREECAD_PATH=/usr/lib/freecad/lib \
    PYTHONPATH=/app/python \
    PYTHON_SERVICE_URL=http://localhost:8001 \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s \
    CMD curl -sf http://localhost:3000/ && curl -sf http://localhost:8001/health || exit 1

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
