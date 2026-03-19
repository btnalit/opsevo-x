#!/bin/sh
set -e

# Sync builtin skill files from backup to data volume (first-time setup)
if [ -d /app/skills-backup/builtin ] && [ ! -f /app/data/ai-ops/skills/builtin/.synced ]; then
    echo "[entrypoint] Syncing builtin skills to data volume..."
    mkdir -p /app/data/ai-ops/skills/builtin
    cp -r /app/skills-backup/builtin/* /app/data/ai-ops/skills/builtin/
    touch /app/data/ai-ops/skills/builtin/.synced
fi

# Sync evolution config if not present
if [ -f /app/config-backup/evolution-config.json ] && [ ! -f /app/data/ai-ops/evolution-config.json ]; then
    echo "[entrypoint] Copying default evolution config..."
    mkdir -p /app/data/ai-ops
    cp /app/config-backup/evolution-config.json /app/data/ai-ops/evolution-config.json
fi

# Sync skill mapping if not present
if [ -f /app/skills-backup/mapping.json ] && [ ! -f /app/data/ai-ops/skills/mapping.json ]; then
    echo "[entrypoint] Copying default skill mapping..."
    cp /app/skills-backup/mapping.json /app/data/ai-ops/skills/mapping.json
fi

echo "[entrypoint] Starting Opsevo-X Python backend..."
exec "$@"
