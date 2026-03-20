# Opsevo-x

<div align="center">

[English](README.md) | [中文](README.zh-CN.md)

![Version](https://img.shields.io/badge/version-4.0.0-blue.svg)
![Python](https://img.shields.io/badge/python-%3E%3D3.12-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3.4-42b883.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688.svg)

**泛化 AIOps 智能运维平台 — 设备无关的事件驱动自动化运维框架**

[架构设计](#架构设计) · [快速开始](#快速开始) · [部署指南](#docker-部署推荐) · [开发指南](#开发环境)

</div>

---

## 项目简介

Opsevo-x 是一个泛化 AIOps 智能运维平台，通过设备驱动抽象层支持任意网络设备（API / SSH / SNMP），以事件驱动的 Brain Loop Engine 为核心，实现智能监控、告警分析、故障自愈和自然语言交互。

### 核心特性

- **设备无关** — DeviceDriver 统一接口，插件化驱动（API Driver / SSH Driver / SNMP Driver）
- **设备编排** — DeviceOrchestrator 集中管理设备生命周期：健康检查、指标采集、热插拔、SSE 实时事件推送、离线设备指数退避
- **事件驱动** — EventBus + BrainLoopEngine 替代轮询，统一感知源（Syslog / SNMP Trap / Webhook）
- **AI 大脑** — 多 LLM 适配（OpenAI / Gemini / Claude / DeepSeek / Qwen / Zhipu），ReAct 推理，RAG 知识增强
- **学习进化** — Critic → Reflector → PatternLearner → EvolutionEngine 闭环
- **向量化** — PostgreSQL + pgvector，内置 Embedding（本地模型或远程 API）
- **Skill 胶囊** — 可扩展技能系统，MCP Gateway 集成
- **统一后端** — 单一 Python/FastAPI 进程提供 API、前端静态文件和全部 AIOps 服务

---

## 架构设计

Opsevo-x 采用 8 层架构（Layer 0 — Layer 7）：

```text
┌─────────────────────────────────────────────────────────────────┐
│  Layer 7: Frontend — Vue3 AIOps 工作台                          │
│  GenericDeviceView │ CognitiveCockpit │ AlertEvents │ Topology  │
├─────────────────────────────────────────────────────────────────┤
│  Layer 6: User Interaction                                      │
│  ChatSystem │ NotificationService │ RAGEngine │ UnifiedAgent    │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: Brain Core                                            │
│  BrainLoopEngine │ AlertPipeline │ TopologyDiscovery            │
│  FaultHealer │ ProactiveInspector │ StateMachine                │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: Learning & Evolution                                  │
│  CriticService → ReflectorService → PatternLearner              │
│  → EvolutionEngine │ LearningOrchestrator                       │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: Skill & Tool Execution                                │
│  ToolRegistry │ SkillFactory │ MCP Gateway │ Skill Capsules     │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Knowledge & Prompt                                    │
│  PromptComposer │ KnowledgeGraph │ KnowledgeBase │ VectorStore  │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: AI Foundation                                         │
│  EmbeddingService │ AdapterPool │ RateLimiter │ TokenBudget     │
├─────────────────────────────────────────────────────────────────┤
│  Layer 0: Infrastructure                                        │
│  EventBus │ PgDataStore │ DeviceManager │ DeviceOrchestrator    │
│  SyslogManager │ SNMPTrapReceiver │ DeviceDriverPlugins         │
│  ServiceLifecycle │ TracingService │ DegradationManager         │
└─────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术选型 | 说明 |
| ---- | -------- | ---- |
| 前端 | Vue 3 + TypeScript + Vite | AIOps 工作台 |
| 后端 | Python 3.12+ + FastAPI + Uvicorn | 统一后端 — API、认证、AIOps、Embedding |
| 数据库 | PostgreSQL 15 + pgvector | 统一业务 + 向量存储 |
| 设备驱动 | 插件化 API / SSH / SNMP Driver | 通过 Profile 配置适配任意设备 |
| AI / LLM | OpenAI, Gemini, Claude, DeepSeek, Qwen, Zhipu | 多供应商适配 |
| 测试 | pytest + hypothesis | 属性测试 |
| 部署 | Docker Compose | Python 后端 + PostgreSQL（2 容器） |

### 部署架构

```text
Browser ──→ Python/FastAPI (:3099) ──psycopg──→ PostgreSQL + pgvector (:5432)
                │
                ├── 提供 Vue 3 SPA 静态文件
                ├── REST API + SSE 流式响应
                ├── DeviceOrchestrator（生命周期、健康检查、指标采集）
                ├── Syslog 接收 (UDP :514)
                └── SNMP Trap 接收 (UDP :162)
```

---

## 快速开始

### 环境要求

- Python >= 3.12
- PostgreSQL 15 + pgvector（Docker Compose 自动提供）
- Docker & Docker Compose

### Docker 部署（推荐）

```bash
# 克隆项目
git clone https://github.com/btnalit/opsevo-x.git
cd opsevo-x

# 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置 PG_PASSWORD 和 AI 供应商密钥
```

编辑 `.env` 配置：

```bash
# 必填
PG_PASSWORD=your-secure-password
JWT_SECRET=your-jwt-secret

# AI 供应商（选择一个）
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key

# 可选：修改内部 API 密钥以增强安全性
INTERNAL_API_KEY=your-random-secret
```

启动所有服务：

```bash
# 拉取镜像并启动 PostgreSQL + Opsevo（2 个服务）
docker-compose pull
docker-compose up -d

# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs -f opsevo

# 查看所有日志
docker-compose logs -f
```

通过 `http://your-server:8080` 访问平台。

#### 端口映射

| 端口 | 协议 | 服务 | 说明 |
| ---- | ---- | ---- | ---- |
| 8080 | TCP | Opsevo | Web UI + API（可通过 `PORT` 配置） |
| 514 | UDP | Opsevo | Syslog 接收（可通过 `SYSLOG_PORT` 配置） |
| 162 | UDP | Opsevo | SNMP Trap 接收（可通过 `SNMP_TRAP_PORT` 配置） |
| 5432 | TCP | PostgreSQL | 数据库（可通过 `PG_PORT` 配置） |

#### 数据持久化

使用 Docker Volume 保证数据在容器重启后不丢失：

| Volume | 挂载路径 | 内容 |
| ------ | -------- | ---- |
| `opsevo-data` | `/app/data` | 配置、规则、知识库 |
| `opsevo-logs` | `/app/logs` | 应用日志 |
| `opsevo-pgdata` | `/var/lib/postgresql/data` | PostgreSQL 数据文件 |

#### 常用操作

```bash
# 停止所有服务
docker-compose down

# 停止并删除数据卷（警告：会删除所有数据）
docker-compose down -v

# 更新到最新镜像
docker-compose pull
docker-compose up -d

# 重启单个服务
docker-compose restart opsevo

# 查看资源占用
docker stats
```

### 开发环境

```bash
# 安装 Python 依赖
cd opsevo-python
pip install -e ".[dev]"

# 启动 PostgreSQL
docker-compose up -d postgres

# 启动后端（热重载）
uvicorn opsevo.main:app --host 0.0.0.0 --port 3099 --reload

# 启动前端（另一个终端）
cd frontend && npm install && npm run dev   # 端口 5173
```

### 主要环境变量

| 变量名 | 默认值 | 说明 |
| ------ | ------ | ---- |
| PG_PASSWORD | *（必填）* | PostgreSQL 密码 |
| PG_USER | opsevo | PostgreSQL 用户名 |
| PG_DATABASE | opsevo | 数据库名 |
| JWT_SECRET | *（生产环境必填）* | JWT 签名密钥 |
| INTERNAL_API_KEY | changeme | 内部认证密钥 |
| EMBEDDING_MODEL | all-MiniLM-L6-v2 | Embedding 模型名 |
| AI_PROVIDER | gemini | AI 供应商（openai / gemini / claude / deepseek / qwen / zhipu） |
| AI_MODEL_NAME | gemini-1.5-flash | LLM 模型名 |
| PORT | 8080 | 外部访问端口 |
| SYSLOG_PORT | 514 | Syslog UDP 端口 |
| SNMP_TRAP_PORT | 162 | SNMP Trap UDP 端口 |

完整配置见 `.env.example`。

---

## 设备驱动插件

Opsevo-x 通过 DeviceDriver 统一接口抽象所有设备交互，支持三种驱动类型：

| 驱动 | 协议 | 适用场景 |
| ---- | ---- | -------- |
| API Driver | HTTP REST | REST API 设备（RouterOS, Cisco DNA 等），通过 YAML Profile 配置 |
| SSH Driver | SSH | Linux / Unix 服务器，SSH 命令执行 + 指标采集 |
| SNMP Driver | SNMP v2c/v3 | 网络设备 SNMP 监控 |

API Driver 使用 Profile 机制，通过 YAML 配置文件描述设备 API 的端点映射、认证方式和响应转换规则，无需编写代码即可接入新设备类型。

---

## 项目结构

```text
opsevo-x/
├── opsevo-python/                # Python 统一后端
│   ├── src/opsevo/
│   │   ├── api/                  # FastAPI 路由处理
│   │   ├── middleware/           # 认证、超时、设备上下文
│   │   ├── models/              # Pydantic 数据模型
│   │   ├── services/
│   │   │   ├── ai/              # LLM 适配器 + Prompt 系统
│   │   │   ├── ai_ops/          # AIOps 核心（告警、调度、进化）
│   │   │   ├── brain/           # BrainLoopEngine + OODA 循环
│   │   │   ├── rag/             # RAG + ReAct + VectorStore + Embedding
│   │   │   ├── skill/           # Skill 胶囊系统
│   │   │   ├── mcp/             # MCP 服务端/客户端 + 工具注册
│   │   │   ├── topology/        # 拓扑发现
│   │   │   ├── state_machine/   # 状态机编排
│   │   │   ├── bridges/         # EventBus 桥接
│   │   │   └── device_orchestrator.py  # 设备生命周期编排
│   │   ├── drivers/             # 设备驱动插件（API/SSH/SNMP）
│   │   ├── data/                # DataStore + 迁移
│   │   ├── events/              # EventBus
│   │   ├── utils/               # 加密、Token、日志
│   │   ├── main.py              # FastAPI 应用 + 生命周期
│   │   ├── settings.py          # Pydantic Settings
│   │   └── container.py         # DI 容器
│   ├── profiles/                # 设备 YAML Profile
│   ├── tests/                   # pytest + hypothesis 测试
│   ├── Dockerfile               # 多阶段构建
│   └── pyproject.toml           # Python 项目配置
├── frontend/                    # Vue 3 AIOps 工作台
├── docker-compose.yml           # 2 服务编排
└── .env.example                 # 环境变量模板
```

---

## 测试

```bash
cd opsevo-python

# 运行全部测试
python -m pytest tests/ -v

# 仅运行属性测试
python -m pytest tests/property/ -v

# 仅运行单元测试
python -m pytest tests/unit/ -v

# 仅运行集成测试
python -m pytest tests/integration/ -v
```

---

## 开发规范

- Python 3.12+，全面使用类型注解
- Ruff 代码检查与格式化
- 属性测试（hypothesis）验证正确性属性
- 事件驱动，避免轮询
- Pydantic 模型定义所有请求/响应 Schema
- 全异步 async/await，无阻塞 I/O

---

## 许可证

Apache License 2.0 — 详见 [LICENSE](LICENSE)。
