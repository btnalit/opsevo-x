# OODA 循环能力清单

> ⚠️ **迁移说明 (2026-03-18)**：本文档基于 RouterOS 单设备场景编写。
> Opsevo-x 正在向泛化 AIOps 框架演进，设备操作将通过 DeviceDriver 插件体系实现，
> 意图系统将从 RouterOS 专用命令扩展为设备无关的通用意图。
> 新架构设计请参阅 `.kiro/specs/aiops-brain-evolution/design.md`。
>
> 本文档中的 OODA 循环逻辑、Brain 工具、感知缓存、验证闭环、知识提炼等核心机制仍然有效，
> 但以下内容将随架构演进更新：
> - **79 个 RouterOS 意图** → 迁移至 DeviceDriver 插件提供的设备无关意图
> - **RouterOS 命令白名单** → 迁移至 DeviceDriver 能力声明
> - **DevicePool / RouterOSClient** → 迁移至 DeviceManager + DeviceDriver 插件

> 基于 `AutonomousBrainService` 当前实现，最后更新：2026-03-10
> 
> **优化版本**：已完成 4 大架构优化（意图语义路由、感知缓存层、强制验证闭环、知识提炼器）

## 架构概览

Brain 是 Opsevo 的 Tier 0 全局指挥中心，以 OODA（观察-定向-决策-行动）循环为核心运行模式。每次 tick 是一个自包含的决策单元，由 `ReActLoopController` 驱动 LLM 进行多步推理和工具调用。

```
┌──────────────────────────────────────────────────────────────────────┐
│                         tick() 主循环（优化后）                        │
│                                                                        │
│  OBSERVE ────→ ORIENT ─────→ DECIDE ──→ ACT ──────→ LEARN            │
│  gatherContext   buildPrompt    ReActLoop  brainTools   activeWrite    │
│  (PerceptionCache (IntentSemantic (LLM推理   (12工具     (Knowledge    │
│   6源+缓存优先)   Router≤20意图)  +验证闭环)  +降级引导)  Distiller)   │
└──────────────────────────────────────────────────────────────────────┘
```

### 优化前后对比

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| Prompt 注入意图数 | 全部 79 个 | 按场景路由 ≤20 个 |
| schedule Tick OBSERVE 耗时 | ~5 秒（实时拉取） | <100ms（缓存读取） |
| 中高风险操作验证 | 被动式（LLM 可忽略） | 系统级强制（2 步内未验证自动执行） |
| 知识写入 | 仅夜间巩固 | P0/P1 主动写入 + 夜间提炼巩固 |
| Brain 工具数 | 11 个 | 12 个（+list_intent_categories） |

---

## 一、触发机制

| 触发类型 | 说明 |
|---------|------|
| `schedule` | 定时轮询（可配置间隔，最少 1 分钟） |
| `critical_alert` | 告警引擎推送紧急事件，唤醒大脑 |
| `decision_pending` | 决策引擎有待决事项 |
| `manual` | 人工手动触发 |

保护机制：
- 互斥锁（`isTickRunning`）防止并发 tick
- 冷却期 + 紧急补偿 tick（冷却期内的紧急事件排队，冷却结束后补偿执行）
- 冷却期内去重（相同 `reason:payload` 哈希不重复写入收件箱）
- Token 预算硬阻断（schedule tick 超预算时跳过，告警/手动不受限）
- 会话轮换（每 20 次 tick 重置 sessionId，防止上下文膨胀）
- 优雅停止（`isStopping` 标志，gatherContext 后和 ReAct 循环前两次检查）

---

## 二、OBSERVE（观察）— gatherContext + PerceptionCache

### 感知缓存层（优化新增）

`PerceptionCache` 将感知层与决策层解耦，后台守护进程以 30 秒间隔持续预热缓存，使 schedule Tick 的 OBSERVE 阶段从 ~5s 降至 <100ms。

```
┌─────────────────────────────────────────────────────────────┐
│  PerceptionDaemon（后台守护进程，30s 轮询）                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │HealthMon │ │AlertEng  │ │DecisionEng│ │AnomalyPred│ ...  │
│  └────┬─────┘ └────┬─────┘ └────┬──────┘ └────┬──────┘      │
│       └────────────┴────────────┴─────────────┘              │
│                         ↓ set()                               │
│              ┌─────────────────────┐                          │
│              │  PerceptionCache    │ ← cache:updated 事件     │
│              │  (Memory / Redis)   │                          │
│              └─────────┬───────────┘                          │
│                        ↓ get() + isFresh()                    │
│              ┌─────────────────────┐                          │
│              │  gatherContext()    │                           │
│              └─────────────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

**缓存策略**：
- `schedule` 触发：所有感知源优先读缓存，缓存不新鲜（>60s）时回退实时采集
- `critical_alert` 触发：告警源（alertEngine）强制实时采集，其他源可用缓存
- `manual` / `decision_pending` 触发：全部实时采集
- 守护进程崩溃自动重启（最多 3 次），超过后停止并通过 `send_notification` 告警

### 6 个感知源

`Promise.allSettled` 并行采集，每个 5 秒超时，互不阻断：

| 感知源 | 数据 | 说明 |
|--------|------|------|
| **DeviceManager** | `managedDevices[]` | 跨租户发现所有受管设备（`getDevices('*', { allowCrossTenant: true })`），tenantId 三级补全（DevicePool → DB → 排除无法确定的设备） |
| **连通性探测** | `reachable` / `unreachableReason` | 对每台设备做 tick 级可达性快照，带重试（最多 2 次），5 秒超时，复用 DevicePool 已有连接 |
| **HealthMonitor** | `systemHealth` (CPU/内存/磁盘/接口) | 多设备并行采集指标（`parallelCollectWithLimit`），聚合为平均值；无受管设备时回退全局客户端 |
| **AlertEngine** | `activeAlerts[]` | 多设备并行 + 全局告警合并去重 + 孤儿告警过滤（stale deviceId 不属于当前受管设备） |
| **DecisionEngine** | `pendingDecisions[]` | 未执行的待决决策（最多 10 条） |
| **AnomalyPredictor** | `anomalyPredictions[]` | 异常预测（类型/置信度/趋势/建议动作） |
| **KnowledgeGraph** | `topologySummary` + `freshnessMs` | 网络拓扑节点/边数 + 新鲜度标记（FRESH/STALE） |
| **PatternLearner** | `detectedPatterns[]` | 操作模式识别（按置信度排序，top 10） |

附加采集：
- **感知健康度摘要**（`perceptionSummary`）：统计各感知源成功/失败/耗时，降级时明确告知 LLM "数据可能不完整"
- **进化子模块状态**（`recentEvolutionEvents`）：PatternLearner 统计、AnomalyPredictor 高置信度预测数、ContinuousLearner 定时器状态

### 守护进程感知源注册

`_registerPerceptionSources()` 在 `start()` 时注册 6 个感知源到 `PerceptionCache`，每个源的采集逻辑与 `gatherContext()` 中的 `collect*` lambda 保持一致。守护进程采集时通过 `getLatestDevices()` 动态获取最新设备列表（不依赖上一次 tick 的缓存），连续失败超过 3 次时升级为系统告警并清空缓存设备列表。

---

## 三、ORIENT（定向）— buildPrompt + IntentSemanticRouter

构建 LLM 系统提示词，包含：

### 安全策略
- **绝对白名单制**：禁止生成原始 RouterOS 命令，只能通过 `execute_intent` 调用已注册意图
- 所有已注册意图及其参数、风险等级、审批要求在 prompt 中列出

### 意图语义路由（优化新增）

优化前 `buildPrompt` 一次性注入全部 79 个意图，导致 Token 浪费和 LLM 注意力稀释。优化后通过 `_resolveIntentCategories()` 根据触发场景动态选择意图类别，每次 Tick 仅注入 ≤20 个相关意图。

**7 个意图类别**：

| 类别 | 描述 | 风险范围 |
|------|------|---------|
| `network_query` | 网络状态查询（接口、IP、ARP、连接等只读操作） | low |
| `firewall_ops` | 防火墙规则管理（过滤、NAT、地址列表的增删改查） | low ~ critical |
| `system_config` | 系统配置变更（DNS、NTP、队列、IP 地址等中风险操作） | medium |
| `system_danger` | 高危系统操作（重启、关机、重置配置、系统升级） | critical |
| `dhcp_dns` | DHCP/DNS 配置与租约管理 | low ~ medium |
| `monitoring` | 系统监控与健康检查（资源、日志、健康状态等只读操作） | low |
| `routing` | 路由表管理（静态路由增删） | medium ~ high |

**场景→类别映射规则**（`_resolveIntentCategories`）：

| 触发场景 | 注入类别 |
|---------|---------|
| `critical_alert` + 防火墙相关 | `firewall_ops`, `network_query`, `monitoring` |
| `critical_alert` + 接口相关 | `network_query`, `system_config`, `monitoring` |
| `critical_alert` + DHCP/DNS 相关 | `dhcp_dns`, `network_query`, `monitoring` |
| `critical_alert` + 路由相关 | `routing`, `network_query`, `monitoring` |
| `critical_alert` + 通用 | `network_query`, `monitoring`, `system_config` |
| `decision_pending` | `network_query`, `monitoring` + 根据待决决策内容动态追加 |
| `schedule`（无活跃告警） | `monitoring`, `network_query` |
| `manual` | 全部 7 个类别（用户手动触发，不限制） |

**降级保护**：过滤后意图为空时回退到全量注入（`getIntentSummaryForPrompt()`）。

**未注入意图的优雅降级**：当 LLM 请求执行未注入到当前 Prompt 的意图时，`execute_intent` 工具返回引导信息（而非直接拒绝），告知该意图存在但未在当前上下文加载，并建议调用 `list_intent_categories` 工具查看所有可用类别。

### P0-P4 优先级决策框架

| 优先级 | 场景 | 工具链 |
|--------|------|--------|
| **P0 事件响应** | 活跃告警 > 0 | manage_knowledge(search) → execute_intent(查询) → query_topology(爆炸半径) → invoke_skill(修复) → send_notification |
| **P1 预测防御** | 异常置信度 > 0.7 | execute_intent(验证指标) → read_analysis_report(历史) → propose_decision_rule(自动化) → send_notification |
| **P2 常规基线** | 定时无告警 | execute_intent(系统资源+接口) → compare_state(漂移) → read_analysis_report(趋势) → extract_pattern(模式) |
| **P3 知识进化** | 检测到模式/重复故障 | manage_knowledge(搜索+补充) → propose_decision_rule(编码规则) → invoke_skill(优化) |
| **P4 编排通信** | 待决决策/复杂修复 | send_notification → trigger_state_machine_flow → invoke_skill(动态列表) |

### 硬规则 (HR-1 ~ HR-6)
- HR-1: 安全 — 禁止原始命令
- HR-2: 新鲜度 — 拓扑超 30 秒必须刷新
- HR-3: 验证 — 修复后必须验证
- HR-4: 学习 — 重要发现写入知识库
- HR-5: 效率 — 同一 tick 不重复查询
- HR-6: 设备路由 — 单设备可省略 deviceId，多设备必须指定（ROUTE_A 模糊匹配 + ROUTE_B 自动注入）

### 动态注入
- **Skill 列表**：每次 buildPrompt 从 `skillManager.listSkills({ enabled: true })` 动态获取，格式 `name: description`
- **Intent 列表**：从 `intentRegistry` 动态获取，**按场景类别过滤后注入**（`getIntentSummaryForPromptFiltered`），Prompt 头部标注当前注入的类别标签
- **Prompt 截断**：可变内容超 4000 字符时按优先级逐级截断（patterns → predictions → alerts → 硬截断）

---

## 四、DECIDE & ACT（决策与行动）— ReActLoopController + brainTools + VerificationLoop

### 12 个 Brain 工具

| # | 工具名 | 功能 | 风险 |
|---|--------|------|------|
| 1 | `execute_intent` | 通过白名单意图操作 RouterOS 设备（含未注入意图优雅降级） | 按意图分级 |
| 2 | `invoke_skill` | 调用专家技能（动态列表） | 低 |
| 3 | `read_analysis_report` | 读取历史分析报告（按日期范围，单次最多 7 份） | 低 |
| 4 | `compare_state` | 对比两个健康快照，生成结构化 diff（深度递归比较） | 低 |
| 5 | `trigger_state_machine_flow` | 触发/干预状态机工作流 | 中 |
| 6 | `trigger_alert_pipeline` | 注入合成事件触发告警流水线 | 中 |
| 7 | `extract_pattern` | 命令 PatternLearner 分析操作模式 | 低 |
| 8 | `propose_decision_rule` | 向 DecisionEngine 提审决策规则 | 中 |
| 9 | `query_topology` | 查询网络拓扑节点依赖关系 | 低 |
| 10 | `manage_knowledge` | 知识库 CRUD（增删改查） | 低 |
| 11 | `send_notification` | 推送通知给管理员（前端推送 / 邮件 / 企业微信 Webhook），按 severity 自动过滤渠道 | 低 |
| 12 | `list_intent_categories` | **（新增）** 列出所有 7 个意图类别及描述，供 LLM 发现未注入的意图类别 | 低 |

### 已注册意图（Intent Registry）— 79 个

每个意图携带 `category: IntentCategory[]` 字段，支持按场景按需注入。

**查询类（低风险，自动执行）— 45 个：**

`query_interfaces` `query_interface_detail` `query_ip_addresses` `query_routes` `query_firewall_filter` `query_firewall_nat` `query_dns` `query_dhcp_leases` `query_system_resource` `query_system_identity` `query_arp_table` `query_bridge_hosts` `query_active_connections` `query_logs` `query_queue` `query_system_state` `query_system_resources` `query_health_snapshot` `query_status` `query_system_health` `query_system_clock` `query_system_routerboard` `query_system_license` `query_firewall_address_list` `query_firewall_mangle` `query_firewall_raw` `query_dhcp_server` `query_dhcp_network` `query_ip_pools` `query_neighbors` `query_bridge_ports` `query_bridge_vlans` `query_vlan_interfaces` `query_wireless` `query_wireless_clients` `query_ppp_active` `query_hotspot_active` `query_snmp` `query_ntp` `query_users` `query_scheduler` `query_scripts` `query_certificates` `query_ip_services` `query_traffic`

**配置类（中风险，自动执行）— 16 个：**

`add_firewall_rule` `add_static_route` `modify_queue` `add_address_list_entry` `set_dns_server` `modify_firewall_rule` `modify_nat_rule` `add_nat_rule` `add_dhcp_lease` `remove_dhcp_lease` `set_interface_comment` `set_ntp_server` `add_queue` `remove_queue` `add_ip_address` `remove_ip_address`

**运维类（高风险，需审批）— 12 个：**

`disable_interface` `enable_interface` `remove_firewall_rule` `remove_nat_rule` `disable_firewall_rule` `remove_route` `enable_firewall_rule` `disable_nat_rule` `enable_nat_rule` `flush_dns_cache` `flush_arp_table` `disconnect_ppp`

**危险类（critical，强制审批）— 6 个：**

`system_reboot` `system_shutdown` `system_reset_config` `system_backup` `system_update` `remove_address_list_entry`

### 意图安全机制
- ROUTE_A：LLM 提供 deviceId → 精确匹配 + 模糊匹配建议（Levenshtein 距离）
- ROUTE_B：LLM 未提供 deviceId → 单设备自动注入 / 多设备拒绝并返回设备列表
- 高风险意图需人工审批（前端弹窗确认）
- 连通性预检（执行前检查设备连接状态）
- 结构化错误码（`IntentErrorCode`）：`UNKNOWN_INTENT` / `DEVICE_DISCONNECTED` / `TIMEOUT` / `AUTH_FAILURE` / `FORBIDDEN` 等，供反思系统直接分类

### 系统级强制验证闭环（优化新增）

优化前的 `INTENT_VERIFICATION_MAP` 是被动式验证，LLM 可以忽略验证结果。优化后升级为系统级强制验证：

**执行流程**：
1. `executeIntent()` 执行 medium+ 风险意图成功后，从 `VERIFICATION_DIRECTIVE_TEMPLATES`（30 个模板）生成 `verification_directive` 并附加到 `IntentResult`
2. `ReActLoopController` 检测到 `verification_directive` 后，注入系统消息 `[SYSTEM VERIFICATION REQUIRED]`，要求 LLM 执行验证查询
3. 如果 LLM 在 2 个推理步骤内未执行验证，`ReActLoopController` 自动执行验证查询（`executeRegisteredIntent`）
4. 验证结果不匹配时，注入 `[VERIFICATION FAILED]` 警告消息，要求 LLM 分析原因并决定是否回滚
5. LLM 主动执行验证时，注入 `[VERIFICATION COMPLETE]` 提示，要求分析结果是否满足期望条件

**`VerificationDirective` 结构**：
```typescript
{
    verify_action: string;       // 验证用的查询意图名
    verify_params: Record<string, unknown>; // 查询参数（从原始操作参数派生）
    expected_condition: string;  // 预期结果描述（自然语言，供 LLM 判断）
    timeout_ms: number;          // 验证超时（8000~30000ms）
}
```

**审批后验证**：`grantPendingIntent()` 执行成功后，独立触发验证并将结果通过 `pushNote` 推送给大脑，使用与 `executeIntent` 相同的 `VERIFICATION_DIRECTIVE_TEMPLATES`。

---

## 五、LEARN（学习）— 双轨记忆模型 + KnowledgeDistiller

### 短期记忆
- **Notes**（收件箱）：每次 tick 消费一次性笔记，下次 tick 清空，防止 LLM 对陈旧事件幻觉
- **Episodic Memory**（情景记忆）：工具调用摘要、重要发现，上限 100 条
  - 相似事件合并（前 50 字符匹配 + 同 source → 递增 verificationCount）
  - 时间衰减（`DECAY_FACTOR_PER_HOUR = 0.98`，验证次数越多衰减越慢）
  - 低于 `FORGET_THRESHOLD = 0.1` 的记忆被遗忘

### 长期记忆
- **夜间巩固**（凌晨 3 点 cron）：频次 ≥ 5 且权重 > 0.5 的情景记忆 → **先经 KnowledgeDistiller 提炼** → 固化到 KnowledgeBase（LanceDB/BM25）
- **ContinuousLearner**：自动记录每次工具调用的成功/失败（基于 observation 的实际 success 状态），驱动策略评估和最佳实践提升
- **Ongoing Investigations**：追踪活跃告警 ID，告警消失时自动移除（上限 50 条）

### 主动知识写入（优化新增）

`KnowledgeDistiller` 提供两条写入路径：

**路径 1 — 主动写入（`activeWrite`）**：
- 触发条件：P0（`critical_alert`）或 P1（`decision_pending`）场景，且至少 1 个成功工具调用
- 每次 Tick 最多执行 1 次（限流）
- 写入结构化因果分析条目（`CausalAnalysisEntry`）：
  ```
  trigger → root_cause → actions_taken → outcome → prevention
  ```
- 标签：`source: "brain-active-write"`
- 精确匹配成功操作：将 action 与紧随其后的 observation 关联，仅 `observation.success === true` 的 action 计入；并行执行场景通过 `MergedObservation.results` 数组精确匹配每个 action 的独立成功状态
- 失败补偿：写入失败时记录到情景记忆，下次巩固周期补偿

**路径 2 — 巩固提炼（`distillEpisode` + `mergeAndDeduplicate`）**：
- 夜间巩固前对待固化记忆调用 LLM 提炼，浓缩为结构化知识条目（`KnowledgeEntry`）：
  ```
  title → summary → detailedSteps → applicableScenarios → caveats
  ```
- 去重策略：从 title 提取触发类型 + 排序后的工具名列表作为分组键（`trigger:toolA,toolB`），同组保留 `detailedSteps` 最长的条目，合并 `caveats`
- 通过 `episodeId` 精确映射提炼结果与原始 episode（防止 `mergeAndDeduplicate` 乱序导致错配）
- 标签：`source: "brain-consolidation"`

### Token 预算管理
- 每次 tick 估算 token 消耗（迭代数 × 2000 + 工具调用数 × 300）
- 日预算超限时 schedule tick 被阻断，告警/手动触发不受限
- 每日零点重置

---

## 六、自愈与降级

| 场景 | 处理方式 |
|------|---------|
| 感知源超时/失败 | `Promise.allSettled` 隔离，降级数据标记为 -1，perceptionSummary 告知 LLM |
| 感知缓存不新鲜 | `isFresh()` 检测后自动回退到实时采集（现有逻辑） |
| 感知守护进程崩溃 | 自动重启（最多 3 次），超过后停止守护进程并通过 `send_notification` 告警操作员 |
| 守护进程 DeviceManager 不可用 | 降级到缓存设备列表，连续失败 ≥3 次升级为系统告警并清空缓存 |
| 设备不可达 | 连通性探测标记 ❌，prompt 指示 LLM 不对该设备调用 execute_intent |
| 设备 tenantId 无法确定 | DevicePool + DB 均无 tenantId 时排除该设备（不展示错误的 tenantId） |
| RouterOS 连接断开 | 多设备：DevicePool 自动重连；单设备：`ensureConnectedOrReconnect()` 自愈 |
| 意图类别过滤为空 | 回退到全量注入（`getIntentSummaryForPrompt()`） |
| LLM 请求未注入意图 | 返回引导信息 + `list_intent_categories` 提示（非直接拒绝） |
| 验证查询超时/失败 | 注入警告消息告知 LLM，不阻断 Tick |
| 验证模板缺失 | 跳过验证（降级），记录警告日志 |
| 主动知识写入失败 | 记录到情景记忆，下次巩固周期补偿 |
| SkillManager 不可用 | catch 降级 + pushNote 通知大脑子系统离线 |
| tick 异常 | catch 记录错误 + pushNote，下次 tick 自然恢复 |
| 孤儿告警（设备已删除） | collectAlertEngine 过滤 stale deviceId（仅多设备模式生效） |
| 配置变更禁用大脑 | configChangeListener 自动 stop() |

---

## 七、意识流（Thinking Events）

Brain 在每个 OODA 阶段发射结构化事件，供前端全息座舱实时展示：

| 阶段 | 事件内容 |
|------|---------|
| `observe` | 感知启动、感知完成统计（告警/预测/模式数）、感知健康度摘要（传感器降级状态） |
| `orient` | 认知阶段启动 |
| `decide` | LLM 推理步骤（去重：跳过与上一条完全相同的 thought）、决策完成耗时/迭代数 |
| `act` | 每个工具调用 ✅/❌ + 参数摘要（justification 截断保护）+ 耗时、工具返回结果/错误（基于 observation 的实际 success 状态） |
| `learn` | 学习闭环统计（成功/失败数，基于 observation 实际状态） |
| `error` | OODA 循环异常 |

---

## 八、关键文件索引

| 文件 | 职责 |
|------|------|
| `autonomousBrainService.ts` | OODA 主循环、gatherContext、buildPrompt、LEARN 阶段、感知缓存集成 |
| `intentRegistry.ts` | 意图注册表、类别系统、验证指令模板、executeIntent、审批流程 |
| `brainTools.ts` | 12 个 Brain 工具定义、未注入意图优雅降级、setCurrentInjectedCategories |
| `perceptionCache.ts` | 感知缓存层、后台守护进程、缓存新鲜度判断 |
| `knowledgeDistiller.ts` | 知识提炼器、主动写入、巩固提炼、去重合并 |
| `reactLoopController.ts` | ReAct 推理循环、验证闭环（directive 注入 + 自动执行） |
