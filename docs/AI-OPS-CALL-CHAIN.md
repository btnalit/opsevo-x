# Opsevo-x 智能运维系统完整调用链分析

> ⚠️ **迁移说明 (2026-03-18)**：本文档基于 v10.0 单设备 RouterOS 架构编写。
> Opsevo-x 正在向泛化 AIOps 基础设施框架演进（8 层架构、DeviceDriver 插件、PostgreSQL+pgvector、Python Core）。
> 新架构设计请参阅 `.kiro/specs/aiops-brain-evolution/design.md`。
>
> 本文档中的调用链逻辑（AlertPipeline、ReAct 循环、Skill 系统、Brain OODA 等）仍然有效，
> 但以下内容已过时：
> - **SQLite DataStore** → 迁移至 PgDataStore (PostgreSQL)
> - **LanceDB 向量存储** → 迁移至 PostgreSQL + pgvector，由 Python Core 统一管理
> - **RouterOSClient / DevicePool** → 迁移至 DeviceManager + DeviceDriver 插件体系
> - **单设备硬编码** → 多设备多租户泛化架构

> 本文档详细描述 Opsevo-x 系统的完整架构、调用逻辑链、核心组件功能及设计原则。
>
> **版本: 10.0** | **更新时间: 2026-03-02** | **迁移标注: 2026-03-18**
>
> **代码统计**: 后端 290+ 文件 | AI-Ops 156 服务 | RAG 60 文件 | Skill 15 文件 | Prompt 27 模块 | StateMachine 30+ 文件 | 前端 56 视图

## 一、系统架构概览

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         外部输入层                                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐              │
│  │  MetricsCollector│  │  SyslogReceiver │  │   用户对话请求   │  │  定时任务触发   │              │
│  │   (指标采集)     │  │   (Syslog接收)  │  │  (Chat API)     │  │  (Scheduler)   │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘              │
└───────────┼─────────────────────┼─────────────────────┼─────────────────────┼────────────────────┘
            │                     │                     │                     │
            ▼                     ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         服务入口层                                               │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐              │
│  │           AlertEngine               │  │        UnifiedAgentService          │              │
│  │  ┌─────────────────────────────┐   │  │  ┌─────────────────────────────┐   │              │
│  │  │  evaluate() - 指标告警评估  │   │  │  │  chat() - 统一对话入口      │   │              │
│  │  │  processSyslogEvent()       │   │  │  │  chatStream() - 流式对话    │   │              │
│  │  │  ConcurrencyController      │   │  │  │  executeScript() - 脚本执行 │   │              │
│  │  └─────────────────────────────┘   │  │  └─────────────────────────────┘   │              │
│  └─────────────────────────────────────┘  └─────────────────────────────────────┘              │
│  ┌─────────────────────────────────────┐                                                       │
│  │             Scheduler               │                                                       │
│  │  ┌─────────────────────────────┐   │                                                       │
│  │  │  cron 表达式解析与定时调度  │   │                                                       │
│  │  │  SQLite DataStore 持久化    │   │                                                       │
│  │  └─────────────────────────────┘   │                                                       │
│  └─────────────────────────────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
            │                                           │
            ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          处理层                                                  │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐              │
│  │         AlertPipeline               │  │          SkillManager               │              │
│  │  ┌─────────────────────────────┐   │  │  ┌─────────────────────────────┐   │              │
│  │  │ 1. Normalize  (归一化)      │   │  │  │  selectSkill() - Skill选择  │   │              │
│  │  │   (AlertPreprocessor)       │   │  │  │  SkillMatcher - 智能匹配    │   │              │
│  │  │ 2. Deduplicate (去重)       │   │  │  │  SkillChainManager - 链调用 │   │              │
│  │  │ 3. Filter     (过滤)        │   │  │  └─────────────────────────────┘   │              │
│  │  │ 4. Analyze    (RAG分析)     │   │  └─────────────────────────────────────┘              │
│  │  │ 5. Decide     (智能决策)    │   │                    │                                   │
│  │  │   (enrichContext - 丰富设备信息)│                    │                                   │
│  │  │ ──────────────────────────  │   │                    ▼                                   │
│  │  │ FeatureFlagManager.route()  │   │  ┌─────────────────────────────────────┐                │
│  │  │ → 状态机路径 / Legacy路径   │   │  │   SkillAwareReActController         │                │
│  │  └─────────────────────────────┘   │  │  ┌─────────────────────────────┐   │                │
│  └─────────────────────────────────────┘  │  │  executeLoop() - ReAct循环  │   │                │
│              │                          │  │  IntentDrivenExecutor       │   │                │
│              │                          │  │  (FastPath Execution)       │   │                │
│              │                          │  │  ──────────────────────────  │   │                │
│              │                          │  │  FeatureFlagManager.route()  │   │                │
│              │                          │  │  → 状态机路径 / Legacy路径   │   │                │
│              │                          │  └─────────────────────────────┘   │                │
│              │                          └─────────────────────────────────────┘                │
└──────────────┼──────────────────────────────────────────────┼──────────────────────────────────┘
               │                                              │
               ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     知识与分析层                                                 │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐              │
│  │           RAGEngine                 │  │          KnowledgeBase              │              │
│  │  ┌─────────────────────────────┐   │  │  ┌─────────────────────────────┐   │              │
│  │  │  analyzeAlert() - 告警分析  │   │  │  │  search() - 知识检索        │   │              │
│  │  │  analyzeRootCause() - 根因  │   │  │  │  add() - 知识添加           │   │              │
│  │  │  query() - RAG查询          │   │  │  │  HybridSearchEngine         │   │              │
│  │  │  缓存管理 (LRU Cache)       │   │  │  │  (BM25 + Vector + RRF)      │   │              │
│  │  └─────────────────────────────┘   │  │  └─────────────────────────────┘   │              │
│  └─────────────────────────────────────┘  └─────────────────────────────────────┘              │
│  ┌─────────────────────────────────────┐                                                       │
│  │         HealthReportService         │                                                       │
│  │  ┌─────────────────────────────┐   │                                                       │
│  │  │  系统指标聚合与健康评分     │   │                                                       │
│  │  │  AI 综合分析与优化建议      │   │                                                       │
│  │  └─────────────────────────────┘   │                                                       │
│  └─────────────────────────────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
               │                                              │
               ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          执行层                                                  │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐              │
│  │         DecisionEngine              │  │       ReActLoopController           │              │
│  │  ┌─────────────────────────────┐   │  │  ┌─────────────────────────────┐   │              │
│  │  │  decide() - 智能决策        │   │  │  │  executeLoop() - ReAct循环  │   │              │
│  │  │  executeDecision() - 执行   │   │  │  │  Thought → Action → Obs    │   │              │
│  │  │  决策动作:                  │   │  │  │  并行执行支持               │   │              │
│  │  │  - auto_execute (自动执行)  │   │  │  └─────────────────────────────┘   │              │
│  │  │  - notify_and_wait (通知)   │   │  └─────────────────────────────────────┘              │
│  │  │  - escalate (升级)          │   │                    │                                   │
│  │  │  - silence (静默)           │   │                    ▼                                   │
│  │  └─────────────────────────────┘   │  ┌─────────────────────────────────────┐              │
│  └─────────────────────────────────────┘  │       ParallelExecutor              │              │
│             │                              │  ┌─────────────────────────────┐   │              │
│             ▼                              │  │  executeBatch() - 批量执行  │   │              │
│  ┌─────────────────────────────┐         │  │  AdaptiveModeSelector       │   │              │
│  │    NotificationService      │         │  │  CircuitBreaker - 熔断器    │   │              │
│  │  (WeChat/DingTalk/Email)    │         │  │  DependencyAnalyzer         │   │              │
│  └─────────────────────────────┘         │  └─────────────────────────────┘   │              │
│                                           └─────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
               │                                              │
               ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    智能进化层                                                    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │   HealthMonitor   │  │  AnomalyPredictor │  │ProactiveInspector │  │   PatternLearner  │    │
│  │   (健康监控)      │  │   (异常预测)      │  │   (主动巡检)      │  │   (模式学习)      │    │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │   IntentParser    │  │KnowledgeGraphBuilder│ │  TracingService   │  │EvolutionErrorHandler│  │
│  │   (意图解析)      │  │   (知识图谱)      │  │   (分布式追踪)    │  │   (错误处理)      │    │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │DegradationManager │  │ Critic/Reflector  │  │ContinuousLearner │  │ToolFeedbackCollector│   │
│  │   (降级管理)      │  │  (批评与反思)     │  │   (持续学习)      │  │   (工具反馈)      │    │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
               │                                              │
               ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              状态机编排层 (StateMachine Orchestration) (NEW v10.0)                │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │StateMachineEngine │  │  StateRegistry    │  │  StateExecutor    │  │  ContextManager   │    │
│  │  (状态机引擎)     │  │  (状态注册表)     │  │  (状态执行器)     │  │  (上下文管理)     │    │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐    │
│  │DegradationInteg.  │  │TracingIntegration │  │ConcurrencyGuard  │  │FeatureFlagManager │    │
│  │  (降级集成)       │  │  (追踪集成)       │  │  (并发守卫)       │  │  (特性开关)       │    │
│  └───────────────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  流程定义: reactDefinition (10状态) │ alertDefinition (8状态) │ iterationDefinition (6状态)│   │
│  └──────────────────────────────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  适配器: ReActLoopAdapter │ AlertPipelineAdapter │ IterationLoopAdapter (零侵入桥接)     │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  路由入口 (FeatureFlagManager.route):                                                    │   │
│  │  AlertPipeline.process() ──→ alert-orchestration                                         │   │
│  │  UnifiedAgentService.executeReActWithRouting() ──→ react-orchestration                    │   │
│  │  IterationLoop.start() ──→ iteration-orchestration                                       │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 1.5 多租户与多设备管理

```text
多租户架构提供完整的租户隔离机制，支持企业级多设备管理：

┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     多租户设备管理架构                                           │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│  ┌───────────────────────┐     ┌───────────────────────┐     ┌───────────────────────┐        │
│  │     Tenant A          │     │     Tenant B          │     │     Tenant C          │        │
│  │  ┌─────┐ ┌─────┐     │     │  ┌─────┐ ┌─────┐     │     │  ┌─────┐              │        │
│  │  │Dev1 │ │Dev2 │     │     │  │Dev3 │ │Dev4 │     │     │  │Dev5 │              │        │
│  │  └──┬──┘ └──┬──┘     │     │  └──┬──┘ └──┬──┘     │     │  └──┬──┘              │        │
│  └─────┼───────┼────────┘     └─────┼───────┼────────┘     └─────┼────────────────┘        │
│        │       │                    │       │                    │                          │
│        ▼       ▼                    ▼       ▼                    ▼                          │
│  └─────────────────────────────────────────────────────────────────────────────────────┘    │
│                                          │                                                   │
│                                          ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                              DevicePool (连接池)                                     │    │
│  │  ┌───────────────────────────────────────────────────────────────────────────────┐ │    │
│  │  │ connections: Map<deviceId, PooledConnection>                                   │ │    │
│  │  │ ├─ 连接复用 (同一 deviceId 返回同一 RouterOSClient)                            │ │    │
│  │  │ ├─ 租户隔离 (禁止跨租户访问)                                                   │ │    │
│  │  │ ├─ 空闲清理 (自动关闭超时连接)                                                 │ │    │
│  │  │ ├─ 并发安全 (EventEmitter 等待机制)                                           │ │    │
│  │  │ └─ 并行恢复 (ensureConnections 使用 allSettled) (NEW)                          │ │    │
│  │  └───────────────────────────────────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────────────────────────────────────┘    │
│                                          │                                                   │
│                                          ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                            DeviceManager (设备管理器)                                │    │
│  │  ├─ createDevice(tenantId, config) - AES-256 加密密码存储                           │    │
│  │  ├─ getDevices(tenantId, filter) - 按分组/标签/状态过滤                            │    │
│  │  ├─ updateDevice(tenantId, deviceId, updates) - 部分更新                           │    │
│  │  ├─ deleteDevice(tenantId, deviceId) - 级联清理                                    │    │
│  │  └─ updateStatus(deviceId, status, errorMessage?) - 状态同步                       │    │
│  └─────────────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

设备状态生命周期：
- offline: 设备已创建但未连接
- connecting: 正在建立连接
- online: 连接成功，lastSeen 自动更新
- error: 连接失败，errorMessage 记录原因

多租户会话隔离与任务调度机制：
- ChatSessionService: 所有对话会话 (Sessions)/消息 (Messages) 在持久化和查询时始终结合 `tenantId` 和 `deviceId`，防止跨租户和跨设备会话泄漏。
- Scheduler: 定时任务执行通过 DataStore 持久化到 SQLite (`scheduled_tasks` 表)，创建和执行均受 `tenant_id` 和 `deviceId` 边界隔离保护。
```

## 二、核心服务组件

### 2.1 AlertEngine (告警引擎)

```text
职责：
├─ 告警规则管理 (CRUD)
├─ 指标评估 (evaluate)
├─ Syslog 事件处理 (processSyslogEvent)
├─ 并发控制 (ConcurrencyController)
└─ 告警状态管理

关键方法：
- evaluate(metrics): 评估指标是否触发告警
- processSyslogEvent(event): 处理 Syslog 事件
- addRule/updateRule/deleteRule: 规则管理

指标采集节流 (NEW):
- MetricsCollector.collectNow() 会检查 lastCollectTime
- 如果距离上次采集少于 5 秒，则直接返回缓存数据，不触发 API 请求
- 防止高频点击仪表盘刷新导致对 RouterOS 的压力
```

### 2.2 AlertPipeline (告警处理流水线)

```text
职责：
├─ 5 阶段流水线处理
├─ 事件归一化
├─ 去重和过滤
├─ RAG 根因分析
├─ 智能决策触发
└─ 状态机编排路由 (v10.0)

流水线阶段：
1. Normalize  - 将 Syslog/AlertEvent 转换为 UnifiedEvent (调用 AlertPreprocessor.enrichContext 注入 deviceInfo)
2. Deduplicate - 指纹缓存去重，防止重复处理
3. Filter     - 维护窗口、已知问题、瞬态抖动过滤
4. Analyze    - 调用 RAGEngine 进行根因分析
5. Decide     - 调用 DecisionEngine 确定处理方式

状态机编排路由 (v10.0)：
- setFeatureFlagManager(manager) - 注入特性开关管理器
- setStateMachineOrchestrator(orchestrator) - 注入状态机编排器
- process() 方法路由逻辑：
  ├─ 当 FeatureFlagManager + StateMachineOrchestrator 均已配置时：
  │   └─ FeatureFlagManager.route('alert-orchestration', stateMachinePath, legacyPath)
  │       ├─ Flag ON  → StateMachineOrchestrator.execute('alert-pipeline', { rawEvent })
  │       └─ Flag OFF → processInternalWithTimeout() (原有流水线)
  └─ 未配置时 → 直接走 processInternalWithTimeout() (向后兼容)

超时保护：
- 整体流水线超时: 180秒
- 分析阶段超时: 90秒
- 决策执行超时: 30秒
```

### 2.3 RAGEngine (RAG 检索增强生成引擎)

```text
职责：
├─ 告警分析 (analyzeAlert)
├─ 根因分析 (analyzeRootCause)
├─ 通用 RAG 查询 (query)
├─ 分析结果缓存
└─ 并发控制

缓存机制：
- 告警分析缓存 (analysisCache)
- 根因分析缓存 (rootCauseAnalysisCache)
- 默认 TTL: 30 分钟
- 定期清理过期缓存

配置参数：
- topK: 5 (检索数量)
- minScore: 0.7 (最小相似度)
- alertMinScore: 0.75 (告警分析阈值)
- crossTypeMinScore: 0.85 (跨类型搜索阈值)
- recencyWeight: 0.2 (时效性权重)
```

### 2.4 DecisionEngine (智能决策引擎)

```text
职责：
├─ 决策规则管理
├─ 因子评估
├─ 决策生成
└─ 决策执行

决策动作类型：
- auto_execute: 自动执行修复方案
- notify_and_wait: 发送通知等待确认
- escalate: 升级到更高级别处理
- silence: 静默处理（已知问题）

决策因子：
- 严重级别 (severity)
- 置信度 (confidence)
- 历史成功率 (historical_success_rate)
- 影响范围 (impact_scope)

通知变量 (Enriched Context):
- identity: 设备 hostname 或标识
- ip_address: 设备 IP 地址
- current_value: 当前指标值
- threshold: 触发阈值
- metric: 监控指标名称
- status: 格式化的状态描述 (e.g., "✅ 已恢复", "🔥 触发中")
```

### 2.5 UnifiedAgentService (统一代理服务)

```text
职责：
├─ 统一对话入口 (chat/chatStream)
├─ 模式切换 (standard/knowledge-enhanced)
├─ Skill 系统集成
├─ Fast Path 路由
├─ Prompt 模块化系统集成
├─ 脚本执行
└─ 状态机编排路由 (v10.0)

对话模式：
- standard: 标准对话模式，直接 LLM 响应
- knowledge-enhanced: 知识增强模式，RAG + ReAct

Skill 系统集成：
- 自动选择合适的 Skill
- 应用 Skill 配置（工具、知识、提示词）
- 支持链式调用

Fast Path：
- 简单查询快速响应
- 跳过完整 ReAct 循环
- 提高响应速度
- Content-Aware Routing：当返回的知识内容类型为系统手册或指南时 (manual, guide)，触发防 Dump 机制，自动将 Direct 模式降级为 Enhanced 模式，避免长文本霸屏。

状态机编排路由 (v10.0)：
- setFeatureFlagManager(manager) - 注入特性开关管理器
- setStateMachineOrchestrator(orchestrator) - 注入状态机编排器
- executeReActWithRouting() 私有方法路由逻辑：
  ├─ 当 FeatureFlagManager + StateMachineOrchestrator 均已配置时：
  │   └─ FeatureFlagManager.route('react-orchestration', stateMachinePath, legacyPath)
  │       ├─ Flag ON  → StateMachineOrchestrator.execute('react-orchestration', { message, intentAnalysis, ... })
  │       └─ Flag OFF → skillAwareReActController.executeLoop() (原有 ReAct 循环)
  └─ 未配置时 → 直接走 skillAwareReActController.executeLoop() (向后兼容)
- 非流式 (handleKnowledgeEnhancedChat) 和流式 (handleKnowledgeEnhancedChatStream) 路径均通过此方法路由
```

### 2.6 SkillManager (Skill 系统管理器)

```text
职责：
├─ Skill 加载和注册
├─ 智能 Skill 匹配
├─ 会话级 Skill 管理
├─ 链式调用管理
└─ 使用指标记录

匹配策略优先级：
1. explicit  - 显式指定 @skill-name (置信度 1.0)
2. trigger   - 触发词匹配 (置信度 0.9)
3. context   - 上下文延续 (置信度 0.75)
4. router    - LLM 智能路由 (SkillRouter 两阶段: 语义预筛选 + LLM 精选)
5. intent    - 意图映射 (置信度 > 0.7)
6. keyword   - 关键词映射 (置信度 0.85)
7. semantic  - 语义相似度 (置信度 > 0.6)
8. fallback  - 兜底 generalist (置信度 0.5)

内置 Skill：
- diagnostician: 故障诊断专家
- configurator: 配置生成专家
- auditor: 安全审计专家
- optimizer: 性能优化专家
- generalist: 通用助手（兜底）
```

### 2.7 Prompt 模块化系统 (NEW)

```text
职责：
├─ Prompt 模块化组合 (PromptComposer)
├─ 适配层桥接 (PromptComposerAdapter)
├─ 模块自定义内容覆盖
├─ 段落级去重
├─ 动态上下文注入
└─ Token 估算

两层架构：
1. PromptTemplateService (统一调度层)
   ├─ 模板 CRUD 管理
   ├─ 缓存 (TTL 5 分钟)
   ├─ 渲染 ({{placeholder}} 替换)
   ├─ 默认模板管理
   └─ 用户自定义覆盖 (override)

2. PromptComposer + PromptComposerAdapter (模块化组合层)
   ├─ 7 个独立模块按需组合
   ├─ 场景化 Prompt 构建
   ├─ 自定义模板优先
   └─ 初始化失败回退到单体模板

内置模块：
- basePersona: 基础人设定义
- deviceInfo: 设备信息上下文
- reActFormat: ReAct 格式规范
- apiSafety: API 安全规则
- batchProtocol: 批处理协议
- knowledgeGuide: 知识引导策略
- parallelFormat: 并行执行格式

适配器构建方法：
- buildReActPrompt(): ReAct 循环基础提示词
- buildKnowledgeFirstReActPrompt(): 知识优先 ReAct 提示词
- buildParallelReActPrompt(): 并行执行 ReAct 提示词
- buildKnowledgeEnhancedPrompt(): 知识增强提示词
- buildAlertAnalysisPrompt(): 告警分析提示词
- buildBatchAlertAnalysisPrompt(): 批量告警分析提示词
- buildHealthReportAnalysisPrompt(): 健康报告分析提示词
- buildConfigDiffAnalysisPrompt(): 配置差异分析提示词
- buildFaultDiagnosisPrompt(): 故障诊断提示词

动态上下文注入 (injectContext)：
- 健康评分 < 60 时注入健康状态摘要
- 存在活跃告警时注入最近 5 条告警
- 存在异常预测时注入预测摘要
```

### 2.8 ReActLoopController 模块化架构

```text
将 5900+ 行的 reactLoopController.ts 拆分为独立子模块：

模块文件：
├─ reactLoopController.ts    # 主入口，组合所有模块
├─ reactPromptBuilder.ts     # 提示词构建
├─ reactToolExecutor.ts      # 工具执行与结果处理
├─ reactKnowledgeRetrieval.ts # 知识检索集成
├─ reactOutputValidator.ts   # 输出验证与反思
├─ reactFailureAnalyzer.ts   # 故障分析与恢复
├─ reactFinalAnswer.ts       # 最终答案生成
├─ reactParallelExecution.ts # 并行执行逻辑
├─ intentDrivenExecutor.ts   # 意图驱动执行 (NEW)
└─ parallelLoopHandler.ts    # 并行循环处理 (NEW)

增强功能：
- detectLoopStuck(): 增强的循环卡死检测
  ├─ 精确字符串匹配
  ├─ 工具调用模式检测 (最近 3 次相同工具+相似参数)
  ├─ 关键词重叠率检测 (>80% 判定语义重复)
  └─ 滑动窗口内存保护 (MAX_TOOL_PATTERN_HISTORY=100)
- calculateKeywordOverlap(): 两个 thought 的关键词重叠率计算
- Prompt 模块化集成: 优先使用 PromptComposerAdapter，失败回退到 legacy 模板
```

### 2.9 IntentDrivenExecutor (意图驱动执行器) (NEW)

```text
职责：
├─ 高置信度意图直接执行
├─ 低风险操作快速路径
├─ 工具映射和参数提取
├─ 执行超时保护
└─ 持续学习记录

文件位置: rag/intentDrivenExecutor.ts (494 行)

核心功能：
1. attemptIntentDrivenExecution()
   - 解析用户意图 (通过 IntentParser)
   - 检查执行条件 (置信度 > 阈值 && 风险等级 = low)
   - 映射意图到工具调用
   - 带超时保护执行

2. 意图到工具映射：
   - query_interface → router_query (意图: 查询接口)
   - query_route → router_query (意图: 查询路由)
   - query_system → router_query (意图: 查询系统)
   - diagnose_interface → router_command (意图: 诊断接口)
   - monitor_traffic → router_query (意图: 监控流量)

3. 超时保护：
   - TOOL_EXECUTION_TIMEOUT = 30000ms
   - 使用 Promise.race 实现
   - 超时自动返回错误结果

4. 持续学习集成：
   - 记录成功/失败操作
   - 支持可选的 userId/sessionId
   - 回退到 requestId

配置参数：
- confidenceThreshold: 0.8 (置信度阈值)
- allowedRiskLevels: ['low'] (允许的风险等级)
- enabled: true (功能开关)
```

### 2.10 HybridSearchEngine (混合检索引擎)

```text
职责：
├─ 混合检索策略
├─ BM25 关键词检索
├─ 向量语义检索
└─ RRF 融合排序

组件：
- KeywordIndexManager: BM25 关键词索引
- LanceDB: 向量数据库
- RRFRanker: RRF 融合排序器
- MetadataEnhancer: 元数据增强

检索流程：
1. 并行执行 BM25 和向量检索
2. RRF 算法融合两路结果
3. 按融合分数排序返回
```

### 2.11 KnowledgeBase (知识库)

```text
职责：
├─ 知识存储和检索
├─ 混合检索 (Hybrid Search)
├─ 知识索引管理
└─ 使用统计

检索方式：
- 向量检索 (LanceDB)
- 关键词检索 (BM25)
- RRF 融合排序

知识类型：
- alert: 告警相关知识
- remediation: 修复方案
- config: 配置知识
- pattern: 故障模式
- feedback: 用户反馈
```

### 2.12 Scheduler (调度器服务)

```text
职责：
├─ 管理和执行定时任务 (巡检、自动备份等)
├─ 任务状态与生命周期控制
├─ `cron-parser` CRON 表达式智能解析
├─ `DataStore` (SQLite) 状态持久化集成
└─ 租户和设备边界隔离控制

关键机制：
- CRON 调度: 提供健壮的定时触发，自动计算 NextRunAt，支持标准及 6 字段秒级扩展的 cron 表达式。
- 数据存储: 使用 SQLite 将任务长久保存在 `scheduled_tasks` 表中，并处理从之前版本 JSON 数据文件的 Fallback。
- 任务执行: `executeTask(task)` 按配置注册执行各种自动化处理逻辑（如 HealthReport 报告生成等），支持运行记录跟踪。
```

### 2.13 HealthReportService (健康报告服务)

```text
职责：
├─ 系统健康指标聚合计算 (CPU/Memory/Disk/Interface Stats)
├─ 自动健康打分（0-100分制基准）及状态映射
├─ 调用 AI 分析接口产出深度风险评估和优化建议
├─ 汇总特定周期的历史告警和配置修改
└─ 报告持久化与 Markdown 导出

逻辑流程：
1. 收集设备 `aggregateSystemMetrics` 以及接口历史流量 `aggregateInterfaceStats`
2. 根据阈值（CPU/内存 > 80 扣分）生成 `HealthStatus`
3. 分析告警事件类型分布及 Top 触发源
4. 综合指标注入 AI Prompt 生成自然语言风险/建议，结果作为一份完整报告供前台下载或推送到管理渠道。
```

## 三、智能进化系统

### 3.1 系统概述

```text
Opsevo 的智能进化系统是核心增强功能，实现十大智能能力：
1. 反思与自我修正 (Reflection)
2. 长短期记忆管理 (Experience/Memory)
3. 计划动态修订 (Plan Revision)
4. 工具使用反馈闭环 (Tool Feedback)
5. 主动式运维伙伴 (Proactive Operations)
6. Intent-Driven 自动化 (Intent-Driven)
7. Self-Healing 自愈能力 (Self-Healing)
8. 持续学习与进化 (Continuous Learning)
9. 分布式追踪 (Tracing)
10. 工具反馈收集 (Tool Feedback Collection)

配置管理：
- 所有能力支持独立开关
- 关键参数可通过配置调整
- 配置变更无需重启服务
- 配置文件: backend/data/ai-ops/evolution-config.json
```

### 3.2 HealthMonitor (健康监控)

```text
职责：
├─ 健康指标采集 (CPU/Memory/Disk/Interface)
├─ 健康分数计算 (0-100)
├─ 健康画像生成
├─ 健康快照存储
└─ 历史趋势查询

Requirements: 5.1.1-5.1.5

健康指标：
- cpuUsage: CPU 使用率
- memoryUsage: 内存使用率
- diskUsage: 磁盘使用率
- interfaceStatus: 接口状态 (total/up/down)
- activeConnections: 活跃连接数
- errorRate: 错误率
- avgResponseTime: 平均响应时间

健康分数计算：
- 系统资源分数 (30%)
- 网络状态分数 (30%)
- 性能指标分数 (20%)
- 可靠性分数 (20%)

健康等级：
- healthy: 分数 >= 80
- warning: 分数 60-79
- critical: 分数 < 60

配置参数：
- collectInterval: 60000ms (采集间隔)
- retentionDays: 30 (快照保留天数)
- thresholds: CPU/Memory/Disk 告警阈值
```

### 3.3 AnomalyPredictor (异常预测器)

```text
职责：
├─ 历史模式分析
├─ 异常预测逻辑
├─ 趋势分析 (线性回归)
└─ 预测结果输出

Requirements: 5.2.1, 5.2.2, 5.2.5

预测类型：
- cpu_spike: CPU 飙升
- memory_exhaustion: 内存耗尽
- disk_full: 磁盘满
- interface_failure: 接口故障
- performance_degradation: 性能下降
- error_rate_increase: 错误率上升

预测算法：
- 线性回归分析历史数据
- 计算斜率和 R² 值
- 预测未来值是否超过阈值
- 置信度基于 R² 和当前值接近度

配置参数：
- predictionWindow: 30分钟 (预测窗口)
- minConfidenceThreshold: 0.6 (最小置信度)
- historySize: 60 (历史数据点数量)
```

### 3.4 ProactiveInspector (主动巡检器)

```text
职责：
├─ 定时巡检逻辑
├─ 巡检项配置
├─ 巡检报告生成
├─ 问题发现和告警
└─ 巡检历史记录

Requirements: 5.3.1-5.3.5

巡检项类型：
- system_health: 系统健康
- interface_status: 接口状态
- resource_usage: 资源使用
- security_check: 安全检查
- config_validation: 配置验证
- performance_check: 性能检查
- backup_status: 备份状态
- log_analysis: 日志分析

巡检结果状态：
- passed: 通过
- warning: 警告
- failed: 失败
- skipped: 跳过

配置参数：
- defaultInterval: 3600000ms (1小时)
- defaultTimeout: 30000ms (30秒)
- maxReportRetention: 100 (最大报告保留数)
```

### 3.5 PatternLearner (模式学习器)

```text
职责：
├─ 操作记录
├─ 模式识别
├─ 模式存储
├─ 推荐生成
└─ 模式管理

Requirements: 8.1.1-8.1.5

模式类型：
- sequence: 操作序列模式
- combination: 操作组合模式
- preference: 用户偏好模式

学习算法：
- 提取所有可能的操作序列
- 统计序列出现频率
- 计算置信度 (频率 + 覆盖率 + 长度奖励)
- 过滤低频和低置信度模式

推荐生成：
- 匹配最近操作与已知模式前缀
- 推荐下一个可能的操作
- 按置信度排序返回

配置参数：
- minSequenceLength: 2 (最小序列长度)
- maxSequenceLength: 5 (最大序列长度)
- minFrequencyThreshold: 3 (最小频率阈值)
- minConfidenceThreshold: 0.6 (最小置信度)
```

### 3.6 IntentParser (意图解析器)

```text
职责：
├─ 意图解析逻辑
├─ 意图结构化表示
├─ 置信度计算
├─ 意图消歧
└─ 参数提取

Requirements: 6.1.1-6.1.5

意图类别：
- query: 查询类 (获取信息)
- configure: 配置类 (修改设置)
- diagnose: 诊断类 (排查问题)
- remediate: 修复类 (解决问题)
- monitor: 监控类 (观察状态)
- automate: 自动化类 (批量操作)
- unknown: 未知类型

风险等级：
- low: 查询和监控操作
- medium: 配置和修复操作
- high: 删除和批量操作

配置参数：
- minConfidenceThreshold: 0.7 (低于此值需确认)
- disambiguationThreshold: 0.15 (消歧阈值)
- highRiskCategories: ['configure', 'remediate', 'automate']
```

### 3.7 KnowledgeGraphBuilder (知识图谱构建器)

```text
职责：
├─ 拓扑发现
├─ 图谱更新
├─ 依赖查询
├─ 影响分析
└─ 图谱存储

Requirements: 8.4.1-8.4.5

节点类型：
- device: 设备
- service: 服务
- config: 配置
- resource: 资源
- interface: 接口
- user: 用户

边类型：
- depends_on: 依赖关系
- connects_to: 连接关系
- configures: 配置关系
- hosts: 托管关系
- triggers: 触发关系
- resolves: 解决关系

影响分析：
- 直接影响: 一跳可达的节点
- 间接影响: 多跳可达的节点
- 影响评分: 受影响节点数 / 总节点数
- 风险等级: low/medium/high/critical

配置参数：
- maxNodes: 10000 (最大节点数)
- maxEdges: 50000 (最大边数)
- discoveryInterval: 3600000ms (自动发现间隔)
- maxDependencyDepth: 5 (最大依赖深度)
```

### 3.8 TracingService (分布式追踪服务)

```text
职责：
├─ traceId 和 spanId 生成
├─ 追踪上下文管理
├─ span 生命周期管理
├─ 追踪数据存储
└─ 孤儿追踪清理

Requirements: 9.1.1-9.1.4

Span 状态：
- running: 运行中
- completed: 已完成
- error: 错误

追踪功能：
- startTrace(): 创建新追踪
- startSpan(): 创建子 Span
- endSpan(): 结束 Span
- endTrace(): 结束追踪
- addTag(): 添加标签
- addLog(): 添加日志

孤儿清理：
- 定期清理长时间未结束的追踪
- 清理没有对应 Trace 的 Span
- 默认间隔: 5分钟
- 追踪最大存活: 30分钟
- Span 最大存活: 10分钟

配置参数：
- retentionDays: 7 (数据保留天数)
- maxSpansPerTrace: 100 (每个追踪最大 Span 数)
- samplingRate: 1.0 (采样率)
```

### 3.9 CriticService (批评服务)

```text
职责：
├─ 方案质量评估
├─ 风险识别
├─ 改进建议生成
└─ 评估结果缓存

与 ReflectorService 配合：
- CriticService 评估方案质量
- ReflectorService 基于评估进行反思
- IterationLoop 协调迭代过程
```

### 3.10 EvolutionErrorHandler (进化错误处理器)

```text
职责：
├─ 错误分类
├─ 重试策略
├─ 错误恢复
└─ 错误统计

Requirements: 10.6.1-10.6.3

错误类型：
- NETWORK: 网络错误
- TIMEOUT: 超时错误
- VALIDATION: 验证错误
- RESOURCE: 资源错误
- UNKNOWN: 未知错误

错误严重级别：
- LOW: 低严重性
- MEDIUM: 中等严重性
- HIGH: 高严重性
- CRITICAL: 严重

重试策略：
- 指数退避
- 最大重试次数限制
- 可恢复错误才重试
```

### 3.11 DegradationManager (降级管理器)

```text
职责：
├─ 能力降级管理
├─ 降级状态跟踪
├─ 自动恢复
└─ 降级通知

Requirements: 10.6.4-10.6.5

降级原因：
- ERROR_RATE: 错误率过高
- TIMEOUT: 超时过多
- RESOURCE: 资源不足
- MANUAL: 手动降级

降级状态：
- 能力名称
- 降级原因
- 降级时间
- 恢复时间
```

### 3.12 ContinuousLearner (持续学习协调器)

```text
职责：
├─ 模式学习定时调度
├─ 策略评估定时调度
├─ 知识图谱更新定时调度
├─ 操作记录委托
├─ 最佳实践提升
└─ 配置动态更新

Requirements: 5.1, 5.4, 5.5, 5.6

定时任务：
1. 模式学习 (patternLearningTimer)
   - 间隔: 24 小时
   - 调用 patternLearner.triggerLearnPatterns() 识别操作模式
   - 检查最佳实践提升条件

2. 策略评估 (strategyEvalTimer)
   - 间隔: strategyEvaluationIntervalDays * 24h
   - 分析操作模式的成功率和置信度
   - 统计高置信度模式数量

3. 知识图谱更新 (knowledgeGraphTimer)
   - 间隔: knowledgeGraphUpdateIntervalHours * 1h
   - 调用 knowledgeGraphBuilder.discoverTopology()
   - 增量更新网络拓扑

操作记录：
- recordOperation() 委托给 patternLearner
- 受 continuousLearning 能力开关控制
- 受 patternLearningEnabled 子开关控制

最佳实践提升：
- 高频率 (>= bestPracticeThreshold) + 高成功率 (>= 0.8) 的模式
- 调用 patternLearner.promoteToBestPractice() 提升为知识条目

配置参数：
- enabled: 是否启用持续学习
- patternLearningEnabled: 是否启用模式学习
- patternLearningDelayDays: 学习延迟天数
- bestPracticeThreshold: 最佳实践提升阈值
- strategyEvaluationIntervalDays: 策略评估间隔
- knowledgeGraphUpdateIntervalHours: 知识图谱更新间隔
```

### 3.13 ToolFeedbackCollector (工具反馈收集器)

```text
职责：
├─ 工具执行指标记录
├─ 统计信息聚合
├─ 过期数据清理
└─ 日期分片存储

Requirements: 2.1, 2.3

数据存储：
- 路径: data/ai-ops/tool-metrics/{YYYY-MM-DD}.json
- 按日期分片，每天一个文件
- 记录: id, toolName, timestamp, duration, success, errorMessage

指标记录：
- recordMetric(): 记录单次工具调用指标
- 包含工具名称、耗时、成功/失败状态、错误信息

统计聚合：
- getToolStats(): 聚合指定时间范围内的工具统计
- 按工具名称分组
- 计算: totalCalls, successCount, successRate, avgDuration
- 默认统计范围: metricsRetentionDays (从 evolutionConfig 读取)

过期清理：
- cleanupExpiredMetrics(): 删除超过保留天数的文件
- startCleanupTimer(): 每 24 小时自动清理
- 按文件名日期判断是否过期

配置参数：
- metricsRetentionDays: 指标保留天数 (默认 7)
```

### 3.14 IterationLoop (迭代优化循环)

```text
职责：
├─ Critic + Reflector 协同迭代
├─ Execute → Evaluate → Reflect → Decide 循环
├─ 并发队列管理（最大并发数限制）
├─ 异步迭代与同步等待双模式
├─ 迭代状态持久化 (active/completed 分类存储)
├─ 迭代反馈记录至 FeedbackService
├─ 超时与异常安全保护
└─ 状态机编排路由 (v10.0)

文件位置: ai-ops/iterationLoop.ts (1165 行)

核心流程：
1. start/startAsync() - 启动迭代循环
   ├─ 创建 IterationState (含 maxIterations, qualityThreshold)
   ├─ 检查队列并发 (MAX_CONCURRENT_ITERATIONS = 3)
   ├─ 超出时入队等待 (queueTimeout = 300秒)
   └─ 进入路由决策

2. 状态机编排路由 (v10.0)：
   ├─ 当 FeatureFlagManager + StateMachineOrchestrator 均已配置时：
   │   └─ FeatureFlagManager.route('iteration-orchestration', stateMachinePath, legacyPath)
   │       ├─ Flag ON  → StateMachineOrchestrator.execute('iteration-loop', { alertEvent, decision, plan, ... })
   │       └─ Flag OFF → startLegacy() (原有迭代循环)
   └─ 未配置时 → 直接走 startLegacy() (向后兼容)

3. runIterationLoop() - 核心迭代逻辑 (Legacy 路径)
   ├─ 循环 while (iterations < maxIterations && 未完成)
   │   ├─ Phase 1: FaultHealer.executeRemediation() 执行修复
   │   ├─ Phase 2: CriticService.evaluate() 质量评估
   │   ├─ Phase 3: ReflectorService.reflect() 深度反思
   │   └─ Phase 4: 基于质量分数决策
   │       ├─ 达标 (>= qualityThreshold) → completed
   │       ├─ retry → 继续迭代
   │       ├─ modify → 调整方案后迭代
   │       ├─ alternative → 切换替代方案
   │       ├─ escalate → 升级处理
   │       └─ rollback → 回滚操作
   └─ 完成后：recordIterationFeedback() 记录反馈

4. 安全机制：
   ├─ 最大迭代次数限制 (默认 3 次)
   ├─ 并发迭代数限制 (最大 3 个并行)
   ├─ 队列超时保护 (300 秒)
   ├─ 异常时状态自动标记为 aborted
   └─ subscribe() 支持 AsyncIterable 实时事件流

配置参数：
- maxIterations: 3 (最大迭代次数)
- qualityThreshold: 0.7 (质量达标阈值)
- MAX_CONCURRENT_ITERATIONS: 3 (最大并发迭代数)
- queueTimeout: 300000ms (队列等待超时)
```

### 3.15 FaultHealer 进化增强

```text
新增能力：
├─ 基于 evolutionConfig 的自愈级别控制
├─ autoHealingLevel 决策逻辑
└─ 与 ContinuousLearner 的操作记录集成

自愈级别 (autoHealingLevel)：
- disabled: 禁用自动修复，记录日志并返回 null
- notify: 仅发送修复建议通知，不执行修复
- low_risk: 仅自动执行低风险修复 (L1)
- full: 全自动修复

决策流程：
1. 检查 selfHealing 能力是否启用
2. 读取 autoHealingLevel 配置
3. 根据级别决定: 跳过 / 通知 / 执行
4. 执行后记录操作到 ContinuousLearner
```

### 3.16 状态机编排层 (StateMachine Orchestration Layer) (NEW v10.0)

```text
职责：
├─ 统一编排 ReAct 循环、告警流水线、迭代优化三大核心流程
├─ 声明式状态定义与转换规则
├─ 可插拔的 Handler 注册机制
├─ 降级集成 (DegradationIntegration) 与追踪集成 (TracingIntegration)
├─ 并发守卫 (ConcurrencyGuard) 控制执行并发
├─ 特性开关 (FeatureFlagManager) 支持渐进式发布
└─ 适配器层桥接现有服务，零侵入迁移

文件位置: ai-ops/stateMachine/ (30+ 文件)

架构图：

┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              StateMachine Orchestration Layer                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                    StateMachineOrchestrator (编排器门面)                                 │    │
│  │  executeFlow(definitionId, context) → ExecutionResult                                   │    │
│  └────────────────────────────────────────┬────────────────────────────────────────────────┘    │
│                                           │                                                     │
│           ┌───────────────────────────────┼───────────────────────────────┐                     │
│           ▼                               ▼                               ▼                     │
│  ┌─────────────────┐  ┌──────────────────────────────┐  ┌─────────────────────────────┐        │
│  │FeatureFlagManager│  │    StateMachineEngine        │  │    ConcurrencyGuard         │        │
│  │ isEnabled(flowId)│  │  ┌────────────────────────┐ │  │  maxConcurrent: 5           │        │
│  │ rollout 百分比   │  │  │ runLoop() 核心循环     │ │  │  排队等待机制               │        │
│  └─────────────────┘  │  │ matchTransition()       │ │  └─────────────────────────────┘        │
│                        │  │ degraded/skipped 处理   │ │                                         │
│                        │  │ maxSteps: 50 保护       │ │                                         │
│                        │  └────────────────────────┘ │                                         │
│                        └──────────┬──────────────────┘                                         │
│                                   │                                                             │
│           ┌───────────────────────┼───────────────────────┐                                     │
│           ▼                       ▼                       ▼                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────────────┐                    │
│  │  StateRegistry   │  │  StateExecutor  │  │  Integrations                │                    │
│  │ registerDefinition│ │ canHandle()检查 │  │ ┌────────────────────────┐  │                    │
│  │ registerHandler  │  │ execute(context)│  │ │DegradationIntegration  │  │                    │
│  │ scoped handler   │  │ skipped outcome │  │ │ wrapExecution()        │  │                    │
│  └─────────────────┘  └─────────────────┘  │ ├────────────────────────┤  │                    │
│                                             │ │TracingIntegration      │  │                    │
│                                             │ │ Span per transition    │  │                    │
│                                             │ └────────────────────────┘  │                    │
│                                             └──────────────────────────────┘                    │
│                                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                              流程定义 (Definitions)                                      │    │
│  │  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐              │    │
│  │  │  reactDefinition    │  │  alertDefinition    │  │ iterationDefinition │              │    │
│  │  │  (10 状态)          │  │  (8 状态)           │  │  (6 状态)           │              │    │
│  │  │  init→intentParse→  │  │  init→normalize→    │  │  init→execute→      │              │    │
│  │  │  routing→knowledge→ │  │  dedup→filter→      │  │  evaluate→reflect→  │              │    │
│  │  │  fastPath→intent→   │  │  analyze→decide→    │  │  decide→done        │              │    │
│  │  │  reactLoop→post→    │  │  notify→done        │  │                     │              │    │
│  │  │  response→done      │  │                     │  │                     │              │    │
│  │  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘              │    │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                           │                                                     │
│                                           ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                              适配器层 (Adapters) - 零侵入桥接                            │    │
│  │  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐              │    │
│  │  │  ReActLoopAdapter   │  │AlertPipelineAdapter │  │IterationLoopAdapter │              │    │
│  │  │  ↕ ReActLoop       │  │  ↕ AlertPipeline    │  │  ↕ IterationLoop    │              │    │
│  │  │    Controller       │  │    各阶段           │  │    Critic/Reflector │              │    │
│  │  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘              │    │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                           │                                                     │
│                                           ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                              Handler 实现 (30+ 文件)                                     │    │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────┐   │    │
│  │  │  react/ (8 Handler): intentParse → routingDecision → knowledgeRetrieval →        │   │    │
│  │  │    fastPath → intentDrivenExecution → reactLoop → postProcessing → response      │   │    │
│  │  ├──────────────────────────────────────────────────────────────────────────────────┤   │    │
│  │  │  alertHandlers: normalize → deduplicate → filter → analyze → decide → notify     │   │    │
│  │  ├──────────────────────────────────────────────────────────────────────────────────┤   │    │
│  │  │  iterationHandlers: execute → evaluate → reflect → decide                        │   │    │
│  │  └──────────────────────────────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

核心组件：

1. StateMachineEngine (状态机引擎)
   ├─ 核心状态转换循环 (runLoop)
   ├─ 基于 outcome 的转换匹配 (matchTransition)
   ├─ 降级/跳过 outcome 的特殊处理 (degraded → degradedState, skipped → errorState)
   ├─ 最大步数保护 (maxSteps, 默认 50)
   ├─ 可选 DegradationIntegration 和 TracingIntegration
   └─ 返回 ExecutionResult (含 summary, history, context)

2. StateRegistry (状态注册表)
   ├─ 注册流程定义 (registerDefinition)
   ├─ 注册状态 Handler (registerHandler)
   ├─ 支持 scoped handler (definitionId:stateId)
   └─ 获取定义和 Handler 查询

3. StateExecutor (状态执行器)
   ├─ 执行 Handler 的 canHandle() 检查
   ├─ 支持 skipped outcome (canHandle 返回 false)
   ├─ 调用 handler.execute(context) 获取 TransitionResult
   └─ 异常安全 (捕获错误返回 error outcome)

4. ContextManager (上下文管理器)
   ├─ 类型安全的状态上下文管理
   ├─ get/set/update 操作
   └─ 支持泛型 StateContext<T>

5. StateMachineOrchestrator (编排器门面)
   ├─ 统一的 executeFlow(definitionId, context) 入口
   ├─ 组合 Engine + Registry + ConcurrencyGuard + Integrations
   └─ 委托 registerDefinition/registerHandler 到 Registry

6. ConcurrencyGuard (并发守卫)
   ├─ 控制同时执行的流程数量
   ├─ 可配置 maxConcurrent (默认 5)
   └─ 超出时排队等待

7. DegradationIntegration (降级集成)
   ├─ wrapExecution(capabilityName, fn) 包装执行
   ├─ 检查能力是否已降级 → 直接返回 degraded outcome
   └─ 执行失败时通知 DegradationManager

8. TracingIntegration (追踪集成)
   ├─ 为每次状态转换创建 Span
   ├─ 记录 stateId, outcome, duration 等标签
   └─ 与 TracingService 集成

9. FeatureFlagManager (特性开关)
   ├─ 按 flowId 控制是否启用状态机路径
   ├─ 支持 rollout 百分比
   └─ isEnabled(flowId) 查询

流程定义 (Definitions)：
├─ reactDefinition: ReAct 循环流程
│   状态: init → intentParse → routingDecision → knowledgeRetrieval
│         → fastPath → intentDrivenExecution → reactLoop → postProcessing → response → done
├─ alertDefinition: 告警处理流程
│   状态: init → normalize → deduplicate → filter → analyze → decide → notify → done
└─ iterationDefinition: 迭代优化流程
    状态: init → execute → evaluate → reflect → decide → done

适配器 (Adapters)：
├─ ReActLoopAdapter: 桥接 SkillAwareReActController / ReActLoopController
├─ AlertPipelineAdapter: 桥接 AlertPipeline 各阶段
└─ IterationLoopAdapter: 桥接 IterationLoop (Critic/Reflector)

Handler 实现 (handlers/)：
├─ react/ (8 个 Handler)
│   ├─ intentParseHandler.ts
│   ├─ routingDecisionHandler.ts
│   ├─ knowledgeRetrievalHandler.ts
│   ├─ fastPathHandler.ts
│   ├─ intentDrivenExecutionHandler.ts
│   ├─ reactLoopHandler.ts
│   ├─ postProcessingHandler.ts
│   └─ responseHandler.ts
├─ alertHandlers.ts (告警流程 Handler)
└─ iterationHandlers.ts (迭代流程 Handler)

工厂方法：
- createStateMachineOrchestrator(deps, config)
  ├─ 创建 Registry, Executor, ConcurrencyGuard, TracingIntegration
  ├─ 可选创建 DegradationIntegration (当 config.degradationManager 存在时)
  ├─ 组装 StateMachineEngine 和 StateMachineOrchestrator
  ├─ 调用 registerAllFlows() 注册所有定义和 Handler
  └─ 返回配置好的编排器实例

测试覆盖：
├─ stateMachine.faultCondition.test.ts - 故障条件属性测试
├─ stateMachine.preservation.test.ts - 保持性属性测试
└─ stateMachine.perfFix.faultCondition.test.ts - 性能修复故障条件测试
```

## 四、并行执行系统

### 4.1 系统概述

```text
并行执行系统支持多个工具调用的并发执行，显著提升复杂任务的处理效率。

核心特性：
├─ 自适应模式选择 (SEQUENTIAL/PARALLEL/PLANNED)
├─ 工具依赖分析
├─ 熔断器保护
├─ 可取消超时机制
└─ 完整回退链

默认配置：
- enabled: true (默认启用)
- rolloutPercentage: 100 (全量发布)
- mode: 'auto' (自适应选择)
- maxConcurrency: 5 (最大并发数)
- batchTimeout: 60000ms (批次超时)
- toolTimeout: 30000ms (单工具超时)
```

### 4.2 执行模式

```text
┌─────────────────────────────────────────────────────────────────┐
│                      执行模式选择流程                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  用户请求 → AdaptiveModeSelector.selectMode()                   │
│                    │                                            │
│                    ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              复杂度分析                                  │   │
│  │  ├─ 简单关键词: 查看、显示、获取、状态                   │   │
│  │  ├─ 中等关键词: 检查、分析、比较、诊断                   │   │
│  │  └─ 复杂关键词: 配置、修改、优化、批量、全面             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                    │                                            │
│                    ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              模式选择                                    │   │
│  │  ├─ 预估工具调用 ≤ 2  → SEQUENTIAL (串行)               │   │
│  │  ├─ 预估工具调用 3-4  → PARALLEL (并行)                 │   │
│  │  └─ 预估工具调用 > 4  → PLANNED (计划)                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

三种执行模式：

1. SEQUENTIAL (串行模式)
   - 适用于简单查询
   - 工具调用按顺序执行
   - 最稳定，无并发风险

2. PARALLEL (并行模式)
   - 适用于中等复杂度任务
   - 独立工具调用并发执行
   - 依赖分析确保正确顺序

3. PLANNED (计划模式)
   - 适用于复杂任务
   - 预先生成执行 DAG
   - 支持任务模板匹配
```

### 4.3 ParallelExecutor (并行执行器)

```text
职责：
├─ 解析 LLM 输出中的多个工具调用
├─ 并发执行工具调用批次
├─ 合并观察结果
├─ 超时和重试管理
└─ 熔断器集成

关键方法：
- parseMultipleToolCalls(llmOutput): 解析多工具调用
- executeBatch(batch, interceptors): 执行批次
- createBatch(toolCalls): 创建批次
- mergeObservations(results): 合并结果

并发安全：
- setTools() 创建 Map 副本，避免共享引用
- 每个请求独立的执行上下文
- try-finally 确保资源清理

超时机制（可取消）：
- createToolTimeout(): 单工具超时 (30s)
- createBatchTimeout(): 60s (批次超时)
- 正常完成后自动取消，防止内存泄漏
```

### 4.4 DependencyAnalyzer (依赖分析器)

```text
职责：
├─ 识别数据依赖（输出作为输入）
├─ 识别资源依赖（访问同一设备）
├─ 生成依赖图 (DAG)
└─ 确定可并行执行的工具组

依赖类型：
- DATA: 数据依赖（硬依赖）
- RESOURCE: 资源依赖（软依赖）
- ORDERING: 顺序依赖

依赖强度：
- HARD: 必须等待前置完成
- SOFT: 建议等待，可并行
```

### 4.5 CircuitBreaker (熔断器)

```text
职责：
├─ 防止对失败工具的重复调用
├─ 三态状态机管理
├─ 自动恢复机制
└─ 工具级别隔离

状态机：
┌─────────┐  失败次数 > 阈值  ┌─────────┐
│ CLOSED  │ ─────────────────▶│  OPEN   │
│ (正常)  │                   │ (熔断)  │
└─────────┘                   └─────────┘
     ▲                             │
     │                             │ 恢复超时
     │                             ▼
     │                       ┌─────────┐
     │    成功恢复           │HALF_OPEN│
     └───────────────────────│ (半开)  │
                             └─────────┘

配置参数：
- failureThreshold: 3 (连续失败阈值)
- recoveryTimeout: 30000ms (恢复超时)
- halfOpenRequests: 1 (半开状态允许请求数)
```

### 4.6 回退机制

```text
回退链：PLANNED → PARALLEL → SEQUENTIAL

┌─────────────────────────────────────────────────────────────────┐
│                        回退流程                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PLANNED 模式执行                                               │
│       │                                                         │
│       ├─ 成功 → 返回结果                                        │
│       │                                                         │
│       └─ 失败 → 回退到 PARALLEL                                 │
│              │                                                  │
│              ├─ 成功 → 返回结果                                 │
│              │                                                  │
│              └─ 失败 → 回退到 SEQUENTIAL                        │
│                     │                                           │
│                     ├─ 成功 → 返回结果                          │
│                     │                                           │
│                     └─ 失败 → 返回错误                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 五、数据流详解

### 5.1 指标告警处理流程

```text
MetricsCollector                    AlertEngine                      AlertPipeline
     │                                  │                                  │
     │  采集系统指标                     │                                  │
     │  (CPU/Memory/Interface)          │                                  │
     │                                  │                                  │
     ├─────────────────────────────────▶│                                  │
     │         metrics data             │                                  │
     │                                  │  evaluate(metrics)               │
     │                                  │  ├─ 遍历告警规则                  │
     │                                  │  ├─ 检查阈值条件                  │
     │                                  │  ├─ 生成 AlertEvent              │
     │                                  │  └─ 指纹去重检查                  │
     │                                  │                                  │
     │                                  │  ConcurrencyController           │
     │                                  │  ├─ 检查并发数                    │
     │                                  │  ├─ 入队等待                      │
     │                                  │  └─ 背压控制                      │
     │                                  │                                  │
     │                                  ├─────────────────────────────────▶│
     │                                  │      AlertEvent                  │
     │                                  │                                  │
     │                                  │                    ┌─────────────┴─────────────┐
     │                                  │                    │      5 阶段流水线         │
     │                                  │                    │                           │
     │                                  │                    │  1. Normalize (AlertPreprocessor) │
     │                                  │                    │     ├─ 转换 UnifiedEvent          │
     │                                  │                    │     └─ 丰富设备信息 (enrichContext)│
     │                                  │                    │                           │
     │                                  │                    │  2. Deduplicate           │
     │                                  │                    │     └─ 指纹缓存去重       │
     │                                  │                    │                           │
     │                                  │                    │  3. Filter                │
     │                                  │                    │     ├─ 维护窗口检查       │
     │                                  │                    │     ├─ 已知问题过滤       │
     │                                  │                    │     └─ 瞬态抖动过滤       │
     │                                  │                    │                           │
     │                                  │                    │  4. Analyze (RAGEngine)   │
     │                                  │                    │     ├─ 检索历史告警       │
     │                                  │                    │     ├─ 根因分析           │
     │                                  │                    │     └─ 生成分析报告       │
     │                                  │                    │                           │
     │                                  │                    │  5. Decide                │
     │                                  │                    │     └─ DecisionEngine     │
     │                                  │                    │        ├─ 评估决策因子    │
     │                                  │                    │        ├─ 生成决策        │
     │                                  │                    │        └─ 执行决策        │
     │                                  │                    │               │           │
     │                                  │                    │               ▼           │
     │                                  │                    │      NotificationService  │
     │                                  │                    │      (发送多渠道通知)     │
     │                                  │                    └───────────────────────────┘
```

### 5.2 AI 对话流程 (知识增强模式 + 并行执行)

```text
用户请求                    UnifiedAgentService                 SkillManager
     │                              │                                │
     │  chat(message, mode)         │                                │
     ├─────────────────────────────▶│                                │
     │                              │                                │
     │                              │  selectSkill(message, sessionId)
     │                              ├───────────────────────────────▶│
     │                              │                                │
     │                              │                    ┌───────────┴───────────┐
     │                              │                    │  Skill 匹配流程       │
     │                              │                    │  1. 显式指定检查      │
     │                              │                    │  2. 触发词匹配        │
     │                              │                    │  3. 上下文延续        │
     │                              │                    │  4. 意图映射          │
     │                              │                    │  5. 语义相似度        │
     │                              │                    │  6. 兜底 generalist   │
     │                              │                    └───────────────────────┘
     │                              │                                │
     │                              │◀───────────────────────────────┤
     │                              │      SkillMatchResult          │
     │                              │                                │
     │                              ▼                                │
     │              ┌───────────────────────────────┐                │
     │              │    FastPathRouter (可选)      │                │
     │              │    ├─ 简单查询检测            │                │
     │              │    ├─ 快速响应路径            │                │
     │              │    └─ 跳过完整 ReAct          │                │
     │              └───────────────────────────────┘                │
     │                              │                                │
     │                              ▼                                │
     │              ┌───────────────────────────────┐                │
     │              │  SkillAwareReActController    │                │
     │              │                               │                │
     │              │  executeLoop():               │                │
     │              │  ├─ 应用 Skill 配置           │                │
     │              │  ├─ 工具过滤和排序            │                │
     │              │  ├─ 知识检索 (一次)           │                │
     │              │  ├─ 构建增强提示词            │                │
     │              │  └─ 调用 ReActLoopController  │                │
     │              └───────────────────────────────┘                │
     │                              │                                │
     │                              ▼                                │
     │              ┌───────────────────────────────┐                │
     │              │    ReActLoopController        │                │
     │              │                               │                │
     │              │  ┌─────────────────────────┐ │                │
     │              │  │ 并行执行模式选择        │ │                │
     │              │  │ AdaptiveModeSelector    │ │                │
     │              │  │ ├─ SEQUENTIAL           │ │                │
     │              │  │ ├─ PARALLEL             │ │                │
     │              │  │ └─ PLANNED              │ │                │
     │              │  └─────────────────────────┘ │                │
     │              │              │               │                │
     │              │              ▼               │                │
     │              │  ┌─────────────────────────┐ │                │
     │              │  │    ReAct 循环           │ │                │
     │              │  │    ├─ Thought (思考)    │ │                │
     │              │  │    ├─ Action (工具调用) │ │                │
     │              │  │    │   └─ 并行执行支持  │ │                │
     │              │  │    ├─ Observation       │ │                │
     │              │  │    └─ Final Answer      │ │                │
     │              │  └─────────────────────────┘ │                │
     │              └───────────────────────────────┘                │
     │                              │                                │
     │◀─────────────────────────────┤                                │
     │      UnifiedChatResponse     │                                │
```

### 5.3 智能进化数据流

```text
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              智能进化数据流                                          │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────────────┐                                                                │
│  │  HealthMonitor  │──────┐                                                         │
│  │  (健康监控)     │      │                                                         │
│  └─────────────────┘      │                                                         │
│           │               │                                                         │
│           ▼               ▼                                                         │
│  ┌─────────────────┐  ┌─────────────────┐                                          │
│  │ AnomalyPredictor│  │ProactiveInspector│                                          │
│  │  (异常预测)     │  │  (主动巡检)     │                                          │
│  └─────────────────┘  └─────────────────┘                                          │
│           │               │                                                         │
│           └───────┬───────┘                                                         │
│                   ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐               │
│  │                    AlertPipeline                                 │               │
│  │  ┌─────────────────────────────────────────────────────────┐   │               │
│  │  │  预测告警 / 巡检问题 → 归一化 → 分析 → 决策             │   │               │
│  │  └─────────────────────────────────────────────────────────┘   │               │
│  └─────────────────────────────────────────────────────────────────┘               │
│                   │                                                                 │
│                   ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐               │
│  │                    DecisionEngine                                │               │
│  │  ┌─────────────────────────────────────────────────────────┐   │               │
│  │  │  决策 → 执行 → 反馈 → 学习                              │   │               │
│  │  └─────────────────────────────────────────────────────────┘   │               │
│  └─────────────────────────────────────────────────────────────────┘               │
│                   │                                                                 │
│                   ▼                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                     │
│  │  PatternLearner │  │KnowledgeGraphBuilder│ │  FeedbackService│                     │
│  │  (模式学习)     │  │  (知识图谱)     │  │  (反馈收集)     │                     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘                     │
│           │               │                       │                                 │
│           └───────────────┴───────────────────────┘                                 │
│                           │                                                         │
│                           ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐               │
│  │                    持续学习与进化                                │               │
│  │  ┌─────────────────────────────────────────────────────────┐   │               │
│  │  │  ContinuousLearner 协调:                                │   │               │
│  │  │  ├─ 模式学习定时 → PatternLearner.triggerLearnPatterns  │   │               │
│  │  │  ├─ 策略评估定时 → 分析成功率和置信度趋势               │   │               │
│  │  │  ├─ 知识图谱更新 → KnowledgeGraphBuilder.discoverTopology│  │               │
│  │  │  └─ 最佳实践提升 → PatternLearner.promoteToBestPractice │   │               │
│  │  └─────────────────────────────────────────────────────────┘   │               │
│  │  ┌─────────────────────────────────────────────────────────┐   │               │
│  │  │  ToolFeedbackCollector:                                 │   │               │
│  │  │  ├─ 记录工具调用指标 (名称/耗时/成功率)                 │   │               │
│  │  │  ├─ 聚合统计信息 (按工具分组)                           │   │               │
│  │  │  └─ 定期清理过期数据 (日期分片存储)                     │   │               │
│  │  └─────────────────────────────────────────────────────────┘   │               │
│  └─────────────────────────────────────────────────────────────────┘               │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 知识检索流程

```text
KnowledgeBase.search()              HybridSearchEngine              结果融合
        │                                   │                           │
        │  search(query, options)           │                           │
        ├──────────────────────────────────▶│                           │
        │                                   │                           │
        │                    ┌──────────────┴──────────────┐            │
        │                    │       并行检索              │            │
        │                    │                             │            │
        │                    │  ┌─────────────────────┐   │            │
        │                    │  │ KeywordIndexManager │   │            │
        │                    │  │ (BM25 关键词检索)   │   │            │
        │                    │  │ ├─ 分词处理         │   │            │
        │                    │  │ ├─ TF-IDF 计算      │   │            │
        │                    │  │ └─ BM25 评分        │   │            │
        │                    │  └─────────────────────┘   │            │
        │                    │            │               │            │
        │                    │            │ BM25 Results  │            │
        │                    │            ▼               │            │
        │                    │  ┌─────────────────────┐   │            │
        │                    │  │      RRFRanker      │◀──┼────────────┤
        │                    │  │  ├─ k=60 (常数)    │   │            │
        │                    │  │  ├─ 排名倒数求和   │   │            │
        │                    │  │  └─ 归一化分数     │   │            │
        │                    │  └─────────────────────┘   │            │
        │                    │            ▲               │            │
        │                    │            │ Vector Results│            │
        │                    │  ┌─────────────────────┐   │            │
        │                    │  │      LanceDB        │   │            │
        │                    │  │  (向量语义检索)     │   │            │
        │                    │  │  ├─ 文本向量化      │   │            │
        │                    │  │  ├─ 余弦相似度      │   │            │
        │                    │  │  └─ ANN 近似搜索    │   │            │
        │                    │  └─────────────────────┘   │            │
        │                    │                             │            │
        │                    └─────────────────────────────┘            │
        │                                   │                           │
        │◀──────────────────────────────────┤                           │
        │      Ranked Results               │                           │

RRF 融合公式：
score(d) = Σ 1/(k + rank_i(d))
其中 k=60, rank_i(d) 是文档 d 在第 i 个检索结果中的排名
```

## 六、并发控制与缓存策略

### 6.1 ConcurrencyController (并发控制器)

```text
设计目标：
├─ 防止大量告警/事件导致 CPU 飙升
├─ 保证系统稳定性
├─ 支持优先级队列
└─ 提供背压机制

配置参数：
- maxConcurrent: 最大并发数 (默认 5)
- maxQueueSize: 最大队列大小 (默认 100)
- taskTimeout: 任务超时 (默认 60秒)
- enablePriorityQueue: 启用优先级队列
- enableBackpressure: 启用背压机制
- backpressureThreshold: 背压阈值 (默认 0.8)

工作流程：
1. 任务提交 → 检查并发数
2. 未达上限 → 立即执行
3. 已达上限 → 入队等待
4. 队列满 → 触发背压/拒绝
5. 任务完成 → 从队列取下一个
```

### 6.2 ConcurrencyLimiter (并行执行并发限制器)

```text
职责：
├─ 控制并行工具调用的并发数
├─ 槽位管理
├─ 设备级别隔离
└─ 超时保护

配置参数：
- maxGlobalConcurrency: 5 (全局最大并发)
- maxPerDevice: 2 (单设备最大并发)
- slotAcquireTimeout: 10000ms (槽位获取超时)

槽位管理：
- acquireSlots(): 获取执行槽位
- releaseSlots(): 释放槽位
- 支持批量获取和释放
```

### 6.3 分析结果缓存

```text
RAGEngine 缓存机制：

1. 告警分析缓存 (analysisCache)
   - 键: alertId
   - 值: EnhancedAlertAnalysis
   - TTL: 30 分钟
   - 用途: 避免重复分析相同告警

2. 根因分析缓存 (rootCauseAnalysisCache)
   - 键: eventId
   - 值: RootCauseAnalysis
   - TTL: 30 分钟
   - 用途: 避免重复根因分析

缓存清理：
- 定时清理: 每 5 分钟
- 过期检查: 访问时检查 TTL
- 手动失效: invalidateAnalysisCache()
```

### 6.4 指纹缓存去重

```text
FingerprintCache 机制：

指纹生成规则：
- 告警: ruleId + metric + severity + 关键参数
- Syslog: hostname + category + message前100字符

去重策略：
- 相同指纹在 TTL 内视为重复
- 默认 TTL: 5 分钟
- 最大缓存条目: 1000
- LRU 淘汰策略

AlertPipeline 额外去重：
- Syslog 快速去重: 5秒内相同消息
- 速率限制: 每秒最多 10 个事件
```

## 七、降级与容错机制

### 7.1 服务降级策略

```text
RAGEngine 降级：
├─ 知识检索失败 → 回退到标准分析
├─ AI 分析超时 → 返回基于规则的分析
└─ 缓存服务故障 → 跳过缓存直接分析

AlertPipeline 降级：
├─ RAG 分析失败 → 跳过分析阶段
├─ 决策引擎故障 → 默认通知动作
├─ 通知服务故障 → 记录日志继续处理
└─ 状态机路径异常 → FeatureFlagManager.route 自动回退到 Legacy 流水线 (v10.0)

UnifiedAgentService 降级：
├─ Skill 系统故障 → 使用 generalist
├─ Fast Path 失败 → 回退完整 ReAct
├─ 知识检索失败 → 纯 LLM 响应
└─ 状态机路径异常 → FeatureFlagManager.route 自动回退到 Legacy ReAct 循环 (v10.0)

IterationLoop 降级：
├─ 状态机路径异常 → FeatureFlagManager.route 自动回退到 Legacy 迭代循环 (v10.0)
└─ 迭代超时/异常 → 状态标记为 aborted

并行执行降级：
├─ PLANNED 模式失败 → 回退 PARALLEL
├─ PARALLEL 模式失败 → 回退 SEQUENTIAL
├─ 熔断器打开 → 跳过该工具
└─ 批次超时 → 返回部分结果

智能进化降级：
├─ DegradationManager 统一管理
├─ 能力级别降级控制
├─ 自动恢复机制
└─ 降级状态通知

状态机编排路由降级 (v10.0)：
├─ FeatureFlagManager.route(flowId, stateMachinePath, legacyPath) 统一路由模式
├─ 三大核心流程均采用相同的路由降级模式：
│   ├─ alert-orchestration (AlertPipeline.process)
│   ├─ react-orchestration (UnifiedAgentService.executeReActWithRouting)
│   └─ iteration-orchestration (IterationLoop.start)
├─ Flag ON + 状态机执行成功 → 返回状态机结果
├─ Flag ON + 状态机执行异常 → 捕获错误，记录日志，返回错误结果
├─ Flag OFF → 直接走 Legacy 路径，行为与迁移前完全一致
└─ 未配置 FeatureFlagManager → 直接走 Legacy 路径 (向后兼容)
```

### 7.2 超时保护

```text
各阶段超时设置：

AlertPipeline:
- 整体流水线: 180秒
- RAG 分析: 90秒
- 决策执行: 30秒
- 方案生成: 60秒

RAGEngine:
- 单次分析: 60秒
- 知识检索: 30秒

ReActLoopController:
- 单次迭代: 30秒
- 最大迭代数: 15次
- 工具调用: 60秒

ParallelExecutor:
- 单工具超时: 30秒 (可取消)
- 批次超时: 60秒 (可取消)
- 槽位获取超时: 10秒

AdaptiveModeSelector:
- 模式选择超时: 50ms

ExecutionPlanner:
- 计划生成超时: 1000ms

智能进化组件 (NEW):
- 健康检查超时: 30秒
- 异常预测超时: 60秒
- 巡检项超时: 30秒
- 意图解析超时: 5秒
- 追踪 Span 最大存活: 10分钟
- 追踪 Trace 最大存活: 30分钟
```

### 7.3 错误处理

```text
错误分类：
1. 可恢复错误 → 重试
2. 不可恢复错误 → 降级
3. 系统错误 → 告警 + 降级

重试策略：
- 最大重试次数: 3 (AlertPipeline)
- 最大重试次数: 1 (ParallelExecutor)
- 重试间隔: 指数退避 (100ms * retryCount)
- 重试条件: 网络错误、超时

错误记录：
- 审计日志 (AuditLogger)
- 错误日志 (Logger)
- 指标统计 (Stats)
- 并行执行指标 (ParallelExecutionMetrics)
- 追踪服务 (TracingService)

进化错误处理 (NEW):
- EvolutionErrorHandler 统一处理
- 错误分类和严重级别
- 智能重试策略
- 错误统计和分析
```

## 八、Skill 系统详解

### 8.1 Skill 配置结构

```text
Skill 目录结构：
backend/data/ai-ops/skills/
├─ builtin/                    # 内置 Skill
│   ├─ diagnostician/          # 故障诊断专家
│   │   ├─ SKILL.md           # Skill 定义
│   │   └─ config.json        # Skill 配置
│   ├─ configurator/          # 配置生成专家
│   ├─ auditor/               # 安全审计专家
│   ├─ optimizer/             # 性能优化专家
│   └─ generalist/            # 通用助手
├─ custom/                     # 自定义 Skill
└─ mapping.json               # 意图-Skill 映射
```

### 8.2 Skill 配置示例

```json
{
  "allowedTools": ["device_query", "monitor_metrics", "knowledge_search"],
  "toolPriority": ["knowledge_search", "monitor_metrics", "device_query"],
  "toolDefaults": {
    "device_query": {
      "proplist": "name,type,running,disabled",
      "limit": 50
    }
  },
  "caps": {
    "maxTokens": 4096,
    "temperature": 0.2,
    "maxIterations": 10
  },
  "knowledgeConfig": {
    "enabled": true,
    "priorityTypes": ["alert", "remediation", "pattern"],
    "minScore": 0.3
  }
}
```

### 8.3 Skill 系统调用链

```text
1. UnifiedAgentService.chat()
   │
   ├─→ 2. SkillManager.selectSkill()
   │       ├─ 匹配策略: explicit > trigger > context > intent > semantic > fallback
   │       └─ 返回: SkillMatchResult
   │
   └─→ 3. SkillAwareReActController.executeLoop()
        │
        ├─→ 3.1 buildConfigOverrides(skill)
        │       └─ 应用 Skill 配置 (temperature, maxIterations)
        │
        ├─→ 3.2 SkillAwareToolSelector.filterTools()
        │       └─ 根据 allowedTools 过滤工具
        │
        ├─→ 3.3 SkillAwareKnowledgeRetriever.retrieve()
        │       └─ 应用 knowledgeConfig 检索知识
        │
        ├─→ 3.4 SkillAwarePromptBuilder.build()
        │       └─ 注入 SKILL.md 内容到提示词
        │
        └─→ 3.5 ReActLoopController.executeLoop()
                ├─ PromptComposerAdapter 构建模块化 Prompt
                ├─ 并行执行模式选择
                └─ 执行 Thought → Action → Observation 循环
```

## 九、智能进化配置

### 9.1 配置结构

```text
配置文件: backend/data/ai-ops/evolution-config.json

配置项：
├─ reflection: 反思配置
│   ├─ enabled: 是否启用
│   ├─ maxRetries: 最大重试次数
│   └─ timeoutMs: 超时时间
│
├─ experience: 经验管理配置
│   ├─ enabled: 是否启用
│   ├─ minScoreForRetrieval: 最小检索分数
│   ├─ maxFewShotExamples: 最大示例数
│   └─ autoApprove: 自动批准
│
├─ planRevision: 计划修订配置
│   ├─ enabled: 是否启用
│   ├─ qualityThreshold: 质量阈值
│   └─ maxAdditionalSteps: 最大额外步骤
│
├─ toolFeedback: 工具反馈配置
│   ├─ enabled: 是否启用
│   ├─ metricsRetentionDays: 指标保留天数
│   └─ priorityOptimizationEnabled: 优先级优化
│
├─ proactiveOps: 主动运维配置
│   ├─ enabled: 是否启用
│   ├─ healthCheckIntervalSeconds: 健康检查间隔
│   ├─ predictionTimeWindowMinutes: 预测窗口
│   ├─ predictionConfidenceThreshold: 预测置信度阈值
│   ├─ inspectionIntervalHours: 巡检间隔
│   └─ contextAwareChatEnabled: 上下文感知对话
│
├─ intentDriven: 意图驱动配置
│   ├─ enabled: 是否启用
│   ├─ confidenceThreshold: 置信度阈值
│   ├─ confirmationTimeoutMinutes: 确认超时
│   └─ riskLevelForConfirmation: 需确认的风险等级
│
├─ selfHealing: 自愈配置
│   ├─ enabled: 是否启用
│   ├─ autoHealingLevel: 自动修复级别
│   ├─ faultDetectionIntervalSeconds: 故障检测间隔
│   └─ rootCauseAnalysisTimeoutSeconds: 根因分析超时
│
├─ continuousLearning: 持续学习配置
│   ├─ enabled: 是否启用
│   ├─ patternLearningEnabled: 模式学习
│   ├─ patternLearningDelayDays: 学习延迟
│   ├─ bestPracticeThreshold: 最佳实践阈值
│   ├─ strategyEvaluationIntervalDays: 策略评估间隔
│   └─ knowledgeGraphUpdateIntervalHours: 知识图谱更新间隔
│
└─ tracing: 追踪配置
    ├─ enabled: 是否启用
    ├─ traceRetentionDays: 追踪保留天数
    ├─ longTaskThresholdMinutes: 长任务阈值
    └─ heartbeatIntervalSeconds: 心跳间隔
```

### 9.2 自动修复授权级别

```text
AutoHealingLevel:
- disabled: 禁用自动修复
- notify: 仅通知，不自动修复
- low_risk: 仅自动修复低风险操作 (L1)
- full: 全自动修复

RiskLevel:
- L1: 低风险 (查询、监控)
- L2: 中风险 (配置修改)
- L3: 高风险 (删除、重启)
- L4: 极高风险 (批量操作)
```

### 9.3 配置热更新

```text
配置变更无需重启服务：
- 文件监视器监听配置文件变化
- 变更时自动重新加载配置
- 通知所有配置变更监听器
- 各组件动态应用新配置

API 支持：
- getEvolutionConfig(): 获取当前配置
- updateEvolutionConfig(): 更新配置
- enableCapability(): 启用能力
- disableCapability(): 禁用能力
- resetEvolutionConfig(): 重置为默认配置
```

## 十、文件结构

```text
backend/src/services/
├─ ai/                                    # AI 服务
│   ├─ unifiedAgentService.ts            # 统一代理服务入口
│   ├─ chatSessionService.ts             # 会话管理
│   ├─ contextBuilderService.ts          # 上下文构建
│   ├─ scriptExecutorService.ts          # 脚本执行
│   ├─ apiConfigService.ts               # API 配置
│   ├─ rerankerService.ts                # 重排序服务
│   ├─ tokenBudgetManager.ts             # Token 预算管理
│   ├─ knowledgeSummarizer.ts            # 知识摘要
│   └─ adapters/                         # AI 适配器
│       ├─ openaiAdapter.ts
│       ├─ anthropicAdapter.ts
│       └─ ...
│
└─ ai-ops/                               # AI-OPS 服务
    ├─ index.ts                          # 服务导出
    │
    │  # 核心告警处理
    ├─ alertEngine.ts                    # 告警引擎
    ├─ alertPipeline.ts                  # 告警流水线
    ├─ alertPreprocessor.ts              # 告警预处理
    │
    │  # 分析与决策
    ├─ aiAnalyzer.ts                     # AI 分析器
    ├─ decisionEngine.ts                 # 决策引擎
    ├─ rootCauseAnalyzer.ts              # 根因分析
    ├─ remediationAdvisor.ts             # 修复建议
    │
    │  # 并发与缓存
    ├─ concurrencyController.ts          # 并发控制器
    ├─ fingerprintCache.ts               # 指纹缓存
    ├─ analysisCache.ts                  # 分析缓存
    ├─ batchProcessor.ts                 # 批处理器
    │
    │  # 数据采集
    ├─ metricsCollector.ts               # 指标采集
    ├─ syslogReceiver.ts                 # Syslog 接收
    │
    │  # 通知与审计
    ├─ notificationService.ts            # 通知服务
    ├─ auditLogger.ts                    # 审计日志
    ├─ feedbackService.ts                # 反馈服务
    │
    │  # 配置与快照
    ├─ configSnapshotService.ts          # 配置快照
    ├─ healthReportService.ts            # 健康报告
    │
    │  # 调度与生命周期
    ├─ scheduler.ts                      # 调度器
    ├─ serviceLifecycle.ts               # 服务生命周期
    │
    │  # 智能进化组件 (NEW)
    ├─ evolutionConfig.ts                # 进化配置管理
    ├─ healthMonitor.ts                  # 健康监控
    ├─ anomalyPredictor.ts               # 异常预测
    ├─ proactiveInspector.ts             # 主动巡检
    ├─ patternLearner.ts                 # 模式学习
    ├─ continuousLearner.ts              # 持续学习协调器 (NEW v5.0)
    ├─ toolFeedbackCollector.ts          # 工具反馈收集器 (NEW v5.0)
    ├─ intentParser.ts                   # 意图解析
    ├─ knowledgeGraphBuilder.ts          # 知识图谱构建
    ├─ tracingService.ts                 # 分布式追踪
    ├─ evolutionErrorHandler.ts          # 进化错误处理
    ├─ degradationManager.ts             # 降级管理
    │
    │  # Critic/Reflector 模块
    ├─ criticService.ts                  # Critic 服务
    ├─ reflectorService.ts               # Reflector 服务
    ├─ iterationLoop.ts                  # 迭代循环
    │
    │  # 其他服务
    ├─ faultHealer.ts                    # 故障自愈
    ├─ noiseFilter.ts                    # 噪声过滤
    ├─ inspectionHandler.ts              # 巡检处理
    ├─ eventProcessingTracker.ts         # 事件处理跟踪
    │
    │  # 状态机编排层 (NEW v10.0)
    ├─ stateMachine/                     # 状态机编排子系统
    │   ├─ index.ts                      # 模块导出入口 + 工厂方法
    │   ├─ types.ts                      # 核心类型定义
    │   ├─ stateMachineEngine.ts         # 状态机引擎 (核心转换循环)
    │   ├─ stateRegistry.ts              # 状态注册表
    │   ├─ stateExecutor.ts              # 状态执行器
    │   ├─ contextManager.ts             # 上下文管理器
    │   ├─ stateMachineOrchestrator.ts   # 编排器门面
    │   ├─ featureFlagManager.ts         # 特性开关
    │   ├─ stateDefinitionSerializer.ts  # 定义序列化
    │   ├─ registerFlows.ts              # 流程注册
    │   ├─ integrations/                 # 集成层
    │   │   ├─ concurrencyGuard.ts       # 并发守卫
    │   │   ├─ degradationIntegration.ts # 降级集成
    │   │   └─ tracingIntegration.ts     # 追踪集成
    │   ├─ definitions/                  # 流程定义
    │   │   ├─ reactDefinition.ts        # ReAct 循环定义
    │   │   ├─ alertDefinition.ts        # 告警流程定义
    │   │   └─ iterationDefinition.ts    # 迭代流程定义
    │   ├─ adapters/                     # 适配器层
    │   │   ├─ reactLoopAdapter.ts       # ReAct 适配器
    │   │   ├─ alertPipelineAdapter.ts   # 告警适配器
    │   │   └─ iterationLoopAdapter.ts   # 迭代适配器
    │   └─ handlers/                     # Handler 实现
    │       ├─ alertHandlers.ts          # 告警 Handler
    │       ├─ iterationHandlers.ts      # 迭代 Handler
    │       └─ react/                    # ReAct Handler (8 个)
    │           ├─ intentParseHandler.ts
    │           ├─ routingDecisionHandler.ts
    │           ├─ knowledgeRetrievalHandler.ts
    │           ├─ fastPathHandler.ts
    │           ├─ intentDrivenExecutionHandler.ts
    │           ├─ reactLoopHandler.ts
    │           ├─ postProcessingHandler.ts
    │           └─ responseHandler.ts
    │
    │  # Prompt 模块化系统 (NEW v6.0)
    ├─ prompt/                           # Prompt 模块化子系统
    │   ├─ index.ts                      # 工厂方法入口
    │   ├─ promptComposer.ts             # Prompt 组合器
    │   ├─ promptComposerAdapter.ts      # 适配层
    │   ├─ legacyTemplates.ts            # 遗留模板回退
    │   ├─ types.ts                      # 模块类型定义
    │   └─ modules/                      # 独立 Prompt 模块
    │       ├─ basePersona.ts            # 基础人设
    │       ├─ deviceInfo.ts             # 设备信息
    │       ├─ reActFormat.ts            # ReAct 格式
    │       ├─ apiSafety.ts              # API 安全规则
    │       ├─ batchProtocol.ts          # 批处理协议
    │       ├─ knowledgeGuide.ts         # 知识引导
    │       └─ parallelFormat.ts         # 并行执行格式
    │
    ├─ rag/                              # RAG 子系统
    │   ├─ ragEngine.ts                  # RAG 引擎
    │   ├─ knowledgeBase.ts              # 知识库
    │   ├─ hybridSearchEngine.ts         # 混合检索引擎
    │   ├─ keywordIndexManager.ts        # 关键词索引
    │   ├─ rrfRanker.ts                  # RRF 排序器
    │   ├─ metadataEnhancer.ts           # 元数据增强
    │   ├─ intelligentRetriever.ts       # 智能检索器
    │   ├─ preRetrievalEngine.ts         # 预检索引擎
    │   ├─ fastPathRouter.ts             # 快速路径路由
    │   ├─ fastPathIntentClassifier.ts   # 快速路径意图分类
    │   ├─ fastPathMetrics.ts            # 快速路径指标
    │   ├─ intentAnalyzer.ts             # 意图分析
    │   ├─ mastraAgent.ts                # Mastra Agent
    │   ├─ reactLoopController.ts        # ReAct 循环控制 (主入口)
    │   ├─ reactPromptBuilder.ts         # ReAct 提示词构建 (模块化拆分)
    │   ├─ reactToolExecutor.ts          # ReAct 工具执行 (模块化拆分)
    │   ├─ reactKnowledgeRetrieval.ts    # ReAct 知识检索 (模块化拆分)
    │   ├─ reactOutputValidator.ts       # ReAct 输出验证 (模块化拆分)
    │   ├─ reactFailureAnalyzer.ts       # ReAct 故障分析 (模块化拆分)
    │   ├─ reactFinalAnswer.ts           # ReAct 最终答案 (模块化拆分)
    │   ├─ reactParallelExecution.ts     # ReAct 并行执行 (模块化拆分)
    │   ├─ agentTools.ts                 # Agent 工具
    │   ├─ promptBuilder.ts              # 提示词构建 (legacy)
    │   ├─ outputValidator.ts            # 输出验证
    │   ├─ usageTracker.ts               # 使用追踪
    │   ├─ queryRewriter.ts              # 查询重写
    │   ├─ synonymExpander.ts            # 同义词扩展
    │   ├─ toolOutputSummarizer.ts       # 工具输出摘要
    │   ├─ credibilityCalculator.ts      # 可信度计算
    │   ├─ knowledgeFormatter.ts         # 知识格式化
    │   ├─ responseGenerator.ts          # 响应生成
    │   ├─ documentProcessor.ts          # 文档处理
    │   ├─ fileProcessor.ts              # 文件处理
    │   ├─ embeddingService.ts           # 嵌入服务
    │   ├─ vectorDatabase.ts             # 向量数据库
    │   │
    │   │  # 并行执行组件
    │   ├─ parallelExecutor.ts           # 并行执行器
    │   ├─ adaptiveModeSelector.ts       # 自适应模式选择
    │   ├─ executionPlanner.ts           # 执行计划器
    │   ├─ dependencyAnalyzer.ts         # 依赖分析器
    │   ├─ circuitBreaker.ts             # 熔断器
    │   ├─ concurrencyLimiter.ts         # 并发限制器
    │   └─ parallelExecutionMetrics.ts   # 并行执行指标
    │
    └─ skill/                            # Skill 子系统
        ├─ skillManager.ts               # Skill 管理器
        ├─ skillLoader.ts                # Skill 加载器
        ├─ skillRegistry.ts              # Skill 注册表
        ├─ skillMatcher.ts               # Skill 匹配器
        ├─ skillSemanticMatcher.ts       # 语义匹配器
        ├─ skillMetrics.ts               # Skill 指标
        ├─ skillChainManager.ts          # 链式调用管理
        ├─ skillRouter.ts                # Skill 路由
        ├─ skillParameterTuner.ts        # 参数调优
        ├─ skillAwareReActController.ts  # Skill 感知 ReAct
        ├─ skillAwarePromptBuilder.ts    # 提示词构建
        ├─ skillAwareToolSelector.ts     # 工具选择器
        └─ skillAwareKnowledgeRetriever.ts # 知识检索器
```

```text
backend/data/ai-ops/
├─ alerts/                               # 告警数据
│   ├─ events/                          # 告警事件
│   └─ rules.json                       # 告警规则
├─ analysis/                            # 分析结果
├─ audit/                               # 审计日志
├─ decisions/                           # 决策记录
│   ├─ history/                         # 决策历史
│   └─ rules.json                       # 决策规则
├─ feedback/                            # 用户反馈
├─ filters/                             # 过滤配置
├─ metrics/                             # 指标数据
│   ├─ interfaces/                      # 接口指标
│   ├─ system/                          # 系统指标
│   └─ traffic/                         # 流量指标
├─ notifications/                       # 通知记录
├─ patterns/                            # 故障模式
├─ rag/                                 # RAG 数据
│   ├─ knowledge/                       # 知识条目
│   └─ lancedb/                         # 向量数据库
├─ remediations/                        # 修复方案
│   ├─ executions/                      # 执行记录
│   └─ plans/                           # 修复计划
├─ reports/                             # 健康报告
├─ scheduler/                           # 调度任务
│   ├─ executions/                      # 执行记录
│   └─ tasks.json                       # 任务配置
├─ skills/                              # Skill 配置
│   ├─ builtin/                         # 内置 Skill
│   ├─ custom/                          # 自定义 Skill
│   └─ mapping.json                     # 意图映射
├─ snapshots/                           # 配置快照
├─ evolution-config.json                # 智能进化配置 (NEW)
├─ tool-metrics/                        # 工具执行指标 (NEW v5.0)
│   └─ {YYYY-MM-DD}.json              # 日期分片指标文件
└─ channels.json                        # 通知渠道配置

backend/src/types/
├─ ai-ops.ts                            # AI-OPS 类型定义
├─ ai.ts                                # AI 类型定义
├─ parallel-execution.ts                # 并行执行类型
├─ skill.ts                             # Skill 类型定义
├─ fast-path.ts                         # Fast Path 类型
├─ rag-interfaces.ts                    # RAG 接口定义
├─ summarization.ts                     # 摘要类型
├─ routeros.ts                          # RouterOS 类型
└─ ipv6.ts                              # IPv6 类型
```

## 十一、总结

### 11.1 系统特点

AI-OPS 智能运维系统具有以下核心特点：

1. **统一入口设计**：通过 UnifiedAgentService 提供统一的对话入口，支持标准模式和知识增强模式。

2. **流水线处理架构**：AlertPipeline 实现 5 阶段流水线（归一化→去重→过滤→分析→决策），确保告警处理的标准化和可追溯性。

3. **混合检索能力**：HybridSearchEngine 结合 BM25 关键词检索和向量语义检索，通过 RRF 算法融合排序，提供高质量的知识检索结果。

4. **Skill 系统**：通过 SkillManager 实现智能 Skill 选择和链式调用，支持专业化的任务处理。

5. **并行执行能力**：ParallelExecutor 支持多工具并发执行，通过自适应模式选择、依赖分析、熔断器等机制确保高效稳定。

6. **并发控制**：ConcurrencyController 和 ConcurrencyLimiter 提供完善的并发控制机制，防止系统过载。

7. **多层缓存**：分析结果缓存、指纹缓存等多层缓存机制，提升系统性能。

8. **降级容错**：完善的降级策略、超时保护和回退机制，确保系统稳定性。

9. **智能进化能力**：
   - 健康监控与异常预测
   - 主动巡检与问题发现
   - 模式学习与操作推荐
   - 意图解析与自动化执行
   - 知识图谱与影响分析
   - 分布式追踪与可观测性
   - 统一错误处理与降级管理
   - 持续学习协调 (ContinuousLearner) - 定时模式学习、策略评估、知识图谱更新
   - 工具反馈收集 (ToolFeedbackCollector) - 工具执行指标记录与统计
   - FaultHealer 进化增强 - 基于 evolutionConfig 的自愈级别控制

10. **Prompt 模块化系统**：
    - PromptComposer 按需组合 7 个独立模块
    - PromptComposerAdapter 桥接现有调用方
    - 用户自定义模板优先，初始化失败自动回退
    - 动态上下文注入（健康状态、告警、预测）
    - 段落级去重和 Token 估算

11. **ReActLoopController 模块化**：
    - 5900+ 行拆分为 8 个独立子模块
    - 增强循环卡死检测（工具模式 + 关键词重叠）
    - 主入口保持对外接口不变

12. **状态机编排层** (NEW v10.0)：
    - StateMachineEngine 核心引擎，声明式状态定义与转换
    - 三大流程统一编排 (ReAct/Alert/Iteration)
    - DegradationIntegration 降级集成，degraded/skipped outcome 特殊处理
    - TracingIntegration 追踪集成，ConcurrencyGuard 并发守卫
    - FeatureFlagManager 特性开关，支持渐进式发布
    - 适配器层零侵入桥接现有服务
    - fast-check 属性测试验证正确性

### 11.2 设计原则

- **最小侵入**：通过包装器模式扩展现有功能，不破坏原有逻辑
- **向后兼容**：新功能可选启用，禁用时回退到原有流程
- **知识检索一次**：避免重复检索，提高性能
- **并发安全**：使用执行上下文隔离请求状态，Map 副本避免共享引用
- **可观测性**：完善的日志、指标、追踪和审计记录
- **渐进式发布**：支持 rolloutPercentage 灰度发布
- **配置热更新**：配置变更无需重启服务
- **能力独立开关**：所有智能进化能力支持独立启用/禁用
- **声明式编排**：状态机流程通过声明式定义描述，Handler 可插拔注册

### 11.3 版本历史

| 版本 | 日期       | 主要变更                                                                                                                                                                                                                                     |
|------|------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 10.0 | 2026-03-02 | 新增状态机编排层 (StateMachine Orchestration Layer)：StateMachineEngine 核心引擎、StateRegistry 注册表、StateExecutor 执行器、ContextManager 上下文管理、DegradationIntegration 降级集成、TracingIntegration 追踪集成、ConcurrencyGuard 并发守卫、FeatureFlagManager 特性开关；三大流程定义 (ReAct/Alert/Iteration)；适配器层桥接现有服务；30+ 文件，含属性测试 |
| 9.0  | 2026-02-22 | 深度代码复盘：确认全部代码无语法错误、无逻辑链断裂、无无限循环/积压风险；更新代码统计（266 后端文件, 156 AI-Ops 服务, 56 前端视图）；补充 IterationLoop 详细架构说明；完善 IntentDrivenExecutor 流程细节 |
| 8.0  | 2026-02-20 | 增加 Scheduler 调度器服务；增加 HealthReportService 健康报告；优化 FastPathRoute (补充了文档类型内容感知降级)；多租户与设备会话持久化安全修复；                                                                                                |
| 7.0  | 2026-02-07 | 分离通知引擎，集成 AlertPreprocessor；增加 并行请求熔断和反馈，UI/路由解耦。                                                                                                                                                                 |
| 6.0  | 2026-02-07 | 新增 Prompt 模块化系统（PromptComposer + 7 个独立模块 + PromptComposerAdapter 适配层）；ReActLoopController 模块化拆分为 8 个子模块；增强循环卡死检测（工具模式 + 关键词重叠）；移除 TemplateCache 模块（detailScrubber/intentTagExtractor/templateCache/templateMatcher/templateExecutor）和 ReactAgent/DegradationConfig 死代码 |
| 5.0  | 2026-02-06 | 新增持续学习协调器 (ContinuousLearner)、工具反馈收集器 (ToolFeedbackCollector)、FaultHealer 进化增强、PatternLearner 最佳实践提升                                                                                                            |
| 4.0  | 2026-02-04 | 新增智能进化系统（健康监控、异常预测、主动巡检、模式学习、意图解析、知识图谱、分布式追踪、错误处理、降级管理）                                                                                                                               |
| 3.0  | 2026-02-03 | 新增并行执行系统（ParallelExecutor、DependencyAnalyzer、CircuitBreaker）                                                                                                                                                                     |
| 2.0  | 2026-01-20 | 新增 Skill 系统、RAG 增强、Fast Path                                                                                                                                                                                                         |
| 1.0  | 2026-01-15 | 初始版本，基础告警处理流水线                                                                                                                                                                                                                 |
