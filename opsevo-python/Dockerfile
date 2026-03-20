# Opsevo-X Python Backend — Multi-stage Dockerfile
# Requirements: 17.1, 17.2, 17.3, 17.5

# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Stage 2: Python production image
FROM python:3.12-slim AS production

# Install tini, wget, and libpq (required by psycopg)
RUN apt-get update && apt-get install -y --no-install-recommends tini wget libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Python project files
COPY opsevo-python/pyproject.toml ./
COPY opsevo-python/src/ ./src/

# Install Python dependencies (no dev deps)
RUN pip install --no-cache-dir . \
    && pip cache purge 2>/dev/null || true

# Copy device profiles
COPY opsevo-python/profiles/ ./profiles/

# Copy built frontend to public directory
COPY --from=frontend-builder /app/frontend/dist ./public

# Copy skill data files to backup location
COPY opsevo-python/data/ai-ops/skills /app/skills-backup
COPY opsevo-python/data/ai-ops/evolution-config.json /app/config-backup/evolution-config.json

# Create data directory
RUN mkdir -p /app/data/ai-ops/skills/custom

# Copy entrypoint script
COPY opsevo-python/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# Environment
ENV ENV=production
ENV PORT=3099
ENV PYTHONUNBUFFERED=1

# Expose ports
EXPOSE 3099
EXPOSE 514/udp
EXPOSE 162/udp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3099/api/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["uvicorn", "opsevo.main:app", "--host", "0.0.0.0", "--port", "3099"]
