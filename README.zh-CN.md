# Opsevo-x

<div align="center">

[English](README.md) | [中文](README.zh-CN.md)

![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3.4-42b883.svg)

**泛化 AIOps 智能运维平台 — 设备无关的事件驱动自动化运维框架**

[架构设计](#架构设计) · [快速开始](#快速开始) · [部署指南](#docker-部署推荐) · [开发指南](#开发环境)

</div>

---

## 项目简介

Opsevo-x 是一个泛化 AIOps 智能运维平台，通过设备驱动抽象层支持任意网络设备（API / SSH / SNMP），以事件驱动的 Brain Loop Engine 为核心，实现智能监控、告警分析、故障自愈和自然语言交互。

### 核心特性

- **设备无关** — DeviceDriver 统一接口，插件化驱动（API Driver / SSH Driver / SNMP Driver）
- **事件驱动** — EventBus + BrainLoopEngine 替代轮询，统一感知源（Syslog / SNMP Trap / Webhook）
- **AI 大脑** — 多 LLM 适配（OpenAI / Gemini / Qwen / Zhipu），ReAct 推理，RAG 知识增强
- **学习进化** — Critic → Reflector → PatternLearner → EvolutionEngine 闭环
- **向量化** — PostgreSQL + pgvector，Python Core 作为 Embedding 唯一入口
- **Skill 胶囊** — 可扩展技能系统，MCP Gateway 集成

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
│  PromptModule │ KnowledgeGraph │ KnowledgeBase                  │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: AI Foundation                                         │
│  Python Core (Embedding + VectorStore) │ AdapterPool            │
│  RateLimiter │ TokenBudget                                      │
├─────────────────────────────────────────────────────────────────┤
│  Layer 0: Infrastructure                                        │
│  EventBus │ PgDataStore │ DeviceManager │ SyslogManager         │
│  SNMPTrapReceiver │ DeviceDriverPlugins │ ServiceLifecycle       │
│  TracingService │ DegradationManager                            │
└─────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术选型 | 说明 |
| ---- | -------- | ---- |
| 前端 | Vue 3 + TypeScript + Vite | AIOps 工作台 |
| BFF 网关 | Node.js + Express + TypeScript | BFF 层，路由 / 认证 / 设备代理 |
| AIOps 核心 | Python 3.11+ + FastAPI | 向量化 / Embedding 唯一入口 |
| 数据库 | PostgreSQL 15 + pgvector | 统一业务 + 向量存储 |
| 设备驱动 | 插件化 API / SSH / SNMP Driver | 通过 Profile 配置适配任意设备 |
| AI / LLM | OpenAI, Gemini, Qwen, Zhipu | 多供应商适配 |
| 测试 | Jest + fast-check / pytest + hypothesis | 属性测试 |
| 部署 | Docker Compose | Node.js BFF + Python Core + PostgreSQL |

### 部署架构

```text
Browser ──→ Node.js BFF (:3099) ──REST──→ Python Core (:8001)
                │                              │
                └──── pg client ───→ PostgreSQL + pgvector (:5432)
                                               ↑
                                    psycopg ───┘

Syslog Sources ──UDP/TCP :514──→ BFF (SyslogManager)
SNMP Devices ──UDP :162──→ BFF (SNMPTrapReceiver)
Webhooks ──HTTP POST──→ BFF (EventBus)
```

---

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- Python >= 3.11
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

# AI 供应商（选择一个）
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key

# 可选：修改内部 API 密钥以增强安全性
INTERNAL_API_KEY=your-random-secret
```

启动所有服务：

```bash
# 启动 PostgreSQL + Python Core + BFF（3 个服务）
docker-compose up -d

# 查看服务状态
docker-compose ps

# 查看 BFF 日志
docker-compose logs -f opsevo-bff

# 查看所有日志
docker-compose logs -f
```

通过 `http://your-server:8080` 访问平台。

#### 端口映射

| 端口 | 协议 | 服务 | 说明 |
| ---- | ---- | ---- | ---- |
| 8080 | TCP | BFF | Web UI + API（可通过 `PORT` 配置） |
| 514 | UDP | BFF | Syslog 接收（可通过 `SYSLOG_PORT` 配置） |
| 162 | UDP | BFF | SNMP Trap 接收（可通过 `SNMP_TRAP_PORT` 配置） |
| 5432 | TCP | PostgreSQL | 数据库（可通过 `PG_PORT` 配置） |
| 8001 | TCP | Python Core | Embedding 服务（可通过 `PYTHON_CORE_PORT` 配置） |

#### 数据持久化

使用 Docker Volume 保证数据在容器重启后不丢失：

| Volume | 挂载路径 | 内容 |
| ------ | -------- | ---- |
| `opsevo-data` | `/app/backend/data` | 配置、规则、知识库 |
| `opsevo-logs` | `/app/backend/logs` | 应用日志 |
| `opsevo-pgdata` | `/var/lib/postgresql/data` | PostgreSQL 数据文件 |

#### 常用操作

```bash
# 停止所有服务
docker-compose down

# 停止并删除数据卷（警告：会删除所有数据）
docker-compose down -v

# 代码更新后重新构建
docker-compose build --no-cache
docker-compose up -d

# 重启单个服务
docker-compose restart opsevo-bff

# 查看资源占用
docker stats
```

### 开发环境

```bash
# 安装依赖
cd backend && npm install
cd ../frontend && npm install

# 启动 PostgreSQL（需要本地 PostgreSQL 或 Docker）
docker-compose up -d postgres python-core

# 启动后端
cd backend && npm run dev    # 端口 3099

# 启动前端
cd frontend && npm run dev   # 端口 5173

# 或使用根目录并发启动
npm run dev
```

### 主要环境变量

| 变量名 | 默认值 | 说明 |
| ------ | ------ | ---- |
| PG_PASSWORD | *（必填）* | PostgreSQL 密码 |
| PG_USER | opsevo | PostgreSQL 用户名 |
| PG_DATABASE | opsevo | 数据库名 |
| INTERNAL_API_KEY | changeme | BFF ↔ Python Core 内部认证密钥 |
| EMBEDDING_MODEL | all-MiniLM-L6-v2 | 本地 Embedding 模型 |
| AI_PROVIDER | gemini | AI 供应商（openai / gemini / qwen / zhipu） |
| AI_MODEL_NAME | gemini-1.5-flash | LLM 模型名 |
| PORT | 8080 | 外部访问端口 |
| SYSLOG_PORT | 514 | Syslog UDP 端口 |
| SNMP_TRAP_PORT | 162 | SNMP Trap UDP 端口 |

完整配置见 `.env.example`。

---

## 设备驱动插件

Opsevo-x 通过 DeviceDriver 统一接口抽象所有设备交互，支持三种驱动类型：

| 驱动 | 目录 | 适用场景 |
| ---- | ---- | -------- |
| API Driver | `plugins/api-driver/` | REST API 设备（RouterOS, Cisco DNA 等），通过 YAML Profile 配置 |
| SSH Driver | `plugins/ssh-driver/` | Linux / Unix 服务器，SSH 命令执行 + 指标采集 |
| SNMP Driver | `plugins/snmp-driver/` | 网络设备 SNMP v2c / v3 监控 |

API Driver 使用 Profile 机制，通过 YAML 配置文件描述设备 API 的端点映射、认证方式和响应转换规则，无需编写代码即可接入新设备类型。

---

## 项目结构

```text
opsevo-x/
├── backend/                      # Node.js BFF 网关
│   └── src/
│       ├── controllers/          # 控制器层
│       ├── routes/               # 路由定义
│       ├── services/
│       │   ├── ai/               # LLM 适配器
│       │   ├── ai-ops/           # AIOps 核心服务
│       │   │   ├── brain/        # BrainLoopEngine
│       │   │   ├── rag/          # RAG 知识库 + ReAct 推理
│       │   │   ├── skill/        # Skill 技能系统
│       │   │   ├── prompt/       # Prompt 模块化系统
│       │   │   ├── stateMachine/ # 状态机编排层
│       │   │   └── ...           # 告警 / 进化 / 巡检 / 追踪等
│       │   ├── device/           # DeviceManager + DevicePool
│       │   ├── syslog/           # SyslogManager
│       │   ├── snmp/             # SNMPTrapReceiver
│       │   └── core/             # EventBus, PgDataStore, ServiceLifecycle
│       └── types/                # 类型定义
├── frontend/                     # Vue 3 AIOps 工作台
├── plugins/                      # 设备驱动插件
│   ├── api-driver/               # API Driver + Profile
│   ├── ssh-driver/               # SSH Driver
│   └── snmp-driver/              # SNMP Driver
├── python-core/                  # Python Core (Embedding + VectorStore)
├── docker-compose.yml            # 三服务编排
├── Dockerfile                    # BFF 多阶段构建
└── .env.example                  # 环境变量模板
```

---

## 测试

```bash
# 后端测试（Jest + fast-check 属性测试）
cd backend && npm test

# 前端测试
cd frontend && npm test

# 全部测试
npm test
```

---

## 开发规范

- TypeScript 严格模式
- ESLint + Prettier
- 属性测试（fast-check / hypothesis）验证正确性属性
- 事件驱动，避免 `setInterval` 轮询

---

## 许可证

Apache License 2.0 — 详见 [LICENSE](LICENSE)。
