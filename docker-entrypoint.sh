#!/bin/sh
set -e

# Opsevo-x Docker Entrypoint
# 解决 Docker volume 覆盖 builtin skill 文件的问题
# 同时处理 evolution-config.json 默认配置

SKILLS_DIR="/app/backend/data/ai-ops/skills"
BACKUP_DIR="/app/skills-backup"
AI_OPS_DIR="/app/backend/data/ai-ops"
CONFIG_BACKUP_DIR="/app/config-backup"

echo "=== Opsevo-x Startup ==="
echo "Working directory: $(pwd)"
echo "Skills directory: $SKILLS_DIR"
echo "Backup directory: $BACKUP_DIR"
echo "Config backup directory: $CONFIG_BACKUP_DIR"

# 确保目录结构存在
mkdir -p "$SKILLS_DIR/builtin"
mkdir -p "$SKILLS_DIR/custom"
mkdir -p "$AI_OPS_DIR"

# 同步 builtin skills（每次启动都覆盖，确保最新版本）
# 这是安全的，因为 builtin skills 应该是只读的，用户不应修改
if [ -d "$BACKUP_DIR/builtin" ]; then
    echo "Syncing builtin skills from backup..."
    # 使用 cp -r 覆盖，确保 builtin skills 始终是最新版本
    cp -r "$BACKUP_DIR/builtin"/* "$SKILLS_DIR/builtin/"
    echo "Builtin skills synced successfully."
else
    echo "ERROR: Backup directory not found: $BACKUP_DIR/builtin"
    echo "This is a critical error - builtin skills are required!"
    # 不退出，让应用启动并报告更详细的错误
fi

# mapping.json 处理策略：
# - 如果不存在，从备份复制（首次启动）
# - 如果存在，保留用户的修改（用户可能禁用了某些 skills）
# - 如果需要强制更新 mapping，用户可以手动删除后重启
if [ ! -f "$SKILLS_DIR/mapping.json" ]; then
    if [ -f "$BACKUP_DIR/mapping.json" ]; then
        echo "Copying mapping.json (first time setup)..."
        cp "$BACKUP_DIR/mapping.json" "$SKILLS_DIR/"
    else
        echo "WARNING: No mapping.json found in backup"
    fi
else
    echo "mapping.json exists, preserving user modifications"
fi

# evolution-config.json 处理策略：
# - 如果不存在，从备份复制（首次启动）
# - 如果存在，保留用户的修改（用户可能调整了进化配置）
# - 支持热更新，无需重启服务
if [ ! -f "$AI_OPS_DIR/evolution-config.json" ]; then
    if [ -f "$CONFIG_BACKUP_DIR/evolution-config.json" ]; then
        echo "Copying evolution-config.json (first time setup)..."
        cp "$CONFIG_BACKUP_DIR/evolution-config.json" "$AI_OPS_DIR/"
    else
        echo "WARNING: No evolution-config.json found in backup"
    fi
else
    echo "evolution-config.json exists, preserving user modifications"
fi

# 显示 skill 文件状态
echo "=== Skill Files Status ==="
echo "Builtin skills:"
ls -la "$SKILLS_DIR/builtin/" 2>/dev/null || echo "  (none)"
echo "Custom skills:"
ls -la "$SKILLS_DIR/custom/" 2>/dev/null || echo "  (none)"
echo "==========================="

# 显示配置文件状态
echo "=== Config Files Status ==="
if [ -f "$AI_OPS_DIR/evolution-config.json" ]; then
    echo "evolution-config.json: exists"
else
    echo "evolution-config.json: missing"
fi
echo "==========================="

# 执行传入的命令
exec "$@"
