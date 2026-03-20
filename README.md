# Opsevo-x

<div align="center">

[English](README.md) | [中文](README.zh-CN.md)

![Version](https://img.shields.io/badge/version-4.0.0-blue.svg)
![Python](https://img.shields.io/badge/python-%3E%3D3.12-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3.4-42b883.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688.svg)

**Generalized AIOps Platform — Device-Agnostic, Event-Driven Intelligent Operations Framework**

[Architecture](#architecture) · [Quick Start](#quick-start) · [Deployment](#docker-deployment) · [Development](#development)

</div>

---

## Overview

Opsevo-x is a generalized AIOps intelligent operations platform. Through a device driver abstraction layer it supports any network device (API / SSH / SNMP). At its core is an event-driven Brain Loop Engine that delivers intelligent monitoring, alert analysis, self-healing, and natural language interaction.

### Key Features

- **Device-Agnostic** — Unified DeviceDriver interface with pluggable drivers (API / SSH / SNMP)
- **Device Orchestration** — Centralized lifecycle management with health checks, metrics collection, hot-plug, SSE real-time events, and exponential backoff for offline devices
- **Event-Driven** — EventBus + BrainLoopEngine replaces polling; unified perception sources (Syslog / SNMP Trap / Webhook)
- **AI Brain** — Multi-LLM adapters (OpenAI / Gemini / Claude / DeepSeek / Qwen / Zhipu), ReAct reasoning, RAG knowledge augmentation
- **Learning & Evolution** — Critic → Reflector → PatternLearner → EvolutionEngine closed loop
- **Vectorization** — PostgreSQL + pgvector; built-in Embedding (local or remote API)
- **Skill Capsules** — Extensible skill system with MCP Gateway integration
- **Unified Backend** — Single Python/FastAPI process serves API, frontend, and all AIOps services

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

### Tech Stack

| Layer | Technology | Description |
| ----- | ---------- | ----------- |
| Frontend | Vue 3 + TypeScript + Vite | AIOps Workbench |
| Backend | Python 3.12+ + FastAPI + Uvicorn | Unified backend — API, auth, AIOps, Embedding |
| Database | PostgreSQL 15 + pgvector | Unified business + vector storage |
| Device Drivers | Pluggable API / SSH / SNMP Drivers | Adapts to any device via Profile config |
| AI / LLM | OpenAI, Gemini, Claude, DeepSeek, Qwen, Zhipu | Multi-provider adapters |
| Testing | pytest + hypothesis | Property-based testing |
| Deployment | Docker Compose | Python backend + PostgreSQL (2 containers) |

### Deployment Architecture

```text
Browser ──→ Python/FastAPI (:3099) ──psycopg──→ PostgreSQL + pgvector (:5432)
                │
                ├── Serves Vue 3 SPA (static files)
                ├── REST API + SSE streaming
                ├── DeviceOrchestrator (lifecycle, health, metrics)
                ├── Syslog receiver (UDP :514)
                └── SNMP Trap receiver (UDP :162)
```

---

## Quick Start

### Prerequisites

- Python >= 3.12
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
JWT_SECRET=your-jwt-secret

# AI provider (choose one)
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key

# Optional: change internal API key for security
INTERNAL_API_KEY=your-random-secret
```

Start all services:

```bash
# Pull images and start PostgreSQL + Opsevo (2 services)
docker-compose pull
docker-compose up -d

# Check service status
docker-compose ps

# View logs
docker-compose logs -f opsevo

# View all logs
docker-compose logs -f
```

Access the platform at `http://your-server:8080`.

#### Port Mapping

| Port | Protocol | Service | Description |
| ---- | -------- | ------- | ----------- |
| 8080 | TCP | Opsevo | Web UI + API (configurable via `PORT`) |
| 514 | UDP | Opsevo | Syslog receiver (configurable via `SYSLOG_PORT`) |
| 162 | UDP | Opsevo | SNMP Trap receiver (configurable via `SNMP_TRAP_PORT`) |
| 5432 | TCP | PostgreSQL | Database (configurable via `PG_PORT`) |

#### Data Persistence

Docker volumes are used to persist data across container restarts:

| Volume | Mount Point | Content |
| ------ | ----------- | ------- |
| `opsevo-data` | `/app/data` | Configuration, rules, knowledge base |
| `opsevo-logs` | `/app/logs` | Application logs |
| `opsevo-pgdata` | `/var/lib/postgresql/data` | PostgreSQL database files |

#### Common Operations

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (WARNING: deletes all data)
docker-compose down -v

# Update to latest images
docker-compose pull
docker-compose up -d

# Restart a single service
docker-compose restart opsevo

# View resource usage
docker stats
```

### Local Development

```bash
# Install Python dependencies
cd opsevo-python
pip install -e ".[dev]"

# Start PostgreSQL
docker-compose up -d postgres

# Start backend (with hot reload)
uvicorn opsevo.main:app --host 0.0.0.0 --port 3099 --reload

# Start frontend (in another terminal)
cd frontend && npm install && npm run dev   # port 5173
```

### Key Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| PG_PASSWORD | *(required)* | PostgreSQL password |
| PG_USER | opsevo | PostgreSQL username |
| PG_DATABASE | opsevo | Database name |
| JWT_SECRET | *(required in production)* | JWT signing secret |
| INTERNAL_API_KEY | changeme | Internal auth key |
| EMBEDDING_MODEL | all-MiniLM-L6-v2 | Embedding model name |
| AI_PROVIDER | gemini | AI provider (openai / gemini / claude / deepseek / qwen / zhipu) |
| AI_MODEL_NAME | gemini-1.5-flash | LLM model name |
| PORT | 8080 | External access port |
| SYSLOG_PORT | 514 | Syslog UDP port |
| SNMP_TRAP_PORT | 162 | SNMP Trap UDP port |

See `.env.example` for the full configuration reference.

---

## Device Driver Plugins

Opsevo-x abstracts all device interactions through a unified DeviceDriver interface, supporting three driver types:

| Driver | Protocol | Use Case |
| ------ | -------- | -------- |
| API Driver | HTTP REST | REST API devices (RouterOS, Cisco DNA, etc.) — configured via YAML Profiles |
| SSH Driver | SSH | Linux / Unix servers — SSH command execution + metric collection |
| SNMP Driver | SNMP v2c/v3 | Network device monitoring via SNMP |

The API Driver uses a Profile mechanism: YAML config files describe device API endpoint mappings, authentication methods, and response transformation rules — no code required to onboard a new device type.

---

## Project Structure

```text
opsevo-x/
├── opsevo-python/                # Python unified backend
│   ├── src/opsevo/
│   │   ├── api/                  # FastAPI route handlers
│   │   ├── middleware/           # Auth, timeout, device context
│   │   ├── models/              # Pydantic data models
│   │   ├── services/
│   │   │   ├── ai/              # LLM adapters + prompt system
│   │   │   ├── ai_ops/          # AIOps core (alerts, scheduler, evolution)
│   │   │   ├── brain/           # BrainLoopEngine + OODA loop
│   │   │   ├── rag/             # RAG + ReAct + VectorStore + Embedding
│   │   │   ├── skill/           # Skill capsule system
│   │   │   ├── mcp/             # MCP server/client + tool registry
│   │   │   ├── topology/        # Topology discovery
│   │   │   ├── state_machine/   # State machine orchestration
│   │   │   ├── bridges/         # EventBus bridges
│   │   │   └── device_orchestrator.py  # Device lifecycle orchestration
│   │   ├── drivers/             # DeviceDriver plugins (API/SSH/SNMP)
│   │   ├── data/                # DataStore + migrations
│   │   ├── events/              # EventBus
│   │   ├── utils/               # Crypto, tokens, logger
│   │   ├── main.py              # FastAPI app + lifespan
│   │   ├── settings.py          # Pydantic Settings
│   │   └── container.py         # DI container
│   ├── profiles/                # Device YAML profiles
│   ├── tests/                   # pytest + hypothesis tests
│   ├── Dockerfile               # Multi-stage build
│   └── pyproject.toml           # Python project config
├── frontend/                    # Vue 3 AIOps Workbench
├── docker-compose.yml           # 2-service orchestration
└── .env.example                 # Environment variable template
```

---

## Testing

```bash
cd opsevo-python

# Run all tests
python -m pytest tests/ -v

# Run property-based tests only
python -m pytest tests/property/ -v

# Run unit tests only
python -m pytest tests/unit/ -v

# Run integration tests only
python -m pytest tests/integration/ -v
```

---

## Development Standards

- Python 3.12+ with type hints
- Ruff for linting and formatting
- Property-based testing (hypothesis) for correctness validation
- Event-driven design — avoid polling
- Pydantic models for all request/response schemas
- async/await throughout — no blocking I/O

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
