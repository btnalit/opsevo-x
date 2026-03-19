"""Dependency injection container using dependency-injector.

Registers all service singletons/factories and wires dependencies.
Requirements: 2.6, 2.9 (bugfix-v2)
"""

from dependency_injector import containers, providers

from opsevo.data.pg_datastore import PgDataStore
from opsevo.drivers.manager import DeviceDriverManager
from opsevo.events.event_bus import EventBus
from opsevo.services.auth_service import AuthService
from opsevo.services.device_manager import DeviceManager
from opsevo.services.device_pool import DevicePool
from opsevo.settings import Settings


class Container(containers.DeclarativeContainer):
    """Application-level DI container."""

    wiring_config = containers.WiringConfiguration(packages=["opsevo"])

    config = providers.Configuration()
    settings = providers.Singleton(Settings)

    # ── Data layer ────────────────────────────────────────────────────────
    datastore = providers.Singleton(PgDataStore, settings=settings)
    event_bus = providers.Singleton(EventBus)

    # ── Auth ──────────────────────────────────────────────────────────────
    auth_service = providers.Singleton(
        AuthService,
        settings=settings,
        datastore=datastore,
    )

    # ── Device drivers ────────────────────────────────────────────────────
    driver_manager = providers.Singleton(
        DeviceDriverManager,
        profiles_dir=settings.provided.profiles_dir,
    )
    device_pool = providers.Singleton(
        DevicePool,
        manager=driver_manager,
    )
    device_manager = providers.Singleton(
        DeviceManager,
        datastore=datastore,
    )

    # ── AI / Adapter ──────────────────────────────────────────────────────
    adapter_pool = providers.Singleton(
        "opsevo.services.ai.adapter_pool.AdapterPool",
        settings=settings,
    )

    unified_agent = providers.Singleton(
        "opsevo.services.ai.unified_agent.UnifiedAgentService",
        settings=settings,
        datastore=datastore,
        adapter_pool=adapter_pool,
    )

    # ── Crypto ────────────────────────────────────────────────────────────
    crypto_service = providers.Singleton(
        "opsevo.services.ai.crypto_service.CryptoService",
        secret_key=settings.provided.ai_crypto_secret_key,
    )

    # ── RAG / Embedding / Vector ──────────────────────────────────────────
    embedding_service = providers.Singleton(
        "opsevo.services.rag.embedding.EmbeddingService",
        settings=settings,
    )

    vector_store = providers.Singleton(
        "opsevo.services.rag.vector_store.VectorStore",
        datastore=datastore,
        embedding=embedding_service,
    )

    knowledge_base = providers.Singleton(
        "opsevo.services.rag.knowledge_base.KnowledgeBase",
        datastore=datastore,
        vector_store=vector_store,
    )

    # ── AI-Ops core ──────────────────────────────────────────────────────
    alert_engine = providers.Singleton(
        "opsevo.services.ai_ops.alert_engine.AlertEngine",
        datastore=datastore,
        event_bus=event_bus,
    )

    alert_pipeline = providers.Singleton(
        "opsevo.services.ai_ops.alert_pipeline.AlertPipeline",
        datastore=datastore,
    )

    batch_processor = providers.Singleton(
        "opsevo.services.ai_ops.batch_processor.BatchProcessor",
    )

    fault_healer = providers.Singleton(
        "opsevo.services.ai_ops.fault_healer.FaultHealer",
        datastore=datastore,
    )

    health_monitor = providers.Singleton(
        "opsevo.services.ai_ops.health_monitor.HealthMonitor",
        event_bus=event_bus,
    )

    scheduler = providers.Singleton(
        "opsevo.services.ai_ops.scheduler.Scheduler",
        datastore=datastore,
    )

    syslog_receiver = providers.Singleton(
        "opsevo.services.ai_ops.syslog_receiver.SyslogReceiver",
        event_bus=event_bus,
    )

    snmp_trap_receiver = providers.Singleton(
        "opsevo.services.ai_ops.snmp_trap_receiver.SnmpTrapReceiver",
        data_store=datastore,
        event_bus=event_bus,
    )

    decision_engine = providers.Singleton(
        "opsevo.services.ai_ops.decision_engine.DecisionEngine",
    )

    script_synthesizer = providers.Singleton(
        "opsevo.services.ai_ops.script_synthesizer.ScriptSynthesizer",
    )

    analysis_cache = providers.Singleton(
        "opsevo.services.ai_ops.analysis_cache.AnalysisCache",
    )

    concurrency_controller = providers.Singleton(
        "opsevo.services.ai_ops.concurrency_controller.ConcurrencyController",
    )

    # ── Skills ────────────────────────────────────────────────────────────
    skill_manager = providers.Singleton(
        "opsevo.services.skill.skill_manager.SkillManager",
        datastore=datastore,
    )

    skill_loader = providers.Singleton(
        "opsevo.services.skill.skill_loader.SkillLoader",
    )

    # ── MCP ───────────────────────────────────────────────────────────────
    tool_registry = providers.Singleton(
        "opsevo.services.mcp.tool_registry.ToolRegistry",
    )

    mcp_server_handler = providers.Singleton(
        "opsevo.services.mcp.server_handler.McpServerHandler",
    )

    mcp_client_manager = providers.Singleton(
        "opsevo.services.mcp.client_manager.McpClientManager",
        tool_registry=tool_registry,
    )

    api_key_manager = providers.Singleton(
        "opsevo.services.mcp.api_key_manager.ApiKeyManager",
        crypto_service=crypto_service,
    )

    security_gateway = providers.Singleton(
        "opsevo.services.mcp.security_gateway.SecurityGateway",
        api_key_manager=api_key_manager,
    )

    # ── Bridges ───────────────────────────────────────────────────────────
    health_monitor_bridge = providers.Singleton(
        "opsevo.services.bridges.health_monitor_bridge.HealthMonitorBridge",
        event_bus=event_bus,
        health_monitor=health_monitor,
    )

    alert_engine_bridge = providers.Singleton(
        "opsevo.services.bridges.alert_engine_bridge.AlertEngineBridge",
        event_bus=event_bus,
        alert_engine=alert_engine,
    )

    # ── Brain ─────────────────────────────────────────────────────────────
    brain_tools = providers.Singleton(
        "opsevo.services.brain.brain_tools.BrainTools",
        device_pool=device_pool,
        datastore=datastore,
        event_bus=event_bus,
        knowledge_base=knowledge_base,
    )

    perception_cache = providers.Singleton(
        "opsevo.services.brain.perception_cache.PerceptionCache",
        datastore=datastore,
        health_monitor=health_monitor,
        alert_engine=alert_engine,
    )

    autonomous_brain = providers.Singleton(
        "opsevo.services.brain.autonomous_brain.AutonomousBrainService",
        event_bus=event_bus,
        datastore=datastore,
        brain_tools=brain_tools,
        adapter_pool=adapter_pool,
        perception_cache=perception_cache,
    )

    # ── Topology ──────────────────────────────────────────────────────────
    topology_discovery = providers.Singleton(
        "opsevo.services.topology.discovery_service.TopologyDiscoveryService",
    )
