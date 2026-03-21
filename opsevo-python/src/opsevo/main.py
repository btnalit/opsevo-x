"""FastAPI application entry point with lifespan management.

Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 2.5, 19.1, 19.2, 19.3
"""

from __future__ import annotations

import os
import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from opsevo.container import Container
from opsevo.middleware.timeout import TimeoutMiddleware
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


def _resolve_public_dir() -> pathlib.Path | None:
    """Resolve the frontend static files directory by priority.

    Candidates (first match wins):
      1. ``PUBLIC_DIR`` environment variable
      2. Relative to ``__file__`` (works in local dev)
      3. ``/app/public`` (Docker default)

    Each candidate must be an existing directory **and** contain
    ``index.html`` to be accepted.  Returns ``None`` when no candidate
    qualifies (a warning is logged in that case).

    Requirements: 1.1, 1.2, 1.3, 1.5, 1.6
    """
    candidates: list[pathlib.Path] = []

    # Priority 1: environment variable override
    env_dir = os.environ.get("PUBLIC_DIR")
    if env_dir:
        candidates.append(pathlib.Path(env_dir))

    # Priority 2: __file__-relative path (local development)
    candidates.append(
        pathlib.Path(__file__).resolve().parent.parent.parent / "public"
    )

    # Priority 3: Docker default path
    candidates.append(pathlib.Path("/app/public"))

    for p in candidates:
        if p.is_dir() and (p / "index.html").is_file():
            logger.info("public_dir_resolved", path=str(p))
            return p

    logger.warning(
        "public_dir_not_found",
        candidates=[str(c) for c in candidates],
        msg="No valid public directory found; SPA fallback will be disabled",
    )
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown phases."""
    container = Container()
    settings = container.settings()
    app.state.container = container
    app.state.settings = settings

    # Phase 0 — Production safety check
    if not settings.is_development():
        problems = settings.validate_production_requirements()
        if problems:
            for p in problems:
                logger.error("production_config_problem", problem=p)
            raise RuntimeError(
                f"Refusing to start: {len(problems)} production config problem(s): "
                + "; ".join(problems)
            )

    # Phase 1 — Core data layer
    logger.info("startup_phase_1", msg="Initializing data layer")
    ds = container.datastore()
    await ds.initialize()

    # Phase 1b — Run database migrations
    try:
        from opsevo.data.migrations.runner import MigrationRunner
        import pathlib
        migrations_dir = str(pathlib.Path(__file__).resolve().parent / "data" / "migrations")
        runner = MigrationRunner(ds, migrations_dir)
        applied = await runner.run()
        if applied:
            logger.info("migrations_applied", count=len(applied), names=applied)
    except Exception:
        logger.warning("migration_runner_skipped", exc_info=True)

    # Phase 2 — Device driver profiles
    logger.info("startup_phase_2", msg="Loading device profiles")
    dm = container.driver_manager()
    dm.load_profiles()

    # Phase 3 — Device pool
    logger.info("startup_phase_3", msg="Starting device pool")
    pool = container.device_pool()
    await pool.start()

    # Phase 4 — Event bus
    logger.info("startup_phase_4", msg="EventBus ready")
    _event_bus = container.event_bus()

    # Phase 5 — Background services (BUG-5/7 fix: 2.9, 2.10)
    import asyncio

    logger.info("startup_phase_5", msg="Starting background services")

    async def _safe_start(name: str, coro):
        try:
            await asyncio.wait_for(coro, timeout=15.0)
            logger.info("startup_service_ok", service=name)
        except asyncio.TimeoutError:
            logger.warning("startup_service_timeout", service=name)
        except Exception:
            logger.warning("startup_service_error", service=name, exc_info=True)

    def _safe_start_sync(name: str, fn):
        try:
            fn()
            logger.info("startup_service_ok", service=name)
        except Exception:
            logger.warning("startup_service_error", service=name, exc_info=True)

    # 5a — EmbeddingService init
    embedding_svc = container.embedding_service()
    await _safe_start("embedding_service", embedding_svc.initialize())

    # 5b — VectorStore init (depends on embedding)
    vs = container.vector_store()
    await _safe_start("vector_store", vs.initialize())

    # 5b+ — Wire optional deps into UnifiedAgentService
    agent_svc = container.unified_agent()
    kb = container.knowledge_base()
    agent_svc.set_knowledge_base(kb)
    agent_svc.set_device_pool(pool)
    agent_svc.set_tool_registry(container.tool_registry())
    agent_svc.set_tool_search(container.tool_search())
    logger.info("startup_unified_agent_wired", msg="knowledge_base, device_pool, tool_registry, tool_search injected")

    # 5c — AlertEngine init
    ae = container.alert_engine()
    await _safe_start("alert_engine", ae.initialize())

    # 5d — AlertPipeline init
    ap = container.alert_pipeline()
    await _safe_start("alert_pipeline", ap.initialize())

    # 5e — ApiKeyManager: inject datastore
    akm = container.api_key_manager()
    akm.set_datastore(ds)

    # 5f — Scheduler start (wire action executor before start so persisted tasks get callbacks)
    sched = container.scheduler()
    sched.set_action_executor(container.brain_tools().execute)
    await _safe_start("scheduler", sched.start())

    # 5g — SyslogReceiver start
    syslog_rx = container.syslog_receiver()
    await _safe_start("syslog_receiver", syslog_rx.start())

    # 5h — SnmpTrapReceiver start
    snmp_rx = container.snmp_trap_receiver()
    await _safe_start("snmp_trap_receiver", snmp_rx.start())

    # 5i — HealthMonitorBridge start (sync)
    hm_bridge = container.health_monitor_bridge()
    _safe_start_sync("health_monitor_bridge", hm_bridge.start)

    # 5j — AlertEngineBridge start (sync)
    ae_bridge = container.alert_engine_bridge()
    _safe_start_sync("alert_engine_bridge", ae_bridge.start)

    # 5k — BatchProcessor start (sync)
    bp = container.batch_processor()
    bp.start()

    # 5k' — DeviceOrchestrator start
    orchestrator = container.device_orchestrator()
    await _safe_start("device_orchestrator", orchestrator.start())

    # 5l — AutonomousBrainService start
    brain = container.autonomous_brain()
    await _safe_start("autonomous_brain", brain.start())

    # 5m — PerceptionCache start
    pc = container.perception_cache()
    await _safe_start("perception_cache", pc.start())

    # 5n — McpClientManager init (no external configs at startup)
    mcp_cm = container.mcp_client_manager()
    await _safe_start("mcp_client_manager", mcp_cm.initialize([]))

    # 5o — Skill system bootstrap (load builtin skills into SkillManager)
    from opsevo.services.skill.bootstrap import BootstrapSkillSystem
    skill_bootstrap = BootstrapSkillSystem(
        container.skill_manager(), settings.skills_dir
    )
    await _safe_start("skill_bootstrap", skill_bootstrap.bootstrap())

    logger.info("startup_complete", port=settings.port)
    yield

    # ── Graceful shutdown (reverse order, 30s budget) ─────────────────────
    # Requirements: 19.1, 19.2, 19.3
    logger.info("shutdown_start", msg="Graceful shutdown initiated")
    shutdown_timeout = 30.0

    async def _safe_shutdown(name: str, coro):
        try:
            await asyncio.wait_for(coro, timeout=shutdown_timeout / 4)
            logger.info("shutdown_step_ok", service=name)
        except asyncio.TimeoutError:
            logger.warning("shutdown_step_timeout", service=name)
        except Exception:
            logger.warning("shutdown_step_error", service=name, exc_info=True)

    def _safe_stop_sync(name: str, fn):
        try:
            fn()
            logger.info("shutdown_step_ok", service=name)
        except Exception:
            logger.warning("shutdown_step_error", service=name, exc_info=True)

    # Reverse order of Phase 5 startup
    await _safe_shutdown("mcp_client_manager", mcp_cm.shutdown())
    _safe_stop_sync("perception_cache", pc.stop)
    _safe_stop_sync("autonomous_brain", brain.stop)
    _safe_stop_sync("batch_processor", bp.stop)
    _safe_stop_sync("alert_engine_bridge", ae_bridge.stop)
    _safe_stop_sync("health_monitor_bridge", hm_bridge.stop)
    await _safe_shutdown("snmp_trap_receiver", snmp_rx.stop())
    await _safe_shutdown("syslog_receiver", syslog_rx.stop())
    await _safe_shutdown("scheduler", sched.stop())
    await _safe_shutdown("alert_pipeline", ap.stop())
    await _safe_shutdown("adapter_pool", container.adapter_pool().close_all())

    # Phase 3/1 shutdown (existing)
    await _safe_shutdown("device_orchestrator", orchestrator.stop())
    await _safe_shutdown("device_pool", pool.stop())
    await _safe_shutdown("datastore", ds.close())

    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Opsevo-X",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS: read allowed origins from settings; fall back to dev defaults
    from opsevo.settings import Settings
    _settings = Settings()
    _origins = [o.strip() for o in _settings.cors_origins.split(",") if o.strip()]
    _allow_credentials = "*" not in _origins

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=_allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(TimeoutMiddleware)

    # ── Register all API routers ──────────────────────────────────────────
    from opsevo.api.auth import router as auth_router
    from opsevo.api.devices import router as devices_router
    from opsevo.api.system import router as system_router
    from opsevo.api.monitoring import router as monitoring_router
    from opsevo.api.dashboard import router as dashboard_router
    from opsevo.api.events import router as events_router
    from opsevo.api.ai import router as ai_router
    from opsevo.api.ai_ops import router as ai_ops_router
    from opsevo.api.unified_agent import router as unified_agent_router
    from opsevo.api.rag import router as rag_router
    from opsevo.api.knowledge import router as knowledge_router
    from opsevo.api.skills import router as skills_router
    from opsevo.api.mcp import router as mcp_router
    from opsevo.api.topology import router as topology_router
    from opsevo.api.file_upload import router as file_upload_router
    from opsevo.api.prompt_templates import router as prompt_templates_router
    from opsevo.api.bff import router as bff_router
    from opsevo.api.connection import router as connection_router
    from opsevo.api.drivers import router as drivers_router

    app.include_router(auth_router)
    app.include_router(devices_router)
    app.include_router(system_router)
    app.include_router(monitoring_router)
    app.include_router(dashboard_router)
    app.include_router(events_router)
    app.include_router(ai_router)
    app.include_router(ai_ops_router)
    app.include_router(unified_agent_router)
    app.include_router(rag_router)
    app.include_router(knowledge_router)
    app.include_router(skills_router)
    app.include_router(mcp_router)
    app.include_router(topology_router)
    app.include_router(file_upload_router)
    app.include_router(prompt_templates_router)
    app.include_router(bff_router)
    app.include_router(connection_router)
    app.include_router(drivers_router)

    # ── Static files & SPA fallback ──────────────────────────────────────
    from fastapi.responses import FileResponse, JSONResponse

    public_dir = _resolve_public_dir()
    if public_dir is not None:
        # Mount static assets (js/css/img etc.)
        assets_dir = public_dir / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        # SPA fallback: non-API routes serve index.html
        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str):
            # API paths must NOT fall through to SPA — return 404 JSON
            if full_path.startswith("api/") or full_path.startswith("api"):
                return JSONResponse(
                    status_code=404,
                    content={"success": False, "error": f"API endpoint not found: /{full_path}"},
                )
            # Try to serve the exact file first
            file_path = public_dir / full_path
            if full_path and file_path.is_file():
                return FileResponse(str(file_path))
            # Fallback to index.html for SPA routing
            return FileResponse(str(public_dir / "index.html"))

    return app


app = create_app()
