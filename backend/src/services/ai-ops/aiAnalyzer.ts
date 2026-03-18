/**
 * AIAnalyzer AI 分析服务
 * 封装 AI 分析能力，复用现有 AI Agent 基础设施
 *
 * Requirements: 3.2, 3.4, 4.6, 6.4, 7.5
 * - 3.2: 调用 AI 服务分析异常原因
 * - 3.4: 请求 AI 分析时强制使用结构化 JSON 输出格式
 * - 4.6: 调用 AI 服务分析数据并生成风险评估
 * - 6.4: 调用 AI 服务分析变更影响
 * - 7.5: 匹配到故障模式时调用 AI 服务确认故障诊断
 *
 * Architecture Optimization Requirements: 1.3, 12.2
 * - 1.3: 通过 ServiceRegistry 获取 RAGEngine 实例
 * - 12.2: 使用 AdapterPool 获取适配器，而非每次创建新实例
 */

import {
  AnalysisRequest,
  AnalysisResult,
  IAIAnalyzer,
  AlertEvent,
  SystemMetrics,
  HealthReport,
  SnapshotDiff,
  FaultPattern,
  RiskLevel,
  AlertSeverity,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { apiConfigService, cryptoService, getAdapterPool } from '../ai';
import { AIProvider, ChatMessage } from '../../types/ai';
import { serviceRegistry } from '../serviceRegistry';
import type { RAGEngine } from './rag/ragEngine';
import { createPromptComposerAdapter } from './prompt';
import { promptTemplateService } from '../ai/promptTemplateService';
import type { DeviceManager } from '../device/deviceManager';

/**
 * 结构化输出 JSON Schema 定义
 * Requirement 3.4: 强制使用结构化 JSON 输出格式
 */
interface StructuredAlertAnalysis {
  summary: string;
  problemAnalysis: string;
  impactAssessment: string;
  recommendations: string[];
  riskLevel: RiskLevel;
  confidence?: number;
}

interface StructuredBatchAnalysis {
  analyses: Array<{
    index: number;
    analysis: string;
    recommendations: string[];
    riskLevel: RiskLevel;
  }>;
}

/**
 * 提示词模板
 * Requirement 3.4: 强制使用结构化 JSON 输出格式
 */
const PROMPT_TEMPLATES = {
  /**
   * 告警分析提示词模板（结构化 JSON 输出）
   * 注意：系统状态部分由代码动态构建，以支持指标不可用的场景
   */
  alertAnalysis: `你是一个专业的网络运维专家，正在分析 RouterOS 设备的告警事件。

## 告警信息
- 设备: {{deviceName}} ({{deviceId}})
- 告警名称: {{ruleName}}
- 严重级别: {{severity}}
- 指标类型: {{metric}}
- 当前值: {{currentValue}}
- 阈值: {{threshold}}
- 告警消息: {{message}}

{{systemStatus}}

请仔细阅读告警消息内容，**基于告警消息本身**分析可能的原因，并提供处理建议。
注意：请不要猜测与告警消息不相关的问题，聚焦在告警消息描述的实际故障上。

**重要：请严格按照以下 JSON 格式返回分析结果，不要包含任何其他内容：**
\`\`\`json
{
  "summary": "问题概述（一句话总结，与告警消息内容直接相关）",
  "problemAnalysis": "问题分析（基于告警消息详细说明可能的原因）",
  "impactAssessment": "影响评估（说明此问题可能造成的影响）",
  "recommendations": ["建议1", "建议2", "建议3"],
  "riskLevel": "low|medium|high",
  "confidence": 0.85
}
\`\`\``,

  /**
   * 健康报告分析提示词模板（结构化 JSON 输出）
   */
  healthReportAnalysis: `你是一个专业的网络运维专家，正在分析 RouterOS 设备的健康报告数据。

## 资源使用统计
### CPU
- 平均使用率: {{cpuAvg}}%
- 最高使用率: {{cpuMax}}%
- 最低使用率: {{cpuMin}}%

### 内存
- 平均使用率: {{memoryAvg}}%
- 最高使用率: {{memoryMax}}%
- 最低使用率: {{memoryMin}}%

### 磁盘
- 平均使用率: {{diskAvg}}%
- 最高使用率: {{diskMax}}%
- 最低使用率: {{diskMin}}%

## 告警统计
- 告警总数: {{alertsTotal}}
- 紧急告警: {{alertsEmergency}}
- 严重告警: {{alertsCritical}}
- 警告: {{alertsWarning}}
- 信息: {{alertsInfo}}

请基于以上数据进行分析。

**重要：请严格按照以下 JSON 格式返回分析结果，不要包含任何其他内容：**
\`\`\`json
{
  "summary": "健康状况概述（一句话总结）",
  "riskAssessment": "风险评估（识别潜在的风险点）",
  "trendAnalysis": "趋势分析（分析资源使用趋势）",
  "recommendations": ["优化建议1", "优化建议2", "优化建议3"],
  "riskLevel": "low|medium|high",
  "confidence": 0.85
}
\`\`\``,

  /**
   * 配置变更分析提示词模板（结构化 JSON 输出）
   */
  configDiffAnalysis: `你是一个专业的网络运维专家，正在分析 RouterOS 设备的配置变更。

## 变更摘要
- 新增配置: {{additionsCount}} 项
- 修改配置: {{modificationsCount}} 项
- 删除配置: {{deletionsCount}} 项

## 新增的配置
{{additions}}

## 修改的配置
{{modifications}}

## 删除的配置
{{deletions}}

请分析这些配置变更。

**重要：请严格按照以下 JSON 格式返回分析结果，不要包含任何其他内容：**
\`\`\`json
{
  "summary": "变更概述（一句话总结）",
  "impactAssessment": "变更影响评估（说明这些变更可能造成的影响）",
  "securityAnalysis": "安全分析（如果存在安全风险，说明风险点）",
  "recommendations": ["建议1", "建议2", "建议3"],
  "riskLevel": "low|medium|high",
  "confidence": 0.85
}
\`\`\``,

  /**
   * 故障诊断确认提示词模板（结构化 JSON 输出）
   */
  faultDiagnosis: `你是一个专业的网络运维专家，正在确认故障诊断。

## 故障模式
- 名称: {{patternName}}
- 描述: {{patternDescription}}
- 修复脚本:
\`\`\`
{{remediationScript}}
\`\`\`

## 告警事件
- 告警消息: {{alertMessage}}
- 指标类型: {{metric}}
- 当前值: {{currentValue}}
- 阈值: {{threshold}}
- 严重级别: {{severity}}

请确认此告警是否与故障模式匹配。

**重要：请严格按照以下 JSON 格式返回分析结果，不要包含任何其他内容：**
\`\`\`json
{
  "confirmed": true,
  "confidence": 0.85,
  "reasoning": "分析理由（简要说明判断依据）",
  "shouldExecuteRemediation": true
}
\`\`\``,

  /**
   * 批量告警分析提示词模板（结构化 JSON 输出）
   * Requirement 3.1, 3.2, 3.3: 批量分析告警
   */
  batchAlertAnalysis: `你是一个专业的网络运维专家，正在批量分析 RouterOS 设备的告警事件。

## 告警列表
{{alertsList}}

请为每个告警提供简要分析和建议。

**重要：请严格按照以下 JSON 格式返回分析结果，不要包含任何其他内容：**
\`\`\`json
{
  "analyses": [
    {
      "index": 0,
      "analysis": "告警1的分析",
      "recommendations": ["建议1", "建议2"],
      "riskLevel": "low|medium|high"
    },
    {
      "index": 1,
      "analysis": "告警2的分析",
      "recommendations": ["建议1", "建议2"],
      "riskLevel": "low|medium|high"
    }
  ]
}
\`\`\``,

  /**
   * 规则提取提示词模板（结构化 JSON 输出）
   * 用于从反思结果中提取可复用的运维规则
   */
  ruleExtraction: `你是一个专家级的系统架构师，正在分析一次故障反思报告，目标是提炼出通用的运维规则。
  
## 反思上下文
- 摘要: {{reflectionSummary}}
- 核心洞察: {{insights}}
- 差距分析: {{gapAnalysis}}
- 失败类型: {{failureCategory}}
@
## 你的任务
请分析上述反思内容，提炼出 1-3 条高价值的"运维规则"。这些规则将用于指导未来的 AI Agent 避免犯同样的错误。

规则类型说明：
- constraint: 约束规则，明确禁止某些操作或参数（例如：在生产环境禁止直接使用 /system/reboot）
- correction: 修正建议，针对特定场景的更好做法（例如：查询日志时必须带上 limit 参数）

**重要：请严格按照以下 JSON 格式返回分析结果，不要包含任何其他内容：**
\`\`\`json
{
  "recommendations": [
    "规则1描述: 在 [条件] 下，禁止 [操作]，因为 [原因]",
    "规则2描述: 当遇到 [情况] 时，建议优先使用 [替代方案]"
  ],
  "confidence": 0.85
}
\`\`\``,

  /**
   * 告警智能分类与语义提取模板
   */
  classifyAlert: `你是一个资深的网络协议专家和运维架构师。请分析以下告警消息，并进行深度分类和语义提取。

## 告警消息
{{message}}

## 你的任务
1. **识别类别**：确定告警属于哪个技术领域（如 DHCP, DNS, OSPF, Firewall, CPU, Memory 等）。
2. **提取关键词**：生成 3-5 个用于知识库语义搜索的高质量关键词。
3. **逻辑判断**：判断这是否是一个特定协议或业务逻辑问题（isProtocolIssue: true），还是一个通用资源压力问题（isProtocolIssue: false）。
4. **置信度**：给出你对此次分类的置信度评分（0.0 到 1.0 之间）。

**重要：请严格按照以下 JSON 格式返回，不要包含任何其他内容：**
\`\`\`json
{
  "category": "主要类别",
  "subCategory": "子类别/协议点",
  "searchKeywords": ["关键词1", "关键词2", "关键词3"],
  "isProtocolIssue": true|false,
  "reasoning": "简要分类逻辑",
  "confidence": 0.85
}
\`\`\``,

  /**
   * 智能根因合成分析模板
   */
  intelligentRootCause: `你是一个顶级网络排障专家。请结合当前告警、系统指标及历史案例，给出最准确的根因分析。

## 当前告警
- 消息: {{message}}
- 类别: {{category}}
- 严重级别: {{severity}}

## 系统指标
{{systemStatus}}

## 历史参考（来自知识库，仅供参考，请批判性对待）
{{historyContext}}

## 你的诊断准则
1. **协议优先**：如果告警描述了具体的协议动作（如 DHCP 租约、邻居状态变更），请优先从协议逻辑角度分析。
2. **拒绝偏见**：如果历史参考显示是资源问题（如 CPU 高），但当前告警是业务逻辑问题且缺乏资源压力证据（指标正常或未知），请果断排除资源问题的可能性。
3. **指标敏感**：如果指标显示为“未知/不可用”，严禁以此为由推断设备负载过高。

**重要：请严格按以下 JSON 格式返回根因数组，不要包含任何其他内容：**
\`\`\`json
{
  "rootCauses": [
    {
      "description": "根因描述（一句话，精准、客观）",
      "evidence": "支持该根因的具体证据或逻辑推导（请输出一段完整的文本，不要使用数组格式）",
      "confidence": 0.9,
      "category": "所属类别",
      "metricsSupport": "confirmed" | "none" | "unknown"
    }
  ]
}
\`\`\``,
};


/**
 * 严重级别文本映射
 */
const SEVERITY_TEXT: Record<AlertSeverity, string> = {
  info: '信息',
  warning: '警告',
  critical: '严重',
  emergency: '紧急',
};

/**
 * 指标类型文本映射
 */
const METRIC_TEXT: Record<string, string> = {
  cpu: 'CPU 使用率',
  memory: '内存使用率',
  disk: '磁盘使用率',
  interface_status: '接口状态',
  interface_traffic: '接口流量',
};

export class AIAnalyzer implements IAIAnalyzer {
  private initialized = false;
  private promptAdapter = createPromptComposerAdapter(promptTemplateService);

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('AIAnalyzer initialized');
  }

  /**
   * 获取 RAGEngine 实例
   * Requirement 1.3: 通过 ServiceRegistry 获取 RAGEngine 实例
   */
  private getRagEngine(): RAGEngine | null {
    try {
      return serviceRegistry.tryGet<RAGEngine>('ragEngine');
    } catch (error) {
      logger.debug('RAGEngine not available via ServiceRegistry:', error);
      return null;
    }
  }

  /**
   * 获取 AI 适配器
   * Requirement 12.2: 使用 AdapterPool 获取适配器，而非每次创建新实例
   * 复用现有 AI Agent 的适配器工厂
   * 每次调用都会重新读取配置，确保配置变更实时生效
   */
  private async getAdapter() {
    // 获取默认 API 配置（每次都从文件读取最新配置）
    const config = await apiConfigService.getDefault();
    if (!config) {
      throw new Error('No AI provider configured. Please configure an AI provider first.');
    }

    // 记录当前使用的配置
    logger.info(`AIAnalyzer using provider: ${config.provider}, model: ${config.model}, configId: ${config.id}`);

    // 解密 API Key
    const apiKey = cryptoService.decrypt(config.apiKey);

    // 使用 AdapterPool 获取适配器（Requirement 12.2）
    const adapterPool = getAdapterPool();
    const adapter = adapterPool.getAdapter(
      { provider: config.provider, endpoint: config.endpoint },
      apiKey
    );

    return { adapter, config };
  }

  /**
   * 发送消息到 AI 并获取响应
   */
  private async chat(systemPrompt: string, userMessage: string): Promise<string> {
    try {
      const { adapter, config } = await this.getAdapter();

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      const response = await adapter.chat({
        provider: config.provider,
        model: config.model,
        messages,
        stream: false,
        temperature: 0.7,
        maxTokens: 4096,
      });

      return response.content;
    } catch (error) {
      logger.error('AI chat failed:', error);
      throw error;
    }
  }

  /**
   * 替换模板中的占位符
   */
  private replaceTemplateVars(template: string, vars: Record<string, string | number>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
    }
    return result;
  }

  // ==================== 通用分析 ====================

  /**
   * 通用分析方法
   */
  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    await this.initialize();

    switch (request.type) {
      case 'alert':
        return this.analyzeAlertFromContext(request.context);
      case 'health_report':
        return this.analyzeHealthReportFromContext(request.context);
      case 'config_diff':
        return this.analyzeConfigDiffFromContext(request.context);
      case 'fault_diagnosis':
        // 检查是否为规则提取子类型（复用 fault_diagnosis 类型或扩展）
        if (request.context.analysisType === 'rule_extraction') {
          return this.analyzeRuleExtractionFromContext(request.context);
        }
        return this.analyzeFaultDiagnosisFromContext(request.context);
      case 'classify_alert':
        return this.analyzeClassifyAlertFromContext(request.context);
      case 'intelligent_rca':
        return this.analyzeIntelligentRootCauseFromContext(request.context);
      default:
        throw new Error(`Unknown analysis type: ${request.type}`);
    }
  }

  /**
   * 从上下文分析规则提取
   */
  private async analyzeRuleExtractionFromContext(context: Record<string, unknown>): Promise<AnalysisResult> {
    const reflectionSummary = context.reflectionSummary as string;
    const insights = context.insights as string[];
    const gapAnalysis = context.gapAnalysis as string;
    const failureCategory = context.failureCategory as string;

    const result = await this.extractRules(reflectionSummary, insights, gapAnalysis, failureCategory);

    return {
      summary: '规则提取完成',
      recommendations: result.recommendations,
      confidence: result.confidence
    };
  }

  /**
   * 提取规则
   */
  async extractRules(
    reflectionSummary: string,
    insights: string[],
    gapAnalysis: string,
    failureCategory: string
  ): Promise<{ recommendations: string[]; confidence: number }> {
    await this.initialize();

    try {
      const vars: Record<string, string | number> = {
        reflectionSummary,
        insights: insights.join('; '),
        gapAnalysis,
        failureCategory: failureCategory || 'unknown'
      };

      const prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.ruleExtraction, vars);

      const response = await this.chat(
        '你是一个专注于从复盘中提炼经验的专家。',
        prompt
      );

      // 解析 JSON
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        return {
          recommendations: parsed.recommendations || [],
          confidence: parsed.confidence || 0.7
        };
      }

      return { recommendations: [], confidence: 0 };
    } catch (error) {
      logger.warn('Rule extraction failed:', error);
      return { recommendations: [], confidence: 0 };
    }
  }

  /**
   * 从上下文分析告警
   */
  private async analyzeAlertFromContext(context: Record<string, unknown>): Promise<AnalysisResult> {
    const alertEvent = context.alertEvent as AlertEvent;
    const systemMetrics = context.systemMetrics as SystemMetrics;
    const operationalRules = context.operationalRules as string[] | undefined;
    return this.analyzeAlert(alertEvent, systemMetrics, undefined, operationalRules);
  }

  /**
   * 从上下文分析健康报告
   */
  private async analyzeHealthReportFromContext(context: Record<string, unknown>): Promise<AnalysisResult> {
    const metrics = context.metrics as HealthReport['metrics'];
    const alerts = context.alerts as HealthReport['alerts'];
    return this.analyzeHealthReport(metrics, alerts);
  }

  /**
   * 从上下文分析配置差异
   */
  private async analyzeConfigDiffFromContext(context: Record<string, unknown>): Promise<AnalysisResult> {
    const diff = context.diff as SnapshotDiff;
    return this.analyzeConfigDiff(diff);
  }

  /**
   * 从上下文分析故障诊断
   */
  private async analyzeFaultDiagnosisFromContext(context: Record<string, unknown>): Promise<AnalysisResult> {
    const pattern = context.pattern as FaultPattern;
    const alertEvent = context.alertEvent as AlertEvent;
    const confirmation = await this.confirmFaultDiagnosis(pattern, alertEvent);

    return {
      summary: confirmation.reasoning,
      confidence: confirmation.confidence,
      riskLevel: confirmation.confirmed ? 'medium' : 'low',
      recommendations: confirmation.confirmed
        ? ['建议执行修复脚本']
        : ['建议人工检查确认'],
    };
  }

  /**
   * 从上下文分析告警分类
   */
  private async analyzeClassifyAlertFromContext(context: Record<string, unknown>): Promise<any> {
    const message = context.message as string;
    return this.analyzeClassifyAlert(message);
  }

  /**
   * 从上下文分析智能根因
   */
  private async analyzeIntelligentRootCauseFromContext(context: Record<string, unknown>): Promise<any> {
    const event = context.event as any;
    const metrics = context.metrics as SystemMetrics;
    const historyContext = context.historyContext as string;
    return this.analyzeIntelligentRootCause(event, metrics, historyContext);
  }


  // ==================== 特定场景分析 ====================

  /**
   * 分析告警事件
   * Requirements: 3.2 - 调用 AI 服务分析异常原因
   * Requirements: 6.1, 6.2 - 使用 RAG 增强告警分析
   * Requirement 1.3: 通过 ServiceRegistry 获取 RAGEngine 实例
   * Requirements (syslog-cpu-spike-fix): 2.4 - 移除直接 RAG 调用，接收外部 RAG 上下文
   * @param alertEvent 告警事件
   * @param metrics 系统指标
   * @param externalRagContext 可选的外部 RAG 上下文，由 AlertPipeline 统一提供
   */
  async analyzeAlert(
    alertEvent: AlertEvent,
    metrics: SystemMetrics,
    externalRagContext?: { summary?: string; details?: string; recommendations?: string[]; riskLevel?: string; confidence?: number },
    operationalRules?: string[]
  ): Promise<AnalysisResult> {
    await this.initialize();

    // Requirements (syslog-cpu-spike-fix): 2.4 - 如果有外部 RAG 上下文，直接使用
    if (externalRagContext && externalRagContext.summary) {
      logger.debug('Using external RAG context for alert analysis', { alertId: alertEvent.id });
      return {
        summary: externalRagContext.summary,
        details: externalRagContext.details,
        recommendations: externalRagContext.recommendations || [],
        riskLevel: (externalRagContext.riskLevel as AnalysisResult['riskLevel']) || 'medium',
        confidence: externalRagContext.confidence,
      };
    }

    // 注意：不再在此处调用 RAGEngine.analyzeAlert()
    // RAG 分析应由 AlertPipeline 统一调用并传入 externalRagContext
    // 这里只做标准的 AI 分析作为回退

    try {
      // 获取设备信息
      let deviceName = 'Unknown Device';
      if (alertEvent.deviceId) {
        try {
          const deviceManager = serviceRegistry.tryGet<DeviceManager>('deviceManager');
          if (deviceManager) {
            // 注意：这里可能需要 tenantId，但在 AIAnalyzer 中可能只有 alertEvent
            // 假设 alertEvent.tenantId 存在
            const tenantId = alertEvent.tenantId || 'default';
            const device = await deviceManager.getDevice(tenantId, alertEvent.deviceId);
            if (device) {
              deviceName = device.name;
            }
          }
        } catch (error) {
          logger.warn('Failed to fetch device info for AI analysis:', error);
        }
      }

      // 构建提示词 - 优先使用 PromptComposerAdapter，回退到原始模板
      // Requirements: 3.1, 3.2, 5.4 - 使用模块化 Prompt 增强告警分析
      // 动态构建系统状态部分：仅在指标有效时包含
      const metricsAvailable = metrics.cpu.usage >= 0 && metrics.memory.usage >= 0 && metrics.disk.usage >= 0;
      let systemStatus: string;
      if (metricsAvailable) {
        systemStatus = `## 系统状态\n- CPU 使用率: ${metrics.cpu.usage}%\n- 内存使用率: ${metrics.memory.usage}%\n- 磁盘使用率: ${metrics.disk.usage}%\n- 系统运行时间: ${metrics.uptime}`;
      } else {
        systemStatus = '## 系统状态\n当前无法获取设备系统指标数据。请根据告警消息内容本身进行分析，不要假设任何系统资源（CPU、内存、磁盘）的使用情况。';
      }

      const vars: Record<string, string | number> = {
        deviceName,
        deviceId: alertEvent.deviceId || 'unknown',
        ruleName: alertEvent.ruleName,
        severity: SEVERITY_TEXT[alertEvent.severity],
        metric: METRIC_TEXT[alertEvent.metric] || alertEvent.metric,
        currentValue: alertEvent.currentValue,
        threshold: alertEvent.threshold,
        message: alertEvent.message,
        systemStatus,
        // 仅在指标有效时提供，否则提供占位说明
        cpuUsage: metricsAvailable ? metrics.cpu.usage : '未知',
        memoryUsage: metricsAvailable ? metrics.memory.usage : '未知',
        diskUsage: metricsAvailable ? metrics.disk.usage : '未知',
        uptime: metricsAvailable ? metrics.uptime : '未知',
        operationalRules: operationalRules && operationalRules.length > 0 ? operationalRules.join('\n') : '',
      };

      let prompt: string;
      try {
        prompt = this.promptAdapter.buildAlertAnalysisPrompt(vars);
        logger.debug('Using PromptComposerAdapter for alert analysis prompt');
      } catch (adapterError) {
        logger.warn('PromptComposerAdapter failed for alert analysis, falling back to legacy template', { error: adapterError });
        prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.alertAnalysis, vars);
      }

      // 调用 AI 分析
      const response = await this.chat(
        '你是一个专业的网络运维专家，擅长分析 RouterOS 设备的告警和故障。',
        prompt
      );

      // 解析响应
      const result = this.parseAlertAnalysisResponse(response, alertEvent);

      logger.info(`Alert analysis completed for event: ${alertEvent.id}`);
      return result;
    } catch (error) {
      logger.warn('AI alert analysis failed, using fallback:', error);
      return this.getFallbackAlertAnalysis(alertEvent, metrics);
    }
  }

  /**
   * 解析告警分析响应（支持结构化 JSON 输出）
   * Requirement 3.4: 强制使用结构化 JSON 输出格式
   */
  private parseAlertAnalysisResponse(response: string, alertEvent: AlertEvent): AnalysisResult {
    try {
      // 尝试解析 JSON 格式响应
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
        response.match(/\{[\s\S]*"summary"[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr) as StructuredAlertAnalysis;

        return {
          summary: parsed.summary || response,
          details: parsed.problemAnalysis ?
            `问题分析：${parsed.problemAnalysis}\n\n影响评估：${parsed.impactAssessment || ''}` :
            response,
          recommendations: parsed.recommendations || ['建议检查相关配置和系统状态'],
          riskLevel: this.normalizeRiskLevel(parsed.riskLevel),
          confidence: parsed.confidence,
        };
      }
    } catch (error) {
      logger.debug('Failed to parse JSON response, falling back to text parsing:', error);
    }

    // 回退到文本解析
    const recommendations: string[] = [];
    const lines = response.split('\n');
    let inRecommendations = false;

    for (const line of lines) {
      if (line.includes('处理建议') || line.includes('建议') || line.includes('recommendations')) {
        inRecommendations = true;
        continue;
      }
      if (inRecommendations && line.trim().startsWith('-')) {
        recommendations.push(line.trim().substring(1).trim());
      }
    }

    // 根据告警严重级别确定风险级别
    const riskLevel: RiskLevel =
      alertEvent.severity === 'emergency' || alertEvent.severity === 'critical'
        ? 'high'
        : alertEvent.severity === 'warning'
          ? 'medium'
          : 'low';

    return {
      summary: response,
      details: response,
      recommendations: recommendations.length > 0 ? recommendations : ['建议检查相关配置和系统状态'],
      riskLevel,
    };
  }

  /**
   * 标准化风险级别
   */
  private normalizeRiskLevel(level: string | undefined): RiskLevel {
    if (!level) return 'low';
    const normalized = level.toLowerCase();
    if (normalized === 'high' || normalized === '高') return 'high';
    if (normalized === 'medium' || normalized === '中' || normalized === '中等') return 'medium';
    return 'low';
  }

  /**
   * 获取告警分析的回退结果
   * 当 AI 分析失败时使用，基于告警消息内容和指标类型提供基础建议
   */
  private getFallbackAlertAnalysis(alertEvent: AlertEvent, metrics: SystemMetrics): AnalysisResult {
    const recommendations: string[] = [];
    const message = alertEvent.message.toLowerCase();

    // 首先尝试从告警消息内容推断建议（比指标类型更准确）
    if (/\btimeout\b|\bconnection.*(?:error|lost|refused)\b|\bunreachable\b/.test(message)) {
      recommendations.push('检查网络连接状态和路由配置');
      recommendations.push('验证远程服务是否可达');
      recommendations.push('检查 DNS 解析和防火墙规则');
    } else if (/\bdns\b|\bdoh\b|\bresolv/.test(message)) {
      recommendations.push('检查 DNS 服务器配置是否正确');
      recommendations.push('验证 DNS 服务器可达性');
      recommendations.push('考虑配置备用 DNS 服务器');
    } else if (/\bpppoe\b|\bppp\b/.test(message)) {
      recommendations.push('检查 PPPoE 连接配置和凭据');
      recommendations.push('联系 ISP 确认线路状态');
    } else if (/\binterface\b.*\bdown\b|\blink.*down\b|\bdisconnected\b/.test(message)) {
      recommendations.push('检查网络线缆连接');
      recommendations.push('检查接口配置和对端设备状态');
    } else if (/\bfirewall\b|\bblocked\b|\bdrop\b|\breject\b/.test(message)) {
      recommendations.push('检查防火墙规则配置');
      recommendations.push('确认被阻止的流量是否合法');
    } else if (/\bauth\b|\blogin.*fail\b|\bpassword\b/.test(message)) {
      recommendations.push('检查认证凭据配置');
      recommendations.push('检查是否存在异常登录尝试');
    } else {
      // 根据指标类型生成基础建议
      switch (alertEvent.metric) {
        case 'cpu':
          recommendations.push('检查高 CPU 占用的进程');
          recommendations.push('考虑优化防火墙规则或升级硬件');
          break;
        case 'memory':
          recommendations.push('检查内存使用情况');
          recommendations.push('清理不必要的缓存或增加内存');
          break;
        case 'disk':
          recommendations.push('清理日志文件和临时文件');
          recommendations.push('检查磁盘空间使用情况');
          break;
        case 'interface_status':
          recommendations.push('检查网络连接和接口配置');
          recommendations.push('尝试重启接口');
          break;
        case 'interface_traffic':
          recommendations.push('检查流量来源');
          recommendations.push('考虑配置流量限制');
          break;
        default:
          recommendations.push('检查告警相关的配置和系统状态');
          recommendations.push('查看设备日志获取更多信息');
      }
    }

    const riskLevel: RiskLevel =
      alertEvent.severity === 'emergency' || alertEvent.severity === 'critical'
        ? 'high'
        : alertEvent.severity === 'warning'
          ? 'medium'
          : 'low';

    return {
      summary: `[${SEVERITY_TEXT[alertEvent.severity]}] ${alertEvent.message}`,
      recommendations,
      riskLevel,
    };
  }

  /**
   * 分析健康报告数据
   * Requirements: 4.6 - 调用 AI 服务分析数据并生成风险评估
   */
  async analyzeHealthReport(
    metrics: HealthReport['metrics'],
    alerts: HealthReport['alerts']
  ): Promise<AnalysisResult> {
    await this.initialize();

    try {
      // 构建提示词 - 优先使用 PromptComposerAdapter，回退到原始模板
      // Requirements: 3.5, 5.4 - 使用模块化 Prompt 增强健康报告分析
      const vars: Record<string, string | number> = {
        cpuAvg: metrics.cpu.avg,
        cpuMax: metrics.cpu.max,
        cpuMin: metrics.cpu.min,
        memoryAvg: metrics.memory.avg,
        memoryMax: metrics.memory.max,
        memoryMin: metrics.memory.min,
        diskAvg: metrics.disk.avg,
        diskMax: metrics.disk.max,
        diskMin: metrics.disk.min,
        alertsTotal: alerts.total,
        alertsEmergency: alerts.bySeverity.emergency,
        alertsCritical: alerts.bySeverity.critical,
        alertsWarning: alerts.bySeverity.warning,
        alertsInfo: alerts.bySeverity.info,
      };

      let prompt: string;
      try {
        prompt = this.promptAdapter.buildHealthReportAnalysisPrompt(vars);
        logger.debug('Using PromptComposerAdapter for health report analysis prompt');
      } catch (adapterError) {
        logger.warn('PromptComposerAdapter failed for health report analysis, falling back to legacy template', { error: adapterError });
        prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.healthReportAnalysis, vars);
      }

      // 调用 AI 分析
      const response = await this.chat(
        '你是一个专业的网络运维专家，擅长分析系统健康状况和提供优化建议。',
        prompt
      );

      // 解析响应
      const result = this.parseHealthReportResponse(response, metrics, alerts);

      logger.info('Health report analysis completed');
      return result;
    } catch (error) {
      logger.warn('AI health report analysis failed, using fallback:', error);
      return this.getFallbackHealthReportAnalysis(metrics, alerts);
    }
  }


  /**
   * 解析健康报告分析响应（支持结构化 JSON 输出）
   * Requirement 3.4: 强制使用结构化 JSON 输出格式
   */
  private parseHealthReportResponse(
    response: string,
    metrics: HealthReport['metrics'],
    alerts: HealthReport['alerts']
  ): AnalysisResult {
    try {
      // 尝试解析 JSON 格式响应
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
        response.match(/\{[\s\S]*"summary"[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        return {
          summary: parsed.summary || response,
          details: parsed.riskAssessment ?
            `风险评估：${parsed.riskAssessment}\n\n趋势分析：${parsed.trendAnalysis || ''}` :
            response,
          recommendations: parsed.recommendations || ['继续保持当前配置，定期检查系统状态'],
          riskLevel: this.normalizeRiskLevel(parsed.riskLevel),
          confidence: parsed.confidence,
        };
      }
    } catch (error) {
      logger.debug('Failed to parse JSON response, falling back to text parsing:', error);
    }

    // 回退到文本解析
    const recommendations: string[] = [];
    const lines = response.split('\n');
    let inRecommendations = false;

    for (const line of lines) {
      if (line.includes('优化建议') || line.includes('建议')) {
        inRecommendations = true;
        continue;
      }
      if (inRecommendations && line.trim().startsWith('-')) {
        recommendations.push(line.trim().substring(1).trim());
      }
    }

    // 计算风险级别
    let riskLevel: RiskLevel = 'low';
    if (metrics.cpu.avg > 80 || metrics.memory.avg > 85 || metrics.disk.avg > 90) {
      riskLevel = 'high';
    } else if (metrics.cpu.avg > 60 || metrics.memory.avg > 70 || metrics.disk.avg > 80) {
      riskLevel = 'medium';
    }
    if (alerts.bySeverity.emergency > 0 || alerts.bySeverity.critical > 0) {
      riskLevel = 'high';
    }

    return {
      summary: response,
      details: response,
      recommendations: recommendations.length > 0 ? recommendations : ['继续保持当前配置，定期检查系统状态'],
      riskLevel,
    };
  }

  /**
   * 获取健康报告分析的回退结果
   */
  private getFallbackHealthReportAnalysis(
    metrics: HealthReport['metrics'],
    alerts: HealthReport['alerts']
  ): AnalysisResult {
    const recommendations: string[] = [];
    const risks: string[] = [];

    // 分析 CPU
    if (metrics.cpu.avg > 80) {
      risks.push('CPU 使用率较高');
      recommendations.push('检查高 CPU 占用的进程，考虑优化或升级硬件');
    }

    // 分析内存
    if (metrics.memory.avg > 85) {
      risks.push('内存使用率过高');
      recommendations.push('清理不必要的缓存或增加内存');
    }

    // 分析磁盘
    if (metrics.disk.avg > 90) {
      risks.push('磁盘空间严重不足');
      recommendations.push('立即清理磁盘空间或扩展存储');
    } else if (metrics.disk.avg > 80) {
      risks.push('磁盘空间不足');
      recommendations.push('清理日志文件和临时文件');
    }

    // 分析告警
    if (alerts.bySeverity.emergency > 0) {
      risks.push(`存在 ${alerts.bySeverity.emergency} 个紧急告警`);
      recommendations.push('优先处理紧急告警');
    }
    if (alerts.bySeverity.critical > 0) {
      risks.push(`存在 ${alerts.bySeverity.critical} 个严重告警`);
      recommendations.push('尽快处理严重告警');
    }

    if (recommendations.length === 0) {
      recommendations.push('系统运行状态良好，继续保持当前配置');
    }

    // 计算风险级别
    let riskLevel: RiskLevel = 'low';
    if (risks.length > 2 || alerts.bySeverity.emergency > 0) {
      riskLevel = 'high';
    } else if (risks.length > 0 || alerts.bySeverity.critical > 0) {
      riskLevel = 'medium';
    }

    return {
      summary: risks.length > 0 ? risks.join('；') : '系统运行状态良好',
      recommendations,
      riskLevel,
    };
  }

  /**
   * 分析配置差异
   * Requirements: 6.4 - 调用 AI 服务分析变更影响
   */
  async analyzeConfigDiff(diff: SnapshotDiff): Promise<AnalysisResult> {
    await this.initialize();

    try {
      // 格式化变更内容
      const additionsText = diff.additions.length > 0
        ? diff.additions.slice(0, 20).join('\n') + (diff.additions.length > 20 ? '\n...(更多)' : '')
        : '无';

      const modificationsText = diff.modifications.length > 0
        ? diff.modifications.slice(0, 10).map(m => `${m.path}:\n  旧值: ${m.oldValue}\n  新值: ${m.newValue}`).join('\n')
        : '无';

      const deletionsText = diff.deletions.length > 0
        ? diff.deletions.slice(0, 20).join('\n') + (diff.deletions.length > 20 ? '\n...(更多)' : '')
        : '无';

      // 构建提示词 - 优先使用 PromptComposerAdapter，回退到原始模板
      // Requirements: 3.6, 5.4 - 使用模块化 Prompt 增强配置变更分析
      const vars: Record<string, string | number> = {
        additionsCount: diff.additions.length,
        modificationsCount: diff.modifications.length,
        deletionsCount: diff.deletions.length,
        additions: additionsText,
        modifications: modificationsText,
        deletions: deletionsText,
      };

      let prompt: string;
      try {
        prompt = this.promptAdapter.buildConfigDiffAnalysisPrompt(vars);
        logger.debug('Using PromptComposerAdapter for config diff analysis prompt');
      } catch (adapterError) {
        logger.warn('PromptComposerAdapter failed for config diff analysis, falling back to legacy template', { error: adapterError });
        prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.configDiffAnalysis, vars);
      }

      // 调用 AI 分析
      const response = await this.chat(
        '你是一个专业的网络运维专家，擅长分析 RouterOS 配置变更和评估风险。',
        prompt
      );

      // 解析响应
      const result = this.parseConfigDiffResponse(response, diff);

      logger.info(`Config diff analysis completed for snapshots: ${diff.snapshotA} -> ${diff.snapshotB}`);
      return result;
    } catch (error) {
      logger.warn('AI config diff analysis failed, using fallback:', error);
      return this.getFallbackConfigDiffAnalysis(diff);
    }
  }

  /**
   * 解析配置差异分析响应（支持结构化 JSON 输出）
   * Requirement 3.4: 强制使用结构化 JSON 输出格式
   */
  private parseConfigDiffResponse(response: string, diff: SnapshotDiff): AnalysisResult {
    try {
      // 尝试解析 JSON 格式响应
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
        response.match(/\{[\s\S]*"summary"[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        return {
          summary: parsed.summary || response,
          details: parsed.impactAssessment ?
            `影响评估：${parsed.impactAssessment}\n\n安全分析：${parsed.securityAnalysis || ''}` :
            response,
          recommendations: parsed.recommendations || ['建议在生产环境应用前进行测试'],
          riskLevel: this.normalizeRiskLevel(parsed.riskLevel),
          confidence: parsed.confidence,
        };
      }
    } catch (error) {
      logger.debug('Failed to parse JSON response, falling back to text parsing:', error);
    }

    // 回退到文本解析
    const recommendations: string[] = [];
    const lines = response.split('\n');
    let inRecommendations = false;

    for (const line of lines) {
      if (line.includes('安全建议') || line.includes('建议')) {
        inRecommendations = true;
        continue;
      }
      if (inRecommendations && line.trim().startsWith('-')) {
        recommendations.push(line.trim().substring(1).trim());
      }
    }

    // 尝试从响应中提取风险级别
    let riskLevel: RiskLevel = 'low';
    const lowerResponse = response.toLowerCase();
    if (lowerResponse.includes('高风险') || lowerResponse.includes('high')) {
      riskLevel = 'high';
    } else if (lowerResponse.includes('中风险') || lowerResponse.includes('medium') || lowerResponse.includes('中等')) {
      riskLevel = 'medium';
    }

    // 如果删除了很多配置，提高风险级别
    if (diff.deletions.length > 10) {
      riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
    }

    return {
      summary: response,
      details: response,
      recommendations: recommendations.length > 0 ? recommendations : ['建议在生产环境应用前进行测试'],
      riskLevel,
    };
  }

  /**
   * 获取配置差异分析的回退结果
   */
  private getFallbackConfigDiffAnalysis(diff: SnapshotDiff): AnalysisResult {
    const recommendations: string[] = [];
    let riskLevel: RiskLevel = 'low';

    // 检查删除操作
    if (diff.deletions.length > 0) {
      const hasFirewallDeletion = diff.deletions.some(d =>
        d.toLowerCase().includes('firewall') || d.toLowerCase().includes('filter')
      );
      if (hasFirewallDeletion) {
        recommendations.push('检测到防火墙规则变更，请确认不会影响网络安全');
        riskLevel = 'high';
      }
    }

    // 检查密码变更
    const allChanges = [...diff.additions, ...diff.deletions, ...diff.modifications.map(m => m.newValue)];
    const hasPasswordChange = allChanges.some(c =>
      c.toLowerCase().includes('password') || c.toLowerCase().includes('secret')
    );
    if (hasPasswordChange) {
      recommendations.push('检测到密码变更，请确保新密码符合安全策略');
      riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
    }

    // 检查大量删除
    if (diff.deletions.length > 5) {
      recommendations.push('删除了较多配置项，建议在执行前创建备份');
      riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
    }

    if (recommendations.length === 0) {
      recommendations.push('配置变更看起来是安全的，但仍建议在生产环境应用前进行测试');
    }

    const summary = `新增 ${diff.additions.length} 项，修改 ${diff.modifications.length} 项，删除 ${diff.deletions.length} 项配置`;

    return {
      summary,
      recommendations,
      riskLevel,
    };
  }


  /**
   * 确认故障诊断
   * Requirements: 7.5 - 匹配到故障模式时调用 AI 服务确认故障诊断
   */
  async confirmFaultDiagnosis(
    pattern: FaultPattern,
    alertEvent: AlertEvent
  ): Promise<{ confirmed: boolean; confidence: number; reasoning: string }> {
    await this.initialize();

    try {
      // 构建提示词 - 优先使用 PromptComposerAdapter，回退到原始模板
      // Requirements: 3.7, 5.4 - 使用模块化 Prompt 增强故障诊断
      const vars: Record<string, string | number> = {
        patternName: pattern.name,
        patternDescription: pattern.description,
        remediationScript: pattern.remediationScript,
        alertMessage: alertEvent.message,
        metric: METRIC_TEXT[alertEvent.metric] || alertEvent.metric,
        currentValue: alertEvent.currentValue,
        threshold: alertEvent.threshold,
        severity: SEVERITY_TEXT[alertEvent.severity],
      };

      let prompt: string;
      try {
        prompt = this.promptAdapter.buildFaultDiagnosisPrompt(vars);
        logger.debug('Using PromptComposerAdapter for fault diagnosis prompt');
      } catch (adapterError) {
        logger.warn('PromptComposerAdapter failed for fault diagnosis, falling back to legacy template', { error: adapterError });
        prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.faultDiagnosis, vars);
      }

      // 调用 AI 分析
      const response = await this.chat(
        '你是一个专业的网络运维专家，擅长故障诊断和修复决策。请严格按照要求的格式回复。',
        prompt
      );

      // 解析响应
      const result = this.parseFaultDiagnosisResponse(response);

      logger.info(`Fault diagnosis confirmation completed for pattern: ${pattern.name}, confirmed: ${result.confirmed}`);
      return result;
    } catch (error) {
      logger.warn('AI fault diagnosis confirmation failed, using fallback:', error);
      return this.getFallbackFaultDiagnosis(pattern, alertEvent);
    }
  }

  /**
   * 解析故障诊断响应（支持结构化 JSON 输出）
   * Requirement 3.4: 强制使用结构化 JSON 输出格式
   */
  private parseFaultDiagnosisResponse(response: string): { confirmed: boolean; confidence: number; reasoning: string } {
    try {
      // 尝试解析 JSON 格式响应
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
        response.match(/\{[\s\S]*"confirmed"[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        return {
          confirmed: parsed.confirmed === true,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
          reasoning: parsed.reasoning || response,
        };
      }
    } catch (error) {
      logger.debug('Failed to parse JSON response, falling back to text parsing:', error);
    }

    // 回退到文本解析
    const lowerResponse = response.toLowerCase();

    // 尝试提取确认状态
    let confirmed = false;
    if (lowerResponse.includes('是') && !lowerResponse.includes('否')) {
      confirmed = true;
    } else if (lowerResponse.includes('匹配') && !lowerResponse.includes('不匹配')) {
      confirmed = true;
    } else if (lowerResponse.includes('建议执行')) {
      confirmed = true;
    }

    // 尝试提取置信度
    let confidence = 0.7; // 默认置信度
    const confidenceMatch = response.match(/(\d{1,3})%/);
    if (confidenceMatch) {
      confidence = parseInt(confidenceMatch[1], 10) / 100;
      confidence = Math.min(1, Math.max(0, confidence));
    }

    return {
      confirmed,
      confidence,
      reasoning: response,
    };
  }

  /**
   * 获取故障诊断的回退结果
   */
  private getFallbackFaultDiagnosis(
    pattern: FaultPattern,
    alertEvent: AlertEvent
  ): { confirmed: boolean; confidence: number; reasoning: string } {
    // 基于条件匹配进行简单判断
    let matchCount = 0;
    for (const condition of pattern.conditions) {
      if (condition.metric === alertEvent.metric) {
        matchCount++;
      }
    }

    const confirmed = matchCount > 0;
    const confidence = matchCount > 0 ? 0.75 : 0.3;
    const reasoning = confirmed
      ? `告警事件 "${alertEvent.message}" 与故障模式 "${pattern.name}" 的条件匹配（${matchCount}/${pattern.conditions.length} 条件满足）。建议执行修复脚本。`
      : `告警事件与故障模式的条件不完全匹配，建议人工确认后再执行修复。`;

    return { confirmed, confidence, reasoning };
  }

  /**
   * 批量分析告警（支持结构化 JSON 输出）
   * Requirements: 3.1, 3.2, 3.3, 3.4 - 批量分析告警并返回结构化结果
   */
  async analyzeBatch(alerts: Array<{
    index: number;
    id: string;
    ruleName: string;
    severity: string;
    metric: string;
    currentValue: number;
    threshold: number;
    message: string;
  }>): Promise<StructuredBatchAnalysis> {
    await this.initialize();

    try {
      // 构建告警列表文本
      const alertsList = alerts.map((info, i) =>
        `[告警 ${i + 1}] ID: ${info.id}\n  规则: ${info.ruleName}\n  严重级别: ${info.severity}\n  指标: ${info.metric}\n  当前值: ${info.currentValue}\n  阈值: ${info.threshold}\n  消息: ${info.message}`
      ).join('\n\n');

      // 构建提示词 - 优先使用 PromptComposerAdapter，回退到原始模板
      // Requirements: 3.3, 5.4 - 使用模块化 Prompt 增强批量告警分析
      const vars: Record<string, string | number> = {
        alertsList,
      };

      let prompt: string;
      try {
        prompt = this.promptAdapter.buildBatchAlertAnalysisPrompt(vars);
        logger.debug('Using PromptComposerAdapter for batch alert analysis prompt');
      } catch (adapterError) {
        logger.warn('PromptComposerAdapter failed for batch alert analysis, falling back to legacy template', { error: adapterError });
        prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.batchAlertAnalysis, vars);
      }

      // 调用 AI 分析
      const response = await this.chat(
        '你是一个专业的网络运维专家，擅长批量分析 RouterOS 设备的告警。请严格按照 JSON 格式返回结果。',
        prompt
      );

      // 解析响应
      return this.parseBatchAnalysisResponse(response, alerts.length);
    } catch (error) {
      logger.warn('AI batch analysis failed, using fallback:', error);
      return this.getFallbackBatchAnalysis(alerts);
    }
  }

  /**
   * 解析批量分析响应
   */
  private parseBatchAnalysisResponse(response: string, expectedCount: number): StructuredBatchAnalysis {
    try {
      // 尝试解析 JSON 格式响应
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
        response.match(/\{[\s\S]*"analyses"[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr) as StructuredBatchAnalysis;

        // 确保返回正确数量的结果
        const analyses = parsed.analyses || [];
        while (analyses.length < expectedCount) {
          analyses.push({
            index: analyses.length,
            analysis: '分析结果不可用',
            recommendations: ['建议检查相关配置和系统状态'],
            riskLevel: 'low',
          });
        }

        return { analyses };
      }
    } catch (error) {
      logger.debug('Failed to parse batch JSON response:', error);
    }

    // 回退：返回默认结果
    return this.getFallbackBatchAnalysis([]);
  }

  /**
   * 获取批量分析的回退结果
   */
  private getFallbackBatchAnalysis(alerts: Array<{
    index: number;
    ruleName: string;
    severity: string;
    message: string;
  }>): StructuredBatchAnalysis {
    const analyses = alerts.map((alert, index) => ({
      index,
      analysis: `[${alert.severity}] ${alert.ruleName}: ${alert.message}`,
      recommendations: ['建议检查相关配置和系统状态'],
      riskLevel: (alert.severity === 'emergency' || alert.severity === 'critical'
        ? 'high'
        : alert.severity === 'warning'
          ? 'medium'
          : 'low') as RiskLevel,
    }));

    return { analyses };
  }

  /**
   * 检查 AI 服务是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      const config = await apiConfigService.getDefault();
      return config !== null;
    } catch {
      return false;
    }
  }

  /**
   * 获取当前配置的 AI 提供商信息
   */
  async getProviderInfo(): Promise<{ provider: AIProvider; model: string } | null> {
    try {
      const config = await apiConfigService.getDefault();
      if (!config) return null;
      return {
        provider: config.provider,
        model: config.model,
      };
    } catch {
      return null;
    }
  }

  /**
   * 智能分类告警
   */
  async analyzeClassifyAlert(message: string): Promise<any> {
    await this.initialize();
    try {
      const prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.classifyAlert, { message });
      const response = await this.chat('你是一个资深的网络协议专家。', prompt);
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*"category"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        // Ensure confidence exists
        if (typeof parsed.confidence !== 'number') {
          parsed.confidence = 0.8;
        }
        return parsed;
      }
      throw new Error('Failed to parse classification JSON');
    } catch (error) {
      logger.warn('Classify alert failed, using unknown fallback:', error);
      return { category: 'unknown', subCategory: 'unknown', searchKeywords: [message.substring(0, 20)], isProtocolIssue: false, reasoning: 'Fallback', confidence: 0.5 };
    }
  }

  /**
   * 智能根因合成
   */
  async analyzeIntelligentRootCause(event: any, metrics: SystemMetrics, historyContext: string): Promise<any> {
    await this.initialize();
    try {
      const metricsAvailable = metrics.cpu.usage >= 0 && metrics.memory.usage >= 0 && metrics.disk.usage >= 0;
      let systemStatus: string;
      if (metricsAvailable) {
        systemStatus = `## 系统状态\n- CPU 使用率: ${metrics.cpu.usage}%\n- 内存使用率: ${metrics.memory.usage}%\n- 磁盘使用率: ${metrics.disk.usage}%\n- 系统运行时间: ${metrics.uptime}`;
      } else {
        systemStatus = '## 系统状态\n当前无法获取设备系统指标数据（标记为未知）。请不要假设任何系统资源（CPU、内存、磁盘）的使用情况。';
      }

      const prompt = this.replaceTemplateVars(PROMPT_TEMPLATES.intelligentRootCause, {
        message: event.message,
        category: event.category || 'unknown',
        severity: event.severity || 'info',
        systemStatus,
        historyContext: historyContext || '（无相关历史记录）'
      });

      const response = await this.chat('你是一个顶级网络排障专家。', prompt);
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*"rootCauses"[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1] || jsonMatch[0]);
      }
      throw new Error('Failed to parse intelligent RCA JSON');
    } catch (error) {
      logger.warn('Intelligent RCA failed:', error);
      return { rootCauses: [{ description: event.message, evidence: ['AI 分析失败，回退到原始消息'], confidence: 0.5, category: event.category || 'unknown' }] };
    }
  }
}

// 导出单例实例
export const aiAnalyzer = new AIAnalyzer();
