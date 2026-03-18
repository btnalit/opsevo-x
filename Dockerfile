# Opsevo-x - Multi-stage Dockerfile
# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./

# Install dependencies
RUN npm ci

# Copy frontend source
COPY frontend/ ./

# Build frontend (increase heap for vue-tsc + vite on large projects)
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

# Copy backend package files
COPY backend/package*.json ./

# Install dependencies
RUN npm ci

# Copy backend source
COPY backend/ ./

# Build backend
RUN npm run build

# Stage 3: Production Image
FROM node:20-alpine AS production

# Install tini for proper signal handling
RUN apk add --no-cache tini

WORKDIR /app

# Copy backend package files
COPY backend/package*.json ./backend/

# Install production dependencies (skip scripts to avoid patch-package error since it's a devDep)
# Clean npm cache to reduce image size
RUN cd backend && npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built backend
COPY --from=backend-builder /app/backend/dist ./backend/dist

# Copy built frontend to backend public directory
COPY --from=frontend-builder /app/frontend/dist ./backend/public

# Copy skill data files to BACKUP location (not in /app/backend/data which is mounted as volume)
# This ensures builtin skills survive volume mounts
COPY backend/data/ai-ops/skills /app/skills-backup

# Copy evolution config to BACKUP location for first-time setup
COPY backend/data/ai-ops/evolution-config.json /app/config-backup/evolution-config.json

# Note: prompt-templates.json is NOT copied to backup because:
# 1. Default templates are defined in code (DEFAULT_SYSTEM_TEMPLATES in promptTemplateService.ts)
# 2. The service auto-creates them on first startup if file doesn't exist
# 3. User modifications are preserved in the volume-mounted data directory

# Verify backup files exist and create data directory
RUN ls -la /app/skills-backup/builtin/generalist/ && \
    ls -la /app/config-backup/ && \
    mkdir -p /app/backend/data/ai-ops/skills/custom

# Copy entrypoint script and ensure LF line endings (fix Windows CRLF issue)
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3099
# 限制 Node.js 堆内存为 512MB，防止内存泄漏导致 OOM
ENV NODE_OPTIONS="--max-old-space-size=512"

# Expose ports
EXPOSE 3099
EXPOSE 514/udp
EXPOSE 162/udp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3099/api/health || exit 1

# Set stop signal
STOPSIGNAL SIGTERM

# Start the application with entrypoint script (handles skill file sync)
WORKDIR /app/backend
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
