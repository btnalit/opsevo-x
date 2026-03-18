/**
 * ReActLoopController - ReAct 循环控制器
 * 
 * 管理 Thought → Action → Observation 循环，实现多步骤推理
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 * - 2.1: 进入 ReAct 循环，生成 Thought
 * - 2.2: 选择并执行 Action，工具名称和参数由 LLM 决定
 * - 2.3: 将 Observation 反馈给 LLM
 * - 2.4: 由 LLM 评估是否需要继续循环
 * - 2.5: 问题已解决或达到最大迭代次数时生成 Final Answer
 * - 2.6: 记录完整的推理轨迹
 * 
 * 智能知识应用系统集成:
 * - 8.1: 使用 IntelligentRetriever 替代简单的 knowledge_search
 * - 8.2: 集成 OutputValidator 进行输出验证
 * - 9.4: 实现修正重试逻辑（最多 2 次）
 * 
 * Prompt 模板管理集成:
 * - 支持从 PromptTemplateService 动态获取提示词模板
 * - 支持模板热更新，无需重启服务
 */

import { logger } from '../../../utils/logger';
import { ReActStep, ReActStepType, IntentAnalysis, RAGContext, RAGDocument, EnhancedIntentAnalysis, QuestionType, FailureAnalysis, ModifiedParams, FailureType, ParamModification } from '../../../types/ai-ops';
import { IAIProviderAdapter, ChatMessage, ChatRequest, AIProvider } from '../../../types/ai';
import { AgentTool, ConversationMemory } from './mastraAgent';
import { IntelligentRetriever, intelligentRetriever } from './intelligentRetriever';
import { OutputValidator, outputValidator } from './outputValidator';
import { UsageTracker, usageTracker } from './usageTracker';
import { ToolOutputSummarizer } from './toolOutputSummarizer';
import { PromptBuilder, promptBuilder } from './promptBuilder';
import { FormattedKnowledge, TrackedKnowledgeReference } from './types/intelligentRetrieval';
// 并行执行组件导入 (Requirements: 1.1, 4.1, 2.1)
import { ExecutionMode, ModeSelectionResult, ToolCallBatch, MergedObservation, FallbackState, FallbackInfo } from '../../../types/parallel-execution';
import { ParallelExecutor, parallelExecutor } from './parallelExecutor';
import { AdaptiveModeSelector, adaptiveModeSelector } from './adaptiveModeSelector';
import { ExecutionPlanner, executionPlanner } from './executionPlanner';
import { ParallelExecutionMetricsCollector, parallelExecutionMetrics } from './parallelExecutionMetrics';
// 智能进化系统组件导入 (Requirements: 1.1.1, 1.1.2, 1.1.3)
import { getCapabilityConfig, isCapabilityEnabled } from '../evolutionConfig';
import { criticService } from '../criticService';
import { reflectorService } from '../reflectorService';
import { auditLogger } from '../auditLogger';
// 经验管理集成导入 (Requirements: 1.1, 1.2, 1.3)
import { feedbackService, ExperienceEntry } from '../feedbackService';
// 工具反馈闭环集成导入 (Requirements: 2.1, 2.2, 2.4)
import { toolFeedbackCollector } from '../toolFeedbackCollector';
// 持续学习集成导入 (Requirements: 5.1, 5.6)
import { continuousLearner } from '../continuousLearner';
// 意图驱动自动化集成导入 (Requirements: 6.1, 6.2, 6.3, 6.4)
import { intentParser, ParsedIntent } from '../intentParser';
// Prompt 模板服务导入
import { promptTemplateService } from '../../ai/promptTemplateService';
// Prompt 模块化系统导入 (Requirements: 1.7, 1.8, 1.9, 5.2)
import { createPromptComposerAdapter } from '../prompt';
import { RelevanceScorer } from '../../ai/relevanceScorer';

// Action 选择与 LLM 输出解析模块（从 RALC 拆分）
import { parseLLMOutput as parseLLMOutputFn, ParsedLLMOutput, extractBalancedJson as extractBalancedJsonFn, parseActionInput as parseActionInputFn, extractFallbackKeyValues as extractFallbackKeyValuesFn } from './llmOutputParser';
import { ActionSelector } from './actionSelector';
// 中间件管道系统 (Requirements: 1.1-1.8, 2.1-2.6, 3.1-3.6, 4.1-4.6)
import { MiddlewarePipeline } from './middleware/middlewarePipeline';
import { ToolCorrectionMiddleware } from './middleware/toolCorrectionMiddleware';
import type { ReActMiddleware, MiddlewareCorrection, MiddlewareContext } from './middleware/types';
// 操作后自我验证：使用动态导入避免循环依赖
// reactLoopController → intentRegistry → autonomousBrainService → reactLoopController
import type { IntentParams } from '../brain/intentRegistry';

// ==================== 提示词模板 ====================

/**
 * 提示词模板名称常量
 * 用于从 PromptTemplateService 获取模板
 */
const TEMPLATE_NAMES = {
  REACT_LOOP: 'ReAct 循环基础提示词',
  KNOWLEDGE_FIRST: '知识优先 ReAct 提示词',
  PARALLEL: '并行执行 ReAct 提示词',
} as const;

/**
 * ReAct 循环提示词模板
 * 用于指导 LLM 进行 Thought → Action → Observation 循环
 * 注意：此为回退模板，优先从 PromptTemplateService 获取
 */
const REACT_LOOP_PROMPT = `你是一个 MikroTik RouterOS 网络设备运维助手，使用 ReAct 方法解决问题。

## 设备信息
- 设备类型: MikroTik RouterOS
- 系统版本: RouterOS 7.x（具体版本可通过 monitor_metrics 获取）
- API 协议: RouterOS API（不是 SSH/CLI）

## RouterOS API 命令格式说明
RouterOS API 使用路径格式，不是 CLI 命令格式：
- 正确格式: /interface, /ip/address, /routing/ospf/instance
- 错误格式: show ip route, /interface print（不要加 print，API 会自动添加）

常用 RouterOS 7.x API 路径：
- 接口: /interface
- IP 地址: /ip/address
- 路由表: /ip/route
- OSPF 实例: /routing/ospf/instance
- OSPF 邻居: /routing/ospf/neighbor
- BGP: /routing/bgp/connection
- 系统资源: /system/resource
- 系统包: /system/package

## ⚠️ 【分批处理协议】- 防止数据截断

作为智能 Agent，你必须意识到 LLM 的上下文窗口是有限的。当使用工具查询数据时，如果预期返回的数据量巨大，**绝对不能**尝试一次性获取所有数据。

### 必须严格执行以下协议：

1. **探测总量优先**：在深入分析前，先确认数据规模
   - 对于可能返回大量数据的路径，先使用 count 或 limit=1 探测
   - 例如：先查询 /ip/firewall/filter 的规则数量，再决定是否分批

2. **强制分页查询**：
   - 使用 proplist 参数限制返回字段，减少数据量
   - 使用 limit 参数限制返回条数（建议每批 20-50 条）
   - 使用 offset 参数进行分页（如 offset=0, offset=50, offset=100...）
   - **严禁**对大数据量路径使用不带限制的查询

3. **迭代处理模式**：
   - 获取第一批数据 → 分析并提炼要点 → 记住关键信息
   - 获取第二批数据 → 分析并提炼要点 → 合并新要点
   - 重复直到数据取完或已获得足够信息

4. **截断检测与恢复**：
   - 如果观察到输出被截断（显示"...[数据已截断]"），立即停止当前操作
   - 改用更小的 limit 或更精确的 proplist 重新查询
   - 不要基于截断的数据做出结论

### 分批查询示例：

**错误示范 ❌：**
Thought: 用户想查看所有防火墙规则
Action: device_query
Action Input: {"command": "/ip/firewall/filter"}
（后果：可能返回数百条规则，导致数据截断）

**正确示范 ✅：**
Thought: 用户想查看防火墙规则。这可能包含大量数据，我需要分批处理。先获取前20条规则。
Action: device_query
Action Input: {"command": "/ip/firewall/filter", "proplist": "chain,action,src-address,dst-address,comment", "limit": 20}

（获取下一批时）
Thought: 已获取前20条规则，继续获取下一批。
Action: device_query
Action Input: {"command": "/ip/firewall/filter", "proplist": "chain,action,src-address,dst-address,comment", "limit": 20, "offset": 20}

用户请求：{{message}}

可用工具（包含参数说明）：
{{tools}}

之前的步骤：
{{steps}}

请思考下一步行动。如果问题已解决，输出最终答案。

格式要求：
- 如果需要继续，输出：
  Thought: 你的思考过程（必须具体说明要做什么，不要重复之前的思考）
  Action: 工具名称
  Action Input: {"参数名": "具体值", ...}

- 如果问题已解决，输出：
  Thought: 总结思考
  Final Answer: 最终回答

重要规则：
1. 每次只能选择一个工具执行
2. Action 必须是可用工具列表中的工具名称
3. Action Input 必须是有效的 JSON 格式，必须包含所有必需参数
4. 如果之前的工具调用失败（显示"执行失败"），分析失败原因：
   - 如果是 "no such command"，说明路径不对，尝试其他路径
   - 如果是缺少参数，补充正确的参数重试
   - 不要重复使用相同的错误参数调用同一工具
5. device_query 用于只读查询，execute_command 用于写入/执行操作（如删除、添加、修改、脚本执行）
6. device_query 和 execute_command 的 command 参数是 RouterOS API 路径，例如：{"command": "/interface"}, {"command": "/routing/ospf/instance"}
7. 需要执行清理、删除、添加、修改等写操作时，必须使用 execute_command，不要使用 device_query
8. 思考内容必须具体，说明你要查询什么、为什么
9. 回答时使用中文，并基于 RouterOS 的实际情况给出建议
10. **对于可能返回大量数据的查询，必须使用 proplist 和 limit 参数进行分批处理**`;

/**
 * 知识增强模式的 ReAct 提示词
 * 用于指导 LLM 在知识增强模式下优先查询知识库
 * Requirements: 3.1, 3.2, 3.4
 */
const KNOWLEDGE_FIRST_REACT_PROMPT = `你是一个 MikroTik RouterOS 网络设备运维助手，使用 ReAct 方法解决问题。

## 重要：知识优先原则
在处理任何问题之前，你必须首先查询知识库获取历史经验和案例。
知识库中包含了大量的历史告警、修复方案、配置变更记录，这些是宝贵的运维经验。

**如果知识库中有相关的配置方案或处理步骤，请直接参考使用，不要重新发明轮子！**

## 推理步骤
1. **首先**：使用 knowledge_search 工具查询相关的历史案例和经验
2. **然后**：根据知识库结果决定是否需要查询设备状态
3. **最后**：综合知识库经验和设备状态给出建议

## 设备信息
- 设备类型: MikroTik RouterOS
- 系统版本: RouterOS 7.x（具体版本可通过 monitor_metrics 获取）
- API 协议: RouterOS API（不是 SSH/CLI）

## RouterOS API 命令格式说明
RouterOS API 使用路径格式，不是 CLI 命令格式：
- 正确格式: /interface, /ip/address, /routing/ospf/instance
- 错误格式: show ip route, /interface print（不要加 print，API 会自动添加）

## ⚠️ 【分批处理协议】- 防止数据截断

作为智能 Agent，你必须意识到 LLM 的上下文窗口是有限的。当使用工具查询数据时，如果预期返回的数据量巨大，**绝对不能**尝试一次性获取所有数据。

### 必须严格执行以下协议：

1. **探测总量优先**：在深入分析前，先确认数据规模
   - 对于可能返回大量数据的路径，先使用 count 或 limit=1 探测
   - 例如：先查询 /ip/firewall/filter 的规则数量，再决定是否分批

2. **强制分页查询**：
   - 使用 proplist 参数限制返回字段，减少数据量
   - 使用 limit 参数限制返回条数（建议每批 20-50 条）
   - 使用 offset 参数进行分页（如 offset=0, offset=50, offset=100...）
   - **严禁**对大数据量路径使用不带限制的查询

3. **迭代处理模式**：
   - 获取第一批数据 → 分析并提炼要点 → 记住关键信息
   - 获取第二批数据 → 分析并提炼要点 → 合并新要点
   - 重复直到数据取完或已获得足够信息

4. **截断检测与恢复**：
   - 如果观察到输出被截断（显示"...[数据已截断]"），立即停止当前操作
   - 改用更小的 limit 或更精确的 proplist 重新查询
   - 不要基于截断的数据做出结论

### 分批查询示例：

**错误示范 ❌：**
Thought: 用户想查看所有防火墙规则
Action: device_query
Action Input: {"command": "/ip/firewall/filter"}
（后果：可能返回数百条规则，导致数据截断）

**正确示范 ✅：**
Thought: 用户想查看防火墙规则。这可能包含大量数据，我需要分批处理。先获取前20条规则。
Action: device_query
Action Input: {"command": "/ip/firewall/filter", "proplist": "chain,action,src-address,dst-address,comment", "limit": 20}

## RouterOS 7.x API 路径参考

### 基础信息（数据量小，可直接查询）
- 系统资源: /system/resource
- 系统标识: /system/identity
- 系统时钟: /system/clock
- 系统包: /system/package
- 系统健康: /system/health
- 系统许可: /system/license

### 接口相关
- 所有接口: /interface
- 网桥: /interface/bridge
- 网桥端口: /interface/bridge/port
- VLAN: /interface/vlan
- VXLAN: /interface/vxlan
- Bonding: /interface/bonding
- 以太网: /interface/ethernet
- WireGuard: /interface/wireguard
- PPPoE 客户端: /interface/pppoe-client
- PPPoE 服务端: /interface/pppoe-server
- GRE 隧道: /interface/gre
- EoIP 隧道: /interface/eoip
- VETH: /interface/veth
- 接口列表: /interface/list

### IP 相关
- IP 地址: /ip/address
- 路由表: /ip/route
- ARP 表: /ip/arp（⚠️ 可能数据量大，建议使用 limit 参数）
- DNS 设置: /ip/dns
- DNS 缓存: /ip/dns/cache（⚠️ 可能数据量大，建议使用 limit 参数）
- DHCP 服务器: /ip/dhcp-server
- DHCP 租约: /ip/dhcp-server/lease（⚠️ 可能数据量大，建议使用 limit 参数）
- DHCP 客户端: /ip/dhcp-client
- IP 池: /ip/pool
- IP 服务: /ip/service
- 邻居发现: /ip/neighbor

### 防火墙（⚠️ 规则可能很多，必须分批查询）
- Filter 规则: /ip/firewall/filter（建议 limit=20, proplist=chain,action,src-address,dst-address,comment）
- NAT 规则: /ip/firewall/nat（建议 limit=20）
- Mangle 规则: /ip/firewall/mangle（建议 limit=20）
- Raw 规则: /ip/firewall/raw（建议 limit=20）
- 地址列表: /ip/firewall/address-list（建议 limit=50）
- 连接跟踪: /ip/firewall/connection（⚠️ 数据量极大，**禁止直接查询**，必须使用 limit=10 且指定 proplist）

### 路由协议
- OSPF 实例: /routing/ospf/instance
- OSPF 区域: /routing/ospf/area
- OSPF 接口: /routing/ospf/interface-template
- OSPF 邻居: /routing/ospf/neighbor
- OSPF LSA: /routing/ospf/lsa（⚠️ 可能数据量大，建议使用 limit 参数）
- BGP 连接: /routing/bgp/connection
- BGP 会话: /routing/bgp/session
- BGP 模板: /routing/bgp/template
- 路由过滤: /routing/filter/rule
- 路由表: /routing/table

### 队列和 QoS
- 简单队列: /queue/simple
- 队列树: /queue/tree
- 队列类型: /queue/type

### 系统管理
- 计划任务: /system/scheduler
- 脚本: /system/script
- 日志: /log（⚠️ 数据量大，**禁止直接查询**，必须使用 limit=20 且指定 topics 过滤）
- 日志规则: /system/logging
- NTP 客户端: /system/ntp/client
- 用户: /user
- 用户组: /user/group

### 工具
- Netwatch: /tool/netwatch
- 带宽测试服务: /tool/bandwidth-server
- 邮件: /tool/e-mail
- 流量监控: /tool/traffic-monitor
- SNMP: /snmp
- SNMP 社区: /snmp/community

### 容器（RouterOS 7.x）
- 容器列表: /container
- 容器配置: /container/config
- 容器环境变量: /container/envs
- 容器挂载: /container/mounts

### IPv6
- IPv6 地址: /ipv6/address
- IPv6 路由: /ipv6/route
- IPv6 防火墙: /ipv6/firewall/filter
- IPv6 邻居: /ipv6/neighbor
- IPv6 ND: /ipv6/nd
- DHCPv6 客户端: /ipv6/dhcp-client
- DHCPv6 服务器: /ipv6/dhcp-server

### PPP
- PPP 配置文件: /ppp/profile
- PPP 用户: /ppp/secret
- PPP 活动连接: /ppp/active

### 证书和安全
- 证书: /certificate
- IPsec 策略: /ip/ipsec/policy
- IPsec 对等体: /ip/ipsec/peer

## ⚠️ 高危数据路径（必须分批处理）
以下路径可能返回大量数据，**必须使用 limit 和 proplist 参数**：
- /ip/firewall/connection - 连接跟踪表，可能有数万条，**limit=10, proplist=src-address,dst-address,protocol,state**
- /log - 系统日志，可能有数千条，**limit=20, topics=过滤条件**
- /ip/dns/cache - DNS 缓存，可能很大，**limit=50**
- /ip/arp - ARP 表，大型网络可能很大，**limit=50**
- /ip/dhcp-server/lease - DHCP 租约，可能很多，**limit=50**
- /ip/firewall/filter - 防火墙规则，**limit=20**
- /ip/firewall/nat - NAT 规则，**limit=20**
- /ip/firewall/address-list - 地址列表，**limit=50**

**违反分批处理协议将导致数据截断，无法完成分析任务！**

## 知识库使用指引
知识库中的内容包括：
1. **历史告警案例** - 之前发生过的问题及处理方法
2. **配置方案** - 经过验证的配置模板和步骤
3. **最佳实践** - RouterOS 运维经验总结
4. **故障排查** - 常见问题的诊断和解决方法
5. **操作指南** - 包含具体步骤的操作流程（如网络拓扑绘制、故障诊断流程）

**⚠️ 重要：严格按照知识库步骤执行**
当知识库返回包含具体步骤的操作指南时：
- **必须严格按照步骤顺序执行**，不要跳过或修改步骤
- **必须使用知识库中指定的命令和参数**，包括 proplist 参数
- 如果知识库说"使用 /ip/neighbor 并带 proplist=identity,address,interface"，就必须这样执行
- 不要自作主张使用其他命令或省略参数
- 在最终回答中引用知识库来源 [KB-xxx]

**当知识库返回相关内容时**：
- 仔细阅读知识库中的方案和步骤
- 如果方案适用，直接参考执行，不要自己重新设计
- 在最终回答中引用知识库来源

## device_query 工具高级用法
device_query 支持以下参数，用于控制返回数据量：
- proplist: 指定返回字段，减少数据量
  示例：{"command": "/ip/neighbor", "proplist": "identity,address,interface,mac-address"}
- limit: 限制返回条数
  示例：{"command": "/ip/firewall/filter", "limit": 20}
- offset: 分页偏移量
  示例：{"command": "/ip/firewall/filter", "limit": 20, "offset": 20}

**知识库中的步骤如果指定了这些参数，必须使用！**

用户请求：{{message}}

知识库上下文：
{{ragContext}}

可用工具（包含参数说明）：
{{tools}}

之前的步骤：
{{steps}}

请思考下一步行动。记住：如果还没有查询知识库，应该先查询知识库！

格式要求：
- 如果需要继续，输出：
  Thought: 你的思考过程（必须具体说明要做什么，不要重复之前的思考）
  Action: 工具名称
  Action Input: {"参数名": "具体值", ...}

- 如果问题已解决，输出：
  Thought: 总结思考（需要引用知识库中的相关案例）
  Final Answer: 最终回答

重要规则：
1. 每次只能选择一个工具执行
2. Action 必须是可用工具列表中的工具名称
3. Action Input 必须是有效的 JSON 格式，必须包含所有必需参数
4. 如果还没有查询知识库，第一步必须使用 knowledge_search 工具
5. 如果之前的工具调用失败（显示"执行失败"），分析失败原因并尝试其他方法
6. device_query 用于只读查询，execute_command 用于写入/执行操作（如删除、添加、修改、脚本执行）
7. device_query 和 execute_command 的 command 参数是 RouterOS API 路径，例如：{"command": "/interface"}
8. device_query 支持 proplist、limit、offset 参数：{"command": "/ip/firewall/filter", "proplist": "chain,action", "limit": 20}
9. 需要执行清理、删除、添加、修改等写操作时，必须使用 execute_command，不要使用 device_query
10. 思考内容必须具体，说明你要查询什么、为什么
11. 回答时使用中文，并基于知识库经验和 RouterOS 的实际情况给出建议
12. **对于高危数据路径，必须使用 limit 和 proplist 参数进行分批处理**
13. **如果观察到数据被截断，立即改用更小的 limit 重新查询**
14. **优先使用知识库中的方案**，不要重复造轮子
15. **⚠️ 严格遵循知识库步骤**：如果知识库提供了具体的操作步骤，必须严格按照步骤执行，包括使用指定的命令、参数和 proplist

## 知识优先推理示例
Thought: 用户询问接口故障问题，我需要先查询知识库看是否有类似的历史案例和处理经验。
Action: knowledge_search
Action Input: {"query": "接口故障 处理经验"}

## 分批处理示例
Thought: 用户想查看防火墙规则。防火墙规则可能很多，我需要分批获取。先获取前20条 filter 规则。
Action: device_query
Action Input: {"command": "/ip/firewall/filter", "proplist": "chain,action,src-address,dst-address,comment", "limit": 20}

## 遵循知识库步骤示例
假设知识库返回了网络拓扑绘制步骤：
"步骤1: 使用 /ip/neighbor 查询邻居，proplist=identity,address,interface,mac-address"

正确做法：
Thought: 知识库 [KB-xxx] 提供了网络拓扑绘制步骤，步骤1要求查询邻居信息并使用 proplist 参数。我将严格按照步骤执行。
Action: device_query
Action Input: {"command": "/ip/neighbor", "proplist": "identity,address,interface,mac-address"}

错误做法（不要这样做）：
Thought: 我需要查询接口信息来绘制拓扑。
Action: device_query
Action Input: {"command": "/interface"}  // 错误：没有按照知识库步骤执行`;


/**
 * 默认 Thought 提示词（当 LLM 调用失败时使用）
 */
const DEFAULT_THOUGHT = '我需要获取更多信息来解决这个问题。';

/**
 * 并行执行模式的 ReAct 提示词
 * 用于指导 LLM 在并行模式下同时输出多个工具调用
 * Requirements: 1.6 - 并行执行提示词
 */
const PARALLEL_REACT_PROMPT = `你是一个 MikroTik RouterOS 网络设备运维助手，使用 ReAct 方法解决问题。

## 🚀 并行执行模式

你现在处于**并行执行模式**，可以同时执行多个独立的工具调用来提高效率。

### ⚠️ 重要：并行执行格式要求

当你需要同时执行多个独立的工具调用时，**必须严格使用以下编号格式**：

\`\`\`
Thought: 我需要同时获取接口状态和系统资源信息，这两个查询相互独立，可以并行执行。

Action 1: device_query
Action Input 1: {"command": "/interface"}

Action 2: device_query
Action Input 2: {"command": "/system/resource"}
\`\`\`

**格式规则**：
- 使用 "Action 1:", "Action 2:", "Action 3:" 等带编号的格式
- 使用 "Action Input 1:", "Action Input 2:", "Action Input 3:" 等带编号的格式
- 编号必须匹配（Action 1 对应 Action Input 1）
- 每个 Action Input 后面必须是有效的 JSON 对象

### 并行执行规则

1. **识别独立操作**：分析哪些工具调用之间没有数据依赖，可以并行执行
2. **依赖顺序**：如果某个操作依赖另一个操作的结果，必须在后续步骤中执行
3. **最大并行数**：每次最多并行执行 {{maxConcurrency}} 个工具调用

### 何时使用并行执行

✅ 适合并行（请使用编号格式）：
- 查询多个独立的系统状态（接口、路由、资源）
- 同时检查多个配置项
- 批量获取不同类型的信息

❌ 不适合并行（使用单个 Action）：
- 需要前一个结果才能确定下一步的操作
- 修改操作（需要按顺序执行）
- 有明确依赖关系的查询

## 设备信息
- 设备类型: MikroTik RouterOS
- 系统版本: RouterOS 7.x
- API 协议: RouterOS API

## RouterOS API 命令格式
- 正确格式: /interface, /ip/address, /routing/ospf/instance
- 错误格式: show ip route, /interface print

用户请求：{{message}}

可用工具：
{{tools}}

之前的步骤：
{{steps}}

请思考下一步行动。**如果可以并行执行多个独立操作，请务必使用编号格式（Action 1, Action 2...）**。

格式要求：
- 单个工具调用：
  Thought: 思考过程
  Action: 工具名称
  Action Input: {"参数": "值"}

- 多个并行工具调用（必须使用编号）：
  Thought: 思考过程（说明为什么可以并行）
  Action 1: 工具名称
  Action Input 1: {"参数": "值"}
  Action 2: 工具名称
  Action Input 2: {"参数": "值"}

- 问题已解决：
  Thought: 总结思考
  Final Answer: 最终回答`;

// ==================== 配置类型 ====================

/**
 * 知识检索超时常量（毫秒）
 * Requirements: 7.1
 */
const KNOWLEDGE_SEARCH_TIMEOUT = 10000;

/**
 * 并行执行配置块
 * Requirements: 8.5, 8.6 - 并行执行配置
 */
export interface ParallelExecutionConfig {
  /** 是否启用并行执行 */
  enabled: boolean;
  /** 执行模式（auto 表示自适应选择） */
  mode: 'sequential' | 'parallel' | 'planned' | 'auto';
  /** 最大并发工具调用数 */
  maxConcurrency: number;
  /** 批次执行超时（毫秒） */
  batchTimeout: number;
  /** 是否启用计划模式 */
  enablePlanning: boolean;
  /** 计划生成超时（毫秒） */
  planningTimeout: number;
  /** 失败重试次数 */
  retryCount: number;
  /** 是否启用熔断器 */
  enableCircuitBreaker: boolean;
  /** 发布百分比 (0-100)，用于渐进式发布 */
  rolloutPercentage: number;
}

/**
 * ReActLoopController 配置
 */
export interface ReActLoopControllerConfig {
  /** ReAct 最大迭代次数，默认 5 */
  maxIterations: number;
  /** 思考超时时间（毫秒），默认 30000 */
  thoughtTimeout: number;
  /** 单次工具执行超时时间（毫秒），默认 60000 */
  actionTimeout: number;
  /** 是否启用详细日志，默认 false */
  verbose: boolean;
  /** 是否启用知识增强模式，默认 false */
  knowledgeEnhancedMode: boolean;
  /** 知识检索超时时间（毫秒），默认 10000 */
  knowledgeSearchTimeout: number;
  /** 是否启用智能检索，默认 true（知识增强模式下） */
  enableIntelligentRetrieval: boolean;
  /** 是否启用输出验证，默认 true */
  enableOutputValidation: boolean;
  /** 输出验证最大重试次数，默认 2 */
  maxValidationRetries: number;
  /** 是否启用使用追踪，默认 true */
  enableUsageTracking: boolean;
  /** 是否启用智能数据摘要（大数据自动摘要），默认 true */
  enableSmartSummarization: boolean;
  /** 触发智能摘要的数据大小阈值（字符数），默认 5000 */
  smartSummarizationThreshold: number;
  /** 摘要后的目标大小（字符数），默认 1500 */
  summarizedTargetSize: number;
  /** LLM 温度参数，控制输出随机性，默认 0.5 */
  temperature: number;
  /** 重复调用检测时间窗口（毫秒），默认 60000 */
  duplicateDetectionWindowMs: number;
  /** 时间窗口内允许的最大重复调用次数，默认 2 */
  maxDuplicateCallsInWindow: number;
  /** 并行执行配置 (Requirements: 8.5, 8.6) */
  parallelExecution?: ParallelExecutionConfig;
}

/**
 * 循环检测配置
 * Requirements: 7.4 - 循环检测配置
 */
export interface LoopDetectionConfig {
  /** 重复调用检测时间窗口（毫秒） */
  windowMs: number;
  /** 时间窗口内允许的最大重复调用次数 */
  maxDuplicates: number;
}

/**
 * 默认并行执行配置
 * Requirements: 8.5, 8.6
 * 
 * 注意：默认启用并行执行功能，使用自适应模式选择
 * - enabled: true - 功能默认启用
 * - rolloutPercentage: 100 - 全量发布
 * - mode: 'auto' - 自适应选择最佳执行模式
 */
const DEFAULT_PARALLEL_EXECUTION_CONFIG: ParallelExecutionConfig = {
  enabled: true, // 默认启用并行执行
  mode: 'auto', // 自适应选择模式
  maxConcurrency: 5,
  batchTimeout: 60000,
  enablePlanning: true,
  planningTimeout: 1000,
  retryCount: 1,
  enableCircuitBreaker: true,
  rolloutPercentage: 100, // 全量发布
};

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ReActLoopControllerConfig = {
  maxIterations: 15, // 增加到 15，支持复杂请求和分批查询场景
  thoughtTimeout: 60000, // 60秒超时，给 LLM 足够时间
  actionTimeout: 60000, // 60秒超时，给工具执行足够时间
  verbose: false,
  knowledgeEnhancedMode: false,
  knowledgeSearchTimeout: KNOWLEDGE_SEARCH_TIMEOUT,
  enableIntelligentRetrieval: true,
  enableOutputValidation: true,
  maxValidationRetries: 2,
  enableUsageTracking: true,
  enableSmartSummarization: true,
  smartSummarizationThreshold: 5000, // 5000 字符触发摘要
  summarizedTargetSize: 1500, // 摘要后目标 1500 字符
  temperature: 0.5, // 默认温度
  duplicateDetectionWindowMs: 60000, // 60秒时间窗口
  maxDuplicateCallsInWindow: 2, // 允许最多2次重复调用
  parallelExecution: DEFAULT_PARALLEL_EXECUTION_CONFIG, // 并行执行配置
};

/**
 * ReAct 循环执行结果
 */
export interface ReActLoopResult {
  /** 所有 ReAct 步骤 */
  steps: ReActStep[];
  /** 最终答案 */
  finalAnswer: string;
  /** 迭代次数 */
  iterations: number;
  /** 是否达到最大迭代次数 */
  reachedMaxIterations: boolean;
  /** 总耗时（毫秒） */
  totalDuration: number;
  /** RAG 上下文（知识增强模式下） */
  ragContext?: RAGContext;
  /** 智能检索结果（知识增强模式下） */
  intelligentRetrievalResult?: {
    documents: FormattedKnowledge[];
    retrievalTime: number;
    rewrittenQueries: string[];
    degradedMode: boolean;
  };
  /** 输出验证结果 */
  validationResult?: {
    isValid: boolean;
    validReferences: string[];
    invalidReferences: string[];
    correctionAttempts: number;
  };
  /** 使用的知识引用 */
  knowledgeReferences?: TrackedKnowledgeReference[];
  /** 回退信息 - Fix 3: Requirements 3.7 (react-parallel-bugfix) */
  fallbackInfo?: FallbackInfo;
  /** 本次循环使用的 LearningEntry IDs，用于反馈闭环 */
  usedLearningEntryIds?: string[];
  /** 中间件修正摘要（Requirements: 4.4, 4.5） */
  middlewareCorrections?: import('./middleware/types').MiddlewareCorrection[];
}

// ParsedLLMOutput 已迁移到 llmOutputParser.ts，通过顶部 import 引入
// 此处保留注释以便追溯

// ==================== ReActLoopController 类 ====================

/**
 * ReActLoopController 类
 * 管理 ReAct 循环的执行
 */
/**
 * 工具拦截器类型
 * 用于拦截特定工具的调用，返回缓存结果或自定义处理
 */
export type ToolInterceptor = (
  toolName: string,
  params: Record<string, unknown>
) => Promise<{ intercepted: boolean; result?: unknown }>;

/**
 * Skill 上下文接口
 * 用于在 ReAct 循环中传递 Skill 相关配置
 * Requirements: 4.1 - Skill 上下文传递
 */
export interface SkillContext {
  /** Skill 名称 */
  skillName: string;
  /** 工具优先级列表 */
  toolPriority: string[];
  /** 允许的工具列表 */
  allowedTools: string[];
  /** 工具默认参数 */
  toolDefaults?: Record<string, Record<string, unknown>>;
}

/**
 * ReAct 执行上下文
 * 用于在并发请求中隔离状态，解决单例并发安全问题
 * 
 * 设计说明：
 * - 每个请求创建独立的执行上下文
 * - 所有可变状态存储在上下文中，而非单例实例属性
 * - 支持并发请求互不干扰
 * 
 * 并发安全保证：
 * - aiAdapter: 请求级别的 AI 适配器，避免并发请求共享适配器
 * - toolInterceptors: 请求级别的拦截器，避免 Skill 系统的拦截器泄漏到其他请求
 * - systemPromptOverride: 请求级别的提示词覆盖，避免 Skill 提示词影响其他请求
 * - toolCallPatterns: 请求级别的工具调用追踪，用于智能循环检测
 */
export interface ReActExecutionContext {
  /** 请求唯一标识 */
  requestId: string;
  /** 工具拦截器（请求级别） */
  toolInterceptors: Map<string, ToolInterceptor>;
  /** 系统提示词覆盖（请求级别） */
  systemPromptOverride: string | null;
  /** AI 适配器（请求级别） */
  aiAdapter: IAIProviderAdapter | null;
  /** AI 提供商 */
  provider: AIProvider;
  /** 模型名称 */
  model: string;
  /** 工具调用模式追踪（用于智能循环检测） */
  toolCallPatterns: Array<{ toolName: string; paramsHash: string; timestamp: number; failed?: boolean }>;
  /** 温度参数覆盖（可选） */
  temperature?: number;
  /** Skill 上下文（新增，用于 Skill 感知的工具选择）Requirements: 4.1 */
  skillContext?: SkillContext;
  /** 是否已执行过工具（新增，用于强制执行逻辑）Requirements: 2.5 */
  hasExecutedTool: boolean;
  /** 配置覆盖（并发安全：请求级别的配置，优先于实例 config） */
  configOverrides?: Partial<ReActLoopControllerConfig>;
  /** 多设备支持：请求级 RouterOS 客户端（Requirements: 8.1, 8.2） */
  routerosClient?: import('../../routerosClient').RouterOSClient;
  /** 多设备支持：tick 上下文推断的目标设备 ID（Brain 自动补全用） */
  tickDeviceId?: string;
  /** 会话上下文引用（并发安全：请求级别，用于记录 usedLearningEntryIds） */
  conversationContext?: Record<string, unknown>;
}

/**
 * 创建新的执行上下文
 * 
 * @param adapter AI 适配器（请求级别）
 * @param provider AI 提供商
 * @param model 模型名称
 * @param temperature 可选的温度参数覆盖
 * @param skillContext 可选的 Skill 上下文（Requirements: 4.1）
 * @param routerosClient 可选的请求级 RouterOS 客户端（Requirements: 8.1, 8.2）
 * @param tickDeviceId 可选的 tick 上下文推断的目标设备 ID（Brain 自动补全用）
 */
export function createExecutionContext(
  adapter?: IAIProviderAdapter | null,
  provider?: AIProvider,
  model?: string,
  temperature?: number,
  skillContext?: SkillContext,
  routerosClient?: import('../../routerosClient').RouterOSClient,
  tickDeviceId?: string
): ReActExecutionContext {
  return {
    requestId: `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    toolInterceptors: new Map(),
    systemPromptOverride: null,
    aiAdapter: adapter || null,
    provider: provider || AIProvider.OPENAI,
    model: model || 'gpt-4o',
    toolCallPatterns: [],
    temperature,
    skillContext,
    hasExecutedTool: false, // 初始化为 false，Requirements: 4.1
    routerosClient, // Requirements: 8.1, 8.2
    tickDeviceId, // 多设备支持：tick 上下文推断的目标设备 ID
  };
}

/**
 * 规范化工具参数（用于语义化循环检测）
 * Requirements: 7.2 - 规范化参数：排序键、去除空值、字符串转小写、数组排序
 * 
 * @param params 原始参数对象
 * @returns 规范化后的参数对象
 */
export function normalizeToolParams(params: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  // 获取排序后的键
  const sortedKeys = Object.keys(params).sort();

  for (const key of sortedKeys) {
    const value = params[key];

    // 跳过 null、undefined 和空字符串
    if (value === null || value === undefined || value === '') {
      continue;
    }

    // 递归处理嵌套对象
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nestedNormalized = normalizeToolParams(value as Record<string, unknown>);
      if (Object.keys(nestedNormalized).length > 0) {
        normalized[key] = nestedNormalized;
      }
      continue;
    }

    // 数组排序（如果元素是基本类型）
    if (Array.isArray(value)) {
      const sortedArray = [...value].sort((a, b) => {
        if (typeof a === 'string' && typeof b === 'string') {
          return a.toLowerCase().localeCompare(b.toLowerCase());
        }
        return String(a).localeCompare(String(b));
      });
      normalized[key] = sortedArray;
      continue;
    }

    // 字符串转小写（用于语义比较）
    if (typeof value === 'string') {
      normalized[key] = value.toLowerCase().trim();
      continue;
    }

    // 其他类型直接保留
    normalized[key] = value;
  }

  return normalized;
}

/**
 * 计算参数哈希（用于智能循环检测）
 * 将工具参数转换为稳定的哈希字符串
 * Requirements: 7.1, 7.2 - 使用规范化后的参数进行比较
 */
export function hashToolParams(params: Record<string, unknown>): string {
  try {
    // 先规范化参数
    const normalized = normalizeToolParams(params);
    // 对键排序以确保稳定的哈希
    const sortedKeys = Object.keys(normalized).sort();
    const hashStr = sortedKeys.map(k => `${k}:${JSON.stringify(normalized[k])}`).join('|');
    // 简单哈希：使用字符串的前 64 个字符作为标识
    return hashStr.length > 64 ? hashStr.substring(0, 64) : hashStr;
  } catch {
    return 'hash_error';
  }
}

/**
 * 检测是否为重复的工具调用
 * Requirements: 7.1, 7.3, 7.5 - 使用规范化后的参数进行比较，清理过期记录，统计重复次数
 * 
 * @param toolName 工具名称
 * @param params 工具参数
 * @param patterns 历史调用模式记录
 * @param config 循环检测配置
 * @returns 是否为重复调用
 */
export function isDuplicateToolCall(
  toolName: string,
  params: Record<string, unknown>,
  patterns: Array<{ toolName: string; paramsHash: string; timestamp: number; failed?: boolean }>,
  config: LoopDetectionConfig
): { isDuplicate: boolean; duplicateCount: number } {
  const now = Date.now();
  const paramsHash = hashToolParams(params);

  // 清理过期的调用记录
  const validPatterns = patterns.filter(p => now - p.timestamp < config.windowMs);

  // 缺陷 B 修复：失败历史感知 — 如果前一次相同工具和参数的调用已失败，立即拦截
  const matchingPatterns = validPatterns.filter(
    p => p.toolName === toolName && p.paramsHash === paramsHash
  );

  // 如果存在任何一次失败的相同调用，立即拦截
  const hasPreviousFailure = matchingPatterns.some(p => p.failed === true);
  if (hasPreviousFailure && matchingPatterns.length > 0) {
    return {
      isDuplicate: true,
      duplicateCount: matchingPatterns.length,
    };
  }

  // 缺陷 B 修复：空参数特殊处理 — 空参数 {} 视为异常模式
  const isEmptyParams = Object.keys(params).length === 0;
  if (isEmptyParams && matchingPatterns.length > 0) {
    // 空参数调用只要出现过一次就拦截后续
    return {
      isDuplicate: true,
      duplicateCount: matchingPatterns.length,
    };
  }

  // 统计时间窗口内的重复调用次数（原有逻辑）
  const duplicateCount = matchingPatterns.length;

  return {
    isDuplicate: duplicateCount >= config.maxDuplicates,
    duplicateCount,
  };
}

// ==================== 增强循环卡死检测 (Requirements: 10.1, 10.2, 10.3) ====================

export interface LoopDetectionResult {
  isStuck: boolean;
  reason?: 'exact_match' | 'tool_pattern_repeat' | 'keyword_overlap' | 'alternating_pattern';
  details?: string;
}

/**
 * 计算两个 thought 的关键词重叠率
 * Requirement 10.2
 * Fix #9: 改进中文分词，对连续中文字符按 2-gram 切分，提升中文语义重复检测准确度
 */
export function calculateKeywordOverlap(thought1: string, thought2: string): number {
  const stopWords = new Set(['的', '是', '在', '了', '和', '与', '或', '有', '这', '那', 'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by']);

  const extractWords = (text: string): Set<string> => {
    const words = new Set<string>();
    const lower = text.toLowerCase();

    // Extract English words and numbers
    const englishWords = lower.match(/[a-z0-9_]+/g) || [];
    for (const w of englishWords) {
      if (w.length > 0 && !stopWords.has(w)) words.add(w);
    }

    // Chinese characters: add both characters and segments
    const chineseSegments = lower.match(/[\u4e00-\u9fff]+/g) || [];
    for (const segment of chineseSegments) {
      if (segment.length > 1) {
        words.add(segment);
      }
      for (const char of segment) {
        if (!stopWords.has(char)) words.add(char);
      }
    }

    return words;
  };

  const words1 = extractWords(thought1);
  const words2 = extractWords(thought2);

  if (words1.size === 0 && words2.size === 0) return 0;
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }

  const union = new Set([...words1, ...words2]).size;
  const minSize = Math.min(words1.size, words2.size);
  return minSize === 0 ? 0 : intersection / minSize;
}

export function detectLoopStuck(
  recentThoughts: string[],
  toolCallPatterns: Array<{ toolName: string; paramsHash: string }>,
  config: { maxRepeats: number; keywordOverlapThreshold: number },
): LoopDetectionResult {
  const { maxRepeats, keywordOverlapThreshold } = config;

  // 1. Exact match detection
  if (recentThoughts.length >= maxRepeats) {
    const lastN = recentThoughts.slice(-maxRepeats).map(t => t.toLowerCase().trim());
    const unique = new Set(lastN);
    if (unique.size <= 1) {
      return {
        isStuck: true,
        reason: 'exact_match',
        details: `Last ${maxRepeats} thoughts are identical`,
      };
    }
  }

  // 2. Tool call pattern detection
  if (toolCallPatterns.length >= maxRepeats) {
    const lastN = toolCallPatterns.slice(-maxRepeats);
    const allSameTool = lastN.every(p => p.toolName === lastN[0].toolName);
    const allSameParams = lastN.every(p => p.paramsHash === lastN[0].paramsHash);

    if (allSameTool && allSameParams) {
      return {
        isStuck: true,
        reason: 'tool_pattern_repeat',
        details: `Tool "${lastN[0].toolName}" called ${maxRepeats} times with same params`,
      };
    }
  }

  // 3. Keyword overlap detection
  if (recentThoughts.length >= maxRepeats) {
    const lastN = recentThoughts.slice(-maxRepeats);
    // 检查最后连续的几条思考是否存在高重叠（只需检查相邻的或者两两检查）
    // 为了更严格，我们检查是否存在任何一对重叠超过阈值
    for (let i = 0; i < lastN.length - 1; i++) {
      for (let j = i + 1; j < lastN.length; j++) {
        const overlap = calculateKeywordOverlap(lastN[i], lastN[j]);
        if (overlap > keywordOverlapThreshold) {
          return {
            isStuck: true,
            reason: 'keyword_overlap',
            details: `Keyword overlap ${(overlap * 100).toFixed(1)}% exceeds threshold ${(keywordOverlapThreshold * 100).toFixed(1)}%`,
          };
        }
      }
    }
  }

  // 4. Alternating tool call pattern detection (period=2 and period=3)
  // 检测 A→B→A→B 或 A→B→C→A→B→C 这类周期性工具调用模式
  if (toolCallPatterns.length >= 4) {
    // period=2: 检查最后 4-6 条是否呈 A→B→A→B 交替模式
    const last4 = toolCallPatterns.slice(-4);
    if (
      last4[0].toolName === last4[2].toolName &&
      last4[1].toolName === last4[3].toolName &&
      last4[0].toolName !== last4[1].toolName // 确保不是同一工具重复（那是策略2的职责）
    ) {
      return {
        isStuck: true,
        reason: 'alternating_pattern',
        details: `Alternating period-2 pattern detected: ${last4[0].toolName} ↔ ${last4[1].toolName}`,
      };
    }
  }

  if (toolCallPatterns.length >= 6) {
    // period=3: 检查最后 6 条是否呈 A→B→C→A→B→C 三元素周期
    const last6 = toolCallPatterns.slice(-6);
    if (
      last6[0].toolName === last6[3].toolName &&
      last6[1].toolName === last6[4].toolName &&
      last6[2].toolName === last6[5].toolName &&
      // 确保不是全部相同工具
      !(last6[0].toolName === last6[1].toolName && last6[1].toolName === last6[2].toolName)
    ) {
      return {
        isStuck: true,
        reason: 'alternating_pattern',
        details: `Alternating period-3 pattern detected: ${last6[0].toolName} → ${last6[1].toolName} → ${last6[2].toolName} (repeated)`,
      };
    }
  }

  return { isStuck: false };
}

// ==================== 操作后自我验证辅助函数 (需求 6) ====================

/** sleep 辅助函数 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export class ReActLoopController {
  private config: ReActLoopControllerConfig;
  // 以下属性保留用于向后兼容，但推荐使用 executionContext
  private aiAdapter: IAIProviderAdapter | null = null;
  private provider: AIProvider = AIProvider.OPENAI;
  private model: string = 'gpt-4o';

  private tools: Map<string, AgentTool> = new Map();

  // 智能知识应用系统组件
  private intelligentRetriever: IntelligentRetriever;
  private outputValidator: OutputValidator;
  private usageTracker: UsageTracker;
  private promptBuilder: PromptBuilder;

  // 工具拦截器和提示词覆盖（Skill 系统集成）
  // Requirements: 7.6, 9.1
  private toolInterceptors: Map<string, ToolInterceptor> = new Map();
  private systemPromptOverride: string | null = null;

  // Prompt 模块化适配器 (Requirements: 1.7, 1.8, 1.9, 5.2, 6.5)
  private promptAdapter = createPromptComposerAdapter(promptTemplateService);

  // 缺陷 G 修复：集成 ToolOutputSummarizer
  private toolOutputSummarizer: ToolOutputSummarizer;

  // Action 选择器（从 RALC 拆分的独立模块）
  private actionSelector: ActionSelector;

  // 中间件管道（在 parseLLMOutput 后、action 分发前执行）
  private middlewarePipeline: MiddlewarePipeline = new MiddlewarePipeline();

  constructor(config?: Partial<ReActLoopControllerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 初始化智能知识应用系统组件
    this.intelligentRetriever = intelligentRetriever;
    this.outputValidator = outputValidator;
    this.usageTracker = usageTracker;
    this.promptBuilder = promptBuilder;

    // 缺陷 G 修复：初始化 ToolOutputSummarizer
    this.toolOutputSummarizer = new ToolOutputSummarizer({
      maxCharsPerOutput: 2000,
      maxArrayElements: 10,
      maxStringLength: 300,
    });

    // 初始化 ActionSelector，注入 RALC 依赖
    this.actionSelector = new ActionSelector({
      callLLMSimple: (prompt, adapter, provider, model, temperature) =>
        this.callLLMSimple(prompt, adapter, provider, model, temperature),
      getToolsMap: () => this.tools,
      knowledgeEnhancedMode: this.config.knowledgeEnhancedMode,
    });

    // 默认注册 ToolCorrectionMiddleware（priority 100，留出低优先级位给未来中间件）
    this.middlewarePipeline.register(new ToolCorrectionMiddleware(), 100);

    logger.info('ReActLoopController created', { config: this.config });
  }

  /**
   * 设置 AI 适配器
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model: string): void {
    this.aiAdapter = adapter;
    this.provider = provider;
    this.model = model;
    logger.info('ReActLoopController AI adapter set', { provider, model });
  }

  /**
   * 注册工具
   */
  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 注册多个工具
   */
  registerTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * 清除所有注册的工具
   */
  clearTools(): void {
    this.tools.clear();
  }

  /**
   * 获取所有注册的工具
   */
  getTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 注册中间件到管道
   * Requirements: 1.1
   */
  registerMiddleware(middleware: ReActMiddleware, priority: number): void {
    this.middlewarePipeline.register(middleware, priority);
  }

  /**
   * 移除中间件
   * Requirements: 1.2
   */
  unregisterMiddleware(name: string): boolean {
    return this.middlewarePipeline.unregister(name);
  }

  /**
   * 验证工具调用的必需参数 — 委托给 ActionSelector
   */
  private validateActionRequiredParams(
    action: { toolName: string; toolInput: Record<string, unknown> } | null
  ): { toolName: string; toolInput: Record<string, unknown> } | null {
    return this.actionSelector.validateActionRequiredParams(action);
  }

  /**
   * 获取带历史统计的工具描述（异步版本）
   * 工具选择优化：附加成功率、调用次数等统计信息，按成功率排序
   * 使 LLM 优先选择表现好的工具
   */
  private async getToolDescriptionsWithStats(): Promise<string> {
    const tools = this.getTools();

    // 尝试获取工具统计数据
    let statsMap = new Map<string, { totalCalls: number; successRate: number; avgDuration: number }>();
    try {
      if (isCapabilityEnabled('toolFeedback')) {
        const stats = await toolFeedbackCollector.getToolStats();
        statsMap = new Map(stats.map(s => [s.toolName, s]));
      }
    } catch (error) {
      logger.debug('Failed to load tool stats for prompt, proceeding without stats', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 按成功率排序工具（高成功率排前面），无数据的放末尾
    const sortedTools = [...tools].sort((a, b) => {
      const sa = statsMap.get(a.name);
      const sb = statsMap.get(b.name);
      if (!sa && !sb) return 0;
      if (!sa) return 1;
      if (!sb) return -1;
      return sb.successRate - sa.successRate;
    });

    return sortedTools.map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
        .join('\n');

      // 附加历史统计
      const stat = statsMap.get(tool.name);
      const statsHint = stat
        ? ` [历史: ${stat.totalCalls}次调用, 成功率${(stat.successRate * 100).toFixed(0)}%, 平均${stat.avgDuration.toFixed(0)}ms]`
        : '';

      return `- ${tool.name}: ${tool.description}${statsHint}\n  参数:\n${params}`;
    }).join('\n\n');
  }


  /**
   * 执行 ReAct 循环
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.2, 4.3, 8.1, 8.4
   * 智能知识应用: 8.1, 8.2, 9.4, 10.2, 10.3, 10.4
   * 并行执行: 1.1, 1.2, 1.6, 4.1, 8.1
   * 
   * 并发安全修复 (ai-ops-code-review-fixes):
   * - Requirements 1.1: executionContext 现在是必需参数
   * - Requirements 1.2, 1.4: 不再回退到实例属性，强制使用 executionContext
   * - Requirements 1.3, 4.1-4.5: aiAdapter 必须在 executionContext 中配置
   * 
   * @param message 用户消息
   * @param intentAnalysis 意图分析结果
   * @param context 对话上下文
   * @param executionContext 执行上下文（必需，用于并发安全）
   * @returns ReAct 循环执行结果
   * @throws Error 如果 executionContext 未提供或 aiAdapter 未配置
   */
  async executeLoop(
    message: string,
    intentAnalysis: IntentAnalysis,
    context: ConversationMemory,
    executionContext: ReActExecutionContext
  ): Promise<ReActLoopResult> {
    // Requirements 1.1 (ai-ops-code-review-fixes): ExecutionContext 必需性检查
    if (!executionContext) {
      throw new Error(
        'ExecutionContext is required for concurrent safety. ' +
        'Use createExecutionContext() to create one.'
      );
    }

    // Requirements 1.3, 4.1-4.5 (ai-ops-code-review-fixes): aiAdapter 空值检查
    if (!executionContext.aiAdapter) {
      throw new Error(
        `AI adapter not configured in executionContext. ` +
        `RequestId: ${executionContext.requestId}. ` +
        `Please set executionContext.aiAdapter or call setAIAdapter() before executeLoop().`
      );
    }

    const startTime = Date.now();
    const steps: ReActStep[] = [];

    let iterations = 0;
    let finalAnswer = '';
    let reachedMaxIterations = false;
    let hasExecutedTool = executionContext.hasExecutedTool ?? false; // Requirements: 4.1 - 从执行上下文初始化

    // 并发安全：将会话上下文引用存入 executionContext，而非实例属性
    // Requirements: conversation-and-reflection-optimization 8.1
    executionContext.conversationContext = context.context;

    // Requirements 1.2, 1.4 (ai-ops-code-review-fixes): 并发安全 - 直接使用 executionContext 中的配置，不再回退到实例属性
    const effectiveAdapter = executionContext.aiAdapter;
    const effectiveProvider = executionContext.provider;
    const effectiveModel = executionContext.model;
    const effectiveInterceptors = executionContext.toolInterceptors;
    const effectivePromptOverride = executionContext.systemPromptOverride;
    const effectiveTemperature = executionContext.temperature ?? this.config.temperature;

    // 并发安全 (rag-pipeline-consolidation): 合并请求级别的配置覆盖
    // 当 SARC 通过 executionContext.configOverrides 传递配置时，优先使用请求级别的值
    const effectiveConfig: ReActLoopControllerConfig = executionContext.configOverrides
      ? { ...this.config, ...executionContext.configOverrides }
      : this.config;

    // Requirements: 4.1, 10.1 - 从执行上下文获取 skillContext
    const skillContext = executionContext?.skillContext;

    // 并行执行: 4.1 - 模式选择
    let selectedMode: ExecutionMode = ExecutionMode.SEQUENTIAL;
    let modeSelectionResult: ModeSelectionResult | undefined;

    // 检查是否启用并行执行
    const parallelConfig = effectiveConfig.parallelExecution;
    const parallelEnabled = parallelConfig?.enabled && this.shouldEnableParallelExecution(executionContext?.requestId);

    if (parallelEnabled) {
      // 使用自适应模式选择器
      modeSelectionResult = adaptiveModeSelector.selectMode(message, skillContext);
      selectedMode = modeSelectionResult.mode;

      // 如果配置了固定模式，使用配置的模式
      if (parallelConfig?.mode && parallelConfig.mode !== 'auto') {
        selectedMode = parallelConfig.mode as ExecutionMode;
      }

      logger.info('Parallel execution mode selected', {
        mode: selectedMode,
        confidence: modeSelectionResult?.confidence,
        reason: modeSelectionResult?.reason,
        estimatedToolCalls: modeSelectionResult?.estimatedToolCalls,
        requestId: executionContext?.requestId,
      });
    }

    // 初始化 RAGContext（知识增强模式下）
    // Requirements: 6.1, 6.4
    const ragContext: RAGContext = this.initializeRAGContext();

    // 智能检索结果存储
    let intelligentRetrievalResult: ReActLoopResult['intelligentRetrievalResult'] | undefined;
    let formattedKnowledge: FormattedKnowledge[] = [];
    let knowledgeReferences: TrackedKnowledgeReference[] = [];

    // 用于检测循环卡死
    const recentThoughts: string[] = [];
    const MAX_REPEATED_THOUGHTS = 3;

    // 需求 3.2, 3.4, 3.5: VerificationDirective 追踪器
    // 当 execute_intent 返回 verification_directive 时，记录待验证状态
    // 若 LLM 在 2 个推理步骤内未主动执行验证查询，系统自动执行
    let pendingVerificationDirective: import('../brain/intentRegistry').VerificationDirective | null = null;
    let pendingVerificationAction: string | null = null; // 触发验证的原始意图名
    let stepsWithoutVerification = 0; // 自上次注入验证指令后经过的推理步骤数
    const VERIFICATION_AUTO_TRIGGER_STEPS = 2; // 超过此步数自动执行验证

    // Requirements: 8.1, 8.4 - 诊断信息收集
    const diagnosticInfo = {
      thoughts: [] as string[],
      failedParses: [] as Array<{ raw: string; error: string }>,
      terminationReason: 'unknown' as string,
    };

    // 中间件管道状态（跨迭代累计，Requirements: 4.1-4.6）
    let totalCorrectionsInLoop = 0;
    const allMiddlewareCorrections: MiddlewareCorrection[] = [];

    // 注入中间件执行函数到 ActionSelector（闭包捕获循环级状态）
    this.actionSelector.updateDeps({
      executeMiddleware: async (output, availableToolNames, mwSkillContext) => {
        const mwContext: MiddlewareContext = {
          stepIndex: iterations,
          userMessage: message,
          availableToolNames,
          skillContext: mwSkillContext,
          corrections: [],
          totalCorrectionsInLoop,
        };
        const corrected = await this.middlewarePipeline.execute(output, mwContext);
        // 累计修正
        totalCorrectionsInLoop = mwContext.totalCorrectionsInLoop;
        allMiddlewareCorrections.push(...mwContext.corrections);
        return { output: corrected, corrections: mwContext.corrections };
      },
    });

    logger.info('Starting ReAct loop', {
      message: message.substring(0, 100),
      intentAnalysis: {
        intent: intentAnalysis.intent,
        toolCount: intentAnalysis.tools.length,
      },
      knowledgeEnhancedMode: effectiveConfig.knowledgeEnhancedMode,
      enableIntelligentRetrieval: effectiveConfig.enableIntelligentRetrieval,
      requestId: executionContext?.requestId || 'legacy',
      hasExecutionContext: !!executionContext,
      skillContext: skillContext?.skillName, // Requirements: 4.5 - 记录 Skill 名称
      toolPriority: skillContext?.toolPriority, // Requirements: 4.5 - 记录 toolPriority
    });

    // Fix 3: 初始化回退状态 - Requirements: 3.6, 3.7 (react-parallel-bugfix)
    // 在 try 块外初始化，确保在所有返回路径中都可用
    const fallbackState = this.createFallbackState(selectedMode);

    try {
      // 智能知识应用: 8.1 - 在循环开始前使用 IntelligentRetriever 进行智能检索
      if (effectiveConfig.knowledgeEnhancedMode && effectiveConfig.enableIntelligentRetrieval) {
        try {
          const retrievalResult = await this.performIntelligentRetrieval(message);
          if (retrievalResult) {
            intelligentRetrievalResult = {
              documents: retrievalResult.documents,
              retrievalTime: retrievalResult.retrievalTime,
              rewrittenQueries: retrievalResult.rewrittenQueries,
              degradedMode: retrievalResult.degradedMode,
            };
            formattedKnowledge = retrievalResult.documents;

            // 更新 RAGContext
            ragContext.hasRetrieved = true;
            ragContext.retrievalTime = retrievalResult.retrievalTime;
            ragContext.documents = retrievalResult.documents.map(doc => ({
              id: doc.referenceId,
              title: doc.title,
              type: doc.type,
              score: doc.credibilityScore,
              excerpt: doc.content.substring(0, 500),
              metadata: doc.metadata as unknown as Record<string, unknown>,
            }));

            // 构建知识引用
            knowledgeReferences = retrievalResult.documents.map(doc => ({
              referenceId: doc.referenceId,
              entryId: doc.entryId,
              title: doc.title,
              type: doc.type,
              isValid: true,
              score: doc.credibilityScore,
            }));

            logger.info('Intelligent retrieval completed', {
              documentCount: formattedKnowledge.length,
              retrievalTime: retrievalResult.retrievalTime,
              degradedMode: retrievalResult.degradedMode,
            });
          }
        } catch (error) {
          logger.warn('Intelligent retrieval failed, continuing without knowledge', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // ==================== 意图驱动自动化：意图预解析 (Requirements: 6.1, 6.2, 6.3, 6.4) ====================
      // Brain 模式（systemPromptOverride 存在）跳过意图预解析：
      // Brain 有自己的 OODA 决策框架（P0/P1/P2 playbook），不需要 IntentParser 猜测意图。
      // Brain tick 的固定格式消息会导致 IntentParser 每次匹配到相同关键词，产生无意义的固定置信度。
      try {
        if (isCapabilityEnabled('intentDriven') && !effectivePromptOverride) {
          const idConfig = getCapabilityConfig('intentDriven');
          const parsedIntent = await intentParser.parse(message);

          if (parsedIntent.confidence >= idConfig.confidenceThreshold) {
            const riskLevel = intentParser.getRiskLevel(parsedIntent);
            // 将 intentParser 的风险等级 (low/medium/high) 映射到 evolutionConfig 的 RiskLevel (L1/L2/L3/L4)
            const riskToLevel: Record<string, string> = { low: 'L1', medium: 'L2', high: 'L3' };
            const riskLevelOrder: Record<string, number> = { L1: 0, L2: 1, L3: 2, L4: 3 };
            const mappedRiskLevel = riskToLevel[riskLevel] || 'L3';
            const configRiskLevel = idConfig.riskLevelForConfirmation || 'L3';

            if (riskLevelOrder[mappedRiskLevel] < riskLevelOrder[configRiskLevel]) {
              // 高置信度 + 低风险 → 直接执行，跳过常规思考循环
              logger.info('Intent-driven: high confidence + low risk, executing directly', {
                intentId: parsedIntent.id,
                category: parsedIntent.category,
                action: parsedIntent.action,
                confidence: parsedIntent.confidence,
                riskLevel,
                requestId: executionContext?.requestId,
              });

              // 将意图转换为工具调用参数
              const intentToolName = this.mapIntentToTool(parsedIntent);
              const intentToolInput = {
                ...parsedIntent.parameters,
                ...(parsedIntent.target ? { target: parsedIntent.target } : {}),
              };

              // 记录思考步骤
              steps.push({
                type: 'thought' as ReActStepType,
                content: `[意图驱动自动化] 识别到高置信度意图: ${parsedIntent.category}/${parsedIntent.action}` +
                  `${parsedIntent.target ? `, 目标: ${parsedIntent.target}` : ''}` +
                  `, 置信度: ${parsedIntent.confidence}, 风险等级: ${riskLevel}。直接执行对应操作。`,
                timestamp: Date.now(),
              });

              if (intentToolName && this.tools.has(intentToolName)) {
                // 记录动作步骤
                steps.push({
                  type: 'action' as ReActStepType,
                  content: `调用工具: ${intentToolName}`,
                  timestamp: Date.now(),
                  toolName: intentToolName,
                  toolInput: intentToolInput,
                });

                // 执行工具
                const observation = await this.executeAction(
                  intentToolName,
                  intentToolInput,
                  effectiveInterceptors,
                  executionContext?.routerosClient,
                  executionContext?.tickDeviceId
                );

                hasExecutedTool = true;
                if (executionContext) {
                  executionContext.hasExecutedTool = true;
                }

                // 记录观察步骤
                steps.push({
                  type: 'observation' as ReActStepType,
                  content: this.formatObservation(observation.output, observation.success),
                  timestamp: Date.now(),
                  toolOutput: observation.output,
                  duration: observation.duration,
                  success: observation.success,
                });

                // 记录工具反馈指标
                try {
                  if (isCapabilityEnabled('toolFeedback')) {
                    toolFeedbackCollector.recordMetric({
                      toolName: intentToolName,
                      timestamp: Date.now(),
                      duration: observation.duration,
                      success: observation.success,
                      errorMessage: observation.success ? undefined : String(observation.output),
                    });
                  }
                } catch (tfError) {
                  logger.warn('Failed to record intent-driven tool feedback', {
                    error: tfError instanceof Error ? tfError.message : String(tfError),
                  });
                }

                // 生成最终答案
                finalAnswer = await this.generateFinalAnswerFromSteps(
                  message, steps, context,
                  effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
                );

                steps.push({
                  type: 'final_answer' as ReActStepType,
                  content: finalAnswer,
                  timestamp: Date.now(),
                });

                // 记录持续学习
                try {
                  if (isCapabilityEnabled('continuousLearning')) {
                    const clConfig = getCapabilityConfig('continuousLearning');
                    if (clConfig.patternLearningEnabled) {
                      continuousLearner.recordOperation(executionContext.requestId, {
                        userId: executionContext.requestId,
                        sessionId: executionContext.requestId,
                        toolName: intentToolName,
                        parameters: {
                          type: 'intent_driven_execution',
                          intentCategory: parsedIntent.category,
                          intentAction: parsedIntent.action,
                        },
                        result: observation.success ? 'success' : 'failure',
                        timestamp: Date.now(),
                        context: {
                          confidence: parsedIntent.confidence,
                          riskLevel,
                        },
                      });
                    }
                  }
                } catch (clError) {
                  logger.warn('Failed to record intent-driven continuous learning', {
                    error: clError instanceof Error ? clError.message : String(clError),
                  });
                }

                const totalDuration = Date.now() - startTime;

                // 知识蒸馏：intent-driven 早期返回前，将工具执行结果写入知识库
                await this.produceKnowledgeEntry({
                  steps, message, finalAnswer, iterations: 0,
                  reachedMaxIterations: false, totalDuration,
                  executionContext, intentAnalysis,
                });

                return {
                  steps,
                  finalAnswer,
                  iterations: 0,
                  reachedMaxIterations: false,
                  totalDuration,
                  ragContext: effectiveConfig.knowledgeEnhancedMode ? ragContext : undefined,
                  intelligentRetrievalResult,
                  knowledgeReferences: knowledgeReferences.length > 0 ? knowledgeReferences : undefined,
                  fallbackInfo: this.buildFallbackInfo(fallbackState),
                  usedLearningEntryIds: (executionContext.conversationContext?.usedLearningEntryIds as string[]) ?? undefined,
                  middlewareCorrections: allMiddlewareCorrections.length > 0 ? allMiddlewareCorrections : undefined,
                };
              } else {
                // 未找到匹配工具，回退到常规循环，但保留意图上下文
                logger.info('Intent-driven: no matching tool found, falling back to ReAct loop', {
                  intentAction: parsedIntent.action,
                  intentCategory: parsedIntent.category,
                });
                steps.push({
                  type: 'thought' as ReActStepType,
                  content: `[意图驱动自动化] 未找到与意图 "${parsedIntent.category}/${parsedIntent.action}" 直接匹配的工具，将通过常规推理流程处理。`,
                  timestamp: Date.now(),
                });
              }
            } else {
              // 高置信度但高风险 → 注入意图上下文到思考提示词中
              logger.info('Intent-driven: high confidence but high risk, injecting context', {
                intentId: parsedIntent.id,
                category: parsedIntent.category,
                action: parsedIntent.action,
                confidence: parsedIntent.confidence,
                riskLevel,
                requestId: executionContext?.requestId,
              });

              steps.push({
                type: 'thought' as ReActStepType,
                content: `[意图预解析参考] 检测到运维意图: ${parsedIntent.category}/${parsedIntent.action}` +
                  `${parsedIntent.target ? `, 目标: ${parsedIntent.target}` : ''}` +
                  `, 置信度: ${parsedIntent.confidence}, 风险等级: ${riskLevel}(${mappedRiskLevel})。` +
                  `由于风险等级不低于确认阈值(${configRiskLevel})，需要通过常规推理流程进行详细分析和确认。` +
                  (Object.keys(parsedIntent.parameters).length > 0
                    ? ` 提取的参数: ${JSON.stringify(parsedIntent.parameters)}`
                    : ''),
                timestamp: Date.now(),
              });
            }
          } else if (parsedIntent.category !== 'unknown') {
            // 低置信度 → 注入意图上下文作为参考
            logger.debug('Intent-driven: low confidence, injecting as reference', {
              intentId: parsedIntent.id,
              category: parsedIntent.category,
              confidence: parsedIntent.confidence,
              requestId: executionContext?.requestId,
            });

            steps.push({
              type: 'thought' as ReActStepType,
              content: `[意图预解析参考] 可能的运维意图: ${parsedIntent.category}/${parsedIntent.action}` +
                `, 置信度: ${parsedIntent.confidence}（低于阈值 ${idConfig.confidenceThreshold}）。` +
                `仅作为参考信息，将通过常规推理流程处理。`,
              timestamp: Date.now(),
            });
          }
          // 如果是 unknown 类别且低置信度，不注入任何信息，保持原有行为
        }
      } catch (intentError) {
        // 意图解析失败，回退到常规 ReAct 循环
        logger.warn('Intent parsing failed, falling back to regular ReAct loop', {
          error: intentError instanceof Error ? intentError.message : String(intentError),
          requestId: executionContext?.requestId,
        });
      }

      // Requirements: 2.1, 14.4 - PLANNED 模式：使用 ExecutionPlanner 生成并执行计划
      if (parallelEnabled && selectedMode === ExecutionMode.PLANNED && parallelConfig?.enablePlanning) {
        try {
          const planResult = await this.executePlannedMode(
            message,
            steps,
            ragContext,
            formattedKnowledge,
            effectiveAdapter,
            effectiveProvider,
            effectiveModel,
            effectiveInterceptors,
            effectiveTemperature,
            executionContext,
            skillContext
          );

          // 如果计划执行成功，直接返回结果
          if (planResult.success) {
            hasExecutedTool = planResult.hasExecutedTool;
            finalAnswer = planResult.finalAnswer;

            // 记录模式选择准确性
            if (modeSelectionResult) {
              const actualToolCalls = steps.filter(s => s.type === 'action').length;
              parallelExecutionMetrics.recordModeSelectionAccuracy(
                modeSelectionResult.estimatedToolCalls,
                actualToolCalls,
                selectedMode
              );
            }

            const totalDuration = Date.now() - startTime;
            logger.info('PLANNED mode execution completed', {
              iterations: planResult.iterations,
              stepCount: steps.length,
              totalDuration,
              requestId: executionContext?.requestId,
            });

            // 知识蒸馏：PLANNED 模式早期返回前，将工具执行结果写入知识库
            await this.produceKnowledgeEntry({
              steps, message, finalAnswer,
              iterations: planResult.iterations,
              reachedMaxIterations: false, totalDuration,
              executionContext, intentAnalysis,
            });

            return {
              steps,
              finalAnswer,
              iterations: planResult.iterations,
              reachedMaxIterations: false,
              totalDuration,
              ragContext: effectiveConfig.knowledgeEnhancedMode ? ragContext : undefined,
              intelligentRetrievalResult,
              knowledgeReferences: knowledgeReferences.length > 0 ? knowledgeReferences : undefined,
              fallbackInfo: this.buildFallbackInfo(fallbackState), // Fix 3: 包含回退信息
              usedLearningEntryIds: (executionContext.conversationContext?.usedLearningEntryIds as string[]) ?? undefined,
              middlewareCorrections: allMiddlewareCorrections.length > 0 ? allMiddlewareCorrections : undefined,
            };
          }

          // 计划执行失败，使用回退逻辑 - Fix 3: 完整回退链
          const nextMode = this.fallbackToNextMode(
            ExecutionMode.PLANNED,
            planResult.error || 'Plan execution failed',
            fallbackState
          );
          if (nextMode) {
            selectedMode = nextMode;
          }
        } catch (error) {
          // 计划生成/执行失败，使用回退逻辑 - Fix 3: 完整回退链
          const nextMode = this.fallbackToNextMode(
            ExecutionMode.PLANNED,
            error instanceof Error ? error.message : String(error),
            fallbackState
          );
          if (nextMode) {
            selectedMode = nextMode;
          }
        }
      }

      let nullActionRetryCount = 0;
      while (iterations < effectiveConfig.maxIterations) {
        iterations++;

        // 并行执行: 1.6 - 根据模式选择提示词
        let effectivePromptForThought = effectivePromptOverride;
        if (parallelEnabled && selectedMode !== ExecutionMode.SEQUENTIAL && !effectivePromptOverride) {
          // 使用并行执行提示词
          effectivePromptForThought = this.buildParallelPrompt(message, steps, parallelConfig?.maxConcurrency || 5);
        }

        // Requirement 2.1: 生成 Thought（传递 RAGContext、格式化知识、hasExecutedTool 和 skillContext）
        // Requirements: 4.2, 10.2 - 传递 skillContext 到 generateThought
        // Fix: 并行执行分支逻辑链问题修复 - 使用 generateThoughtWithRawResponse 获取完整响应
        const thoughtResult = await this.generateThoughtWithRawResponse(
          message, steps, context, ragContext, formattedKnowledge,
          effectiveAdapter, effectiveProvider, effectiveModel, effectivePromptForThought, effectiveTemperature,
          hasExecutedTool, skillContext, executionContext.conversationContext
        );
        const thought = thoughtResult.thought;
        const rawLLMResponse = thoughtResult.rawResponse; // 保存原始响应用于并行解析

        // Requirements: 8.1 - 收集诊断信息
        diagnosticInfo.thoughts.push(thought);

        // 记录 Thought 步骤
        steps.push({
          type: 'thought',
          content: thought,
          timestamp: Date.now(),
        });

        // 检测循环卡死
        recentThoughts.push(thought);
        if (recentThoughts.length > MAX_REPEATED_THOUGHTS) {
          recentThoughts.shift();
        }
        if (this.isStuckInLoop(recentThoughts)) {
          logger.warn('Detected stuck loop, forcing final answer');
          diagnosticInfo.terminationReason = 'stuck_loop';
          finalAnswer = await this.generateForcedFinalAnswer(
            message, steps, context,
            effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
          );
          break;
        }

        // Fix: 并行执行检查移到 selectAction 之前
        // 这样可以避免在并行模式下不必要的 selectAction LLM 调用
        // 并保持 steps 记录的一致性
        if (parallelEnabled && selectedMode !== ExecutionMode.SEQUENTIAL && rawLLMResponse) {
          // 添加调试日志：记录 LLM 原始响应用于诊断
          logger.debug('Attempting parallel tool call parsing', {
            responseLength: rawLLMResponse.length,
            responsePreview: rawLLMResponse.substring(0, 500),
            containsNumberedAction: /Action\s*\d+\s*:/i.test(rawLLMResponse),
            containsUnnumberedAction: /Action\s*:\s*\w+/i.test(rawLLMResponse),
            actionMatches: (rawLLMResponse.match(/Action\s*[\d]*\s*:/gi) || []).length,
            requestId: executionContext?.requestId,
          });

          // 尝试从完整的 LLM 响应中解析多个工具调用
          const multipleToolCalls = parallelExecutor.parseMultipleToolCalls(rawLLMResponse);

          // 添加调试日志：记录解析结果
          logger.debug('Parallel parsing result', {
            parsedCount: multipleToolCalls.length,
            tools: multipleToolCalls.map(tc => tc.toolName),
            willExecuteParallel: multipleToolCalls.length > 1,
            requestId: executionContext?.requestId,
          });

          if (multipleToolCalls.length > 1) {
            // 并行执行多个工具调用
            // Requirements 3.1 (ai-ops-code-review-fixes): 记录回滚点
            const rollbackPoint = steps.length;
            logger.debug('Recording rollback point for parallel execution', {
              rollbackPoint,
              toolCount: multipleToolCalls.length,
              requestId: executionContext?.requestId,
            });

            try {
              logger.info('Executing parallel tool calls (early check)', {
                count: multipleToolCalls.length,
                tools: multipleToolCalls.map(tc => tc.toolName),
                requestId: executionContext?.requestId,
              });

              // 为每个工具调用记录 Action 步骤
              for (const toolCall of multipleToolCalls) {
                steps.push({
                  type: 'action',
                  content: `调用工具: ${toolCall.toolName}`,
                  timestamp: Date.now(),
                  toolName: toolCall.toolName,
                  toolInput: toolCall.params,
                });
              }

              // 设置工具到 ParallelExecutor
              parallelExecutor.setTools(this.tools);

              // 创建批次并执行
              const batch = parallelExecutor.createBatch(multipleToolCalls);
              const mergedObservation = await parallelExecutor.executeBatch(
                batch,
                effectiveInterceptors,
                executionContext
              );

              // 记录并行执行指标
              parallelExecutionMetrics.recordExecution({
                executionId: batch.batchId,
                mode: selectedMode,
                toolCallCount: multipleToolCalls.length,
                batchCount: 1,
                totalDuration: mergedObservation.totalDuration,
                theoreticalSequentialDuration: mergedObservation.results.reduce((sum, r) => sum + r.duration, 0),
                speedupRatio: parallelExecutionMetrics.calculateSpeedupRatio(
                  mergedObservation.totalDuration,
                  mergedObservation.results.map(r => r.duration)
                ),
                avgParallelism: mergedObservation.parallelism,
                failureRate: mergedObservation.failureCount / multipleToolCalls.length,
                retryCount: mergedObservation.results.reduce((sum, r) => sum + r.retryCount, 0),
              });

              // 更新 hasExecutedTool 状态
              hasExecutedTool = true;
              if (executionContext) {
                executionContext.hasExecutedTool = true;

                // 记录并行执行的工具调用模式（用于循环检测）
                for (const toolCall of multipleToolCalls) {
                  const paramsHash = hashToolParams(toolCall.params);
                  // 缺陷 B 修复：记录失败状态
                  const toolResult = mergedObservation.results?.find((r: any) => r.toolName === toolCall.toolName);
                  executionContext.toolCallPatterns.push({
                    toolName: toolCall.toolName,
                    paramsHash,
                    timestamp: Date.now(),
                    failed: toolResult ? !toolResult.success : false,
                  });
                }
              }

              // Requirements: 2.1, 2.4 - 工具反馈闭环：记录并行执行的工具指标
              try {
                if (isCapabilityEnabled('toolFeedback')) {
                  for (const result of mergedObservation.results) {
                    toolFeedbackCollector.recordMetric({
                      toolName: result.toolName,
                      timestamp: Date.now(),
                      duration: result.duration,
                      success: result.success,
                      errorMessage: result.success ? undefined : String(result.output),
                    });
                  }
                }
              } catch (toolFeedbackError) {
                logger.warn('Failed to record parallel tool feedback metrics', {
                  error: toolFeedbackError instanceof Error ? toolFeedbackError.message : String(toolFeedbackError),
                });
              }

              // 为每个成功的工具调用处理知识搜索结果
              for (const result of mergedObservation.results) {
                if (result.toolName === 'knowledge_search') {
                  this.storeKnowledgeResults({ output: result.output, duration: result.duration, success: result.success }, ragContext);
                }
              }

              // 记录并行执行的 Observation 步骤
              const parallelObservation = {
                output: mergedObservation.formattedText || parallelExecutor.formatForLLM(mergedObservation.results),
                duration: mergedObservation.totalDuration,
                success: mergedObservation.successCount > 0,
              };

              steps.push({
                type: 'observation',
                content: this.formatObservation(parallelObservation.output, parallelObservation.success),
                timestamp: Date.now(),
                toolOutput: parallelObservation.output,
                duration: parallelObservation.duration,
                success: parallelObservation.success,
              });

              // 判断是否需要继续循环
              const shouldContinue = await this.shouldContinue(
                steps, message,
                effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature,
                hasExecutedTool, skillContext, effectivePromptOverride
              );

              if (!shouldContinue) {
                finalAnswer = await this.generateFinalAnswerFromSteps(
                  message, steps, context,
                  effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
                );

                if (this.config.enableOutputValidation && formattedKnowledge.length > 0) {
                  const validationResult = await this.validateAndCorrectOutput(
                    finalAnswer,
                    formattedKnowledge,
                    message,
                    steps,
                    context,
                    effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
                  );
                  finalAnswer = validationResult.correctedAnswer;
                  knowledgeReferences = validationResult.validatedReferences;
                }

                steps.push({
                  type: 'final_answer',
                  content: finalAnswer,
                  timestamp: Date.now(),
                });
                break;
              }

              // 继续下一次迭代
              continue;
            } catch (parallelError) {
              // 并行执行失败，回退到串行模式
              const errorMessage = parallelError instanceof Error ? parallelError.message : String(parallelError);
              logger.warn('Parallel execution failed, falling back to sequential', {
                error: errorMessage,
                requestId: executionContext?.requestId,
              });

              // Requirements 3.2, 3.3, 3.4, 3.5 (ai-ops-code-review-fixes): 精确回滚
              // 使用 rollbackPoint 精确移除所有在并行执行期间添加的步骤
              if (rollbackPoint >= 0 && rollbackPoint <= steps.length) {
                const stepsToRemove = steps.length - rollbackPoint;
                if (stepsToRemove > 0) {
                  logger.info('Rolling back parallel execution steps', {
                    rollbackPoint,
                    currentLength: steps.length,
                    stepsToRemove,
                    requestId: executionContext?.requestId,
                  });
                  steps.splice(rollbackPoint);
                }
              } else {
                logger.warn('Invalid rollback point, skipping rollback', {
                  rollbackPoint,
                  currentLength: steps.length,
                  requestId: executionContext?.requestId,
                });
              }

              // 使用 fallbackToNextMode 正确更新回退状态
              const nextMode = this.fallbackToNextMode(
                ExecutionMode.PARALLEL,
                errorMessage,
                fallbackState
              );

              if (nextMode === ExecutionMode.SEQUENTIAL) {
                selectedMode = ExecutionMode.SEQUENTIAL;
                // 继续标准流程（调用 selectAction）
              } else {
                // 无法回退，抛出错误
                throw parallelError;
              }
            }
          }
          // 如果只解析出 0 或 1 个工具调用，继续标准流程（调用 selectAction）
        }

        // Requirement 2.2: 选择 Action（传递 RAGContext、hasExecutedTool 和 skillContext）
        // Requirements: 4.2, 10.2 - 传递 skillContext 到 selectAction
        const correctionsBeforeSelect = allMiddlewareCorrections.length;
        const action = await this.selectAction(
          thought,
          this.getTools(),
          hasExecutedTool,
          steps,
          message,
          ragContext,
          effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature,
          skillContext,
          intentAnalysis.tools
        );

        // 如果没有选择 Action，说明应该生成 Final Answer
        if (!action) {
          // 🔴 韧性模式：如果循环还年轻（工具执行不足或迭代次数少），不立即放弃
          // 给 LLM 一个格式纠正的机会，避免因解析失败而过早终止
          const toolExecutionCount = steps.filter(s => s.type === 'action').length;
          if (iterations < 5 && toolExecutionCount < 3 && nullActionRetryCount < 2) {
            nullActionRetryCount++;
            logger.warn(`selectAction returned null, but loop is young. Injecting format hint and retrying (attempt ${nullActionRetryCount}/2)`, {
              iterations,
              toolExecutionCount,
              hasExecutedTool,
            });

            // 注入格式纠正提示，让 LLM 下一轮输出规范格式
            steps.push({
              type: 'observation',
              content: '⚠️ 系统提示：你的上一次回复未包含有效的工具调用指令。请严格按照以下格式输出：\nThought: [你的思考]\nAction: [工具名称，如 execute_intent、device_query、knowledge_search 等]\nAction Input: {"参数名": "参数值"}\n\n如果你认为已经收集到足够的信息，请输出：\nFinal Answer: [你的最终回答]',
              timestamp: Date.now(),
              success: false,
            });
            continue;
          }

          // 重试次数耗尽或循环已成熟，正常退出
          // Requirements: 2.4, 5.4, 5.5 - 检查是否在没有执行工具的情况下生成 Final Answer
          if (!hasExecutedTool) {
            logger.warn('Generating Final Answer without executing any tool', {
              skillContext: skillContext?.skillName,
              toolPriority: skillContext?.toolPriority,
              iterations,
            });
            diagnosticInfo.terminationReason = 'no_action_without_tool_execution';
          } else {
            diagnosticInfo.terminationReason = 'final_answer';
          }

          // Requirement 2.5: 生成 Final Answer
          finalAnswer = await this.extractFinalAnswer(
            thought, message, steps, context,
            effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
          );

          // Requirements: 2.4, 5.5 - 如果没有执行过工具，添加警告消息
          if (!hasExecutedTool) {
            finalAnswer = `⚠️ 注意：本次分析未能执行任何工具获取实际数据，以下回答基于已有知识。\n\n${finalAnswer}`;
          }

          // 智能知识应用: 8.2, 9.4 - 输出验证和修正重试
          if (this.config.enableOutputValidation && formattedKnowledge.length > 0) {
            const validationResult = await this.validateAndCorrectOutput(
              finalAnswer,
              formattedKnowledge,
              message,
              steps,
              context,
              effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
            );
            finalAnswer = validationResult.correctedAnswer;
            knowledgeReferences = validationResult.validatedReferences;
          }

          // 记录 Final Answer 步骤
          steps.push({
            type: 'final_answer',
            content: finalAnswer,
            timestamp: Date.now(),
          });
          break;
        }

        // 智能循环检测：检查是否重复调用相同工具和参数
        // Requirements: 7.1, 7.3, 7.5 - 使用增强的循环检测
        let isDuplicate = false;
        if (executionContext) {
          // 清理过期的调用记录
          const now = Date.now();
          executionContext.toolCallPatterns = executionContext.toolCallPatterns.filter(
            p => now - p.timestamp < this.config.duplicateDetectionWindowMs
          );

          // 使用增强的循环检测函数
          const duplicateCheck = isDuplicateToolCall(
            action.toolName,
            action.toolInput,
            executionContext.toolCallPatterns,
            {
              windowMs: this.config.duplicateDetectionWindowMs,
              maxDuplicates: this.config.maxDuplicateCallsInWindow,
            }
          );
          if (duplicateCheck.isDuplicate) {
            // Knife 3: 不再默默 continue，而是注入一个观察结果告诉 AI：该动作已执行且结果重复，请尝试其他方案。
            steps.push({
              type: 'observation',
              content: `执行失败: 工具 "${action.toolName}" 已使用相同参数调用了 ${duplicateCheck.duplicateCount} 次。请分析原因并尝试使用不同的参数或不同的工具，不要重复错误动作。`,
              timestamp: Date.now(),
              toolOutput: { error: 'DUPLICATE_CALL_THRESHOLD_EXCEEDED', count: duplicateCheck.duplicateCount },
              success: false,
            });
            isDuplicate = true;
          } else {
            // 记录工具调用模式（初始记录，执行后会更新 failed 状态）
            const paramsHash = hashToolParams(action.toolInput);
            const patternEntry = {
              toolName: action.toolName,
              paramsHash,
              timestamp: Date.now(),
              failed: false, // 执行后更新
            };
            executionContext.toolCallPatterns.push(patternEntry);
          }
        }

        // 记录 Action 步骤
        const stepMiddlewareCorrected = allMiddlewareCorrections.length > correctionsBeforeSelect;
        steps.push({
          type: 'action',
          content: `调用工具: ${action.toolName}`,
          timestamp: Date.now(),
          toolName: action.toolName,
          toolInput: action.toolInput,
          middlewareCorrected: stepMiddlewareCorrected || undefined,
        });

        // Requirement 2.3: 执行 Action 并获取 Observation（单个工具调用）
        // 注意：并行执行已在 selectAction 之前处理，这里只处理单个工具调用
        // Requirements: 1.2.1, 1.2.2, 1.2.3, 1.2.4 - 集成反思重试逻辑
        let observation: { output: unknown; duration: number; success: boolean; reflectionUsed?: boolean };

        if (isDuplicate) {
          observation = {
            output: { error: 'DUPLICATE_CALL_THRESHOLD_EXCEEDED' },
            duration: 0,
            success: false
          };
        } else if (action.toolName === 'knowledge_search' && effectiveConfig.knowledgeEnhancedMode) {
          if (effectiveConfig.enableIntelligentRetrieval && !ragContext.hasRetrieved) {
            // 使用智能检索替代简单的 knowledge_search
            observation = await this.executeIntelligentKnowledgeSearch(action.toolInput, ragContext, formattedKnowledge);
          } else {
            observation = await this.executeKnowledgeSearchWithTimeout(action.toolInput, ragContext);
          }
        } else {
          // Requirements: 1.2.1, 1.2.2, 1.2.3, 1.2.4 - 使用带反思的工具执行
          // 当反思能力启用时，工具执行失败会自动触发反思分析和参数修正重试
          if (isCapabilityEnabled('reflection')) {
            const reflectionConfig = getCapabilityConfig('reflection');
            observation = await this.executeWithReflection(
              action.toolName,
              action.toolInput,
              reflectionConfig.maxRetries,
              steps, // 传递 steps 以记录反思步骤
              effectiveInterceptors,
              executionContext?.routerosClient,
              executionContext?.tickDeviceId
            );

            // 如果使用了反思重试，记录到日志
            if (observation.reflectionUsed) {
              logger.info('Reflection retry was used for tool execution', {
                toolName: action.toolName,
                success: observation.success,
                requestId: executionContext?.requestId,
              });
            }
          } else {
            // 反思能力未启用，直接执行
            observation = await this.executeAction(action.toolName, action.toolInput, effectiveInterceptors, executionContext?.routerosClient, executionContext?.tickDeviceId);
          }
        }

        // Requirements: 2.5, 10.3 - 更新 hasExecutedTool 状态
        hasExecutedTool = true;
        // 同时更新执行上下文中的状态
        if (executionContext) {
          executionContext.hasExecutedTool = true;
          // 缺陷 B 修复：更新工具调用模式的失败状态，供后续重复检测使用
          if (!observation.success && executionContext.toolCallPatterns.length > 0) {
            const lastPattern = executionContext.toolCallPatterns[executionContext.toolCallPatterns.length - 1];
            if (lastPattern.toolName === action.toolName) {
              lastPattern.failed = true;
            }
          }
        }

        // Requirements: 2.1, 2.4 - 工具反馈闭环：记录工具执行指标
        try {
          if (isCapabilityEnabled('toolFeedback')) {
            toolFeedbackCollector.recordMetric({
              toolName: action.toolName,
              timestamp: Date.now(),
              duration: observation.duration,
              success: observation.success,
              errorMessage: observation.success ? undefined : String(observation.output),
            });
          }
        } catch (toolFeedbackError) {
          // 工具反馈记录失败不影响主流程
          logger.warn('Failed to record tool feedback metric', {
            error: toolFeedbackError instanceof Error ? toolFeedbackError.message : String(toolFeedbackError),
          });
        }

        // 如果是 knowledge_search，存储结果到 RAGContext
        if (action.toolName === 'knowledge_search') {
          this.storeKnowledgeResults(observation, ragContext);
        }

        // 智能数据摘要：如果数据量超过阈值，自动进行摘要处理
        let processedObservation = observation;
        if (this.config.enableSmartSummarization && observation.success) {
          const summarizationResult = await this.smartSummarizeIfNeeded(
            observation.output,
            action.toolName,
            message,
            context,
            effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
          );
          if (summarizationResult.wasSummarized) {
            processedObservation = {
              ...observation,
              output: summarizationResult.summarizedOutput,
            };
            // 记录摘要信息到推理步骤
            steps.push({
              type: 'thought',
              content: `📊 数据摘要：原始数据 ${summarizationResult.originalSize} 字符，已智能提炼为 ${summarizationResult.summarizedSize} 字符的关键要点。`,
              timestamp: Date.now(),
            });
          }
        }

        // 记录 Observation 步骤（使用处理后的数据）
        steps.push({
          type: 'observation',
          content: this.formatObservation(processedObservation.output, processedObservation.success),
          timestamp: Date.now(),
          toolOutput: processedObservation.output,
          duration: observation.duration,
          success: observation.success,
        });

        // 需求 3.2, 3.4: 操作后验证注入（统一使用 VERIFICATION_DIRECTIVE_TEMPLATES）
        // 旧的 INTENT_VERIFICATION_MAP 路径已移除，所有验证均通过 verification_directive 完成
        if (observation.success && action.toolName === 'execute_intent') {
          const toolInput = action.toolInput as Record<string, unknown>;
          const intentAction = toolInput.action as string;
          if (intentAction) {
            // 需求 3.2, 3.4: 检测 VerificationDirective — LLM 驱动的强制验证闭环
            // 从工具输出中提取 verification_directive（由 executeIntent 注入到 IntentResult）
            if (observation.success) {
              try {
                const intentOutput = observation.output as Record<string, unknown> | null;
                const vd = intentOutput?.verification_directive as import('../brain/intentRegistry').VerificationDirective | undefined;
                if (vd) {
                  pendingVerificationDirective = vd;
                  pendingVerificationAction = intentAction;
                  stepsWithoutVerification = 0;
                  // 注入系统消息，要求 LLM 在下一步执行验证查询
                  steps.push({
                    type: 'thought' as ReActStepType,
                    content: `[SYSTEM VERIFICATION REQUIRED] 操作 "${intentAction}" 已执行，必须验证结果。` +
                      `\n请立即调用 execute_intent(action="${vd.verify_action}", ...) 验证以下条件：` +
                      `\n期望条件: ${vd.expected_condition}` +
                      `\n验证参数: ${JSON.stringify(vd.verify_params)}` +
                      `\n⚠️ 如果你在接下来 ${VERIFICATION_AUTO_TRIGGER_STEPS} 步内未执行验证，系统将自动执行。`,
                    timestamp: Date.now(),
                  });
                  logger.info('[VerificationDirective] Injected verification requirement', {
                    intentAction,
                    verifyAction: vd.verify_action,
                    requestId: executionContext?.requestId,
                  });
                }
              } catch { /* 提取失败不阻断主流程 */ }
            }
          }
        }

        // 需求 3.4, 3.5: 追踪 LLM 是否执行了验证查询
        if (pendingVerificationDirective && action.toolName === 'execute_intent') {
          const toolInput = action.toolInput as Record<string, unknown>;
          if (toolInput.action === pendingVerificationDirective.verify_action) {
            // LLM 主动执行了验证 — 注入分析提示
            steps.push({
              type: 'thought' as ReActStepType,
              content: observation.success
                ? `[VERIFICATION COMPLETE] 验证查询 "${pendingVerificationDirective.verify_action}" 已执行。` +
                  `\n期望条件: ${pendingVerificationDirective.expected_condition}` +
                  `\n请分析返回结果，判断条件是否满足。如不满足，需分析原因并采取补救措施。`
                : `[VERIFICATION FAILED] 验证查询 "${pendingVerificationDirective.verify_action}" 执行失败。` +
                  `\n请分析失败原因，考虑是否需要回滚操作 "${pendingVerificationAction}"。`,
              timestamp: Date.now(),
            });
            logger.info('[VerificationDirective] LLM executed verification query', {
              verifyAction: pendingVerificationDirective.verify_action,
              success: observation.success,
              requestId: executionContext?.requestId,
            });
            pendingVerificationDirective = null;
            pendingVerificationAction = null;
            stepsWithoutVerification = 0;
          } else {
            stepsWithoutVerification++;
          }
        } else if (pendingVerificationDirective) {
          stepsWithoutVerification++;
        }

        // 需求 3.5: 超过 2 步未验证 → 系统自动执行验证查询
        if (pendingVerificationDirective && stepsWithoutVerification >= VERIFICATION_AUTO_TRIGGER_STEPS) {
          const vd = pendingVerificationDirective;
          const originalAction = pendingVerificationAction;
          pendingVerificationDirective = null;
          pendingVerificationAction = null;
          stepsWithoutVerification = 0;
          try {
            const { executeIntent: executeRegisteredIntent } = await import('../brain/intentRegistry');
            const autoVerifyParams = { ...vd.verify_params, _client: executionContext?.routerosClient } as IntentParams;
            const autoVerifyResult = await executeRegisteredIntent(vd.verify_action, autoVerifyParams);
            steps.push({
              type: 'observation' as ReActStepType,
              content: autoVerifyResult.success
                ? `✅ [系统自动验证] 操作 "${originalAction}" 验证已自动执行。` +
                  `\n期望条件: ${vd.expected_condition}` +
                  `\n结果: ${JSON.stringify(autoVerifyResult.output).slice(0, 300)}` +
                  `\n请分析结果是否满足期望条件，如不满足需采取补救措施。`
                : `⚠️ [系统自动验证失败] "${vd.verify_action}" 执行失败: ${autoVerifyResult.error}`,
              timestamp: Date.now(),
              toolOutput: autoVerifyResult.output,
              success: autoVerifyResult.success,
            });
            logger.warn('[VerificationDirective] Auto-triggered verification (LLM did not verify in time)', {
              originalAction,
              verifyAction: vd.verify_action,
              success: autoVerifyResult.success,
              requestId: executionContext?.requestId,
            });
          } catch (autoVerifyErr) {
            logger.warn('[VerificationDirective] Auto-verification failed', {
              verifyAction: vd.verify_action,
              error: autoVerifyErr instanceof Error ? autoVerifyErr.message : String(autoVerifyErr),
              requestId: executionContext?.requestId,
            });
          }
        }

        // 若仍有待验证指令，强制进入下一轮，避免执行单一工具后提前退出
        if (pendingVerificationDirective) {
          logger.info('[VerificationDirective] Pending verification directive detected, forcing another iteration', {
            verifyAction: pendingVerificationDirective.verify_action,
            requestId: executionContext?.requestId,
          });
          continue;
        }

        // Requirement 2.4: 判断是否需要继续循环
        // Requirements: 5.1, 5.2, 10.2 - 传递 hasExecutedTool 和 skillContext 到 shouldContinue
        const shouldContinue = await this.shouldContinue(
          steps, message,
          effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature,
          hasExecutedTool, skillContext, effectivePromptOverride
        );
        if (!shouldContinue) {
          // 生成 Final Answer
          finalAnswer = await this.generateFinalAnswerFromSteps(
            message, steps, context,
            effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
          );

          // 智能知识应用: 8.2, 9.4 - 输出验证和修正重试
          if (this.config.enableOutputValidation && formattedKnowledge.length > 0) {
            const validationResult = await this.validateAndCorrectOutput(
              finalAnswer,
              formattedKnowledge,
              message,
              steps,
              context,
              effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
            );
            finalAnswer = validationResult.correctedAnswer;
            knowledgeReferences = validationResult.validatedReferences;
          }

          steps.push({
            type: 'final_answer',
            content: finalAnswer,
            timestamp: Date.now(),
          });
          break;
        }
      }

      // Requirement 2.5: 达到最大迭代次数
      if (iterations >= effectiveConfig.maxIterations && !finalAnswer) {
        reachedMaxIterations = true;
        diagnosticInfo.terminationReason = 'max_iterations';

        // Requirements: 5.4 - 记录错误诊断信息
        logger.warn('Reached max iterations', {
          iterations,
          hasExecutedTool,
          skillContext: skillContext?.skillName,
          toolPriority: skillContext?.toolPriority,
          thoughtCount: diagnosticInfo.thoughts.length,
        });

        finalAnswer = await this.generateForcedFinalAnswer(
          message, steps, context,
          effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
        );

        // Requirements: 5.5 - 如果没有执行过工具，添加警告消息
        if (!hasExecutedTool) {
          finalAnswer = `⚠️ 注意：达到最大迭代次数但未能执行任何工具获取实际数据。\n\n${finalAnswer}`;
        }

        steps.push({
          type: 'final_answer',
          content: finalAnswer,
          timestamp: Date.now(),
        });
      }

      // 智能知识应用: 11.1 - 记录知识使用
      if (this.config.enableUsageTracking && knowledgeReferences.length > 0) {
        await this.trackKnowledgeUsage(knowledgeReferences, message);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('ReAct loop error', { error: errorMessage });

      // 生成错误恢复的 Final Answer
      finalAnswer = `抱歉，在处理您的请求时遇到了问题: ${errorMessage}。基于已收集的信息，${this.summarizeSteps(steps)}`;

      steps.push({
        type: 'final_answer',
        content: finalAnswer,
        timestamp: Date.now(),
      });
    }

    const totalDuration = Date.now() - startTime;

    // Requirements: 7.3 - 记录模式选择准确性
    if (parallelEnabled && modeSelectionResult) {
      const actualToolCalls = steps.filter(s => s.type === 'action').length;
      parallelExecutionMetrics.recordModeSelectionAccuracy(
        modeSelectionResult.estimatedToolCalls,
        actualToolCalls,
        selectedMode
      );
    }

    // Requirements: 8.1, 8.4 - 记录完整的诊断信息
    logger.info('ReAct loop completed', {
      iterations,
      stepCount: steps.length,
      reachedMaxIterations,
      totalDuration,
      hasExecutedTool,
      ragContextHasRetrieved: ragContext.hasRetrieved,
      ragContextDocumentCount: ragContext.documents.length,
      intelligentRetrievalUsed: !!intelligentRetrievalResult,
      knowledgeReferencesCount: knowledgeReferences.length,
      requestId: executionContext?.requestId || 'legacy',
      skillContext: skillContext?.skillName,
      terminationReason: diagnosticInfo.terminationReason,
      parallelMode: parallelEnabled ? selectedMode : 'disabled',
      modeSelectionConfidence: modeSelectionResult?.confidence,
    });

    // ==================== 持续学习：记录操作序列 (Requirements: 5.1, 5.6) ====================
    try {
      if (isCapabilityEnabled('continuousLearning')) {
        const clConfig = getCapabilityConfig('continuousLearning');
        if (clConfig.patternLearningEnabled) {
          const toolNames = steps.filter(s => s.toolName).map(s => s.toolName!);
          continuousLearner.recordOperation(executionContext.requestId, {
            userId: executionContext.requestId,
            sessionId: executionContext.requestId,
            toolName: toolNames.join(',') || 'react_execution',
            parameters: {
              type: 'react_execution',
              tools: toolNames,
              iterations,
            },
            result: finalAnswer ? 'success' : 'failure',
            timestamp: Date.now(),
            context: {
              totalDuration,
              reachedMaxIterations,
              stepCount: steps.length,
            },
          });
        }
      }
    } catch (clError) {
      // 持续学习记录失败不影响主流程
      logger.warn('Failed to record continuous learning operation', {
        error: clError instanceof Error ? clError.message : String(clError),
        requestId: executionContext.requestId,
      });
    }

    // ==================== 自动反思：生成学习条目 (B: 自动反馈机制) ====================
    try {
      if (isCapabilityEnabled('reflection')) {
        const toolSteps = steps.filter(s => s.type === 'action');
        // 🔴 FIX: 之前检查 action step 的 success 字段，但 action step 没有 success 字段（只有 observation 有）
        // 导致 failedSteps 永远为空，反思模块永远报告"成功"，即使工具实际全部失败
        // 修复：查找每个 action step 对应的 observation step，用 observation 的 success 判断
        const failedSteps = toolSteps.filter(s => {
            const idx = steps.indexOf(s);
            const nextObs = steps.slice(idx + 1).find(obs => obs.type === 'observation');
            // 🟡 FIX (Gemini audit round 2): 与 autonomousBrainService 保持一致的 fail-safe 逻辑
            // 缺失 observation 或 success 为 undefined 时视为失败，确保反思模块能捕获所有异常
            return !(nextObs?.success ?? false);
        });

        // 主动式 Reflexion: 每次有工具调用都反思，不只是失败时
        if (toolSteps.length > 0) {
          const toolNames = toolSteps.map(s => s.toolName || 'unknown');
          const uniqueTools = [...new Set(toolNames)];

          // 区分成功/失败/复杂场景，生成不同的学习模式
          let failurePattern: string;
          let rootCause: string;
          let confidence: number;

          // 缺陷 E 修复：基于实际执行结果计算置信度
          const totalToolCalls = toolSteps.length;
          const successfulToolCalls = toolSteps.filter(s => {
            const idx = steps.indexOf(s);
            const nextObs = steps.slice(idx + 1).find(obs => obs.type === 'observation');
            return nextObs?.success === true;
          }).length;
          const successRate = totalToolCalls > 0 ? successfulToolCalls / totalToolCalls : 0;

          // 检查是否有实质性数据返回
          const hasSubstantialData = steps.some(s =>
            s.type === 'observation' && s.success === true &&
            s.toolOutput && JSON.stringify(s.toolOutput).length > 50
          );

          if (failedSteps.length > 0) {
            failurePattern = `意图 [${intentAnalysis.intent || '未知'}] 执行失败: ${failedSteps.map(s => s.toolName).join(', ')}`;
            rootCause = `针对意图 [${intentAnalysis.intent || '未知'}]，工具 ${failedSteps.map(s => s.toolName).join(', ')} 执行出错。用户请求: ${message.substring(0, 100)}`;
            // 缺陷 E 修复：即使有失败，如果成功率高且有实质数据，置信度应合理
            confidence = hasSubstantialData && successRate >= 0.5
              ? 0.6 + successRate * 0.2  // 0.7-0.8
              : 0.4 + successRate * 0.3; // 0.4-0.7
          } else if (reachedMaxIterations) {
            failurePattern = `意图 [${intentAnalysis.intent || '未知'}] 达到最大迭代次数`;
            rootCause = `请求处理复杂度高，超过迭代限制。意图: ${intentAnalysis.intent}, 请求: ${message.substring(0, 100)}`;
            // 缺陷 E 修复：达到最大迭代但有成功数据时，置信度不应过低
            confidence = hasSubstantialData ? 0.65 + successRate * 0.15 : 0.5;
          } else {
            failurePattern = `意图解决 [${intentAnalysis.intent || '直接回答'}]: ${message.substring(0, 60)}${message.length > 60 ? '...' : ''}`;
            rootCause = `使用 ${uniqueTools.length > 0 ? uniqueTools.join(' + ') : '直接回答'} 成功解决用户意图 [${intentAnalysis.intent || '未知'}]。原始请求: ${message}`;
            // 缺陷 E 修复：成功完成且有数据时，置信度不低于 0.75
            confidence = hasSubstantialData ? Math.max(0.75, 0.7 + successRate * 0.2) : 0.7 + successRate * 0.1;
          }

          // 构建学习条目并持久化
          const learningEntry = {
            id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: Date.now(),
            iterationId: executionContext.requestId,
            failurePattern,
            rootCause,
            effectiveSolution: finalAnswer && !reachedMaxIterations
              ? `经过 ${iterations} 步迭代，成功解决意图 [${intentAnalysis.intent || '未知'}]。使用工具: [${uniqueTools.join(', ') || '无'}]。`
              : undefined,
            ineffectiveApproaches: failedSteps.map(s =>
              `${s.toolName}: ${(s.content || '').substring(0, 100)}`
            ),
            contextFactors: {
              totalDuration: `${totalDuration}ms`,
              iterationCount: String(iterations),
              toolCount: String(toolSteps.length),
              originalMessage: message,
              intent: intentAnalysis.intent || '未知',
              intentConfidence: String(intentAnalysis.confidence || 0),
            },
            confidence,
            indexed: false,
          };

          // 持久化到文件
          await reflectorService.persistLearning(learningEntry as any);
          logger.info('Auto-reflection learning entry saved', {
            entryId: learningEntry.id,
            failurePattern: learningEntry.failurePattern,
            requestId: executionContext.requestId,
          });
        }
      }
    } catch (reflectError) {
      // 自动反思失败不影响主流程
      logger.warn('Auto-reflection failed', {
        error: reflectError instanceof Error ? reflectError.message : String(reflectError),
        requestId: executionContext.requestId,
      });
    }

    // ==================== 回退知识生产：reflection 未启用时仍生成知识 ====================
    try {
      if (!isCapabilityEnabled('reflection')) {
        const toolSteps = steps.filter(s => s.type === 'action');
        const successfulObs = steps.filter(s => s.type === 'observation' && s.success === true);
        // 有工具调用且有成功结果时，生成知识条目
        if (toolSteps.length > 0 && successfulObs.length > 0) {
          const toolNames = toolSteps.map(s => s.toolName || 'unknown');
          const uniqueTools = [...new Set(toolNames)];
          const successRate = successfulObs.length / toolSteps.length;

          const fallbackEntry = {
            id: `fallback_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: Date.now(),
            iterationId: executionContext.requestId,
            failurePattern: `意图解决 [${intentAnalysis.intent || '直接回答'}]: ${message.substring(0, 60)}${message.length > 60 ? '...' : ''}`,
            rootCause: `使用 ${uniqueTools.join(' + ')} 处理用户意图 [${intentAnalysis.intent || '未知'}]。原始请求: ${message.substring(0, 200)}`,
            effectiveSolution: finalAnswer
              ? `经过 ${iterations} 步迭代解决。使用工具: [${uniqueTools.join(', ')}]。`
              : undefined,
            ineffectiveApproaches: [] as string[],
            contextFactors: {
              totalDuration: `${totalDuration}ms`,
              iterationCount: String(iterations),
              toolCount: String(toolSteps.length),
              originalMessage: message,
              intent: intentAnalysis.intent || '未知',
              source: 'fallback_no_reflection',
            },
            confidence: finalAnswer ? Math.max(0.7, 0.6 + successRate * 0.3) : 0.5 + successRate * 0.2,
            indexed: false,
          };

          await reflectorService.persistLearning(fallbackEntry as any);
          logger.info('Fallback knowledge entry saved (reflection disabled)', {
            entryId: fallbackEntry.id,
            intent: intentAnalysis.intent,
            requestId: executionContext.requestId,
          });
        }
      }
    } catch (fallbackKnowledgeError) {
      logger.warn('Fallback knowledge production failed (non-critical)', {
        error: fallbackKnowledgeError instanceof Error ? fallbackKnowledgeError.message : String(fallbackKnowledgeError),
        requestId: executionContext.requestId,
      });
    }

    // ==================== 经验反馈闭环: 成功时更新经验使用计数和置信度 ====================
    try {
      if (finalAnswer && !reachedMaxIterations && isCapabilityEnabled('reflection')) {
        // 检索本次使用的经验（与 buildReActPromptAsync 中相同的查询）
        const usedExperiences = await this.retrieveExperiences(message);
        if (usedExperiences.length > 0) {
          const { knowledgeBase } = await import('./index');
          for (const exp of usedExperiences) {
            try {
              // 优先使用 knowledgeEntryId（知识库条目 ID），回退到 exp.id
              const kbId = (exp as any).knowledgeEntryId || exp.id;
              await knowledgeBase.recordUsage(kbId);
              logger.debug(`Experience usage recorded: ${kbId} (source: ${exp.id})`);
            } catch {
              // 单条经验更新失败不影响其他
            }
          }
        }
      }
    } catch (feedbackError) {
      logger.debug('Experience feedback loop failed (non-critical)', {
        error: feedbackError instanceof Error ? feedbackError.message : String(feedbackError),
      });
    }

    return {
      steps,
      finalAnswer,
      iterations,
      reachedMaxIterations,
      totalDuration,
      ragContext: effectiveConfig.knowledgeEnhancedMode ? ragContext : undefined,
      intelligentRetrievalResult,
      knowledgeReferences: knowledgeReferences.length > 0 ? knowledgeReferences : undefined,
      fallbackInfo: this.buildFallbackInfo(fallbackState), // Fix 3: 包含回退信息
      usedLearningEntryIds: (executionContext.conversationContext?.usedLearningEntryIds as string[]) ?? undefined,
      middlewareCorrections: allMiddlewareCorrections.length > 0 ? allMiddlewareCorrections : undefined,
    };
  }

  /**
   * 知识蒸馏：从工具执行结果中提取知识条目并持久化
   * 修复：intent-driven 和 PLANNED 模式的早期返回路径之前缺少此逻辑，
   * 导致这些路径执行的工具结果不会被写入知识库。
   */
  private async produceKnowledgeEntry(params: {
    steps: ReActStep[];
    message: string;
    finalAnswer: string;
    iterations: number;
    reachedMaxIterations: boolean;
    totalDuration: number;
    executionContext: ReActExecutionContext;
    intentAnalysis: IntentAnalysis;
  }): Promise<void> {
    const { steps, message, finalAnswer, iterations, reachedMaxIterations, totalDuration, executionContext, intentAnalysis } = params;

    // Path 1: reflection 启用时，生成完整学习条目
    try {
      if (isCapabilityEnabled('reflection')) {
        const toolSteps = steps.filter(s => s.type === 'action');
        const failedSteps = toolSteps.filter(s => {
          const idx = steps.indexOf(s);
          const nextObs = steps.slice(idx + 1).find(obs => obs.type === 'observation');
          return !(nextObs?.success ?? false);
        });

        if (toolSteps.length > 0) {
          const toolNames = toolSteps.map(s => s.toolName || 'unknown');
          const uniqueTools = [...new Set(toolNames)];

          const totalToolCalls = toolSteps.length;
          const successfulToolCalls = toolSteps.filter(s => {
            const idx = steps.indexOf(s);
            const nextObs = steps.slice(idx + 1).find(obs => obs.type === 'observation');
            return nextObs?.success === true;
          }).length;
          const successRate = totalToolCalls > 0 ? successfulToolCalls / totalToolCalls : 0;

          const hasSubstantialData = steps.some(s =>
            s.type === 'observation' && s.success === true &&
            s.toolOutput && JSON.stringify(s.toolOutput).length > 50
          );

          let failurePattern: string;
          let rootCause: string;
          let confidence: number;

          if (failedSteps.length > 0) {
            failurePattern = `意图 [${intentAnalysis.intent || '未知'}] 执行失败: ${failedSteps.map(s => s.toolName).join(', ')}`;
            rootCause = `针对意图 [${intentAnalysis.intent || '未知'}]，工具 ${failedSteps.map(s => s.toolName).join(', ')} 执行出错。用户请求: ${message.substring(0, 100)}`;
            confidence = hasSubstantialData && successRate >= 0.5
              ? 0.6 + successRate * 0.2
              : 0.4 + successRate * 0.3;
          } else if (reachedMaxIterations) {
            failurePattern = `意图 [${intentAnalysis.intent || '未知'}] 达到最大迭代次数`;
            rootCause = `请求处理复杂度高，超过迭代限制。意图: ${intentAnalysis.intent}, 请求: ${message.substring(0, 100)}`;
            confidence = hasSubstantialData ? 0.65 + successRate * 0.15 : 0.5;
          } else {
            failurePattern = `意图解决 [${intentAnalysis.intent || '直接回答'}]: ${message.substring(0, 60)}${message.length > 60 ? '...' : ''}`;
            rootCause = `使用 ${uniqueTools.length > 0 ? uniqueTools.join(' + ') : '直接回答'} 成功解决用户意图 [${intentAnalysis.intent || '未知'}]。原始请求: ${message}`;
            confidence = hasSubstantialData ? Math.max(0.75, 0.7 + successRate * 0.2) : 0.7 + successRate * 0.1;
          }

          const learningEntry = {
            id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: Date.now(),
            iterationId: executionContext.requestId,
            failurePattern,
            rootCause,
            effectiveSolution: finalAnswer && !reachedMaxIterations
              ? `经过 ${iterations} 步迭代，成功解决意图 [${intentAnalysis.intent || '未知'}]。使用工具: [${uniqueTools.join(', ') || '无'}]。`
              : undefined,
            ineffectiveApproaches: failedSteps.map(s =>
              `${s.toolName}: ${(s.content || '').substring(0, 100)}`
            ),
            contextFactors: {
              totalDuration: `${totalDuration}ms`,
              iterationCount: String(iterations),
              toolCount: String(toolSteps.length),
              originalMessage: message,
              intent: intentAnalysis.intent || '未知',
              intentConfidence: String(intentAnalysis.confidence || 0),
            },
            confidence,
            indexed: false,
          };

          await reflectorService.persistLearning(learningEntry as any);
          logger.info('Auto-reflection learning entry saved', {
            entryId: learningEntry.id,
            failurePattern: learningEntry.failurePattern,
            requestId: executionContext.requestId,
          });
        }
      }
    } catch (reflectError) {
      logger.warn('Auto-reflection failed (produceKnowledgeEntry)', {
        error: reflectError instanceof Error ? reflectError.message : String(reflectError),
        requestId: executionContext.requestId,
      });
    }

    // Path 2: reflection 未启用时，生成回退知识条目
    try {
      if (!isCapabilityEnabled('reflection')) {
        const toolSteps = steps.filter(s => s.type === 'action');
        const successfulObs = steps.filter(s => s.type === 'observation' && s.success === true);
        if (toolSteps.length > 0 && successfulObs.length > 0) {
          const toolNames = toolSteps.map(s => s.toolName || 'unknown');
          const uniqueTools = [...new Set(toolNames)];
          const successRate = successfulObs.length / toolSteps.length;

          const fallbackEntry = {
            id: `fallback_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            timestamp: Date.now(),
            iterationId: executionContext.requestId,
            failurePattern: `意图解决 [${intentAnalysis.intent || '直接回答'}]: ${message.substring(0, 60)}${message.length > 60 ? '...' : ''}`,
            rootCause: `使用 ${uniqueTools.join(' + ')} 处理用户意图 [${intentAnalysis.intent || '未知'}]。原始请求: ${message.substring(0, 200)}`,
            effectiveSolution: finalAnswer
              ? `经过 ${iterations} 步迭代解决。使用工具: [${uniqueTools.join(', ')}]。`
              : undefined,
            ineffectiveApproaches: [] as string[],
            contextFactors: {
              totalDuration: `${totalDuration}ms`,
              iterationCount: String(iterations),
              toolCount: String(toolSteps.length),
              originalMessage: message,
              intent: intentAnalysis.intent || '未知',
              source: 'fallback_no_reflection',
            },
            confidence: finalAnswer ? Math.max(0.7, 0.6 + successRate * 0.3) : 0.5 + successRate * 0.2,
            indexed: false,
          };

          await reflectorService.persistLearning(fallbackEntry as any);
          logger.info('Fallback knowledge entry saved (reflection disabled)', {
            entryId: fallbackEntry.id,
            intent: intentAnalysis.intent,
            requestId: executionContext.requestId,
          });
        }
      }
    } catch (fallbackKnowledgeError) {
      logger.warn('Fallback knowledge production failed (non-critical)', {
        error: fallbackKnowledgeError instanceof Error ? fallbackKnowledgeError.message : String(fallbackKnowledgeError),
        requestId: executionContext.requestId,
      });
    }
  }

  /**
   * 执行智能知识检索
   * Requirements: 8.1 - 使用 IntelligentRetriever 替代简单的 knowledge_search
   */
  private async performIntelligentRetrieval(query: string): Promise<{
    documents: FormattedKnowledge[];
    retrievalTime: number;
    rewrittenQueries: string[];
    degradedMode: boolean;
  } | null> {
    try {
      // 确保智能检索器已初始化
      if (!this.intelligentRetriever.isInitialized()) {
        await this.intelligentRetriever.initialize();
      }

      const result = await this.intelligentRetriever.retrieve(query, {
        topK: 5,
        minScore: 0.3,
        includeFullContent: true,
        timeout: this.config.knowledgeSearchTimeout,
      });

      return {
        documents: result.documents,
        retrievalTime: result.retrievalTime,
        rewrittenQueries: result.rewrittenQueries,
        degradedMode: result.degradedMode,
      };
    } catch (error) {
      logger.error('Intelligent retrieval failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 执行智能知识搜索（作为工具调用）
   * Requirements: 8.1 - 使用 IntelligentRetriever 替代简单的 knowledge_search
   */
  private async executeIntelligentKnowledgeSearch(
    toolInput: Record<string, unknown>,
    ragContext: RAGContext,
    formattedKnowledge: FormattedKnowledge[]
  ): Promise<{ output: unknown; duration: number; success: boolean }> {
    const startTime = Date.now();
    const query = toolInput.query as string || '';

    try {
      const result = await this.performIntelligentRetrieval(query);

      if (!result) {
        return {
          output: { error: '智能检索失败', results: [] },
          duration: Date.now() - startTime,
          success: false,
        };
      }

      // 更新 formattedKnowledge（通过引用）
      formattedKnowledge.length = 0;
      formattedKnowledge.push(...result.documents);

      // 更新 RAGContext
      ragContext.hasRetrieved = true;
      ragContext.retrievalTime = result.retrievalTime;
      ragContext.documents = result.documents.map(doc => ({
        id: doc.referenceId,
        title: doc.title,
        type: doc.type,
        score: doc.credibilityScore,
        excerpt: doc.content.substring(0, 500),
        metadata: doc.metadata as unknown as Record<string, unknown>,
      }));

      return {
        output: {
          success: true,
          count: result.documents.length,
          results: result.documents.map(doc => ({
            id: doc.entryId,
            referenceId: doc.referenceId,
            title: doc.title,
            type: doc.type,
            score: doc.credibilityScore,
            content: doc.content,
            metadata: doc.metadata as unknown as Record<string, unknown>,
          })),
          retrievalTime: result.retrievalTime,
          rewrittenQueries: result.rewrittenQueries,
          degradedMode: result.degradedMode,
        },
        duration: Date.now() - startTime,
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        output: { error: errorMessage, results: [] },
        duration: Date.now() - startTime,
        success: false,
      };
    }
  }

  /**
   * 验证并修正输出
   * Requirements: 8.2, 9.4 - 输出验证和修正重试（最多 2 次）
   * Requirements: 1.3.1, 1.3.2, 1.3.3, 1.3.4 - 输出验证失败时触发反思处理
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async validateAndCorrectOutput(
    answer: string,
    formattedKnowledge: FormattedKnowledge[],
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<{
    correctedAnswer: string;
    validatedReferences: TrackedKnowledgeReference[];
    correctionAttempts: number;
    reflectionUsed?: boolean;
  }> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    let currentAnswer = answer;
    let correctionAttempts = 0;
    const maxRetries = this.config.maxValidationRetries;
    let reflectionUsed = false;

    // 构建知识引用映射
    const knowledgeMap = new Map<string, FormattedKnowledge>();
    for (const doc of formattedKnowledge) {
      knowledgeMap.set(doc.referenceId, doc);
    }

    while (correctionAttempts < maxRetries) {
      // 验证输出
      const validationResult = this.outputValidator.validate(currentAnswer, formattedKnowledge);

      if (validationResult.isValid) {
        // 验证通过，返回结果
        return {
          correctedAnswer: currentAnswer,
          validatedReferences: validationResult.references.map(ref => {
            const refId = ref.fullText.replace(/[\[\]]/g, '');
            const knowledge = knowledgeMap.get(refId);
            return {
              referenceId: refId,
              entryId: knowledge?.entryId || '',
              title: knowledge?.title || '',
              type: knowledge?.type || 'unknown',
              isValid: true,
              score: knowledge?.credibilityScore,
            };
          }),
          correctionAttempts,
          reflectionUsed,
        };
      }

      // 验证失败，尝试修正
      correctionAttempts++;
      logger.info('Output validation failed, attempting correction', {
        attempt: correctionAttempts,
        invalidReferences: validationResult.invalidReferences.map(r => r.fullText),
      });

      // Requirements: 1.3.1, 1.3.2, 1.3.3, 1.3.4 - 输出验证失败时触发反思处理
      if (isCapabilityEnabled('reflection')) {
        reflectionUsed = true;

        // 构建包含错误信息的反思分析
        const validationError = new Error(
          `Output validation failed: ${validationResult.invalidReferences.length} invalid references found - ${validationResult.invalidReferences.map(r => r.fullText).join(', ')}`
        );

        // 分析验证失败原因
        const failureAnalysis = await this.analyzeValidationFailure(
          currentAnswer,
          validationResult,
          formattedKnowledge
        );

        // 记录反思步骤到 steps
        steps.push({
          type: 'reflection',
          content: `输出验证反思: 发现 ${validationResult.invalidReferences.length} 个无效引用 - ${failureAnalysis.summary}`,
          timestamp: Date.now(),
          failureAnalysis: {
            failureType: 'parameter_error' as FailureType,
            possibleCauses: failureAnalysis.causes,
            suggestions: failureAnalysis.suggestions,
            confidence: failureAnalysis.confidence,
            originalError: validationError.message,
          },
        });

        // 使用反思分析结果构建更精确的修正提示词
        const reflectionCorrectionPrompt = this.buildReflectionCorrectionPrompt(
          currentAnswer,
          validationResult,
          formattedKnowledge,
          failureAnalysis
        );

        // 调用 LLM 进行修正
        if (adapter) {
          try {
            const correctedResponse = await this.callLLMSimple(reflectionCorrectionPrompt, adapter, provider, model, temperature);
            currentAnswer = correctedResponse;
            continue;
          } catch (error) {
            logger.warn('Failed to correct output with reflection', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // 构建修正提示词（非反思模式或反思失败时的回退）
      const correctionPrompt = this.outputValidator.buildCorrectionPrompt(
        currentAnswer,
        validationResult,
        formattedKnowledge
      );

      // 调用 LLM 进行修正（使用请求级别的适配器）
      if (adapter) {
        try {
          const correctedResponse = await this.callLLMSimple(correctionPrompt, adapter, provider, model, temperature);
          currentAnswer = correctedResponse;
        } catch (error) {
          logger.warn('Failed to correct output', {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      } else {
        break;
      }
    }

    // 返回最终结果（可能仍有无效引用）
    const finalValidation = this.outputValidator.validate(currentAnswer, formattedKnowledge);
    return {
      correctedAnswer: currentAnswer,
      validatedReferences: finalValidation.references.map(ref => {
        const refId = ref.fullText.replace(/[\[\]]/g, '');
        const knowledge = knowledgeMap.get(refId);
        const isValid = finalValidation.validReferences.some(vr => vr.fullText === ref.fullText);
        return {
          referenceId: refId,
          entryId: knowledge?.entryId || '',
          title: knowledge?.title || '',
          type: knowledge?.type || 'unknown',
          isValid,
          score: knowledge?.credibilityScore,
        };
      }),
      correctionAttempts,
      reflectionUsed,
    };
  }

  /**
   * 分析输出验证失败原因
   * Requirements: 1.3.1, 1.3.2 - 分析验证失败的具体原因
   * 
   * @param answer 当前答案
   * @param validationResult 验证结果
   * @param formattedKnowledge 格式化的知识
   * @returns 失败分析结果
   */
  private async analyzeValidationFailure(
    answer: string,
    validationResult: { invalidReferences: Array<{ fullText: string }>; validReferences: Array<{ fullText: string }> },
    formattedKnowledge: FormattedKnowledge[]
  ): Promise<{
    summary: string;
    causes: string[];
    suggestions: string[];
    confidence: number;
  }> {
    const causes: string[] = [];
    const suggestions: string[] = [];

    // 分析无效引用的原因
    for (const invalidRef of validationResult.invalidReferences) {
      const refId = invalidRef.fullText.replace(/[\[\]]/g, '');

      // 检查是否是格式错误
      if (!refId.startsWith('KB-')) {
        causes.push(`引用 "${invalidRef.fullText}" 格式不正确，应使用 [KB-xxx] 格式`);
        suggestions.push(`将 "${invalidRef.fullText}" 修正为正确的知识库引用格式`);
      } else {
        // 检查是否是引用了不存在的知识
        const exists = formattedKnowledge.some(k => k.referenceId === refId);
        if (!exists) {
          causes.push(`引用 "${invalidRef.fullText}" 指向的知识条目不存在`);
          suggestions.push(`移除无效引用 "${invalidRef.fullText}" 或替换为有效的知识库引用`);
        }
      }
    }

    // 生成摘要
    const summary = causes.length > 0
      ? `发现 ${causes.length} 个问题: ${causes[0]}`
      : '验证失败但原因未知';

    // 添加通用建议
    if (formattedKnowledge.length > 0) {
      suggestions.push(`可用的知识库引用: ${formattedKnowledge.slice(0, 3).map(k => k.referenceId).join(', ')}`);
    }

    return {
      summary,
      causes,
      suggestions,
      confidence: causes.length > 0 ? 0.8 : 0.5,
    };
  }

  /**
   * 构建基于反思的修正提示词
   * Requirements: 1.3.3, 1.3.4 - 构建包含错误信息的反思提示词
   * 
   * @param answer 当前答案
   * @param validationResult 验证结果
   * @param formattedKnowledge 格式化的知识
   * @param failureAnalysis 失败分析结果
   * @returns 修正提示词
   */
  private buildReflectionCorrectionPrompt(
    answer: string,
    validationResult: { invalidReferences: Array<{ fullText: string }>; validReferences: Array<{ fullText: string }> },
    formattedKnowledge: FormattedKnowledge[],
    failureAnalysis: { summary: string; causes: string[]; suggestions: string[]; confidence: number }
  ): string {
    const validRefs = formattedKnowledge.map(k => `- ${k.referenceId}: ${k.title}`).join('\n');
    const invalidRefsList = validationResult.invalidReferences.map(r => r.fullText).join(', ');
    const causesList = failureAnalysis.causes.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const suggestionsList = failureAnalysis.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n');

    return `## 输出验证失败 - 反思修正

你的回答中包含无效的知识库引用，需要修正。

### 问题分析
${failureAnalysis.summary}

### 具体原因
${causesList}

### 修正建议
${suggestionsList}

### 无效引用
${invalidRefsList}

### 可用的知识库引用
${validRefs}

### 原始回答
${answer}

### 修正要求
1. 移除或替换所有无效的知识库引用
2. 只使用上面列出的可用知识库引用
3. 保持回答的完整性和准确性
4. 如果某个引用无法找到对应的知识，直接移除该引用

请输出修正后的完整回答：`;
  }

  /**
   * 追踪知识使用
   * Requirements: 11.1 - 记录知识使用
   */
  private async trackKnowledgeUsage(
    references: TrackedKnowledgeReference[],
    query: string
  ): Promise<void> {
    try {
      for (const ref of references) {
        if (ref.isValid && ref.entryId) {
          await this.usageTracker.recordUsage(ref.entryId, {
            query,
            timestamp: Date.now(),
            referenceId: ref.referenceId,
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to track knowledge usage', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 初始化 RAGContext
   * Requirements: 6.1
   */
  private initializeRAGContext(): RAGContext {
    return {
      documents: [],
      retrievalTime: 0,
      query: '',
      hasRetrieved: false,
      error: undefined,
      degradedMode: false,
    };
  }

  /**
   * 存储知识检索结果到 RAGContext
   * Requirements: 6.1, 6.4
   */
  storeKnowledgeResults(
    observation: { output: unknown; duration: number; success: boolean },
    ragContext: RAGContext
  ): void {
    ragContext.retrievalTime = observation.duration;
    ragContext.hasRetrieved = true;

    if (!observation.success) {
      ragContext.error = typeof observation.output === 'object' && observation.output !== null
        ? (observation.output as Record<string, unknown>).error as string || 'Unknown error'
        : 'Knowledge search failed';
      logger.warn('Knowledge search failed', { error: ragContext.error });
      return;
    }

    // 解析检索结果
    try {
      const output = observation.output as Record<string, unknown>;
      const results = output.results as Array<Record<string, unknown>> || [];

      ragContext.documents = results.map((result, index) => ({
        id: (result.id as string) || `doc-${index}`,
        title: (result.title as string) || (result.name as string) || `Document ${index + 1}`,
        type: (result.type as string) || (result.category as string) || 'unknown',
        score: (result.score as number) || (result.similarity as number) || 0,
        excerpt: (result.excerpt as string) || (result.content as string) || (result.summary as string) || '',
        metadata: {
          source: result.source,
          timestamp: result.timestamp,
          ...((result.metadata as Record<string, unknown>) || {}),
        },
      }));

      ragContext.query = (output.query as string) || '';

      logger.info('Knowledge results stored', {
        documentCount: ragContext.documents.length,
        query: ragContext.query,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to parse knowledge results', { error: errorMessage });
      ragContext.error = errorMessage;
    }
  }

  /**
   * 执行带超时的知识检索
   * Requirements: 7.1, 7.2
   */
  private async executeKnowledgeSearchWithTimeout(
    toolInput: Record<string, unknown>,
    ragContext: RAGContext
  ): Promise<{ output: unknown; duration: number; success: boolean }> {
    const startTime = Date.now();
    const timeout = this.config.knowledgeSearchTimeout;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Knowledge search timeout')), timeout);
      });

      const tool = this.tools.get('knowledge_search');
      if (!tool) {
        return {
          output: { error: 'knowledge_search tool not found' },
          duration: Date.now() - startTime,
          success: false,
        };
      }

      const result = await Promise.race([
        tool.execute(toolInput),
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;
      const success = this.isToolResultSuccess(result);

      return { output: result, duration, success };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startTime;

      // 超时或失败时设置降级模式
      if (errorMessage.includes('timeout')) {
        ragContext.degradedMode = true;
        ragContext.error = 'Knowledge search timeout';
        logger.warn('Knowledge search timeout, continuing with fallback', { duration });
      } else {
        ragContext.error = errorMessage;
        logger.error('Knowledge search failed', { error: errorMessage, duration });
      }

      return {
        output: { error: errorMessage },
        duration,
        success: false,
      };
    }
  }


  /**
   * 生成 Thought 并返回原始 LLM 响应
   * Fix: 并行执行分支逻辑链问题修复
   * 
   * 问题：原来的 generateThought 方法只返回 parsed.thought（Thought 部分），
   * 但并行执行需要完整的 LLM 响应来解析 Action 1:, Action Input 1: 等格式。
   * 
   * 此方法返回 { thought, rawResponse }，其中：
   * - thought: 解析后的 Thought 内容（与 generateThought 返回值相同）
   * - rawResponse: 完整的 LLM 原始响应（用于并行工具调用解析）
   * 
   * @returns { thought: string, rawResponse: string }
   */
  async generateThoughtWithRawResponse(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    ragContext?: RAGContext,
    formattedKnowledge?: FormattedKnowledge[],
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectivePromptOverride?: string | null,
    effectiveTemperature?: number,
    hasExecutedTool?: boolean,
    skillContext?: SkillContext,
    conversationContext?: Record<string, unknown>
  ): Promise<{ thought: string; rawResponse: string }> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const promptOverride = effectivePromptOverride ?? this.systemPromptOverride;
    const temperature = effectiveTemperature ?? this.config.temperature;

    // 如果没有 AI 适配器，返回默认 Thought
    if (!adapter) {
      logger.warn('No AI adapter configured, using default thought');
      const defaultThought = this.generateDefaultThought(message, steps, ragContext, skillContext);
      return { thought: defaultThought, rawResponse: '' };
    }

    try {
      // 构建提示词（与 generateThought 相同的逻辑）
      let prompt: string;
      if (promptOverride) {
        prompt = promptOverride;

        const toolDescriptions = this.getTools().map(tool => {
          const params = Object.entries(tool.parameters)
            .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
            .join('\n');
          return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
        }).join('\n\n');

        const stepsText = steps.length > 0
          ? steps.map(s => this.formatStepForPrompt(s)).join('\n')
          : '无';

        prompt = prompt
          .replace('{{message}}', message)
          .replace('{{tools}}', toolDescriptions)
          .replace('{{steps}}', stepsText);

        // 意图丢失修复：安全网检查 - 确保用户消息确实在提示词中
        // 如果 {{message}} 替换失败（模板中没有占位符），强制在提示词开头插入用户消息
        if (message && message.trim() && !prompt.includes(message.trim())) {
          logger.warn('User message not found in prompt after replacement, prepending it', {
            messageLength: message.length,
            promptLength: prompt.length,
          });
          prompt = `## ⚠️ 用户当前请求\n\n「${message}」\n\n请务必针对此请求进行回答。\n\n---\n\n${prompt}`;
        }

        // 检查是否是并行执行提示词（包含并行执行相关内容）
        const isParallelPrompt = promptOverride.includes('并行执行模式') || promptOverride.includes('Action 1:');

        if (hasExecutedTool === false) {
          if (isParallelPrompt) {
            prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。
如果有多个独立的查询需求，请使用并行格式（Action 1:, Action 2:...）同时执行多个工具。`;
          } else {
            prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。
请在你的 Thought 中明确说明你要使用哪个工具，然后输出 Action 和 Action Input。`;
          }
        }

        if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          prompt += `

## Skill 工具优先级
当前 Skill (${skillContext.skillName}) 建议按以下顺序使用工具：
${skillContext.toolPriority.map((t, i) => `${i + 1}. ${t}`).join('\n')}

请优先使用上述工具列表中的工具。`;
        }
      } else if (formattedKnowledge && formattedKnowledge.length > 0 && this.config.enableIntelligentRetrieval) {
        const toolDescriptions = this.getTools().map(tool => {
          const params = Object.entries(tool.parameters)
            .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
            .join('\n');
          return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
        }).join('\n\n');

        const stepsText = steps.length > 0
          ? steps.map(s => this.formatStepForPrompt(s)).join('\n')
          : '无';

        prompt = this.promptBuilder.buildKnowledgeEnhancedPrompt(
          message,
          formattedKnowledge,
          {
            requireCitation: true,
            includeCredibilityInfo: true,
            maxKnowledgeItems: 5,
          }
        );

        prompt += `

## 可用工具

${toolDescriptions}

## 之前的步骤

${stepsText}

## 输出格式

请思考下一步行动。如果问题已解决，输出最终答案。

- 如果需要继续，输出：
  Thought: 你的思考过程（必须具体说明要做什么）
  Action: 工具名称
  Action Input: {"参数名": "具体值", ...}

- 如果问题已解决，输出：
  Thought: 总结思考（需要引用知识库中的相关案例，使用 [KB-xxx] 格式）
  Final Answer: 最终回答

重要规则：
1. 每次只能选择一个工具执行
2. Action 必须是可用工具列表中的工具名称
3. Action Input 必须是有效的 JSON 格式
4. 如果使用了知识库中的信息，必须使用 [KB-xxx] 格式引用
5. 回答时使用中文`;

        if (hasExecutedTool === false) {
          prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。`;
        }
      } else {
        prompt = await this.buildReActPromptAsync(message, steps, ragContext, conversationContext);

        if (hasExecutedTool === false) {
          prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。
请在你的 Thought 中明确说明你要使用哪个工具，然后输出 Action 和 Action Input。`;
        }

        if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          prompt += `

## Skill 工具优先级
当前 Skill (${skillContext.skillName}) 建议按以下顺序使用工具：
${skillContext.toolPriority.map((t, i) => `${i + 1}. ${t}`).join('\n')}

请优先使用上述工具列表中的工具。`;
        }
      }

      // 智能进化: 上下文共享与闭环 (Context Sharing & Loop Closure)
      // 将历史反思建议和工具成功率统计信息实时注入到 Prompt
      try {
        let improvementSuggestions;
        let toolStats;

        if (isCapabilityEnabled('toolFeedback')) {
          const stats = await toolFeedbackCollector.getToolStats();
          if (stats.length > 0) {
            toolStats = stats.map(s => ({
              toolName: s.toolName,
              successRate: s.successRate,
              totalCalls: s.totalCalls
            }));
          }
        }

        if (isCapabilityEnabled('reflection')) {
          const recentFailedReports = await criticService.getRecentFailedReports(3);
          if (recentFailedReports.length > 0) {
            improvementSuggestions = recentFailedReports.flatMap(r =>
              r.improvementSuggestions.map(advice => {
                const adviceMap: Record<string, string> = {
                  'retry': '尝试重试当前操作或使用不同的参数',
                  'alternative': '寻找替代的解决途径或工具',
                  'escalate': '问题可能超出系统能力，建议升级或更慎重地操作',
                  'rollback': '检测到可能的负面副作用，建议随时做好回滚准备',
                  'learn': '将此失败案例记录以供未来参考'
                };
                return {
                  advice: adviceMap[advice] || advice,
                  reason: r.aiAnalysis || r.failureCategory || '执行历史中遇到意外情况'
                };
              })
            );
          }
        }

        // 注入包含历史建议和工具统计的动态上下文
        prompt = this.promptAdapter.injectContext(prompt, {
          improvementSuggestions,
          toolStats
        });
      } catch (err) {
        logger.warn('Failed to inject dynamic context', { error: err instanceof Error ? err.message : String(err) });
      }

      // 调用 LLM 并保存原始响应
      // 意图丢失修复：传入原始用户消息，确保 LLM 系统提示词中包含用户意图
      const rawResponse = await this.callLLM(prompt, context, adapter, provider, model, temperature, message);
      const parsed = this.parseLLMOutput(rawResponse);

      // 解析 thought
      let thought: string;
      if (parsed.thought && parsed.thought.length > 10) {
        if (hasExecutedTool === false && skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          const hasActionIntent = /action|工具|tool|使用|调用|查询|执行/i.test(parsed.thought);
          if (!hasActionIntent) {
            const firstTool = skillContext.toolPriority[0];
            thought = `${parsed.thought} 我应该首先使用 ${firstTool} 工具来获取必要的数据。`;
          } else {
            thought = parsed.thought;
          }
        } else {
          thought = parsed.thought;
        }
      } else {
        logger.warn('LLM response did not contain valid thought, generating default');
        thought = this.generateDefaultThought(message, steps, ragContext, skillContext);
      }

      return { thought, rawResponse };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to generate thought with raw response, using default', { error: errorMessage });
      const defaultThought = this.generateDefaultThought(message, steps, ragContext, skillContext);
      return { thought: defaultThought, rawResponse: '' };
    }
  }

  /**
   * 生成 Thought
   * Requirement 2.1: 调用 LLM 生成思考
   * Requirements: 6.1, 6.2, 6.3 - Skill 感知的 Thought 生成
   * 智能知识应用: 使用格式化知识增强提示词
   * Skill System Integration: 9.1 - 支持系统提示词覆盖
   * 
   * 并发安全：接受请求级别的 AI 配置参数
   * 
   * @param message 用户消息
   * @param steps 已执行的步骤
   * @param context 对话上下文
   * @param ragContext RAG 上下文
   * @param formattedKnowledge 格式化知识
   * @param effectiveAdapter AI 适配器
   * @param effectiveProvider AI 提供商
   * @param effectiveModel 模型名称
   * @param effectivePromptOverride 提示词覆盖
   * @param effectiveTemperature 温度参数
   * @param hasExecutedTool 是否已执行过工具（新增参数，Requirements: 6.1）
   * @param skillContext Skill 上下文（新增参数，Requirements: 6.2）
   */
  async generateThought(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    ragContext?: RAGContext,
    formattedKnowledge?: FormattedKnowledge[],
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectivePromptOverride?: string | null,
    effectiveTemperature?: number,
    hasExecutedTool?: boolean,
    skillContext?: SkillContext
  ): Promise<string> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const promptOverride = effectivePromptOverride ?? this.systemPromptOverride;
    const temperature = effectiveTemperature ?? this.config.temperature;

    // 如果没有 AI 适配器，返回默认 Thought
    if (!adapter) {
      logger.warn('No AI adapter configured, using default thought');
      return this.generateDefaultThought(message, steps, ragContext, skillContext);
    }

    try {
      // 如果有系统提示词覆盖（Skill 系统注入），优先使用
      // Requirements: 9.1
      let prompt: string;
      if (promptOverride) {
        // 使用 Skill 系统注入的提示词
        prompt = promptOverride;

        // 构建工具描述（防御性：如果 promptOverride 包含 {{tools}}）
        const toolDescriptions = this.getTools().map(tool => {
          const params = Object.entries(tool.parameters)
            .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
            .join('\n');
          return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
        }).join('\n\n');

        // 添加步骤历史
        const stepsText = steps.length > 0
          ? steps.map(s => this.formatStepForPrompt(s)).join('\n')
          : '无';

        // 替换占位符（如果有）- 替换顺序: message → tools → steps
        prompt = prompt
          .replace('{{message}}', message)
          .replace('{{tools}}', toolDescriptions)
          .replace('{{steps}}', stepsText);

        // 意图丢失修复：安全网检查 - 确保用户消息确实在提示词中
        if (message && message.trim() && !prompt.includes(message.trim())) {
          logger.warn('User message not found in prompt after replacement (generateThought), prepending it', {
            messageLength: message.length,
            promptLength: prompt.length,
          });
          prompt = `## ⚠️ 用户当前请求\n\n「${message}」\n\n请务必针对此请求进行回答。\n\n---\n\n${prompt}`;
        }

        // Requirements: 6.1 - 当 hasExecutedTool 为 false 时添加 action 指导
        if (hasExecutedTool === false) {
          prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。
请在你的 Thought 中明确说明你要使用哪个工具，然后输出 Action 和 Action Input。`;
        }

        // Requirements: 6.2 - 当有 skillContext 时包含 toolPriority 列表
        if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          prompt += `

## Skill 工具优先级
当前 Skill (${skillContext.skillName}) 建议按以下顺序使用工具：
${skillContext.toolPriority.map((t, i) => `${i + 1}. ${t}`).join('\n')}

请优先使用上述工具列表中的工具。`;
        }

        logger.debug('Using system prompt override from Skill system');
      } else if (formattedKnowledge && formattedKnowledge.length > 0 && this.config.enableIntelligentRetrieval) {
        // 如果有格式化知识，使用知识增强的提示词
        // 构建工具描述
        const toolDescriptions = this.getTools().map(tool => {
          const params = Object.entries(tool.parameters)
            .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
            .join('\n');
          return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
        }).join('\n\n');

        // 构建步骤历史
        const stepsText = steps.length > 0
          ? steps.map(s => this.formatStepForPrompt(s)).join('\n')
          : '无';

        // 构建知识增强的 ReAct 提示词
        prompt = this.promptBuilder.buildKnowledgeEnhancedPrompt(
          message,
          formattedKnowledge,
          {
            requireCitation: true,
            includeCredibilityInfo: true,
            maxKnowledgeItems: 5,
          }
        );

        // 添加 ReAct 循环所需的工具列表和步骤历史
        prompt += `

## 可用工具

${toolDescriptions}

## 之前的步骤

${stepsText}

## 输出格式

请思考下一步行动。如果问题已解决，输出最终答案。

- 如果需要继续，输出：
  Thought: 你的思考过程（必须具体说明要做什么）
  Action: 工具名称
  Action Input: {"参数名": "具体值", ...}

- 如果问题已解决，输出：
  Thought: 总结思考（需要引用知识库中的相关案例，使用 [KB-xxx] 格式）
  Final Answer: 最终回答

重要规则：
1. 每次只能选择一个工具执行
2. Action 必须是可用工具列表中的工具名称
3. Action Input 必须是有效的 JSON 格式
4. 如果使用了知识库中的信息，必须使用 [KB-xxx] 格式引用
5. 回答时使用中文`;

        // Requirements: 6.1 - 当 hasExecutedTool 为 false 时添加 action 指导
        if (hasExecutedTool === false) {
          prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。`;
        }
      } else {
        prompt = await this.buildReActPromptAsync(message, steps, ragContext);

        // Requirements: 6.1 - 当 hasExecutedTool 为 false 时添加 action 指导
        if (hasExecutedTool === false) {
          prompt += `

## ⚠️ 重要提示
你还没有执行任何工具！在生成 Final Answer 之前，你必须至少执行一个工具来获取实际数据。
请在你的 Thought 中明确说明你要使用哪个工具，然后输出 Action 和 Action Input。`;
        }

        // Requirements: 6.2 - 当有 skillContext 时包含 toolPriority 列表
        if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          prompt += `

## Skill 工具优先级
当前 Skill (${skillContext.skillName}) 建议按以下顺序使用工具：
${skillContext.toolPriority.map((t, i) => `${i + 1}. ${t}`).join('\n')}

请优先使用上述工具列表中的工具。`;
        }
      }

      // 智能进化: 感知降级的 Prompt 认知 (Degradation-Aware Prompting)
      try {
        const { degradationManager } = await import('../degradationManager');
        const reflectionState = degradationManager.getState('reflection');
        if (reflectionState && reflectionState.degraded) {
          prompt += `

## 🚨 系统状态警告 (System Degradation Alert)
系统当前处于高负载/降级状态 (原因: ${reflectionState.reason || '未知'})。
请**跳过任何认知反思、复杂推理或计划修订步骤**。
使用最严格且快速的规则匹配进行响应，尽快给出 Final Answer 或最关键的单一 Action，避免使用耗时的工具。`;
        }
      } catch (err) {
        logger.warn('Failed to inject degradation-aware prompt', { error: err instanceof Error ? err.message : String(err) });
      }

      // 智能进化: 上下文共享与闭环 (Context Sharing & Loop Closure)
      // 将历史反思建议和工具成功率统计信息实时注入到 Prompt
      try {
        let improvementSuggestions;
        let toolStats;

        if (isCapabilityEnabled('toolFeedback')) {
          const stats = await toolFeedbackCollector.getToolStats();
          if (stats.length > 0) {
            toolStats = stats.map(s => ({
              toolName: s.toolName,
              successRate: s.successRate,
              totalCalls: s.totalCalls
            }));
          }
        }

        if (isCapabilityEnabled('reflection')) {
          const recentFailedReports = await criticService.getRecentFailedReports(3);
          if (recentFailedReports.length > 0) {
            improvementSuggestions = recentFailedReports.flatMap(r =>
              r.improvementSuggestions.map(advice => {
                const adviceMap: Record<string, string> = {
                  'retry': '尝试重试当前操作或使用不同的参数',
                  'alternative': '寻找替代的解决途径或工具',
                  'escalate': '问题可能超出系统能力，建议升级或更慎重地操作',
                  'rollback': '检测到可能的负面副作用，建议随时做好回滚准备',
                  'learn': '将此失败案例记录以供未来参考'
                };
                return {
                  advice: adviceMap[advice] || advice,
                  reason: r.aiAnalysis || r.failureCategory || '执行历史中遇到意外情况'
                };
              })
            );
          }
        }

        // 注入包含历史建议和工具统计的动态上下文
        prompt = this.promptAdapter.injectContext(prompt, {
          improvementSuggestions,
          toolStats
        });
      } catch (err) {
        logger.warn('Failed to inject dynamic context', { error: err instanceof Error ? err.message : String(err) });
      }

      const response = await this.callLLM(prompt, context, adapter, provider, model, temperature, message);
      const parsed = this.parseLLMOutput(response);

      // 如果解析出了 thought，使用它；否则生成智能默认值
      if (parsed.thought && parsed.thought.length > 10) {
        // Requirements: 6.3 - 如果生成的 Thought 不包含 action 意图，追加默认建议
        if (hasExecutedTool === false && skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          const hasActionIntent = /action|工具|tool|使用|调用|查询|执行/i.test(parsed.thought);
          if (!hasActionIntent) {
            const firstTool = skillContext.toolPriority[0];
            const enhancedThought = `${parsed.thought} 我应该首先使用 ${firstTool} 工具来获取必要的数据。`;
            logger.debug('Enhanced thought with action suggestion', {
              originalThought: parsed.thought.substring(0, 50),
              suggestedTool: firstTool,
            });
            return enhancedThought;
          }
        }
        return parsed.thought;
      }

      logger.warn('LLM response did not contain valid thought, generating default');
      return this.generateDefaultThought(message, steps, ragContext, skillContext);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to generate thought, using default', { error: errorMessage });
      return this.generateDefaultThought(message, steps, ragContext, skillContext);
    }
  }

  /**
   * 生成智能默认 Thought（基于消息内容和已执行步骤）
   * Requirements: 6.4 - 当有 skillContext 时建议 toolPriority 中第一个未执行工具
   * 在知识增强模式下，优先提示查询知识库
   */
  private generateDefaultThought(message: string, steps: ReActStep[], ragContext?: RAGContext, skillContext?: SkillContext): string {
    const executedTools = steps
      .filter(s => s.type === 'action' && s.toolName)
      .map(s => s.toolName);

    // 检查工具是否已执行成功
    const isToolExecutedSuccessfully = (name: string) => {
      const actionIndex = steps.findIndex(s => s.type === 'action' && s.toolName === name);
      if (actionIndex === -1) return false;
      const nextObs = steps.slice(actionIndex + 1).find(s => s.type === 'observation');
      return nextObs?.success === true;
    };

    // Requirements: 6.4 - 当有 skillContext 时建议 toolPriority 中第一个未执行工具
    if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
      for (const toolName of skillContext.toolPriority) {
        if (!isToolExecutedSuccessfully(toolName)) {
          return `根据 ${skillContext.skillName} Skill 的配置，我需要首先使用 ${toolName} 工具来获取必要的数据。`;
        }
      }
      // 所有 toolPriority 工具都已执行
      return `已完成 ${skillContext.skillName} Skill 建议的所有工具调用，现在可以基于收集到的数据生成最终答案。`;
    }

    // 知识增强模式下，优先查询知识库
    if (this.config.knowledgeEnhancedMode && !ragContext?.hasRetrieved && !executedTools.includes('knowledge_search')) {
      return '首先需要查询知识库，获取相关的历史案例和处理经验，以便更好地分析和解决问题。';
    }

    // 根据已执行的工具和消息内容生成有意义的 thought
    if (executedTools.length === 0) {
      // 还没执行任何工具，先获取系统状态
      return '首先需要获取设备的当前状态信息，包括系统资源和接口状态，以便进行分析。';
    }

    if (executedTools.includes('monitor_metrics') && !executedTools.includes('device_query')) {
      // 已获取指标，需要查询具体配置
      return '已获取系统状态，现在需要查询相关的设备配置信息。';
    }

    if (executedTools.includes('device_query') && !executedTools.includes('knowledge_search')) {
      // 已查询配置，搜索知识库
      return '已获取配置信息，现在搜索知识库查找相关的处理经验。';
    }

    // 默认：基于已有信息进行分析
    return '基于已收集的信息进行分析并给出建议。';
  }

  /**
   * 选择 Action
   * Requirement 2.2: 解析 LLM 输出选择工具
   * Requirements: 1.1, 2.1, 2.2, 2.3, 4.2, 5.2, 8.2 - Skill 感知的 Action 选择
   * 
   * 修复：即使已执行过工具，也要检查是否还有待执行的查询
   * 并发安全：接受请求级别的 AI 配置参数
   * 
   * @param thought 当前思考内容
   * @param availableTools 可用工具列表
   * @param hasExecutedTool 是否已执行过工具
   * @param steps 已执行的步骤
   * @param originalMessage 用户原始消息
   * @param ragContext RAG 上下文
   * @param effectiveAdapter AI 适配器
   * @param effectiveProvider AI 提供商
   * @param effectiveModel 模型名称
   * @param effectiveTemperature 温度参数
   * @param skillContext Skill 上下文（新增参数，Requirements: 4.2）
   */
  async selectAction(
    thought: string,
    availableTools: AgentTool[],
    hasExecutedTool: boolean = false,
    steps: ReActStep[] = [],
    originalMessage: string = '',
    ragContext?: RAGContext,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number,
    skillContext?: SkillContext,
    intentTools?: Array<{ name: string; params?: Record<string, unknown>; reason?: string }>
  ): Promise<{ toolName: string; toolInput: Record<string, unknown> } | null> {
    // 委托给独立的 ActionSelector 模块
    return this.actionSelector.selectAction(
      thought,
      availableTools,
      hasExecutedTool,
      steps,
      originalMessage,
      ragContext,
      effectiveAdapter ?? this.aiAdapter,
      effectiveProvider ?? this.provider,
      effectiveModel ?? this.model,
      effectiveTemperature ?? this.config.temperature,
      skillContext,
      intentTools,
    );
  }

  /**
   * 执行 Action
   * Requirement 2.3: 执行工具并返回结果
   * Skill System Integration: 7.6 - 支持工具拦截器
   * 
   * 并发安全：接受请求级别的拦截器参数
   */
  async executeAction(
    toolName: string,
    toolInput: Record<string, unknown>,
    // 并发安全：请求级别的拦截器
    effectiveInterceptors?: Map<string, ToolInterceptor>,
    // 多设备支持：请求级 RouterOS 客户端（Requirements: 8.1, 8.2）
    routerosClient?: import('../../routerosClient').RouterOSClient,
    // 多设备支持：tick 上下文推断的目标设备 ID（Brain 自动补全用）
    tickDeviceId?: string
  ): Promise<{ output: unknown; duration: number; success: boolean }> {
    const startTime = Date.now();

    // 并发安全：优先使用传入的拦截器，回退到实例属性
    const interceptors = effectiveInterceptors ?? this.toolInterceptors;

    // 检查是否有拦截器（Skill 系统集成）
    // Requirements: 7.6
    const interceptor = interceptors.get(toolName);
    if (interceptor) {
      try {
        const interceptResult = await interceptor(toolName, toolInput);
        if (interceptResult.intercepted) {
          const duration = Date.now() - startTime;
          logger.debug('Tool call intercepted', { toolName, duration });
          return {
            output: interceptResult.result,
            duration,
            success: true,
          };
        }
      } catch (error) {
        logger.warn('Tool interceptor failed, falling back to normal execution', {
          toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        output: { error: `工具 "${toolName}" 未找到` },
        duration: Date.now() - startTime,
        success: false,
      };
    }

    // 缺陷 A 修复：执行前守卫 — 验证必需参数是否存在且非空
    const requiredParams = Object.entries(tool.parameters)
      .filter(([, info]) => info.required)
      .map(([name]) => name);
    if (requiredParams.length > 0) {
      const missingOrEmpty = requiredParams.filter(p => {
        const val = toolInput[p];
        return val === undefined || val === null || (typeof val === 'string' && val.trim() === '');
      });
      if (missingOrEmpty.length > 0) {
        const duration = Date.now() - startTime;
        logger.warn('executeAction: 必需参数缺失，拦截工具调用', {
          toolName,
          missingParams: missingOrEmpty,
          providedInput: JSON.stringify(toolInput).substring(0, 200),
        });
        return {
          output: { error: `参数错误：工具 "${toolName}" 缺少必需参数 [${missingOrEmpty.join(', ')}]` },
          duration,
          success: false,
        };
      }
    }

    try {
      // 设置超时
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('工具执行超时')), this.config.actionTimeout);
      });

      // 多设备支持：注入请求级 RouterOS 客户端和 tick 上下文设备 ID 到工具参数
      // Requirements: 8.1, 8.2 - 工具实现会优先使用此客户端，回退到全局单例
      // tickDeviceId: Brain tick 上下文推断的目标设备，brainTools 用作 LLM 未传 deviceId 时的兜底
      const effectiveToolInput = {
        ...toolInput,
        ...(routerosClient ? { routerosClient } : {}),
        ...(tickDeviceId ? { tickDeviceId } : {}),
      };

      const result = await Promise.race([
        tool.execute(effectiveToolInput),
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;

      // 判断执行是否成功
      const success = this.isToolResultSuccess(result);

      logger.info('Tool executed', {
        toolName,
        duration,
        success,
      });

      return {
        output: result,
        duration,
        success,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startTime;

      logger.error('Tool execution failed', {
        toolName,
        error: errorMessage,
        duration,
      });

      return {
        output: { error: errorMessage },
        duration,
        success: false,
      };
    }
  }

  /**
   * 判断是否需要继续循环
   * Requirement 2.4: 由 LLM 评估是否需要继续
   * Requirements: 5.1, 5.2 - 强制继续逻辑
   * 
   * 核心逻辑：让 LLM 来判断是否需要继续，而不是硬编码规则
   * 并发安全：接受请求级别的 AI 配置参数
   * 
   * @param steps 已执行的步骤
   * @param message 用户原始消息
   * @param effectiveAdapter AI 适配器
   * @param effectiveProvider AI 提供商
   * @param effectiveModel 模型名称
   * @param effectiveTemperature 温度参数
   * @param hasExecutedTool 是否已执行过工具（新增参数，Requirements: 5.2）
   * @param skillContext Skill 上下文（新增参数，Requirements: 5.1）
   */
  async shouldContinue(
    steps: ReActStep[],
    message: string,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number,
    hasExecutedTool?: boolean,
    skillContext?: SkillContext,
    // 🔴 FIX: 传递 systemPromptOverride，让 LLM 知道完整任务要求（如 Brain 的 OODA 多步循环）
    systemPromptOverride?: string | null
  ): Promise<boolean> {
    // 如果最后一个步骤是 final_answer，不需要继续
    const lastStep = steps[steps.length - 1];
    if (lastStep?.type === 'final_answer') {
      return false;
    }

    // Requirements: 5.2 - 如果 hasExecutedTool 为 false，强制返回 true
    if (hasExecutedTool === false) {
      logger.debug('shouldContinue: forcing true because hasExecutedTool is false');
      return true;
    }

    // Requirements: 5.1 - 如果 hasExecutedTool 为 false，强制返回 true（Skill 感知）
    if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
      const executedToolsSuccessfully = steps
        .filter(s => s.type === 'action' && s.toolName)
        .filter((actionStep, index) => {
          // 找到对应的 observation
          const nextObs = steps.slice(steps.indexOf(actionStep) + 1).find(s => s.type === 'observation');
          return nextObs?.success === true;
        })
        .map(s => s.toolName);

      const hasExecutedPriorityTool = skillContext.toolPriority.some(
        toolName => executedToolsSuccessfully.includes(toolName)
      );

      if (!hasExecutedPriorityTool) {
        logger.debug('shouldContinue: forcing true because no toolPriority tool has been executed successfully', {
          skillName: skillContext.skillName,
          toolPriority: skillContext.toolPriority,
          executedToolsSuccessfully,
        });
        return true;
      }
    }

    // 统计已执行的工具数量
    const executedToolCount = steps.filter(s => s.type === 'action' && s.toolName).length;

    // 缺陷 C 修复：移除 executedToolCount <= 1 硬编码规则
    // 改为数据充分性检查：检查是否有成功的数据检索工具调用
    const successfulDataSteps = this.getSuccessfulDataSteps(steps);
    if (successfulDataSteps.length > 0) {
      // 检查是否所有成功的数据检索都返回了有意义的数据
      const hasSubstantialData = successfulDataSteps.some(s => {
        const outputStr = typeof s.toolOutput === 'string' ? s.toolOutput : JSON.stringify(s.toolOutput || '');
        return outputStr.length > 50; // 有实质性数据（非空/非错误）
      });

      if (hasSubstantialData) {
        // 检查最近是否有连续失败的工具调用（可能是不必要的重试）
        const recentSteps = steps.slice(-6); // 最近 2 次迭代
        const recentFailures = recentSteps.filter(s => s.type === 'observation' && s.success === false).length;
        const recentSuccesses = recentSteps.filter(s => s.type === 'observation' && s.success === true).length;

        // 如果最近全是失败且已有成功数据，停止循环
        if (recentFailures > 0 && recentSuccesses === 0 && successfulDataSteps.length > 0) {
          logger.info('shouldContinue: 已有成功数据但最近调用全部失败，停止循环', {
            successfulDataCount: successfulDataSteps.length,
            recentFailures,
          });
          return false;
        }

        // 数据充分性增强：多维度评估是否已有足够数据可以终止
        // 维度 1：多个成功数据源 + 已执行足够工具调用
        if (successfulDataSteps.length >= 2 && executedToolCount >= 3) {
          // 估算总数据量
          const totalRecords = successfulDataSteps.reduce(
            (sum, s) => sum + this.estimateRecordCount(s.toolOutput), 0
          );
          if (totalRecords >= 5) {
            logger.info('shouldContinue: 多数据源充分（>=2 源, >=5 条记录），提前终止', {
              successfulDataCount: successfulDataSteps.length,
              totalRecords,
              executedToolCount,
            });
            return false;
          }
        }

        // 维度 2：单数据源但数据量大（如一次查询返回大量记录）
        const maxRecords = Math.max(
          ...successfulDataSteps.map(s => this.estimateRecordCount(s.toolOutput))
        );
        if (maxRecords >= 10 && executedToolCount >= 2) {
          logger.info('shouldContinue: 单源大数据量（>=10 条记录），提前终止', {
            maxRecords,
            executedToolCount,
          });
          return false;
        }

        // 维度 3：最近连续成功且无新工具类型可调用
        if (recentSuccesses >= 2 && recentFailures === 0 && executedToolCount >= 3) {
          const executedToolNames = new Set(
            steps.filter(s => s.type === 'action' && s.toolName).map(s => s.toolName)
          );
          const availableToolNames = new Set(this.getTools().map(t => t.name));
          const unusedTools = [...availableToolNames].filter(t => !executedToolNames.has(t));
          // 如果没有未使用的工具，或未使用的工具很少，数据大概率已充分
          if (unusedTools.length <= 1) {
            logger.info('shouldContinue: 连续成功且几乎无未使用工具，提前终止', {
              recentSuccesses,
              executedToolCount,
              unusedToolCount: unusedTools.length,
            });
            return false;
          }
        }
      }
    }

    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    // 如果没有 AI 适配器，使用简单规则判断
    if (!adapter) {
      return this.shouldContinueSimple(steps);
    }

    try {
      const prompt = this.buildContinueCheckPrompt(steps, message, systemPromptOverride);
      const response = await this.callLLMSimple(prompt, adapter, provider, model, temperature);

      // 缺陷 H 修复：优先尝试结构化 JSON 解析
      const jsonDecision = this.parseStructuredContinueDecision(response);
      if (jsonDecision !== null) {
        logger.debug('shouldContinue: 使用结构化 JSON 决策', { continue: jsonDecision });
        return jsonDecision;
      }

      // 回退：关键词匹配
      const lowerResponse = response.toLowerCase();

      // 如果明确说需要继续，返回 true（扩展关键词覆盖更多中文表述）
      if (lowerResponse.includes('需要继续') ||
        lowerResponse.includes('还需要') ||
        lowerResponse.includes('未完成') ||
        lowerResponse.includes('下一步') ||
        lowerResponse.includes('还需查询') ||
        lowerResponse.includes('继续查询') ||
        lowerResponse.includes('进一步') ||
        lowerResponse.includes('接下来') ||
        lowerResponse.includes('还应该') ||
        lowerResponse.includes('需要查询') ||
        lowerResponse.includes('还没有') ||
        lowerResponse.includes('不够') ||
        lowerResponse.includes('不足') ||
        lowerResponse.includes('continue') ||
        lowerResponse.includes('need more')) {
        return true;
      }

      // 如果明确说已解决，返回 false
      if (lowerResponse.includes('已解决') ||
        lowerResponse.includes('已完成') ||
        lowerResponse.includes('全部完成') ||
        lowerResponse.includes('可以生成') ||
        lowerResponse.includes('数据足够') ||
        lowerResponse.includes('信息充足') ||
        lowerResponse.includes('足以回答') ||
        lowerResponse.includes('可以回答')) {
        return false;
      }

      // 回退规则：至少需要 2 次成功的数据查询且执行了 2+ 次工具才默认停止
      // 避免只执行一次错误查询就停止循环
      if (successfulDataSteps.length >= 2 && executedToolCount >= 2) {
        logger.info('shouldContinue: 关键词匹配失败但已有多次成功数据，默认不继续');
        return false;
      }

      // 默认上限：执行不到 5 次工具时继续
      return executedToolCount < 5;
    } catch (error) {
      // 出错时使用简单规则
      return this.shouldContinueSimple(steps);
    }
  }


  // ==================== 私有辅助方法 ====================

  /**
   * 从 PromptTemplateService 获取提示词模板
   * 如果服务不可用或模板不存在，回退到硬编码的默认模板
   * 
   * @param templateName 模板名称
   * @param fallbackTemplate 回退模板
   * @returns 模板内容
   */
  private async getPromptTemplate(templateName: string, fallbackTemplate: string): Promise<string> {
    try {
      const content = await promptTemplateService.getTemplateContent(templateName, fallbackTemplate);
      return content;
    } catch (error) {
      logger.warn('Failed to get prompt template from service, using fallback', {
        templateName,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackTemplate;
    }
  }

  /**
   * 将解析到的意图映射到最匹配的工具名称
   * Requirements: 6.2 - 将意图转换为工具调用
   * 
   * @param intent 解析后的意图
   * @returns 匹配的工具名称，未找到时返回 null
   */
  private mapIntentToTool(intent: ParsedIntent): string | null {
    // 意图类别/动作到工具名称的映射
    const intentToToolMap: Record<string, string[]> = {
      'query/get_status': ['monitor_metrics', 'get_status', 'system_status'],
      'query/get_config': ['get_config', 'show_config', 'knowledge_search'],
      'diagnose/troubleshoot': ['diagnose', 'troubleshoot', 'analyze', 'knowledge_search'],
      'diagnose/find_cause': ['diagnose', 'root_cause_analysis', 'knowledge_search'],
      'monitor/watch': ['monitor_metrics', 'monitor', 'watch'],
      'configure/modify': ['configure', 'set_config', 'update_config'],
      'configure/add': ['configure', 'add_config', 'create'],
      'configure/delete': ['configure', 'delete_config', 'remove'],
      'remediate/fix': ['remediate', 'fix', 'repair'],
      'remediate/restart': ['restart', 'reboot', 'restart_service'],
      'automate/batch': ['batch_execute', 'bulk_operation'],
      'automate/schedule': ['schedule', 'create_schedule'],
    };

    const intentKey = `${intent.category}/${intent.action}`;
    const candidateTools = intentToToolMap[intentKey] || [];

    // 尝试按优先级找到已注册的工具
    for (const toolName of candidateTools) {
      if (this.tools.has(toolName)) {
        return toolName;
      }
    }

    // 如果没有精确匹配，尝试模糊匹配：查找工具名称中包含意图动作或类别的工具
    for (const [toolName] of this.tools) {
      const lowerToolName = toolName.toLowerCase();
      if (lowerToolName.includes(intent.action.toLowerCase()) ||
        lowerToolName.includes(intent.category.toLowerCase())) {
        return toolName;
      }
    }

    // 如果有目标对象，尝试匹配包含目标的工具
    if (intent.target) {
      for (const [toolName] of this.tools) {
        if (toolName.toLowerCase().includes(intent.target.toLowerCase())) {
          return toolName;
        }
      }
    }

    return null;
  }

  /**
   * 从 FeedbackService 检索与当前查询相关的已批准经验
   * Requirements: 1.1, 1.2, 1.3
   * - 检查 experience 能力是否启用
   * - 按 confidence 过滤和排序
   * - 限制返回数量
   */
  private async retrieveExperiences(query: string, conversationContext?: Record<string, unknown>): Promise<ExperienceEntry[]> {
    const results: ExperienceEntry[] = [];

    // 来源 1: 用户反馈经验（feedbackService）
    try {
      if (isCapabilityEnabled('experience')) {
        const config = getCapabilityConfig('experience');
        const experiences = await feedbackService.getExperiences({ status: 'approved' });
        const filtered = experiences
          .filter(e => e.confidence >= config.minScoreForRetrieval)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, config.maxFewShotExamples);
        results.push(...filtered);
      }
    } catch (error) {
      logger.debug('Failed to retrieve user feedback experiences', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 来源 2: 自动反思学习条目（reflectorService）
    // queryLearning 已内置 deprecated/低置信度过滤
    try {
      if (isCapabilityEnabled('reflection') && query) {
        const learningEntries = await reflectorService.queryLearning(query, 3);
        // 将 LearningEntry 转换为 ExperienceEntry 格式
        for (const entry of learningEntries) {
          results.push({
            id: entry.id,
            timestamp: entry.timestamp,
            problemPattern: entry.failurePattern,
            solutionApproach: entry.effectiveSolution || entry.rootCause,
            effectiveTools: Object.keys(entry.contextFactors).includes('toolCount')
              ? [`${entry.contextFactors.toolCount || '?'} 个工具`]
              : [],
            confidence: entry.confidence,
            status: 'approved' as const,
            // 携带知识库条目 ID，用于经验反馈闭环中的 recordUsage
            knowledgeEntryId: entry.knowledgeEntryId,
          } as ExperienceEntry & { knowledgeEntryId?: string });
        }

        // 记录使用的 LearningEntry IDs 到会话上下文（累积而非覆盖）
        // Requirements: conversation-and-reflection-optimization 8.1
        // Fix: 多次迭代调用 retrieveExperiences 时，累积所有使用过的 ID
        if (conversationContext && learningEntries.length > 0) {
          const existing = (conversationContext.usedLearningEntryIds as string[]) ?? [];
          conversationContext.usedLearningEntryIds = [...new Set([...existing, ...learningEntries.map(e => e.id)])];
        }
      }
    } catch (error) {
      logger.debug('Failed to retrieve auto-reflection learning entries', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 去重 + 按置信度排序
    const seen = new Set<string>();
    return results
      .filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }

  /**
   * 将经验条目格式化为提示词段落
   * Requirements: 1.1
   * - 空数组返回空字符串
   * - 格式化为包含问题模式、解决方案和有效工具的段落
   */
  private formatExperiencesForPrompt(experiences: ExperienceEntry[]): string {
    if (experiences.length === 0) return '';
    return `\n## 历史经验参考\n以下是与当前问题相关的历史经验，请优先参考高置信度的经验:\n${experiences.map((e, i) => {
      const confidenceLabel = e.confidence >= 0.8 ? '🟢 高' : e.confidence >= 0.6 ? '🟡 中' : '🔴 低';
      const usageInfo = (e as any).usageCount ? `(已验证 ${(e as any).usageCount} 次)` : '';
      return `${i + 1}. [置信度: ${confidenceLabel} ${(e.confidence * 100).toFixed(0)}%${usageInfo}]\n   问题模式: ${e.problemPattern}\n   解决方案: ${e.solutionApproach}\n   使用工具: ${e.effectiveTools.join(', ') || '无'}\n   ⚡ 建议: 如果当前问题与此经验匹配，优先采用上述方案`;
    }).join('\n\n')}`;
  }

  /**
   * 构建 ReAct 提示词
   * Requirements: 3.1, 6.2
   * 根据 knowledgeEnhancedMode 选择提示词模板，并注入 RAGContext
   * 
   * 模板管理集成：
   * - 优先从 PromptTemplateService 获取模板
   * - 支持模板热更新
   */
  private async buildReActPromptAsync(message: string, steps: ReActStep[], ragContext?: RAGContext, conversationContext?: Record<string, unknown>): Promise<string> {
    // 构建工具描述（带历史统计，工具选择优化）
    const toolDescriptions = await this.getToolDescriptionsWithStats();

    // 缺陷 G 修复：Token 预算管理 — 渐进式压缩步骤历史
    const TOKEN_BUDGET_THRESHOLD = 4000; // 步骤历史的字符预算
    let stepsText: string;
    if (steps.length > 0) {
      const fullStepsText = steps.map(s => this.formatStepForPrompt(s)).join('\n');
      if (fullStepsText.length > TOKEN_BUDGET_THRESHOLD) {
        // 超过预算，压缩旧步骤
        stepsText = this.compressOlderSteps(steps, 6); // 保留最近 6 个步骤（约 2 次迭代）
      } else {
        stepsText = fullStepsText;
      }
    } else {
      stepsText = '无';
    }

    // 检索并格式化历史经验 (Requirements: 1.1, 1.2, 1.3)
    const experiences = await this.retrieveExperiences(message, conversationContext);
    const experienceSection = this.formatExperiencesForPrompt(experiences);

    // 尝试使用 PromptComposerAdapter 构建模块化 Prompt
    // Requirements: 1.7, 1.8, 5.2
    try {
      if (this.config.knowledgeEnhancedMode) {
        const ragContextText = this.formatRAGContext(ragContext);
        const prompt = this.promptAdapter.buildKnowledgeFirstReActPrompt(message, toolDescriptions, stepsText, ragContextText);
        return prompt + experienceSection;
      }
      const prompt = this.promptAdapter.buildReActPrompt(message, toolDescriptions, stepsText);
      return prompt + experienceSection;
    } catch (adapterError) {
      logger.error('PromptComposerAdapter failed in buildReActPromptAsync, falling back to template service', { error: adapterError });
    }

    // 回退到模板服务，再回退到原始模板
    if (this.config.knowledgeEnhancedMode) {
      const ragContextText = this.formatRAGContext(ragContext);

      const template = await this.getPromptTemplate(
        TEMPLATE_NAMES.KNOWLEDGE_FIRST,
        KNOWLEDGE_FIRST_REACT_PROMPT
      );

      const prompt = template
        .replace('{{message}}', message)
        .replace('{{ragContext}}', ragContextText)
        .replace('{{tools}}', toolDescriptions)
        .replace('{{steps}}', stepsText);

      return prompt + experienceSection;
    }

    const template = await this.getPromptTemplate(
      TEMPLATE_NAMES.REACT_LOOP,
      REACT_LOOP_PROMPT
    );

    const prompt = template
      .replace('{{message}}', message)
      .replace('{{tools}}', toolDescriptions)
      .replace('{{steps}}', stepsText);

    return prompt + experienceSection;
  }

  // [已删除] 废弃的同步 buildReActPrompt() — 无调用方，无 Token 预算，已被 buildReActPromptAsync() 完全替代

  /**
   * 格式化 RAG 上下文用于提示词
   * Requirements: 6.2
   */
  private formatRAGContext(ragContext?: RAGContext): string {
    if (!ragContext || !ragContext.hasRetrieved) {
      return '尚未查询知识库，请先使用 knowledge_search 工具查询相关历史案例。';
    }

    if (ragContext.error) {
      return `知识库查询失败: ${ragContext.error}。请继续使用其他工具进行分析。`;
    }

    if (ragContext.documents.length === 0) {
      return '知识库中未找到相关案例。请基于设备状态进行分析。';
    }

    // 格式化检索到的文档
    const documentsText = ragContext.documents
      .slice(0, 5) // 最多显示 5 个文档
      .map((doc, index) => {
        return `${index + 1}. [${doc.type}] ${doc.title} (相关度: ${(doc.score * 100).toFixed(0)}%)
   摘要: ${doc.excerpt.substring(0, 200)}${doc.excerpt.length > 200 ? '...' : ''}`;
      })
      .join('\n\n');

    return `已从知识库检索到 ${ragContext.documents.length} 条相关记录 (耗时 ${ragContext.retrievalTime}ms):

${documentsText}

请参考以上历史案例进行分析。`;
  }

  /**
   * 构建 Action 选择提示词 — 委托给 ActionSelector
   */
  private buildActionSelectionPrompt(
    thought: string,
    availableTools: AgentTool[],
    steps: ReActStep[] = [],
    originalMessage: string = '',
    hasExecutedTool?: boolean,
    skillContext?: SkillContext
  ): string {
    return this.actionSelector.buildActionSelectionPrompt(thought, availableTools, steps, originalMessage, hasExecutedTool, skillContext);
  }

  /**
   * 构建继续检查提示词
   */
  private buildContinueCheckPrompt(steps: ReActStep[], message: string, systemPromptOverride?: string | null): string {
    const stepsText = steps.map(s => this.formatStepForPrompt(s)).join('\n');

    // 统计已执行的工具
    const executedTools = steps
      .filter(s => s.type === 'action' && s.toolName)
      .map(s => s.toolName);

    // 统计成功的观察结果
    const successfulObservations = steps
      .filter(s => s.type === 'observation' && s.success)
      .length;

    // 缺陷 C 修复：包含已成功获取的数据摘要信息
    const successfulDataSteps = this.getSuccessfulDataSteps(steps);
    let dataSummary = '无';
    if (successfulDataSteps.length > 0) {
      dataSummary = successfulDataSteps.map((s, i) => {
        const outputStr = typeof s.toolOutput === 'string' ? s.toolOutput : JSON.stringify(s.toolOutput || '');
        const preview = outputStr.substring(0, 300);
        const recordCount = this.estimateRecordCount(s.toolOutput);
        return `  ${i + 1}. 数据长度: ${outputStr.length} 字符${recordCount > 0 ? `，约 ${recordCount} 条记录` : ''}，预览: ${preview}...`;
      }).join('\n');
    }

    // 缺陷 H 修复：要求 LLM 输出结构化 JSON 决策
    // 🔴 FIX: 当有 systemPromptOverride 时（如 Brain 的 OODA 循环），将任务上下文注入 Prompt
    // 让 LLM 知道完整的多步任务要求，避免在第一个工具成功后就判断"已完成"
    const taskContextSection = systemPromptOverride
      ? `\n系统任务上下文（请基于此判断任务是否真正完成）：\n${systemPromptOverride.substring(0, 2000)}\n`
      : '';

    return `用户请求：${message}
${taskContextSection}
已执行的步骤：
${stepsText}

已使用的工具：${executedTools.length > 0 ? executedTools.join(', ') : '无'}
成功获取的数据：${successfulObservations} 个

已成功获取的数据摘要：
${dataSummary}

请仔细分析：
1. 用户的请求中包含哪些具体任务？${systemPromptOverride ? '（参考系统任务上下文中的完整要求）' : ''}
2. 已获取的数据是否足以回答用户的问题？
3. 是否还需要调用其他工具获取额外数据？
4. ${systemPromptOverride ? '系统任务上下文中是否要求执行多步操作（如：观察→诊断→修复→验证）？如果是，当前是否已完成所有步骤？' : '是否有未完成的子任务？'}

请以 JSON 格式回复你的决策：
{"continue": true/false, "reason": "简要说明原因"}

注意：
- 如果已获取的数据足以回答用户问题，请设置 "continue": false。
- 如果系统任务要求多步操作（如 OODA 循环：观察→决策→行动→验证），仅完成部分步骤时必须设置 "continue": true。`;
  }

  /**
   * 格式化步骤用于提示词
   * @param step 步骤
   * @param fullOutput 是否输出完整内容（用于生成最终答案时）
   */
  private formatStepForPrompt(step: ReActStep, fullOutput: boolean = false): string {
    switch (step.type) {
      case 'thought':
        return `Thought: ${step.content}`;
      case 'action':
        return `Action: ${step.toolName}\nAction Input: ${JSON.stringify(step.toolInput || {})}`;
      case 'observation':
        const output = typeof step.toolOutput === 'string'
          ? step.toolOutput
          : JSON.stringify(step.toolOutput, null, 2);
        // 生成最终答案时使用完整输出（8000字符），循环中使用截断输出（1500字符）
        const maxLength = fullOutput ? 8000 : 1500;
        let truncatedOutput = output;
        let truncationWarning = '';
        if (output.length > maxLength) {
          truncatedOutput = output.substring(0, maxLength);
          truncationWarning = `\n\n⚠️ 【数据截断警告】原始数据 ${output.length} 字符，已截断为 ${maxLength} 字符。
请立即使用分批查询：
- 添加 limit 参数（如 limit=20）限制返回条数
- 添加 proplist 参数（如 proplist=name,address,interface）限制返回字段
- 使用 offset 参数进行分页（如 offset=0, offset=20, offset=40...）
不要基于截断的数据做出结论！`;
        }
        return `Observation: ${step.success ? '成功' : '失败'}\n${truncatedOutput}${truncationWarning}`;
      case 'final_answer':
        return `Final Answer: ${step.content}`;
      default:
        return step.content;
    }
  }

  /**
   * 缺陷 G 修复：渐进式压缩旧步骤
   * 保留最近 N 个步骤的完整内容，将更早的步骤压缩为一行摘要
   * @param steps 所有步骤
   * @param keepRecentCount 保留最近步骤数（默认 6，约 2 次迭代的 thought+action+observation）
   */
  private compressOlderSteps(steps: ReActStep[], keepRecentCount: number = 6): string {
    if (steps.length <= keepRecentCount) {
      return steps.map(s => this.formatStepForPrompt(s)).join('\n');
    }

    const olderSteps = steps.slice(0, steps.length - keepRecentCount);
    const recentSteps = steps.slice(steps.length - keepRecentCount);

    // 压缩旧步骤为一行摘要
    const compressedLines: string[] = [];
    let stepIndex = 0;
    for (let i = 0; i < olderSteps.length; i++) {
      const step = olderSteps[i];
      if (step.type === 'action') {
        stepIndex++;
        const nextObs = olderSteps[i + 1];
        const success = nextObs?.type === 'observation' ? (nextObs.success ? '成功' : '失败') : '未知';
        const dataPoints = nextObs?.toolOutput ? this.estimateRecordCount(nextObs.toolOutput) : 0;
        const dataInfo = dataPoints > 0 ? `，返回 ${dataPoints} 条记录` : '';
        compressedLines.push(`[步骤 ${stepIndex}] ${step.toolName} ${success}${dataInfo}`);
      }
    }

    const compressedSection = compressedLines.length > 0
      ? `--- 历史步骤摘要（已压缩） ---\n${compressedLines.join('\n')}\n--- 最近步骤（完整） ---\n`
      : '';

    const recentText = recentSteps.map(s => this.formatStepForPrompt(s)).join('\n');

    return compressedSection + recentText;
  }

  /**
   * 调用 LLM（带重试和速率限制处理）
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async callLLM(
    prompt: string,
    context: ConversationMemory,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number,
    // 意图丢失修复：传入原始用户消息，确保系统提示词中包含用户意图
    originalUserMessage?: string
  ): Promise<string> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    if (!adapter) {
      throw new Error('AI adapter not configured');
    }

    // 构建历史消息
    // 基于相关性筛选对话历史，替代简单的 slice(-10)
    // Requirements: conversation-and-reflection-optimization 1.4
    const scorer = new RelevanceScorer();
    // 将 AgentMessage[] 转为 ChatMessage[] 以兼容 RelevanceScorer
    const chatHistory: ChatMessage[] = context.messages
      .filter(m => m.role !== 'tool')
      .map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }));
    let historyMessages: ChatMessage[] = scorer.selectRelevant(
      originalUserMessage || prompt,
      chatHistory,
      5
    );

    // 如果最后一条消息是用户消息，移除它（因为 prompt 中已包含当前用户请求）
    if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].role === 'user') {
      historyMessages = historyMessages.slice(0, -1);
    }

    // 意图丢失修复：在系统提示词中明确包含用户的原始请求
    // 这样即使用户消息在长提示词中被淹没，LLM 也能从系统提示词中获取用户意图
    const systemContent = originalUserMessage
      ? `你是一个专业的 RouterOS 网络设备运维助手，使用 ReAct 方法解决问题。\n\n【当前用户请求】${originalUserMessage}\n\n你必须针对上述用户请求进行分析和回答，不要将其视为空请求。`
      : '你是一个专业的 RouterOS 网络设备运维助手，使用 ReAct 方法解决问题。';

    const request: ChatRequest = {
      provider,
      model,
      messages: [
        {
          role: 'system',
          content: systemContent,
        },
        ...historyMessages,
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature,
      maxTokens: 4096,
    };

    return this.callLLMWithRetry(request, 3, adapter);
  }

  /**
   * 简单 LLM 调用（不带历史，带重试和速率限制处理）
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async callLLMSimple(
    prompt: string,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<string> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    if (!adapter) {
      throw new Error('AI adapter not configured');
    }

    const request: ChatRequest = {
      provider,
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature: Math.max(0.1, temperature - 0.2), // 简单调用使用稍低的温度
      maxTokens: 4096,
    };

    return this.callLLMWithRetry(request, 3, adapter);
  }

  /**
   * 带重试、超时和速率限制处理的 LLM 调用
   * 最多重试 3 次，每次重试前等待递增的时间
   * 每次调用有 60 秒超时限制，防止无限等待
   * 并发安全：接受请求级别的 AI 适配器
   */
  private async callLLMWithRetry(
    request: ChatRequest,
    maxRetries: number = 3,
    effectiveAdapter?: IAIProviderAdapter | null
  ): Promise<string> {
    // 并发安全：优先使用传入的适配器，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;

    if (!adapter) {
      throw new Error('AI adapter not configured');
    }

    // LLM 调用超时时间（毫秒）
    const LLM_CALL_TIMEOUT = this.config.thoughtTimeout || 60000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 在每次调用前添加基础延迟，避免触发速率限制
        if (attempt > 0) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000); // 指数退避，最多等待 10 秒
          logger.info(`LLM call retry ${attempt + 1}/${maxRetries}, waiting ${waitTime}ms`);
          await this.sleep(waitTime);
        }

        // 使用 Promise.race 添加超时机制，防止无限等待
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`LLM call timeout after ${LLM_CALL_TIMEOUT}ms`));
          }, LLM_CALL_TIMEOUT);
        });

        const response = await Promise.race([
          adapter.chat(request),
          timeoutPromise,
        ]);

        // 成功后添加小延迟，避免连续调用触发速率限制
        await this.sleep(500);

        return response.content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message.toLowerCase();

        // 如果是超时错误，记录并重试
        if (errorMessage.includes('timeout')) {
          logger.warn(`LLM call timeout, attempt ${attempt + 1}/${maxRetries}`, {
            timeout: LLM_CALL_TIMEOUT,
          });
          continue;
        }

        // 如果是速率限制错误，等待更长时间后重试
        if (errorMessage.includes('rate limit') || errorMessage.includes('too many requests')) {
          const waitTime = Math.min(2000 * Math.pow(2, attempt), 30000); // 速率限制时等待更长
          logger.warn(`Rate limit hit, waiting ${waitTime}ms before retry`, {
            attempt: attempt + 1,
            maxRetries,
          });
          await this.sleep(waitTime);
          continue;
        }

        // 其他错误也重试，但等待时间较短
        logger.warn(`LLM call failed, attempt ${attempt + 1}/${maxRetries}`, {
          error: lastError.message,
        });
      }
    }

    // 所有重试都失败
    throw lastError || new Error('LLM call failed after all retries');
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  /**
   * 解析 LLM 输出 — 委托给独立的 llmOutputParser 模块
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.3
   */
  private parseLLMOutput(output: string): ParsedLLMOutput {
    return parseLLMOutputFn(output);
  }

  /**
   * 从 LLM 输出中提取平衡的 JSON 字符串 — 委托给 llmOutputParser
   */
  private extractBalancedJson(output: string): string | null {
    return extractBalancedJsonFn(output);
  }

  /**
   * 解析 Action Input JSON
   * Requirements: 3.2, 3.3 - 委托给 llmOutputParser
   */
  private parseActionInput(rawInput: string): Record<string, unknown> | null {
    return parseActionInputFn(rawInput);
  }

  /**
   * 备用 key-value 提取
   * Requirements: 3.4 - 委托给 llmOutputParser
   */
  private extractFallbackKeyValues(output: string): Record<string, unknown> {
    return extractFallbackKeyValuesFn(output);
  }

  /**
   * 从 Thought 中提取 Action — 委托给 ActionSelector
   */
  private extractActionFromThought(
    thought: string,
    availableTools: AgentTool[],
    steps: ReActStep[] = [],
    originalMessage: string = '',
    ragContext?: RAGContext,
    skillContext?: SkillContext,
    intentTools?: Array<{ name: string; params?: Record<string, unknown>; reason?: string }>
  ): { toolName: string; toolInput: Record<string, unknown> } | null {
    return this.actionSelector.extractActionFromThought(thought, availableTools, steps, originalMessage, ragContext, skillContext, intentTools);
  }

  /**
   * 为工具生成输入参数 — 委托给 ActionSelector
   */
  private generateToolInput(toolName: string, message: string): Record<string, unknown> | null {
    return this.actionSelector.generateToolInput(toolName, message);
  }

  /**
   * 简单规则判断是否继续
   */
  private shouldContinueSimple(steps: ReActStep[]): boolean {
    // 如果没有步骤，继续
    if (steps.length === 0) {
      return true;
    }

    // 如果最后一个 observation 成功，可能不需要继续
    const observations = steps.filter(s => s.type === 'observation');
    if (observations.length > 0) {
      const lastObs = observations[observations.length - 1];
      if (lastObs.success) {
        // 如果已经有成功的结果，可能不需要继续
        return observations.length < 2;
      }
    }

    // 默认继续
    return true;
  }

  /**
   * 缺陷 C 修复：获取成功的数据检索步骤
   * 返回所有成功的 observation 步骤（包含实际数据的）
   */
  private getSuccessfulDataSteps(steps: ReActStep[]): ReActStep[] {
    return steps.filter(s => {
      if (s.type !== 'observation' || !s.success) return false;
      // 检查是否有实质性数据（非空、非错误信息）
      if (!s.toolOutput) return false;
      const outputStr = typeof s.toolOutput === 'string' ? s.toolOutput : JSON.stringify(s.toolOutput);
      // 排除错误响应和空数据
      if (outputStr.length < 20) return false;
      if (typeof s.toolOutput === 'object' && s.toolOutput !== null && 'error' in (s.toolOutput as any)) return false;
      return true;
    });
  }

  /**
   * 缺陷 C 修复：估算工具输出中的记录数量
   */
  private estimateRecordCount(output: unknown): number {
    if (!output) return 0;
    if (Array.isArray(output)) return output.length;
    if (typeof output === 'object' && output !== null) {
      // 检查常见的数组字段
      for (const key of ['data', 'items', 'results', 'records', 'list']) {
        const val = (output as any)[key];
        if (Array.isArray(val)) return val.length;
      }
    }
    // 尝试从 JSON 字符串中估算
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.length;
    } catch { /* ignore */ }
    return 0;
  }

  /**
   * 缺陷 H 修复：解析结构化的 JSON 继续决策
   * 尝试从 LLM 响应中提取 {"continue": true/false, "reason": "..."} 格式
   * @returns true/false 如果成功解析，null 如果无法解析
   */
  private parseStructuredContinueDecision(response: string): boolean | null {
    try {
      // 尝试直接解析整个响应
      const directParse = JSON.parse(response.trim());
      if (typeof directParse.continue === 'boolean') {
        return directParse.continue;
      }
    } catch {
      // 不是纯 JSON，尝试从文本中提取
    }

    // 尝试从响应中提取 JSON 块
    const jsonMatch = response.match(/\{[^{}]*"continue"\s*:\s*(true|false)[^{}]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.continue === 'boolean') {
          return parsed.continue;
        }
      } catch {
        // 解析失败，返回 null
      }
    }

    return null;
  }

  /**
   * 检测是否陷入循环（增强版）
   *
   * Requirements:
   * - 10.1: 工具调用模式检测（最近 3 次相同工具+相似参数）
   * - 10.2: 关键词重叠率检测（>80% 判定语义重复）
   * - 10.3: 记录卡死诊断信息
   */
  private isStuckInLoop(
    recentThoughts: string[],
    toolCallPatterns?: Array<{ toolName: string; paramsHash: string }>,
  ): boolean {
    const result = detectLoopStuck(recentThoughts, toolCallPatterns || [], {
      maxRepeats: 3,
      keywordOverlapThreshold: 0.6,
    });

    if (result.isStuck) {
      logger.warn('[ReActLoop] Loop stuck detected', {
        reason: result.reason,
        details: result.details,
      });
    }

    return result.isStuck;
  }

  /**
   * 判断工具结果是否成功
   */
  private isToolResultSuccess(result: unknown): boolean {
    if (result === null || result === undefined) {
      return false;
    }

    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      // 检查常见的成功标志
      if ('success' in obj) {
        return Boolean(obj.success);
      }
      if ('error' in obj) {
        return false;
      }
    }

    return true;
  }

  /**
   * 格式化 Observation
   */
  private formatObservation(output: unknown, success: boolean): string {
    const status = success ? '执行成功' : '执行失败';

    if (typeof output === 'string') {
      return `${status}: ${output}`;
    }

    try {
      const json = JSON.stringify(output, null, 2);
      // 增加截断限制到 10000 字符，确保完整数据被保存到步骤中
      const maxLength = 10000;
      let truncatedJson = json;
      let truncationWarning = '';
      if (json.length > maxLength) {
        truncatedJson = json.substring(0, maxLength);
        truncationWarning = `\n\n⚠️ 【数据截断警告】原始数据 ${json.length} 字符，已截断为 ${maxLength} 字符。
请使用 limit 和 proplist 参数重新查询以获取完整数据！`;
      }
      return `${status}:\n${truncatedJson}${truncationWarning}`;
    } catch {
      return `${status}: [无法序列化的结果]`;
    }
  }

  /**
   * 智能数据摘要
   * 当工具返回的数据量超过阈值时，自动使用 LLM 提炼关键要点
   * 避免大量原始数据占用上下文窗口
   * 
   * @param output 工具输出数据
   * @param toolName 工具名称
   * @param userMessage 用户原始消息
   * @param _context 对话上下文（预留参数，未来可用于增强摘要质量）
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async smartSummarizeIfNeeded(
    output: unknown,
    toolName: string,
    userMessage: string,
    _context: ConversationMemory, // 预留参数，未来可用于利用对话历史增强摘要
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<{
    wasSummarized: boolean;
    summarizedOutput: unknown;
    originalSize: number;
    summarizedSize: number;
  }> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    // 转换为字符串计算大小
    let outputStr: string;
    try {
      outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    } catch {
      outputStr = String(output);
    }

    const originalSize = outputStr.length;

    // 如果数据量未超过阈值，不需要摘要
    if (originalSize <= this.config.smartSummarizationThreshold) {
      return {
        wasSummarized: false,
        summarizedOutput: output,
        originalSize,
        summarizedSize: originalSize,
      };
    }

    logger.info('Smart summarization triggered', {
      toolName,
      originalSize,
      threshold: this.config.smartSummarizationThreshold,
    });

    // 缺陷 G 修复：优先使用 ToolOutputSummarizer 进行智能摘要
    try {
      const summarizedResults = this.toolOutputSummarizer.summarize(
        [{ toolName, output }],
        this.config.summarizedTargetSize
      );
      if (summarizedResults.length > 0) {
        const result = summarizedResults[0];
        // 如果 ToolOutputSummarizer 成功且结果足够小，直接使用
        if (result.summarizedOutput.length <= this.config.summarizedTargetSize * 2) {
          logger.info('ToolOutputSummarizer summarization completed', {
            toolName,
            originalSize,
            summarizedSize: result.summarizedOutput.length,
            isTruncated: result.isTruncated,
          });
          return {
            wasSummarized: true,
            summarizedOutput: result.summarizedOutput,
            originalSize,
            summarizedSize: result.summarizedOutput.length,
          };
        }
      }
    } catch (tosError) {
      logger.warn('ToolOutputSummarizer failed, falling back to LLM summarization', {
        error: tosError instanceof Error ? tosError.message : String(tosError),
      });
    }

    // 如果没有 AI 适配器，使用简单截断
    if (!adapter) {
      const truncated = this.simpleTruncateWithStructure(output, this.config.summarizedTargetSize);
      return {
        wasSummarized: true,
        summarizedOutput: truncated,
        originalSize,
        summarizedSize: typeof truncated === 'string' ? truncated.length : JSON.stringify(truncated).length,
      };
    }

    try {
      // 使用 LLM 进行智能摘要（传递请求级别的配置）
      const summarized = await this.summarizeWithLLM(output, toolName, userMessage, adapter, provider, model, temperature);
      const summarizedSize = typeof summarized === 'string' ? summarized.length : JSON.stringify(summarized).length;

      logger.info('Smart summarization completed', {
        toolName,
        originalSize,
        summarizedSize,
        compressionRatio: ((originalSize - summarizedSize) / originalSize * 100).toFixed(1) + '%',
      });

      return {
        wasSummarized: true,
        summarizedOutput: summarized,
        originalSize,
        summarizedSize,
      };
    } catch (error) {
      logger.warn('Smart summarization failed, using simple truncation', {
        error: error instanceof Error ? error.message : String(error),
      });

      // 摘要失败时使用简单截断
      const truncated = this.simpleTruncateWithStructure(output, this.config.summarizedTargetSize);
      return {
        wasSummarized: true,
        summarizedOutput: truncated,
        originalSize,
        summarizedSize: typeof truncated === 'string' ? truncated.length : JSON.stringify(truncated).length,
      };
    }
  }

  /**
   * 使用 LLM 进行智能摘要
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async summarizeWithLLM(
    output: unknown,
    toolName: string,
    userMessage: string,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<unknown> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

    // 缺陷 F 修复：两阶段摘要策略
    // 阶段 1：从完整数据中提取所有记录的关键标识字段
    const keyIdentifiers = this.extractKeyIdentifiers(output);
    const keyIdSection = keyIdentifiers.length > 0
      ? `\n## 关键标识列表（共 ${keyIdentifiers.length} 条记录，必须全部保留）\n${keyIdentifiers.map((k, i) => `${i + 1}. ${k}`).join('\n')}\n`
      : '';

    // 缺陷 F 修复：动态计算截断上限，基于记录数量
    const recordCount = this.estimateRecordCount(output);
    const dynamicTruncateLimit = Math.max(8000, Math.min(recordCount * 800, 30000));
    const truncatedData = outputStr.length > dynamicTruncateLimit
      ? outputStr.substring(0, dynamicTruncateLimit) + `\n...[数据过长，已截断，原始 ${outputStr.length} 字符]`
      : outputStr;

    // 缺陷 F 修复：放宽输出长度限制
    const outputLimit = Math.max(1500, Math.min(recordCount * 150, 4000));

    // 构建摘要提示词
    const prompt = `你是一个数据分析助手。用户正在查询 RouterOS 设备信息，工具返回了大量数据。
请提炼出与用户问题最相关的关键信息。

## 用户问题
${userMessage}

## 工具名称
${toolName}
${keyIdSection}
## 原始数据（${outputStr.length} 字符，共 ${recordCount} 条记录）
${truncatedData}

## 要求
1. 提炼出与用户问题最相关的关键信息
2. 保留重要的数值、状态、配置项
3. 如果是列表数据，必须保留所有记录的关键标识信息（名称、ID 等），允许省略详细内容但不允许省略记录条目
4. 统计总数并确保与实际记录数一致
5. 输出格式要简洁清晰，便于后续分析
6. 输出长度控制在 ${outputLimit} 字符以内

## 输出格式
请直接输出摘要内容，不要添加额外的解释。`;

    const request: ChatRequest = {
      provider,
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature: Math.max(0.1, temperature - 0.2), // 摘要使用稍低的温度以保持一致性
      maxTokens: 2000,
    };

    const response = await this.callLLMWithRetry(request, 3, adapter);

    // 返回摘要结果，包装成结构化格式
    return {
      _summarized: true,
      _original_size: outputStr.length,
      _record_count: recordCount,
      _tool: toolName,
      summary: response,
    };
  }

  /**
   * 简单截断，保留数据结构
   * 用于 LLM 摘要失败时的降级处理
   */
  private simpleTruncateWithStructure(output: unknown, maxSize: number): unknown {
    if (typeof output === 'string') {
      if (output.length <= maxSize) {
        return output;
      }
      return output.substring(0, maxSize) + `\n...[已截断，原始 ${output.length} 字符]`;
    }

    if (Array.isArray(output)) {
      // 空数组直接返回
      if (output.length === 0) {
        return output;
      }

      // 对于数组，保留前几个元素
      const outputStr = JSON.stringify(output, null, 2);
      if (outputStr.length <= maxSize) {
        return output;
      }

      // 缺陷 F 修复：先提取所有元素的关键字段列表
      const keyIdentifiers = this.extractKeyIdentifiers(output);

      // 计算大约能保留多少元素（防止除以 0）
      const avgItemSize = outputStr.length / output.length;
      const itemsToKeep = Math.max(1, Math.floor(maxSize / avgItemSize) - 1);

      // 确保 itemsToKeep 不超过数组长度
      const actualItemsToKeep = Math.min(itemsToKeep, output.length);

      const truncatedArray = output.slice(0, actualItemsToKeep);

      // 缺陷 F 修复：附加完整的关键标识信息列表
      truncatedArray.push({
        _truncation_notice: `数据已截断：原始 ${output.length} 条，显示前 ${actualItemsToKeep} 条`,
        _original_count: output.length,
        _shown_count: actualItemsToKeep,
        _all_key_identifiers: keyIdentifiers,
      });

      return truncatedArray;
    }

    if (typeof output === 'object' && output !== null) {
      const outputStr = JSON.stringify(output, null, 2);
      if (outputStr.length <= maxSize) {
        return output;
      }

      // 对于对象，截断字符串表示
      return {
        _truncated_data: outputStr.substring(0, maxSize),
        _truncation_notice: `数据已截断：原始 ${outputStr.length} 字符，显示前 ${maxSize} 字符`,
        _original_size: outputStr.length,
      };
    }

    return output;
  }

  /**
   * 缺陷 F 修复：从数据中提取所有记录的关键标识字段
   * 支持数组和嵌套对象结构
   */
  private extractKeyIdentifiers(data: unknown): string[] {
    const KEY_FIELDS = ['name', 'id', '.id', 'title', 'label', 'key', 'identifier', 'hostname', 'address'];
    const identifiers: string[] = [];

    const extractFromItem = (item: unknown): string | null => {
      if (typeof item !== 'object' || item === null) return null;
      const obj = item as Record<string, unknown>;
      const parts: string[] = [];
      for (const field of KEY_FIELDS) {
        if (field in obj && obj[field] !== undefined && obj[field] !== null) {
          parts.push(`${field}=${String(obj[field])}`);
        }
      }
      return parts.length > 0 ? parts.join(', ') : null;
    };

    if (Array.isArray(data)) {
      for (const item of data) {
        const id = extractFromItem(item);
        if (id) identifiers.push(id);
      }
    } else if (typeof data === 'object' && data !== null) {
      // 检查常见的数组字段
      for (const key of ['data', 'items', 'results', 'records', 'list']) {
        const val = (data as any)[key];
        if (Array.isArray(val)) {
          for (const item of val) {
            const id = extractFromItem(item);
            if (id) identifiers.push(id);
          }
          break;
        }
      }
    } else if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        return this.extractKeyIdentifiers(parsed);
      } catch { /* not JSON */ }
    }

    return identifiers;
  }


  /**
   * 从步骤中提取 Final Answer
   */
  private async extractFinalAnswer(
    thought: string,
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<string> {
    // 尝试从 thought 中提取 final answer
    const parsed = this.parseLLMOutput(`Thought: ${thought}`);
    if (parsed.finalAnswer) {
      return parsed.finalAnswer;
    }

    // 如果 thought 本身就是答案
    if (thought.length > 50 && !thought.toLowerCase().includes('需要') &&
      !thought.toLowerCase().includes('应该')) {
      return thought;
    }

    // 生成 Final Answer（传递请求级别的配置）
    return this.generateFinalAnswerFromSteps(
      message, steps, context,
      effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
    );
  }

  /**
   * 从步骤生成 Final Answer
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async generateFinalAnswerFromSteps(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<string> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;
    // 如果有 AI 适配器，使用 LLM 生成
    if (adapter) {
      try {
        const prompt = this.buildFinalAnswerPrompt(message, steps);
        const response = await this.callLLMSimple(prompt, adapter, provider, model, temperature);
        return response;
      } catch (error) {
        logger.warn('Failed to generate final answer with LLM', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 回退：基于步骤生成摘要
    return this.generateFallbackFinalAnswer(message, steps);
  }

  /**
   * 构建 Final Answer 提示词
   */
  private buildFinalAnswerPrompt(message: string, steps: ReActStep[]): string {
    // 使用完整输出格式化步骤，确保 LLM 能看到完整数据
    const stepsText = steps.map(s => this.formatStepForPrompt(s, true)).join('\n\n');

    // 提取收集到的数据摘要
    const collectedData = this.extractCollectedData(steps);

    return `你是一个专业的 RouterOS 网络设备运维助手。请基于收集到的**实际数据**生成回答。

## 用户请求
${message}

## 执行的步骤和收集到的完整数据
${stepsText}

## 收集到的关键数据摘要
${collectedData}

## 生成回答的要求
1. **必须使用上面收集到的实际数据**，不要输出通用模板或"如何做"的教程
2. 如果用户请求的是"绘制拓扑"、"列出接口"、"查看配置"等，请直接基于数据生成结果
3. 以结构化的方式展示数据（表格、列表、ASCII 图等）
4. 如果是网络拓扑请求，基于接口、IP、桥接等数据绘制 ASCII 拓扑图
5. 如果数据不完整，说明已获取的部分，并指出缺失的部分

请直接输出回答内容，不要包含"Final Answer:"前缀。`;
  }

  /**
   * 生成回退 Final Answer
   */
  private generateFallbackFinalAnswer(message: string, steps: ReActStep[]): string {
    const observations = steps.filter(s => s.type === 'observation');
    const successfulObs = observations.filter(s => s.success);

    if (successfulObs.length === 0) {
      return `针对您的问题"${message}"，我尝试了多种方法但未能获取到有效信息。建议您检查设备连接状态或提供更多具体信息。`;
    }

    // 汇总成功的结果
    const results = successfulObs.map(s => {
      if (typeof s.toolOutput === 'object' && s.toolOutput !== null) {
        const obj = s.toolOutput as Record<string, unknown>;
        if ('data' in obj) {
          return `${s.toolName || '工具'}返回了相关数据`;
        }
        if ('results' in obj) {
          return `找到了 ${(obj.results as unknown[])?.length || 0} 条相关记录`;
        }
      }
      return `${s.toolName || '工具'}执行成功`;
    });

    return `针对您的问题"${message}"，我进行了以下操作：\n${results.join('\n')}\n\n如需更详细的信息，请告诉我具体需要了解哪些方面。`;
  }

  /**
   * 强制生成 Final Answer（达到最大迭代或卡死时）
   * 修复：必须传递完整的工具输出数据给 LLM，而不是只传递摘要
   * 并发安全：接受请求级别的 AI 配置参数
   */
  private async generateForcedFinalAnswer(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    // 并发安全：请求级别的 AI 配置
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number
  ): Promise<string> {
    // 并发安全：优先使用传入的参数，回退到实例属性
    const adapter = effectiveAdapter ?? this.aiAdapter;
    const provider = effectiveProvider ?? this.provider;
    const model = effectiveModel ?? this.model;
    const temperature = effectiveTemperature ?? this.config.temperature;

    // 使用完整输出格式化步骤，确保 LLM 能看到所有收集到的数据
    const stepsText = steps.map(s => this.formatStepForPrompt(s, true)).join('\n\n');

    // 提取所有成功的观察结果中的实际数据
    const collectedData = this.extractCollectedData(steps);

    if (adapter) {
      try {
        const prompt = `你是一个专业的 RouterOS 网络设备运维助手。用户提出了一个请求，你已经执行了多个工具调用来收集数据。
现在请基于收集到的**实际数据**生成一个完整、有用的回答。

## 用户请求
${message}

## 已执行的步骤和收集到的完整数据
${stepsText}

## 收集到的关键数据摘要
${collectedData}

## 生成回答的要求
1. **必须使用上面收集到的实际数据**，不要输出通用模板或建议
2. 如果用户请求的是"绘制拓扑"、"列出接口"等，请直接基于数据生成结果
3. 以结构化的方式展示数据（表格、列表等）
4. 如果数据不完整，说明已获取的部分，并指出缺失的部分
5. 不要输出"如何做某事"的教程，而是直接给出基于数据的结果

请直接输出回答内容，不要包含"Final Answer:"前缀。`;

        const response = await this.callLLMSimple(prompt, adapter, provider, model, temperature);
        return response;
      } catch (error) {
        logger.warn('Failed to generate forced final answer with LLM', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 回退：基于步骤生成更详细的摘要
    return this.generateDetailedFallbackAnswer(message, steps);
  }

  /**
   * 从步骤中提取收集到的关键数据
   */
  private extractCollectedData(steps: ReActStep[]): string {
    const dataItems: string[] = [];

    for (const step of steps) {
      if (step.type === 'observation' && step.success && step.toolOutput) {
        const toolName = steps.find(s => s.type === 'action' && s.timestamp && s.timestamp < step.timestamp!)?.toolName || '未知工具';

        try {
          const output = step.toolOutput;
          if (typeof output === 'object' && output !== null) {
            const obj = output as Record<string, unknown>;

            // 提取接口数据
            if (Array.isArray(obj.data || obj.results || obj)) {
              const items = (obj.data || obj.results || obj) as unknown[];
              if (items.length > 0) {
                dataItems.push(`- ${toolName}: 获取到 ${items.length} 条记录`);
                // 提取关键字段
                const sample = items[0] as Record<string, unknown>;
                if (sample) {
                  const keys = Object.keys(sample).slice(0, 5).join(', ');
                  dataItems.push(`  字段: ${keys}`);
                }
              }
            }

            // 提取系统资源数据
            if (obj.cpu !== undefined || obj.memory !== undefined || obj.uptime !== undefined) {
              dataItems.push(`- 系统资源: CPU=${obj.cpu}, 内存=${obj.memory}, 运行时间=${obj.uptime}`);
            }

            // 提取知识库搜索结果
            if (obj.documents && Array.isArray(obj.documents)) {
              dataItems.push(`- 知识库: 找到 ${(obj.documents as unknown[]).length} 条相关记录`);
            }
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    if (dataItems.length === 0) {
      return '未能提取到结构化数据，请查看上面的完整步骤输出。';
    }

    return dataItems.join('\n');
  }

  /**
   * 生成更详细的回退答案
   */
  private generateDetailedFallbackAnswer(message: string, steps: ReActStep[]): string {
    const observations = steps.filter(s => s.type === 'observation');
    const successfulObs = observations.filter(s => s.success);

    if (successfulObs.length === 0) {
      return `针对您的问题"${message}"，我尝试了多种方法但未能获取到有效信息。建议您检查设备连接状态或提供更多具体信息。`;
    }

    // 构建详细的结果摘要
    const results: string[] = [];
    for (const obs of successfulObs) {
      if (obs.toolOutput) {
        try {
          const output = typeof obs.toolOutput === 'string'
            ? obs.toolOutput
            : JSON.stringify(obs.toolOutput, null, 2);
          // 截取前 2000 字符
          const truncated = output.length > 2000 ? output.substring(0, 2000) + '...' : output;
          results.push(truncated);
        } catch {
          results.push('[数据格式化失败]');
        }
      }
    }

    return `针对您的问题"${message}"，我收集到以下数据：\n\n${results.join('\n\n')}\n\n如需更详细的分析，请告诉我具体需要了解哪些方面。`;
  }

  /**
   * 汇总步骤
   */
  private summarizeSteps(steps: ReActStep[]): string {
    const thoughts = steps.filter(s => s.type === 'thought').length;
    const actions = steps.filter(s => s.type === 'action').length;
    const observations = steps.filter(s => s.type === 'observation');
    const successful = observations.filter(s => s.success).length;

    if (actions === 0) {
      return '我分析了您的问题但未找到需要执行的具体操作';
    }

    return `我执行了 ${actions} 个操作，其中 ${successful} 个成功完成`;
  }

  // ==================== 拦截器方法（Skill 系统集成）====================

  /**
   * 设置工具拦截器
   * 用于拦截特定工具的调用，返回缓存结果或自定义处理
   * Requirements: 7.6
   * 
   * @param toolName 要拦截的工具名称
   * @param interceptor 拦截器函数
   */
  setToolInterceptor(toolName: string, interceptor: ToolInterceptor): void {
    this.toolInterceptors.set(toolName, interceptor);
    logger.debug('Tool interceptor set', { toolName });
  }

  /**
   * 清除工具拦截器
   * @param toolName 要清除的工具名称，如果不提供则清除所有
   */
  clearToolInterceptor(toolName?: string): void {
    if (toolName) {
      this.toolInterceptors.delete(toolName);
      logger.debug('Tool interceptor cleared', { toolName });
    } else {
      this.toolInterceptors.clear();
      logger.debug('All tool interceptors cleared');
    }
  }

  /**
   * 检查是否有工具拦截器
   */
  hasToolInterceptor(toolName: string): boolean {
    return this.toolInterceptors.has(toolName);
  }

  /**
   * 设置系统提示词覆盖
   * 用于注入 SKILL.md 内容到 ReAct 循环的提示词中
   * Requirements: 9.1
   * 
   * @param prompt 覆盖的系统提示词
   */
  setSystemPromptOverride(prompt: string): void {
    this.systemPromptOverride = prompt;
    logger.debug('System prompt override set', { promptLength: prompt.length });
  }

  /**
   * 清除系统提示词覆盖
   */
  clearSystemPromptOverride(): void {
    this.systemPromptOverride = null;
    logger.debug('System prompt override cleared');
  }

  /**
   * 获取系统提示词覆盖
   */
  getSystemPromptOverride(): string | null {
    return this.systemPromptOverride;
  }

  // ==================== 配置方法 ====================

  /**
   * 获取配置
   */
  getConfig(): ReActLoopControllerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ReActLoopControllerConfig>): void {
    this.config = { ...this.config, ...config };
    // 同步 ActionSelector 的 knowledgeEnhancedMode
    if ('knowledgeEnhancedMode' in config) {
      this.actionSelector.updateDeps({ knowledgeEnhancedMode: this.config.knowledgeEnhancedMode });
    }
    logger.info('ReActLoopController config updated', { config: this.config });
  }

  /**
   * 检查是否已配置 AI 适配器
   */
  hasAIAdapter(): boolean {
    return this.aiAdapter !== null;
  }

  // ==================== 并行执行方法 ====================

  /**
   * 检查是否应该启用并行执行
   * Requirements: 8.6, 8.7 - 功能开关和百分比发布
   * 
   * @param requestId 可选的请求 ID，用于百分比发布判断
   * @returns 是否启用并行执行
   */
  private shouldEnableParallelExecution(requestId?: string): boolean {
    const parallelConfig = this.config.parallelExecution;

    // 检查是否启用
    if (!parallelConfig?.enabled) {
      return false;
    }

    // 检查百分比发布
    const rolloutPercentage = parallelConfig.rolloutPercentage ?? 0;
    if (rolloutPercentage <= 0) {
      return false;
    }

    if (rolloutPercentage >= 100) {
      return true;
    }

    // 基于请求 ID 的百分比判断
    // 使用简单的哈希算法确保同一请求 ID 总是得到相同的结果
    if (requestId) {
      const hash = this.hashString(requestId);
      const bucket = hash % 100;
      return bucket < rolloutPercentage;
    }

    // 如果没有请求 ID，使用随机数
    return Math.random() * 100 < rolloutPercentage;
  }

  /**
   * 构建并行执行提示词（异步版本）
   * Requirements: 1.6 - 并行执行提示词
   * 
   * 模板管理集成：
   * - 优先从 PromptTemplateService 获取模板
   * - 支持模板热更新
   * 
   * @param message 用户消息
   * @param steps 已执行的步骤
   * @param maxConcurrency 最大并发数
   * @returns 并行执行提示词
   */
  private async buildParallelPromptAsync(message: string, steps: ReActStep[], maxConcurrency: number): Promise<string> {
    // 构建工具描述（带历史统计，工具选择优化）
    const toolDescriptions = await this.getToolDescriptionsWithStats();

    // 构建步骤历史
    const stepsText = steps.length > 0
      ? steps.map(s => this.formatStepForPrompt(s)).join('\n')
      : '无';

    // 尝试使用 PromptComposerAdapter 构建模块化 Prompt
    // Requirements: 1.9
    try {
      return this.promptAdapter.buildParallelReActPrompt(message, toolDescriptions, stepsText, maxConcurrency);
    } catch (adapterError) {
      logger.error('PromptComposerAdapter failed in buildParallelPromptAsync, falling back to template service', { error: adapterError });
    }

    // 回退到模板服务，再回退到原始模板
    const template = await this.getPromptTemplate(
      TEMPLATE_NAMES.PARALLEL,
      PARALLEL_REACT_PROMPT
    );

    return template
      .replace('{{message}}', message)
      .replace('{{tools}}', toolDescriptions)
      .replace('{{steps}}', stepsText)
      .replace('{{maxConcurrency}}', String(maxConcurrency));
  }

  /**
   * 构建并行执行提示词（同步版本，用于向后兼容）
   * Requirements: 1.6 - 并行执行提示词
   * 
   * @param message 用户消息
   * @param steps 已执行的步骤
   * @param maxConcurrency 最大并发数
   * @returns 并行执行提示词
   */
  private buildParallelPrompt(message: string, steps: ReActStep[], maxConcurrency: number): string {
    // 构建工具描述
    const toolDescriptions = this.getTools().map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
        .join('\n');
      return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
    }).join('\n\n');

    // 构建步骤历史
    const stepsText = steps.length > 0
      ? steps.map(s => this.formatStepForPrompt(s)).join('\n')
      : '无';

    // 尝试使用 PromptComposerAdapter 构建模块化 Prompt
    // Requirements: 1.9
    try {
      return this.promptAdapter.buildParallelReActPrompt(message, toolDescriptions, stepsText, maxConcurrency);
    } catch (error) {
      logger.error('PromptComposerAdapter failed for parallel prompt, falling back to legacy template', { error });
      // 回退到原始模板
      return PARALLEL_REACT_PROMPT
        .replace('{{message}}', message)
        .replace('{{tools}}', toolDescriptions)
        .replace('{{steps}}', stepsText)
        .replace('{{maxConcurrency}}', String(maxConcurrency));
    }
  }

  /**
   * 简单字符串哈希函数
   * 用于百分比发布的确定性判断
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * 执行 PLANNED 模式
   * Requirements: 2.1, 2.2, 2.3, 2.4, 14.4 - 使用 ExecutionPlanner 生成并执行计划
   * 
   * @param message 用户消息
   * @param steps 步骤数组（会被修改）
   * @param ragContext RAG 上下文
   * @param formattedKnowledge 格式化的知识
   * @param effectiveAdapter AI 适配器
   * @param effectiveProvider AI 提供商
   * @param effectiveModel 模型名称
   * @param effectiveInterceptors 工具拦截器
   * @param effectiveTemperature 温度参数
   * @param executionContext 执行上下文
   * @param skillContext Skill 上下文
   * @returns 执行结果
   */
  private async executePlannedMode(
    message: string,
    steps: ReActStep[],
    ragContext: RAGContext,
    formattedKnowledge: FormattedKnowledge[],
    effectiveAdapter: IAIProviderAdapter | null,
    effectiveProvider: AIProvider,
    effectiveModel: string,
    effectiveInterceptors: Map<string, ToolInterceptor>,
    effectiveTemperature: number,
    executionContext?: ReActExecutionContext,
    skillContext?: SkillContext
  ): Promise<{
    success: boolean;
    finalAnswer: string;
    iterations: number;
    hasExecutedTool: boolean;
    error?: string;
  }> {
    const planConfig = this.config.parallelExecution;
    let hasExecutedTool = false;
    let iterations = 0;

    try {
      // 生成执行计划
      const plan = await executionPlanner.generatePlan(message, skillContext);

      logger.info('Execution plan generated', {
        planId: plan.planId,
        stageCount: plan.stages.length,
        estimatedToolCalls: plan.estimatedToolCalls,
        requestId: executionContext?.requestId,
      });

      // 记录计划生成的 Thought
      steps.push({
        type: 'thought',
        content: `生成执行计划：${plan.stages.length} 个阶段，预计 ${plan.estimatedToolCalls} 次工具调用`,
        timestamp: Date.now(),
      });

      // 设置工具到 ParallelExecutor
      parallelExecutor.setTools(this.tools);

      // 按阶段执行计划（使用索引循环以支持计划修订后替换剩余阶段）
      const completedStages: typeof plan.stages = [];
      const intermediateResults: MergedObservation[] = [];
      let remainingStages = [...plan.stages];

      while (remainingStages.length > 0) {
        const stage = remainingStages[0];
        remainingStages = remainingStages.slice(1);
        iterations++;

        // 检查是否超过最大迭代次数
        if (iterations > this.config.maxIterations) {
          logger.warn('PLANNED mode reached max iterations', {
            iterations,
            maxIterations: this.config.maxIterations,
            requestId: executionContext?.requestId,
          });
          break;
        }

        // 记录阶段开始的 Thought
        steps.push({
          type: 'thought',
          content: `执行阶段 ${stage.stageId}：${stage.toolCalls.map(tc => tc.toolName).join(', ')}`,
          timestamp: Date.now(),
        });

        // 将计划的工具调用转换为 ToolCall 格式
        const toolCalls = stage.toolCalls.map((ptc, index) => ({
          toolName: ptc.toolName,
          params: ptc.paramsTemplate || {},
          callId: `${stage.stageId}_${ptc.toolName}_${index}_${Date.now()}`,
          dependsOn: [] as string[], // 同一阶段内的调用没有依赖
        }));

        // 创建批次并执行
        const batch = parallelExecutor.createBatch(toolCalls);
        const mergedObservation = await parallelExecutor.executeBatch(
          batch,
          effectiveInterceptors,
          executionContext
        );

        // 记录执行指标
        parallelExecutionMetrics.recordExecution({
          executionId: batch.batchId,
          mode: ExecutionMode.PLANNED,
          toolCallCount: toolCalls.length,
          batchCount: 1,
          totalDuration: mergedObservation.totalDuration,
          theoreticalSequentialDuration: mergedObservation.results.reduce((sum, r) => sum + r.duration, 0),
          speedupRatio: parallelExecutionMetrics.calculateSpeedupRatio(
            mergedObservation.totalDuration,
            mergedObservation.results.map(r => r.duration)
          ),
          avgParallelism: mergedObservation.parallelism,
          failureRate: mergedObservation.failureCount / toolCalls.length,
          retryCount: mergedObservation.results.reduce((sum, r) => sum + r.retryCount, 0),
        });

        // 更新状态
        hasExecutedTool = true;
        if (executionContext) {
          executionContext.hasExecutedTool = true;
        }

        // Requirements: 2.1, 2.4 - 工具反馈闭环：记录计划模式下的工具执行指标
        try {
          if (isCapabilityEnabled('toolFeedback')) {
            for (const result of mergedObservation.results) {
              toolFeedbackCollector.recordMetric({
                toolName: result.toolName,
                timestamp: Date.now(),
                duration: result.duration,
                success: result.success,
                errorMessage: result.success ? undefined : String(result.output),
              });
            }
          }
        } catch (toolFeedbackError) {
          logger.warn('Failed to record planned mode tool feedback metrics', {
            error: toolFeedbackError instanceof Error ? toolFeedbackError.message : String(toolFeedbackError),
          });
        }

        // 存储知识搜索结果
        for (const result of mergedObservation.results) {
          if (result.toolName === 'knowledge_search') {
            this.storeKnowledgeResults({ output: result.output, duration: result.duration, success: result.success }, ragContext);
          }
        }

        // 记录 Observation 步骤
        steps.push({
          type: 'observation',
          content: this.formatObservation(
            mergedObservation.formattedText || parallelExecutor.formatForLLM(mergedObservation.results),
            mergedObservation.successCount > 0
          ),
          timestamp: Date.now(),
          toolOutput: mergedObservation.results,
          duration: mergedObservation.totalDuration,
          success: mergedObservation.successCount > 0,
        });

        completedStages.push(stage);
        intermediateResults.push(mergedObservation);

        // 检查是否需要修订计划（Requirements: 2.4, 3.1, 3.3）
        if (remainingStages.length > 0) {
          try {
            if (isCapabilityEnabled('planRevision')) {
              // planRevision 启用：先评估质量，低于阈值时才修订
              const prConfig = getCapabilityConfig('planRevision');
              const evaluation = await executionPlanner.evaluateStep(
                stage,
                mergedObservation
              );

              if (evaluation.qualityScore < prConfig.qualityThreshold) {
                const revisedPlan = await executionPlanner.revisePlan(plan, completedStages, intermediateResults, evaluation);
                // 应用修订后的计划：替换剩余阶段
                if (revisedPlan.stages.length !== remainingStages.length) {
                  logger.info('Execution plan revised and applied (quality below threshold)', {
                    qualityScore: evaluation.qualityScore,
                    qualityThreshold: prConfig.qualityThreshold,
                    originalRemaining: remainingStages.length,
                    revisedStages: revisedPlan.stages.length,
                    requestId: executionContext?.requestId,
                  });
                }
                remainingStages = revisedPlan.stages;
              } else {
                logger.debug('Plan revision skipped - quality score above threshold', {
                  qualityScore: evaluation.qualityScore,
                  qualityThreshold: prConfig.qualityThreshold,
                });
              }
            }
            // planRevision 未启用时：跳过评估和修订，按原计划执行
          } catch (reviseError) {
            // 修订失败，继续使用原计划
            logger.warn('Plan revision failed, continuing with original plan', {
              error: reviseError instanceof Error ? reviseError.message : String(reviseError),
            });
          }
        }
      }

      // 生成最终答案
      const emptyContext: ConversationMemory = {
        sessionId: executionContext?.requestId || `planned_${Date.now()}`,
        messages: [],
        context: {},
        createdAt: Date.now(),
        lastUpdated: Date.now(),
      };
      const finalAnswer = await this.generateFinalAnswerFromSteps(
        message, steps, emptyContext,
        effectiveAdapter, effectiveProvider, effectiveModel, effectiveTemperature
      );

      // 记录 Final Answer 步骤
      steps.push({
        type: 'final_answer',
        content: finalAnswer,
        timestamp: Date.now(),
      });

      return {
        success: true,
        finalAnswer,
        iterations,
        hasExecutedTool,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('PLANNED mode execution failed', {
        error: errorMessage,
        iterations,
        requestId: executionContext?.requestId,
      });

      return {
        success: false,
        finalAnswer: '',
        iterations,
        hasExecutedTool,
        error: errorMessage,
      };
    }
  }

  // ==================== 回退逻辑方法 ====================

  /**
   * 创建初始回退状态
   * Requirements: 3.6, 3.7 (react-parallel-bugfix)
   * 
   * @param originalMode 原始选择的执行模式
   * @returns 初始化的回退状态
   */
  private createFallbackState(originalMode: ExecutionMode): FallbackState {
    return {
      originalMode,
      currentMode: originalMode,
      fallbackCount: 0,
      fallbackHistory: [],
      partialResults: [],
    };
  }

  /**
   * 执行模式回退
   * Requirements: 3.1, 3.2, 3.3, 3.4 (react-parallel-bugfix)
   * 
   * 实现完整的回退链：PLANNED → PARALLEL → SEQUENTIAL
   * 
   * @param currentMode 当前执行模式
   * @param reason 回退原因
   * @param fallbackState 回退状态（会被修改）
   * @returns 下一个模式，如果无法继续回退则返回 null
   */
  private fallbackToNextMode(
    currentMode: ExecutionMode,
    reason: string,
    fallbackState: FallbackState
  ): ExecutionMode | null {
    // 定义回退链：PLANNED → PARALLEL → SEQUENTIAL → null
    const fallbackChain: Record<ExecutionMode, ExecutionMode | null> = {
      [ExecutionMode.PLANNED]: ExecutionMode.PARALLEL,
      [ExecutionMode.PARALLEL]: ExecutionMode.SEQUENTIAL,
      [ExecutionMode.SEQUENTIAL]: null, // 无法继续回退
    };

    const nextMode = fallbackChain[currentMode];

    if (nextMode !== null) {
      // 记录回退日志
      logger.warn('Falling back to next execution mode', {
        fromMode: currentMode,
        toMode: nextMode,
        reason,
        fallbackCount: fallbackState.fallbackCount + 1,
        originalMode: fallbackState.originalMode,
      });

      // 更新回退状态
      fallbackState.fallbackHistory.push({
        fromMode: currentMode,
        toMode: nextMode,
        reason,
        timestamp: Date.now(),
      });
      fallbackState.fallbackCount++;
      fallbackState.currentMode = nextMode;
    } else {
      // 所有模式都失败
      logger.error('All execution modes failed, no fallback available', {
        originalMode: fallbackState.originalMode,
        fallbackCount: fallbackState.fallbackCount,
        history: fallbackState.fallbackHistory,
      });
    }

    return nextMode;
  }

  /**
   * 构建回退信息
   * Requirements: 3.7 (react-parallel-bugfix)
   * 
   * @param fallbackState 回退状态
   * @returns 回退信息对象
   */
  private buildFallbackInfo(fallbackState: FallbackState): FallbackInfo {
    return {
      didFallback: fallbackState.fallbackCount > 0,
      originalMode: fallbackState.originalMode,
      finalMode: fallbackState.currentMode,
      fallbackCount: fallbackState.fallbackCount,
      fallbackHistory: fallbackState.fallbackHistory.map(h => ({
        fromMode: h.fromMode,
        toMode: h.toMode,
        reason: h.reason,
      })),
    };
  }

  // ==================== 反思与自我修正能力 ====================
  // Requirements: 1.1.1, 1.1.2, 1.1.3, 1.2.1, 1.2.2, 1.2.3

  /**
   * 分析工具执行失败
   * 调用 CriticService 分析失败原因，生成失败分析报告
   * 
   * @requirements 1.1.1 工具执行失败后，系统在 5 秒内生成失败分析报告
   * @requirements 1.1.2 失败分析包含：失败类型、可能原因、修正建议
   * 
   * @param toolName 工具名称
   * @param params 工具参数
   * @param error 错误对象
   * @returns 失败分析结果
   */
  async analyzeToolFailure(
    toolName: string,
    params: Record<string, unknown>,
    error: Error
  ): Promise<FailureAnalysis> {
    const startTime = Date.now();
    const reflectionConfig = getCapabilityConfig('reflection');
    const timeoutMs = reflectionConfig.timeoutMs || 5000;

    logger.info('Analyzing tool failure', {
      toolName,
      errorMessage: error.message,
      timeoutMs,
    });

    try {
      // 使用 Promise.race 确保在超时时间内完成
      const analysisPromise = this.performFailureAnalysis(toolName, params, error);
      const timeoutPromise = new Promise<FailureAnalysis>((_, reject) => {
        setTimeout(() => reject(new Error('Failure analysis timeout')), timeoutMs);
      });

      const analysis = await Promise.race([analysisPromise, timeoutPromise]);

      // 记录分析耗时
      analysis.analysisTime = Date.now() - startTime;

      // 记录到审计日志
      await auditLogger.log({
        action: 'remediation_execute',
        actor: 'system',
        details: {
          trigger: 'reflection_analyze_failure',
          metadata: {
            toolName,
            failureType: analysis.failureType,
            confidence: analysis.confidence,
            analysisTime: analysis.analysisTime,
          },
        },
      });

      logger.info('Failure analysis completed', {
        toolName,
        failureType: analysis.failureType,
        confidence: analysis.confidence,
        analysisTime: analysis.analysisTime,
        suggestionsCount: analysis.suggestions.length,
      });

      return analysis;
    } catch (analysisError) {
      const errorMessage = analysisError instanceof Error ? analysisError.message : String(analysisError);
      logger.warn('Failure analysis failed or timed out, using fallback', {
        toolName,
        error: errorMessage,
        elapsed: Date.now() - startTime,
      });

      // 返回基本的失败分析
      return this.createFallbackFailureAnalysis(toolName, params, error, Date.now() - startTime);
    }
  }

  /**
   * 执行失败分析的核心逻辑
   * 
   * @param toolName 工具名称
   * @param params 工具参数
   * @param error 错误对象
   * @returns 失败分析结果
   */
  private async performFailureAnalysis(
    toolName: string,
    params: Record<string, unknown>,
    error: Error
  ): Promise<FailureAnalysis> {
    const errorMessage = error.message.toLowerCase();
    const errorStack = error.stack || '';

    // 分析失败类型
    const failureType = this.classifyFailureType(errorMessage, errorStack);

    // 分析可能原因
    const possibleCauses = this.analyzePossibleCauses(toolName, params, error, failureType);

    // 生成修正建议
    const suggestions = await this.generateSuggestions(toolName, params, error, failureType);

    // 计算置信度
    const confidence = this.calculateAnalysisConfidence(failureType, possibleCauses, suggestions);

    return {
      failureType,
      possibleCauses,
      suggestions,
      confidence,
      originalError: error.message,
    };
  }

  /**
   * 分类失败类型
   * 
   * @param errorMessage 错误消息
   * @param errorStack 错误堆栈
   * @returns 失败类型
   */
  private classifyFailureType(errorMessage: string, errorStack: string): FailureType {
    // 🔴 FIX 2: 优先检查 IntentResult.errorCode 结构化错误码（无需正则）
    // intentRegistry 返回的错误格式: "[ERROR_CODE] 描述信息"
    const errorCodeMatch = errorMessage.match(/^\[([A-Z_]+)\]/);
    if (errorCodeMatch) {
      const code = errorCodeMatch[1];
      const codeToFailureType: Record<string, FailureType> = {
        'DEVICE_DISCONNECTED': 'network',
        'DEVICE_UNREACHABLE': 'network',
        'CONNECTION_REFUSED': 'network',
        'TIMEOUT': 'timeout',
        'AUTH_FAILURE': 'permission',
        'PARAM_VALIDATION': 'parameter_error',
        'UNKNOWN_INTENT': 'parameter_error',
        'REQUIRES_APPROVAL': 'permission',
        'EXECUTION_ERROR': 'unknown',
        'SERVICE_NOT_READY': 'resource',
        'RESOURCE_NOT_FOUND': 'resource',
        'NOTIFICATION_PARTIAL_FAILURE': 'network',
      };
      if (code in codeToFailureType) {
        return codeToFailureType[code];
      }
    }

    // 参数错误模式
    const parameterErrorPatterns = [
      /invalid.*param/i,
      /missing.*param/i,
      /required.*param/i,
      /invalid.*argument/i,
      /type.*error/i,
      /validation.*fail/i,
      /invalid.*value/i,
      /no such command/i,
      /syntax error/i,
      /缺少必填参数/,
      /参数错误/,
      /命令不存在/,
    ];

    // 超时模式
    const timeoutPatterns = [
      /timeout/i,
      /timed out/i,
      /deadline exceeded/i,
      /request timeout/i,
      /连接超时/,
      /执行超时/,
    ];

    // 权限模式
    const permissionPatterns = [
      /permission denied/i,
      /access denied/i,
      /unauthorized/i,
      /forbidden/i,
      /not allowed/i,
      /insufficient.*privilege/i,
      /密码错误/,
      /login failure/i,
      /cannot log in/i,
    ];

    // 资源模式
    const resourcePatterns = [
      /resource.*not found/i,
      /not found/i,
      /does not exist/i,
      /no such/i,
      /resource.*exhausted/i,
      /out of memory/i,
      /disk.*full/i,
      /资源未找到/,
    ];

    // 网络模式 — 🔴 FIX 2: 添加中文错误模式 + RouterOS 客户端常见错误
    const networkPatterns = [
      /network.*error/i,
      /connection.*refused/i,
      /connection.*reset/i,
      /host.*unreachable/i,
      /network.*unreachable/i,
      /dns.*error/i,
      /socket.*error/i,
      /not connected/i,
      /econnrefused/i,
      /etimedout/i,
      /enotfound/i,
      /连接已断开/,
      /无法连接/,
      /请重新连接/,
      /连接被拒绝/,
      /无法解析主机/,
      /TLS.*握手失败/,
      /DEVICE_DISCONNECTED/,
      /DEVICE_UNREACHABLE/,
      /CONNECTION_REFUSED/,
    ];

    const combined = `${errorMessage} ${errorStack}`;

    if (parameterErrorPatterns.some(p => p.test(combined))) {
      return 'parameter_error';
    }
    if (timeoutPatterns.some(p => p.test(combined))) {
      return 'timeout';
    }
    if (permissionPatterns.some(p => p.test(combined))) {
      return 'permission';
    }
    if (resourcePatterns.some(p => p.test(combined))) {
      return 'resource';
    }
    if (networkPatterns.some(p => p.test(combined))) {
      return 'network';
    }

    return 'unknown';
  }

  /**
   * 分析可能原因
   * 
   * @param toolName 工具名称
   * @param params 工具参数
   * @param error 错误对象
   * @param failureType 失败类型
   * @returns 可能原因列表
   */
  private analyzePossibleCauses(
    toolName: string,
    params: Record<string, unknown>,
    error: Error,
    failureType: FailureType
  ): string[] {
    const causes: string[] = [];

    switch (failureType) {
      case 'parameter_error':
        causes.push('工具参数格式不正确或缺少必需参数');
        causes.push('参数值超出有效范围');
        if (toolName === 'device_query') {
          causes.push('RouterOS API 路径格式错误');
          causes.push('查询命令语法不正确');
        }
        if (toolName === 'execute_command') {
          causes.push('RouterOS API 路径格式错误或命令不存在');
          causes.push('缺少必需的命令参数（如 address、interface 等）');
          causes.push('命令参数格式不正确（如 CIDR 格式、接口名称拼写）');
          if (params.command && typeof params.command === 'string') {
            const cmd = params.command as string;
            if (cmd.includes(' ') && cmd.includes('=')) {
              causes.push('CLI 格式命令可能未被正确解析');
            }
            if (!params.args && !cmd.includes('=')) {
              causes.push('命令缺少参数，可能需要通过 args 对象或 CLI 格式传递参数');
            }
          }
        }
        break;

      case 'timeout':
        causes.push('设备响应时间过长');
        causes.push('网络延迟较高');
        causes.push('设备负载过高导致处理缓慢');
        break;

      case 'permission':
        causes.push('当前用户权限不足');
        causes.push('操作需要更高级别的授权');
        causes.push('目标资源访问受限');
        break;

      case 'resource':
        causes.push('目标资源不存在');
        causes.push('资源已被删除或移动');
        causes.push('资源名称或路径错误');
        break;

      case 'network':
        causes.push('网络连接不稳定');
        causes.push('目标设备不可达');
        causes.push('防火墙或安全策略阻止连接');
        break;

      default:
        causes.push('未知错误，可能是系统内部问题');
        causes.push('工具执行过程中发生异常');
    }

    // 添加基于错误消息的具体原因
    if (error.message) {
      causes.push(`原始错误: ${error.message}`);
    }

    return causes;
  }

  /**
   * 生成修正建议
   * 
   * @requirements 1.1.3 修正建议包含具体的参数调整或替代工具推荐
   * 
   * @param toolName 工具名称
   * @param params 工具参数
   * @param error 错误对象
   * @param failureType 失败类型
   * @returns 修正建议列表
   */
  private async generateSuggestions(
    toolName: string,
    params: Record<string, unknown>,
    error: Error,
    failureType: FailureType
  ): Promise<string[]> {
    const suggestions: string[] = [];

    switch (failureType) {
      case 'parameter_error':
        suggestions.push('检查并修正参数格式');
        if (toolName === 'device_query') {
          suggestions.push('使用正确的 RouterOS API 路径格式，如 /interface, /ip/address');
          suggestions.push('确保 command 参数不包含 print 等 CLI 命令');
          if (params.command && typeof params.command === 'string') {
            const cmd = params.command as string;
            if (cmd.includes(' ')) {
              suggestions.push('移除命令中的空格，使用纯路径格式');
            }
            if (cmd.includes('print')) {
              suggestions.push('移除 print 关键字，API 会自动处理');
            }
          }
        }
        if (toolName === 'execute_command') {
          suggestions.push('使用正确的 RouterOS API 路径格式，如 /ip/address/add, /interface/disable');
          suggestions.push('将路径和参数合并为 CLI 格式：/ip/address/add address=192.168.1.1/24 interface=ether1');
          if (params.command && typeof params.command === 'string') {
            const cmd = params.command as string;
            if (cmd.includes('print')) {
              suggestions.push('移除 print 关键字，写操作不需要 print');
            }
            if (!cmd.includes('=') && (!params.args || Object.keys(params.args as object).length === 0)) {
              suggestions.push('命令缺少参数，请添加必需参数（如 address、interface）');
            }
          }
        }
        suggestions.push('参考工具文档确认必需参数');
        break;

      case 'timeout':
        suggestions.push('增加超时时间');
        suggestions.push('使用 limit 参数限制返回数据量');
        suggestions.push('使用 proplist 参数只获取必要字段');
        suggestions.push('考虑分批查询大量数据');
        break;

      case 'permission':
        suggestions.push('检查用户权限配置');
        suggestions.push('使用具有足够权限的账户');
        suggestions.push('联系管理员获取必要权限');
        break;

      case 'resource':
        suggestions.push('确认资源名称或路径正确');
        suggestions.push('先查询资源列表确认资源存在');
        suggestions.push('检查资源是否已被删除或重命名');
        break;

      case 'network':
        suggestions.push('检查网络连接状态');
        suggestions.push('确认目标设备可达');
        suggestions.push('稍后重试');
        break;

      default:
        suggestions.push('查看详细错误日志');
        suggestions.push('尝试使用替代工具');
        suggestions.push('联系技术支持');
    }

    // 添加替代工具建议
    const alternativeTools = this.suggestAlternativeTools(toolName, failureType);
    if (alternativeTools.length > 0) {
      suggestions.push(`考虑使用替代工具: ${alternativeTools.join(', ')}`);
    }

    return suggestions;
  }

  /**
   * 建议替代工具
   * 
   * @param toolName 当前工具名称
   * @param failureType 失败类型
   * @returns 替代工具列表
   */
  private suggestAlternativeTools(toolName: string, failureType: FailureType): string[] {
    const alternatives: string[] = [];

    // 根据工具类型和失败类型建议替代工具
    if (toolName === 'device_query' && failureType === 'timeout') {
      alternatives.push('monitor_metrics');
    }
    if (toolName === 'execute_command' && failureType === 'permission') {
      alternatives.push('device_query');
    }
    if (toolName === 'execute_command' && failureType === 'parameter_error') {
      alternatives.push('device_query'); // 可能用户实际需要的是查询而非写入
    }

    return alternatives;
  }

  /**
   * 计算分析置信度
   * 
   * @param failureType 失败类型
   * @param possibleCauses 可能原因
   * @param suggestions 修正建议
   * @returns 置信度 (0-1)
   */
  private calculateAnalysisConfidence(
    failureType: FailureType,
    possibleCauses: string[],
    suggestions: string[]
  ): number {
    let confidence = 0.5; // 基础置信度

    // 已知失败类型增加置信度
    if (failureType !== 'unknown') {
      confidence += 0.2;
    }

    // 有多个可能原因增加置信度
    if (possibleCauses.length >= 2) {
      confidence += 0.1;
    }

    // 有具体建议增加置信度
    if (suggestions.length >= 3) {
      confidence += 0.1;
    }

    // 特定失败类型有更高置信度
    if (failureType === 'parameter_error' || failureType === 'timeout') {
      confidence += 0.1;
    }

    return Math.min(1, confidence);
  }

  /**
   * 创建回退失败分析
   * 当分析超时或失败时使用
   * 
   * @param toolName 工具名称
   * @param params 工具参数
   * @param error 错误对象
   * @param elapsed 已耗时
   * @returns 基本失败分析
   */
  private createFallbackFailureAnalysis(
    toolName: string,
    params: Record<string, unknown>,
    error: Error,
    elapsed: number
  ): FailureAnalysis {
    return {
      failureType: 'unknown',
      possibleCauses: [
        '分析过程超时或失败',
        `原始错误: ${error.message}`,
      ],
      suggestions: [
        '检查工具参数是否正确',
        '查看详细错误日志',
        '尝试重新执行',
      ],
      confidence: 0.1,
      analysisTime: elapsed,
      originalError: error.message,
    };
  }

  /**
   * 生成修正参数
   * 调用 ReflectorService 生成修正后的参数
   * 
   * @requirements 1.2.1 反思后的重试使用修正后的参数，而非原始参数
   * @requirements 1.1.3 修正建议包含具体的参数调整或替代工具推荐
   * 
   * @param analysis 失败分析结果
   * @param originalParams 原始参数
   * @returns 修正后的参数
   */
  async generateModifiedParams(
    analysis: FailureAnalysis,
    originalParams: Record<string, unknown>
  ): Promise<ModifiedParams> {
    logger.info('Generating modified params', {
      failureType: analysis.failureType,
      originalParamsKeys: Object.keys(originalParams),
    });

    const modifications: ParamModification[] = [];
    const modifiedParams = { ...originalParams };

    // 根据失败类型生成参数修正
    switch (analysis.failureType) {
      case 'parameter_error':
        this.applyParameterErrorFixes(modifiedParams, originalParams, modifications);
        break;

      case 'timeout':
        this.applyTimeoutFixes(modifiedParams, originalParams, modifications);
        break;

      case 'resource':
        this.applyResourceFixes(modifiedParams, originalParams, modifications);
        break;

      case 'network':
        this.applyNetworkFixes(modifiedParams, originalParams, modifications);
        break;

      default:
        // 对于未知错误，尝试通用修正
        this.applyGenericFixes(modifiedParams, originalParams, modifications);
    }

    // 检查是否建议使用替代工具
    const suggestAlternative = analysis.suggestions.some(s => s.includes('替代工具'));
    let alternativeToolName: string | undefined;
    if (suggestAlternative) {
      const match = analysis.suggestions.find(s => s.includes('替代工具'));
      if (match) {
        const toolMatch = match.match(/替代工具[：:]\s*(\w+)/);
        if (toolMatch) {
          alternativeToolName = toolMatch[1];
        }
      }
    }

    const result: ModifiedParams = {
      params: modifiedParams,
      modifications,
      suggestAlternativeTool: suggestAlternative,
      alternativeToolName,
    };

    logger.info('Modified params generated', {
      modificationsCount: modifications.length,
      suggestAlternative,
      alternativeToolName,
    });

    return result;
  }

  /**
   * 应用参数错误修正
   */
  private applyParameterErrorFixes(
    modifiedParams: Record<string, unknown>,
    originalParams: Record<string, unknown>,
    modifications: ParamModification[]
  ): void {
    // 修正 command 参数（针对 device_query 和 execute_command）
    if (typeof modifiedParams.command === 'string') {
      const originalCommand = modifiedParams.command as string;
      let newCommand = originalCommand;

      // 移除 print 关键字
      if (originalCommand.includes('print')) {
        newCommand = originalCommand.replace(/\s*print\s*/gi, '');
        modifications.push({
          field: 'command',
          oldValue: originalCommand,
          newValue: newCommand,
          reason: '移除 print 关键字，RouterOS API 会自动处理',
        });
      }

      // 修正路径格式
      if (!newCommand.startsWith('/')) {
        newCommand = '/' + newCommand;
        modifications.push({
          field: 'command',
          oldValue: originalCommand,
          newValue: newCommand,
          reason: '添加路径前缀 /',
        });
      }

      modifiedParams.command = newCommand;
    }

    // execute_command 专用修正：尝试将分离的 args 合并为 CLI 格式命令
    // 当 API 格式（command + args）执行失败时，尝试转换为 CLI 格式让 Branch 1 处理
    if (typeof modifiedParams.command === 'string' && modifiedParams.args && typeof modifiedParams.args === 'object') {
      const args = modifiedParams.args as Record<string, unknown>;
      const argEntries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null);
      if (argEntries.length > 0) {
        const originalCommand = modifiedParams.command as string;
        const cliParts = argEntries.map(([k, v]) => `${k}=${String(v)}`).join(' ');
        const cliCommand = `${originalCommand} ${cliParts}`;
        modifications.push({
          field: 'command',
          oldValue: originalCommand,
          newValue: cliCommand,
          reason: '将 API 格式转换为 CLI 格式命令，合并路径和参数',
        });
        modifiedParams.command = cliCommand;
        // 清除 args，让 executeCommandTool 的 Branch 1（CLI 格式检测）处理
        modifications.push({
          field: 'args',
          oldValue: args,
          newValue: undefined,
          reason: '参数已合并到 command 中，清除 args 以启用 CLI 格式自动检测',
        });
        delete modifiedParams.args;
      }
    }
  }

  /**
   * 应用超时修正
   */
  private applyTimeoutFixes(
    modifiedParams: Record<string, unknown>,
    originalParams: Record<string, unknown>,
    modifications: ParamModification[]
  ): void {
    // 添加或减少 limit 参数
    const currentLimit = modifiedParams.limit as number | undefined;
    const newLimit = currentLimit ? Math.min(currentLimit, 20) : 20;

    if (currentLimit !== newLimit) {
      modifications.push({
        field: 'limit',
        oldValue: currentLimit,
        newValue: newLimit,
        reason: '限制返回数据量以减少超时风险',
      });
      modifiedParams.limit = newLimit;
    }

    // 添加 proplist 参数（如果没有）
    if (!modifiedParams.proplist && modifiedParams.command) {
      const command = modifiedParams.command as string;
      const defaultProplist = this.getDefaultProplist(command);
      if (defaultProplist) {
        modifications.push({
          field: 'proplist',
          oldValue: undefined,
          newValue: defaultProplist,
          reason: '添加 proplist 参数只获取必要字段',
        });
        modifiedParams.proplist = defaultProplist;
      }
    }
  }

  /**
   * 获取默认的 proplist
   */
  private getDefaultProplist(command: string): string | null {
    const proplistMap: Record<string, string> = {
      '/interface': 'name,type,running,disabled',
      '/ip/address': 'address,interface,network,disabled',
      '/ip/route': 'dst-address,gateway,distance,routing-table',
      '/ip/firewall/filter': 'chain,action,src-address,dst-address,comment',
      '/ip/firewall/nat': 'chain,action,src-address,dst-address,to-addresses',
      '/routing/ospf/neighbor': 'instance,router-id,address,state',
      '/system/resource': 'cpu-load,free-memory,total-memory,uptime',
    };

    for (const [path, proplist] of Object.entries(proplistMap)) {
      if (command.includes(path)) {
        return proplist;
      }
    }

    return null;
  }

  /**
   * 应用资源错误修正
   */
  private applyResourceFixes(
    modifiedParams: Record<string, unknown>,
    originalParams: Record<string, unknown>,
    modifications: ParamModification[]
  ): void {
    // 尝试修正资源路径
    if (typeof modifiedParams.command === 'string') {
      const command = modifiedParams.command as string;

      // 常见路径修正映射
      const pathCorrections: Record<string, string> = {
        '/interface/print': '/interface',
        '/ip/address/print': '/ip/address',
        '/system/resource/print': '/system/resource',
      };

      for (const [wrong, correct] of Object.entries(pathCorrections)) {
        if (command.includes(wrong)) {
          const newCommand = command.replace(wrong, correct);
          modifications.push({
            field: 'command',
            oldValue: command,
            newValue: newCommand,
            reason: '修正 API 路径格式',
          });
          modifiedParams.command = newCommand;
          break;
        }
      }
    }
  }

  /**
   * 应用网络错误修正
   */
  private applyNetworkFixes(
    modifiedParams: Record<string, unknown>,
    originalParams: Record<string, unknown>,
    modifications: ParamModification[]
  ): void {
    // 添加重试标记
    if (!modifiedParams.retry) {
      modifications.push({
        field: 'retry',
        oldValue: undefined,
        newValue: true,
        reason: '启用重试机制应对网络不稳定',
      });
      modifiedParams.retry = true;
    }

    // 减少数据量
    if (!modifiedParams.limit) {
      modifications.push({
        field: 'limit',
        oldValue: undefined,
        newValue: 10,
        reason: '减少数据量以降低网络传输失败风险',
      });
      modifiedParams.limit = 10;
    }
  }

  /**
   * 应用通用修正
   */
  private applyGenericFixes(
    modifiedParams: Record<string, unknown>,
    originalParams: Record<string, unknown>,
    modifications: ParamModification[]
  ): void {
    // 添加 limit 参数（如果没有）
    if (!modifiedParams.limit) {
      modifications.push({
        field: 'limit',
        oldValue: undefined,
        newValue: 50,
        reason: '添加默认限制以防止数据量过大',
      });
      modifiedParams.limit = 50;
    }
  }

  /**
   * 执行带反思的工具调用
   * 当工具执行失败时，自动进行反思分析并重试
   * 
   * @requirements 1.2.2 最多允许 2 次反思重试，防止死循环
   * @requirements 1.2.3 每次反思重试记录到 ReActStep 中，类型为 reflection
   * 
   * @param toolName 工具名称
   * @param params 工具参数
   * @param maxRetries 最大重试次数
   * @param steps 步骤记录数组（用于记录反思步骤）
   * @param effectiveInterceptors 工具拦截器
   * @returns 执行结果
   */
  async executeWithReflection(
    toolName: string,
    params: Record<string, unknown>,
    maxRetries: number = 2,
    steps?: ReActStep[],
    effectiveInterceptors?: Map<string, ToolInterceptor>,
    routerosClient?: import('../../routerosClient').RouterOSClient,
    tickDeviceId?: string
  ): Promise<{ output: unknown; duration: number; success: boolean; reflectionUsed: boolean }> {
    // 检查反思能力是否启用
    if (!isCapabilityEnabled('reflection')) {
      // 反思能力未启用，直接执行
      const result = await this.executeAction(toolName, params, effectiveInterceptors, routerosClient, tickDeviceId);
      return { ...result, reflectionUsed: false };
    }

    const reflectionConfig = getCapabilityConfig('reflection');
    const effectiveMaxRetries = Math.min(maxRetries, reflectionConfig.maxRetries);

    let currentParams = { ...params };
    let retryCount = 0;
    let lastResult: { output: unknown; duration: number; success: boolean } | null = null;

    while (retryCount <= effectiveMaxRetries) {
      // 执行工具
      const result = await this.executeAction(toolName, currentParams, effectiveInterceptors, routerosClient, tickDeviceId);
      lastResult = result;

      // 如果成功，直接返回
      if (result.success) {
        return { ...result, reflectionUsed: retryCount > 0 };
      }

      // 如果已达到最大重试次数，返回失败结果
      if (retryCount >= effectiveMaxRetries) {
        logger.warn('Max reflection retries reached', {
          toolName,
          retryCount,
          maxRetries: effectiveMaxRetries,
        });
        return { ...result, reflectionUsed: retryCount > 0 };
      }

      // 执行反思分析
      const error = new Error(
        typeof result.output === 'object' && result.output !== null && 'error' in result.output
          ? String((result.output as { error: unknown }).error)
          : 'Tool execution failed'
      );

      const analysis = await this.analyzeToolFailure(toolName, currentParams, error);
      const modifiedParams = await this.generateModifiedParams(analysis, currentParams);

      // 记录反思步骤
      if (steps) {
        steps.push({
          type: 'reflection',
          content: `反思分析: ${analysis.failureType} - ${analysis.possibleCauses[0] || '未知原因'}`,
          timestamp: Date.now(),
          failureAnalysis: analysis,
          modifiedParams: modifiedParams,
        });
      }

      // 如果建议使用替代工具，记录但继续使用当前工具重试
      if (modifiedParams.suggestAlternativeTool && modifiedParams.alternativeToolName) {
        logger.info('Alternative tool suggested', {
          currentTool: toolName,
          suggestedTool: modifiedParams.alternativeToolName,
        });
      }

      // 检查参数是否有实际修改
      if (modifiedParams.modifications.length === 0) {
        logger.warn('No parameter modifications generated, stopping retry', {
          toolName,
          retryCount,
        });
        return { ...result, reflectionUsed: true };
      }

      // 使用修正后的参数进行下一次尝试
      currentParams = modifiedParams.params;
      retryCount++;

      logger.info('Retrying with modified params', {
        toolName,
        retryCount,
        modificationsCount: modifiedParams.modifications.length,
      });
    }

    // 返回最后一次执行结果
    return { ...lastResult!, reflectionUsed: true };
  }
}

// 导出单例实例
export const reactLoopController = new ReActLoopController();
