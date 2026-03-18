# Opsevo-x

<div align="center">

[English](README.md) | [中文](README.zh-CN.md)

![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3.4-42b883.svg)

**Generalized AIOps Platform — Device-Agnostic, Event-Driven Intelligent Operations Framework**

[Architecture](#architecture) · [Quick Start](#quick-start) · [Deployment](#docker-deployment) · [Development](#development)

</div>

---

## Overview

Opsevo-x is a generalized AIOps intelligent operations platform. Through a device driver abstraction layer it supports any network device (API / SSH / SNMP). At its core is an event-driven Brain Loop Engine that delivers intelligent monitoring, alert analysis, self-healing, and natural language interaction.

### Key Features

- **Device-Agnostic** — Unified DeviceDriver interface with pluggable drivers (API / SSH / SNMP)
- **Event-Driven** — EventBus + BrainLoopEngine replaces polling; unified perception sources (Syslog / SNMP Trap / Webhook)
- **AI Brain** — Multi-LLM adapters (OpenAI / Gemini / Qwen / Zhipu), ReAct reasoning, RAG knowledge augmentation
- **Learning & Evolution** — Critic → Reflector → PatternLearner → EvolutionEngine closed loop
- **Vectorization** — PostgreSQL + pgvector; Python Core as the single Embedding entry point
- **Skill Capsules** — Extensible skill system with MCP Gateway integration

---

## Architecture

Opsevo-x uses an 8-layer architecture (Layer 0 – Layer 7):

```text
┌─────────────────────────────────────────────────────────────────┐
│  Layer 7: Frontend — Vue 3 AIOps Workbench                      │
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

### Tech Stack

| Layer | Technology | Description |
| ----- | ---------- | ----------- |
| Frontend | Vue 3 + TypeScript + Vite | AIOps Workbench |
| BFF Gateway | Node.js + Express + TypeScript | BFF layer — routing, auth, device proxy |
| AIOps Core | Python 3.11+ + FastAPI | Vectorization / single Embedding entry point |
| Database | PostgreSQL 15 + pgvector | Unified business + vector storage |
| Device Drivers | Pluggable API / SSH / SNMP Drivers | Adapts to any device via Profile config |
| AI / LLM | OpenAI, Gemini, Qwen, Zhipu | Multi-provider adapters |
| Testing | Jest + fast-check / pytest + hypothesis | Property-based testing |
| Deployment | Docker Compose | Node.js BFF + Python Core + PostgreSQL |

### Deployment Architecture

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

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Python >= 3.11
- PostgreSQL 15 + pgvector (provided automatically by Docker Compose)
- Docker & Docker Compose

### Docker Deployment (Recommended)

```bash
# Clone the repository
git clone https://github.com/btnalit/opsevo-x.git
cd opsevo-x

# Configure environment variables
cp .env.example .env
# Edit .env — at minimum set PG_PASSWORD and your AI provider key
```

Edit `.env` with your settings:

```bash
# Required
PG_PASSWORD=your-secure-password

# AI provider (choose one)
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key

# Optional: change internal API key for security
INTERNAL_API_KEY=your-random-secret
```

Start all services:

```bash
# Start PostgreSQL + Python Core + BFF (3 services)
docker-compose up -d

# Check service status
docker-compose ps

# View BFF logs
docker-compose logs -f opsevo-bff

# View all logs
docker-compose logs -f
```

Access the platform at `http://your-server:8080`.

#### Port Mapping

| Port | Protocol | Service | Description |
| ---- | -------- | ------- | ----------- |
| 8080 | TCP | BFF | Web UI + API (configurable via `PORT`) |
| 514 | UDP | BFF | Syslog receiver (configurable via `SYSLOG_PORT`) |
| 162 | UDP | BFF | SNMP Trap receiver (configurable via `SNMP_TRAP_PORT`) |
| 5432 | TCP | PostgreSQL | Database (configurable via `PG_PORT`) |
| 8001 | TCP | Python Core | Embedding service (configurable via `PYTHON_CORE_PORT`) |

#### Data Persistence

Docker volumes are used to persist data across container restarts:

| Volume | Mount Point | Content |
| ------ | ----------- | ------- |
| `opsevo-data` | `/app/backend/data` | Configuration, rules, knowledge base |
| `opsevo-logs` | `/app/backend/logs` | Application logs |
| `opsevo-pgdata` | `/var/lib/postgresql/data` | PostgreSQL database files |

#### Common Operations

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose down -v

# Rebuild after code changes
docker-compose build --no-cache
docker-compose up -d

# Restart a single service
docker-compose restart opsevo-bff

# View resource usage
docker stats
```

### Local Development

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Start PostgreSQL (requires local PostgreSQL or Docker)
docker-compose up -d postgres python-core

# Start backend
cd backend && npm run dev    # port 3099

# Start frontend
cd frontend && npm run dev   # port 5173

# Or use concurrent start from root
npm run dev
```

### Key Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| PG_PASSWORD | *(required)* | PostgreSQL password |
| PG_USER | opsevo | PostgreSQL username |
| PG_DATABASE | opsevo | Database name |
| INTERNAL_API_KEY | changeme | BFF ↔ Python Core internal auth key |
| EMBEDDING_MODEL | all-MiniLM-L6-v2 | Local embedding model |
| AI_PROVIDER | gemini | AI provider (openai / gemini / qwen / zhipu) |
| AI_MODEL_NAME | gemini-1.5-flash | LLM model name |
| PORT | 8080 | External access port |
| SYSLOG_PORT | 514 | Syslog UDP port |
| SNMP_TRAP_PORT | 162 | SNMP Trap UDP port |

See `.env.example` for the full configuration reference.

---

## Device Driver Plugins

Opsevo-x abstracts all device interactions through a unified DeviceDriver interface, supporting three driver types:

| Driver | Directory | Use Case |
| ------ | --------- | -------- |
| API Driver | `plugins/api-driver/` | REST API devices (RouterOS, Cisco DNA, etc.) — configured via YAML Profiles |
| SSH Driver | `plugins/ssh-driver/` | Linux / Unix servers — SSH command execution + metric collection |
| SNMP Driver | `plugins/snmp-driver/` | Network device monitoring via SNMP v2c / v3 |

The API Driver uses a Profile mechanism: YAML config files describe device API endpoint mappings, authentication methods, and response transformation rules — no code required to onboard a new device type.

---

## Project Structure

```text
opsevo-x/
├── backend/                      # Node.js BFF Gateway
│   └── src/
│       ├── controllers/          # Controller layer
│       ├── routes/               # Route definitions
│       ├── services/
│       │   ├── ai/               # LLM adapters
│       │   ├── ai-ops/           # AIOps core services
│       │   │   ├── brain/        # BrainLoopEngine
│       │   │   ├── rag/          # RAG knowledge base + ReAct reasoning
│       │   │   ├── skill/        # Skill system
│       │   │   ├── prompt/       # Modular prompt system
│       │   │   ├── stateMachine/ # State machine orchestration
│       │   │   └── ...           # Alerts / evolution / inspection / tracing
│       │   ├── device/           # DeviceManager + DevicePool
│       │   ├── syslog/           # SyslogManager
│       │   ├── snmp/             # SNMPTrapReceiver
│       │   └── core/             # EventBus, PgDataStore, ServiceLifecycle
│       └── types/                # Type definitions
├── frontend/                     # Vue 3 AIOps Workbench
├── plugins/                      # Device driver plugins
│   ├── api-driver/               # API Driver + Profiles
│   ├── ssh-driver/               # SSH Driver
│   └── snmp-driver/              # SNMP Driver
├── python-core/                  # Python Core (Embedding + VectorStore)
├── docker-compose.yml            # Three-service orchestration
├── Dockerfile                    # BFF multi-stage build
└── .env.example                  # Environment variable template
```

---

## Testing

```bash
# Backend tests (Jest + fast-check property-based testing)
cd backend && npm test

# Frontend tests
cd frontend && npm test

# All tests
npm test
```

---

## Development Standards

- TypeScript strict mode
- ESLint + Prettier
- Property-based testing (fast-check / hypothesis) for correctness validation
- Event-driven design — avoid `setInterval` polling

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
