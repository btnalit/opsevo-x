#!/bin/sh
set -e

# Always sync builtin skill files from backup to data volume
# Builtin skills are read-only defaults shipped with the image,
# so we always overwrite to ensure they stay up-to-date.
if [ -d /app/skills-backup/builtin ]; then
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
