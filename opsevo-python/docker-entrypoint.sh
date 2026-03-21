#!/bin/sh
set -e

# Wait until PostgreSQL is reachable to avoid first-boot race conditions
# during initial database/extension setup.
wait_for_postgres() {
    if [ -z "${DATABASE_URL:-}" ]; then
        echo "[entrypoint] DATABASE_URL not set, skip postgres wait."
        return 0
    fi

    MAX_RETRIES="${DB_WAIT_MAX_RETRIES:-120}"
    SLEEP_SECONDS="${DB_WAIT_SLEEP_SECONDS:-2}"
    ATTEMPT=1

    echo "[entrypoint] Waiting for postgres to become reachable..."
    while [ "$ATTEMPT" -le "$MAX_RETRIES" ]; do
        if python -c "import psycopg; psycopg.connect(\"${DATABASE_URL}\", connect_timeout=3).close()" >/dev/null 2>&1; then
            echo "[entrypoint] Postgres is reachable."
            return 0
        fi
        echo "[entrypoint] Postgres not ready yet (${ATTEMPT}/${MAX_RETRIES}), retrying in ${SLEEP_SECONDS}s..."
        ATTEMPT=$((ATTEMPT + 1))
        sleep "$SLEEP_SECONDS"
    done

    echo "[entrypoint] Postgres not reachable after ${MAX_RETRIES} attempts, exiting."
    return 1
}

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

wait_for_postgres

echo "[entrypoint] Starting Opsevo-X Python backend..."
exec "$@"
