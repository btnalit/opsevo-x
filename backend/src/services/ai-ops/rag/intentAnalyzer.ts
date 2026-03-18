/**
 * IntentAnalyzer - LLM 驱动的意图分析服务
 * 
 * 使用 AI Adapter 分析用户意图，替代现有的关键词匹配逻辑
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4
 * - 1.1: 调用 AI_Adapter 分析用户意图
 * - 1.2: 返回结构化的意图分析结果
 * - 1.3: 识别多个工具及其执行顺序
 * - 1.4: LLM 调用失败时回退到关键词匹配
 * 
 * Prompt 模板管理集成:
 * - 支持从 PromptTemplateService 动态获取提示词模板
 * - 支持模板热更新，无需重启服务
 */

import { logger } from '../../../utils/logger';
import { IntentAnalysis, EnhancedIntentAnalysis, QuestionType } from '../../../types/ai-ops';
import { IAIProviderAdapter, ChatMessage, ChatRequest, AIProvider } from '../../../types/ai';
import { AgentTool } from './mastraAgent';
import { promptTemplateService } from '../../ai/promptTemplateService';

// ==================== 提示词模板 ====================

/**
 * 提示词模板名称常量
 */
const TEMPLATE_NAME_INTENT_ANALYSIS = '意图分析提示词';

/**
 * 默认意图分析提示词模板（回退用）
 * 用于指导 LLM 分析用户请求并确定需要使用的工具
 */
const DEFAULT_INTENT_ANALYSIS_PROMPT = `你是一个网络设备运维助手。分析用户的请求，确定需要使用哪些工具来完成任务。

可用工具：
{{tools}}

用户请求：{{message}}

对话历史：
{{history}}

请以 JSON 格式返回分析结果，不要包含任何其他文字：
{
  "intent": "用户意图的简短描述",
  "tools": [
    {
      "name": "工具名称",
      "params": { "参数名": "参数值" },
      "reason": "为什么需要这个工具"
    }
  ],
  "confidence": 0.0-1.0,
  "requiresMultiStep": true/false
}

工具选择指南：
- "查看系统状态"、"系统资源"、"CPU/内存/磁盘" → 使用 monitor_metrics
- "查看告警"、"分析告警"、"告警详情" → 使用 alert_analysis（需要 alertId 参数）
- "查看接口"、"查看配置"、"查看路由"、"查询数据" → 使用 device_query（只读查询）
- "搜索知识"、"查找案例" → 使用 knowledge_search
- "执行命令"、"清理"、"删除"、"添加"、"修改配置"、"移除"、"重启"、"启用"、"禁用"、"下发脚本" → 使用 execute_command（写入/执行操作）

注意：
1. tools 数组中的工具按执行顺序排列
2. 如果用户请求涉及多个操作，requiresMultiStep 应为 true
3. confidence 表示你对意图理解的置信度
4. 只选择真正需要的工具，不要过度选择
5. alert_analysis 需要具体的告警 ID，如果用户没有提供告警 ID，不要选择此工具`;

// 保留原有常量用于向后兼容
const INTENT_ANALYSIS_PROMPT = DEFAULT_INTENT_ANALYSIS_PROMPT;

// ==================== 关键词映射 ====================

/**
 * 工具关键词映射
 * 用于回退时的关键词匹配
 */
const TOOL_KEYWORDS: Record<string, string[]> = {
  knowledge_search: ['搜索', '查找', '历史', '知识', '案例', '文档', '查询知识'],
  device_query: ['设备', '接口', '配置', '路由', '显示', '获取', '查看配置', '查看接口', '查看路由'],
  alert_analysis: ['告警', '诊断', '问题', '异常', '错误', '分析告警', '告警分析'],
  generate_remediation: ['修复', '解决', '方案', '处理', '修复方案', '建议'],
  config_diff: ['对比', '差异', '变更', '快照', '比较', '配置变更'],
  execute_command: ['执行', '运行', '命令', '脚本', '清理', '删除', '添加', '修改', '设置', '重启', '启用', '禁用', '下发', '移除', '创建', '更新', '操作', '写入', '应用'],
  monitor_metrics: ['监控', '指标', 'CPU', '内存', '磁盘', '流量', '性能', '系统状态', '查看状态', '资源', '负载', '系统资源', '系统信息'],
  check_connectivity: ['ping', 'traceroute', '连通性', '网络检查', '连接测试'],
};

/**
 * 问题类型关键词映射
 * 用于分类用户请求的问题类型
 * Requirements: 2.1
 */
const QUESTION_TYPE_KEYWORDS: Record<QuestionType, string[]> = {
  [QuestionType.TROUBLESHOOTING]: [
    '故障', '问题', '异常', '错误', '失败', '断开', 'down', '不通', '无法',
    '排查', '诊断', '修复', '解决', '为什么', '怎么回事', '出错', '报错',
  ],
  [QuestionType.CONFIGURATION]: [
    '配置', '设置', '参数', '接口', '路由', 'OSPF', 'BGP', 'VLAN',
    '防火墙', 'NAT', 'DHCP', 'DNS', '规则', '策略',
  ],
  [QuestionType.MONITORING]: [
    '状态', '监控', 'CPU', '内存', '流量', '负载', '资源', '性能',
    '使用率', '带宽', '实时', '当前',
  ],
  [QuestionType.HISTORICAL_ANALYSIS]: [
    '历史', '趋势', '变化', '对比', '之前', '以前', '曾经', '过去',
    '统计', '分析', '报告', '记录',
  ],
  [QuestionType.GENERAL]: [],
};

/**
 * 需要知识检索的关键词
 * 当用户消息包含这些关键词时，应该触发知识库检索
 * Requirements: 4.1, 4.2
 */
const KNOWLEDGE_SEARCH_KEYWORDS = [
  // 历史相关
  '历史', '案例', '之前', '以前', '曾经', '过去',
  // 相似性相关
  '类似', '相似', '经验', '处理过', '遇到过',
  // 根因分析相关
  '根因', '原因', '为什么', '怎么回事', '导致',
  // 解决方案相关
  '修复', '解决', '方案', '建议', '处理方法',
  // 告警和故障相关
  '告警', '故障', '问题', '异常', '错误',
  // 知识库相关
  '知识', '文档', '记录', '经验',
];

// ==================== IntentAnalyzer 类 ====================

/**
 * IntentAnalyzer 配置
 */
export interface IntentAnalyzerConfig {
  /** 分析超时时间（毫秒），默认 30000 */
  timeout: number;
  /** 默认置信度阈值，默认 0.5 */
  confidenceThreshold: number;
  /** 最大历史消息数，默认 5 */
  maxHistoryMessages: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: IntentAnalyzerConfig = {
  timeout: 30000,
  confidenceThreshold: 0.5,
  maxHistoryMessages: 10, // 对话意图修复：增加历史消息数以更好地理解多轮对话上下文
};

/**
 * IntentAnalyzer 类
 * 使用 LLM 分析用户意图，支持回退到关键词匹配
 */
export class IntentAnalyzer {
  private config: IntentAnalyzerConfig;
  private aiAdapter: IAIProviderAdapter | null = null;
  private provider: AIProvider = AIProvider.OPENAI;
  private model: string = 'gpt-4o';

  constructor(config?: Partial<IntentAnalyzerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('IntentAnalyzer created', { config: this.config });
  }

  /**
   * 设置 AI 适配器
   * @param adapter AI 适配器实例
   * @param provider AI 提供商
   * @param model 模型名称
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model: string): void {
    this.aiAdapter = adapter;
    this.provider = provider;
    this.model = model;
    logger.info('IntentAnalyzer AI adapter set', { provider, model });
  }

  /**
   * 分析用户意图
   * Requirements: 1.1, 1.2, 1.3, 1.4
   * 
   * @param message 用户消息
   * @param availableTools 可用工具列表
   * @param history 对话历史
   * @returns 意图分析结果
   */
  async analyzeIntent(
    message: string,
    availableTools: AgentTool[],
    history: ChatMessage[] = []
  ): Promise<IntentAnalysis> {
    // 如果没有 AI 适配器，直接使用回退逻辑
    if (!this.aiAdapter) {
      logger.warn('No AI adapter configured, using fallback analysis');
      return this.fallbackAnalyze(message, availableTools);
    }

    try {
      // 构建提示词
      const prompt = this.buildPrompt(message, availableTools, history);
      
      // 调用 LLM
      const response = await this.callLLM(prompt);
      
      // 解析响应
      const analysis = this.parseResponse(response, availableTools);
      
      logger.info('Intent analysis completed', {
        intent: analysis.intent,
        toolCount: analysis.tools.length,
        confidence: analysis.confidence,
      });
      
      return analysis;
    } catch (error) {
      // Requirement 1.4: LLM 调用失败时回退到关键词匹配
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('LLM intent analysis failed, using fallback', { error: errorMessage });
      return this.fallbackAnalyze(message, availableTools);
    }
  }

  /**
   * 构建意图分析提示词
   * 
   * 模板管理集成：
   * - 优先从 PromptTemplateService 获取模板
   * - 支持模板热更新
   */
  private async buildPromptAsync(
    message: string,
    availableTools: AgentTool[],
    history: ChatMessage[]
  ): Promise<string> {
    // 从模板服务获取提示词模板
    let template = INTENT_ANALYSIS_PROMPT;
    try {
      template = await promptTemplateService.getTemplateContent(
        TEMPLATE_NAME_INTENT_ANALYSIS,
        DEFAULT_INTENT_ANALYSIS_PROMPT
      );
    } catch (error) {
      logger.debug('Failed to get intent analysis template, using default', { error });
    }

    // 构建工具描述
    const toolDescriptions = availableTools.map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
        .join('\n');
      return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
    }).join('\n\n');

    // 构建历史对话
    const recentHistory = history.slice(-this.config.maxHistoryMessages);
    const historyText = recentHistory.length > 0
      ? recentHistory.map(m => `${m.role}: ${m.content}`).join('\n')
      : '无';

    // 替换模板变量
    return template
      .replace('{{tools}}', toolDescriptions)
      .replace('{{message}}', message)
      .replace('{{history}}', historyText);
  }

  /**
   * 构建意图分析提示词（同步版本，用于向后兼容）
   */
  private buildPrompt(
    message: string,
    availableTools: AgentTool[],
    history: ChatMessage[]
  ): string {
    // 构建工具描述
    const toolDescriptions = availableTools.map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
        .join('\n');
      return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
    }).join('\n\n');

    // 构建历史对话
    const recentHistory = history.slice(-this.config.maxHistoryMessages);
    const historyText = recentHistory.length > 0
      ? recentHistory.map(m => `${m.role}: ${m.content}`).join('\n')
      : '无';

    // 替换模板变量
    return INTENT_ANALYSIS_PROMPT
      .replace('{{tools}}', toolDescriptions)
      .replace('{{message}}', message)
      .replace('{{history}}', historyText);
  }

  /**
   * 调用 LLM 进行意图分析
   */
  private async callLLM(prompt: string): Promise<string> {
    if (!this.aiAdapter) {
      throw new Error('AI adapter not configured');
    }

    const request: ChatRequest = {
      provider: this.provider,
      model: this.model,
      messages: [
        {
          role: 'system',
          content: '你是一个专业的意图分析助手，只返回 JSON 格式的分析结果，不要包含任何其他文字。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature: 0.3, // 低温度以获得更确定的结果
      maxTokens: 1000,
    };

    const response = await this.aiAdapter.chat(request);
    return response.content;
  }

  /**
   * 解析 LLM 响应
   */
  private parseResponse(response: string, availableTools: AgentTool[]): IntentAnalysis {
    // 尝试提取 JSON
    let jsonStr = response.trim();
    
    // 如果响应包含 markdown 代码块，提取其中的 JSON
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonStr);
      
      // 验证并规范化结果
      const analysis: IntentAnalysis = {
        intent: typeof parsed.intent === 'string' ? parsed.intent : '未知意图',
        tools: [],
        confidence: typeof parsed.confidence === 'number' 
          ? Math.max(0, Math.min(1, parsed.confidence)) 
          : 0.5,
        requiresMultiStep: Boolean(parsed.requiresMultiStep),
      };

      // 验证工具列表
      if (Array.isArray(parsed.tools)) {
        const availableToolNames = new Set(availableTools.map(t => t.name));
        
        for (const tool of parsed.tools) {
          if (typeof tool.name === 'string' && availableToolNames.has(tool.name)) {
            analysis.tools.push({
              name: tool.name,
              params: typeof tool.params === 'object' && tool.params !== null 
                ? tool.params 
                : {},
              reason: typeof tool.reason === 'string' ? tool.reason : '',
            });
          }
        }
      }

      // 如果有多个工具，设置 requiresMultiStep
      if (analysis.tools.length > 1) {
        analysis.requiresMultiStep = true;
      }

      return analysis;
    } catch (parseError) {
      logger.warn('Failed to parse LLM response as JSON', { 
        response: response.substring(0, 200),
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      throw new Error('Failed to parse intent analysis response');
    }
  }

  /**
   * 回退分析方法
   * Requirement 1.4: 使用关键词匹配作为回退
   * 
   * @param message 用户消息
   * @param availableTools 可用工具列表
   * @returns 意图分析结果
   */
  fallbackAnalyze(message: string, availableTools: AgentTool[]): IntentAnalysis {
    const lowerMessage = message.toLowerCase();
    const matchedTools: IntentAnalysis['tools'] = [];
    const availableToolNames = new Set(availableTools.map(t => t.name));

    // 遍历关键词映射，查找匹配的工具
    for (const [toolName, keywords] of Object.entries(TOOL_KEYWORDS)) {
      // 只考虑可用的工具
      if (!availableToolNames.has(toolName)) {
        continue;
      }

      // 检查是否有关键词匹配
      const matchedKeyword = keywords.find(keyword => lowerMessage.includes(keyword));
      if (matchedKeyword) {
        // 提取基本参数
        const params = this.extractBasicParams(message, toolName);
        
        matchedTools.push({
          name: toolName,
          params,
          reason: `关键词匹配: "${matchedKeyword}"`,
        });
      }
    }

    // 构建意图描述
    const intent = matchedTools.length > 0
      ? `用户请求涉及: ${matchedTools.map(t => t.name).join(', ')}`
      : '通用查询';

    // 计算置信度（基于匹配的工具数量和关键词明确程度）
    const confidence = matchedTools.length > 0 
      ? Math.min(0.7, 0.4 + matchedTools.length * 0.1)
      : 0.3;

    return {
      intent,
      tools: matchedTools,
      confidence,
      requiresMultiStep: matchedTools.length > 1,
    };
  }

  /**
   * 从消息中提取基本参数
   */
  private extractBasicParams(message: string, toolName: string): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    switch (toolName) {
      case 'knowledge_search':
        params.query = message;
        params.limit = 5;
        break;

      case 'device_query':
        // 尝试提取命令路径
        const commandMatch = message.match(/\/[\w\/]+/);
        params.command = commandMatch ? commandMatch[0] : '/system/resource';
        break;

      case 'alert_analysis':
        // 尝试提取告警 ID
        const alertIdMatch = message.match(/alert[_-]?(\w+)/i);
        if (alertIdMatch) {
          params.alertId = alertIdMatch[1];
        }
        params.includeHistory = true;
        break;

      case 'generate_remediation':
        // 尝试提取分析 ID
        const analysisIdMatch = message.match(/analysis[_-]?(\w+)/i);
        if (analysisIdMatch) {
          params.analysisId = analysisIdMatch[1];
        }
        params.autoExecute = false;
        break;

      case 'config_diff':
        // 尝试提取快照 ID
        const snapshotMatches = message.match(/snapshot[_-]?(\w+)/gi);
        if (snapshotMatches && snapshotMatches.length >= 2) {
          params.snapshotA = snapshotMatches[0].replace(/snapshot[_-]?/i, '');
          params.snapshotB = snapshotMatches[1].replace(/snapshot[_-]?/i, '');
        }
        break;

      case 'execute_command':
        // 尝试提取命令
        const execCommandMatch = message.match(/\/[\w\/]+(?:\s+[\w=]+)*/);
        if (execCommandMatch) {
          params.command = execCommandMatch[0];
        }
        break;

      case 'monitor_metrics':
        // 检测指标类型
        const metrics: string[] = [];
        if (message.includes('cpu') || message.includes('CPU')) metrics.push('cpu');
        if (message.includes('内存') || message.includes('memory')) metrics.push('memory');
        if (message.includes('磁盘') || message.includes('disk')) metrics.push('disk');
        if (message.includes('接口') || message.includes('流量') || message.includes('interface')) metrics.push('interfaces');
        params.metrics = metrics.length > 0 ? metrics : ['all'];
        break;

      case 'check_connectivity':
        // 尝试提取目标地址
        const ipMatch = message.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        const domainMatch = message.match(/\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/);
        params.target = ipMatch ? ipMatch[0] : (domainMatch ? domainMatch[0] : '8.8.8.8');
        params.type = message.includes('traceroute') ? 'traceroute' : 'ping';
        params.count = 4;
        break;

      default:
        params.query = message;
    }

    return params;
  }

  /**
   * 获取配置
   */
  getConfig(): IntentAnalyzerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<IntentAnalyzerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('IntentAnalyzer config updated', { config: this.config });
  }

  /**
   * 检查是否已配置 AI 适配器
   */
  hasAIAdapter(): boolean {
    return this.aiAdapter !== null;
  }

  /**
   * 分类问题类型
   * 根据关键词匹配确定用户请求的问题类型
   * Requirements: 2.1
   * 
   * @param message 用户消息
   * @returns 问题类型
   */
  classifyQuestionType(message: string): QuestionType {
    const lowerMessage = message.toLowerCase();
    
    // 按优先级顺序检查各问题类型
    // 故障排查优先级最高，因为它通常需要最紧急的处理
    const priorityOrder: QuestionType[] = [
      QuestionType.TROUBLESHOOTING,
      QuestionType.HISTORICAL_ANALYSIS,
      QuestionType.MONITORING,
      QuestionType.CONFIGURATION,
    ];

    for (const questionType of priorityOrder) {
      const keywords = QUESTION_TYPE_KEYWORDS[questionType];
      const matched = keywords.some(keyword => lowerMessage.includes(keyword.toLowerCase()));
      if (matched) {
        logger.debug('Question type classified', { questionType, message: message.substring(0, 50) });
        return questionType;
      }
    }

    // 默认返回通用查询
    return QuestionType.GENERAL;
  }

  /**
   * 检测是否需要知识检索
   * 根据关键词匹配确定用户请求是否需要查询知识库
   * Requirements: 4.1, 4.2
   * 
   * @param message 用户消息
   * @returns 是否需要知识检索
   */
  detectKnowledgeSearchNeed(message: string): boolean {
    const lowerMessage = message.toLowerCase();
    
    // 检查是否包含知识检索关键词
    const hasKeyword = KNOWLEDGE_SEARCH_KEYWORDS.some(keyword => 
      lowerMessage.includes(keyword.toLowerCase())
    );
    
    if (hasKeyword) {
      logger.debug('Knowledge search need detected', { message: message.substring(0, 50) });
    }
    
    return hasKeyword;
  }

  /**
   * 从消息中提取搜索关键词
   * 提取用于知识库检索的关键词
   * Requirements: 4.3
   * 
   * @param message 用户消息
   * @returns 搜索关键词数组
   */
  extractSearchTerms(message: string): string[] {
    const terms: string[] = [];
    const lowerMessage = message.toLowerCase();
    
    // 1. 提取匹配的知识检索关键词
    for (const keyword of KNOWLEDGE_SEARCH_KEYWORDS) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        terms.push(keyword);
      }
    }
    
    // 2. 提取告警规则相关的关键词
    const alertRuleMatch = message.match(/告警规则[：:\s]*([^\s,，。]+)/);
    if (alertRuleMatch) {
      terms.push(alertRuleMatch[1]);
    }
    
    // 3. 提取错误模式相关的关键词
    const errorPatterns = [
      /错误[：:\s]*([^\s,，。]+)/,
      /异常[：:\s]*([^\s,，。]+)/,
      /故障[：:\s]*([^\s,，。]+)/,
      /问题[：:\s]*([^\s,，。]+)/,
    ];
    for (const pattern of errorPatterns) {
      const match = message.match(pattern);
      if (match) {
        terms.push(match[1]);
      }
    }
    
    // 4. 提取接口名称
    const interfaceMatch = message.match(/接口[：:\s]*([a-zA-Z0-9\-_\/]+)/);
    if (interfaceMatch) {
      terms.push(interfaceMatch[1]);
    }
    
    // 5. 提取 IP 地址
    const ipMatch = message.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
    if (ipMatch) {
      terms.push(...ipMatch);
    }
    
    // 6. 去重并返回
    const uniqueTerms = [...new Set(terms)];
    
    logger.debug('Search terms extracted', { 
      message: message.substring(0, 50), 
      terms: uniqueTerms,
    });
    
    return uniqueTerms;
  }

  /**
   * 确定工具优先级
   * 根据问题类型和知识增强模式确定工具执行顺序
   * Requirements: 2.2, 2.3, 2.4, 5.1
   * 
   * @param questionType 问题类型
   * @param knowledgeEnhancedMode 是否启用知识增强模式
   * @returns 工具优先级数组
   */
  determineToolPriority(questionType: QuestionType, knowledgeEnhancedMode: boolean): string[] {
    if (knowledgeEnhancedMode) {
      // 知识增强模式下，根据问题类型确定优先级
      switch (questionType) {
        case QuestionType.TROUBLESHOOTING:
          // 故障排查：知识库优先，包含 execute_command 用于修复操作
          // Requirements: 2.2
          return ['knowledge_search', 'device_query', 'execute_command', 'monitor_metrics', 'alert_analysis'];
        
        case QuestionType.HISTORICAL_ANALYSIS:
          // 历史分析：知识库优先
          // Requirements: 2.2
          return ['knowledge_search', 'device_query', 'monitor_metrics', 'alert_analysis'];
        
        case QuestionType.MONITORING:
          // 监控查询：知识库在前两位
          // Requirements: 2.3
          return ['knowledge_search', 'monitor_metrics', 'device_query', 'alert_analysis'];
        
        case QuestionType.CONFIGURATION:
          // 配置查询/修改：知识库在前两位，包含 execute_command 用于配置变更
          // Requirements: 2.4
          return ['knowledge_search', 'device_query', 'execute_command', 'monitor_metrics', 'config_diff'];
        
        case QuestionType.GENERAL:
        default:
          // 通用查询：知识库优先
          return ['knowledge_search', 'monitor_metrics', 'device_query', 'alert_analysis'];
      }
    }
    
    // 非知识增强模式：保持原有顺序
    return ['monitor_metrics', 'device_query', 'knowledge_search', 'alert_analysis'];
  }

  /**
   * 增强的意图分析
   * 返回包含问题类型、知识检索需求和工具优先级的增强分析结果
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 5.1
   * 
   * @param message 用户消息
   * @param availableTools 可用工具列表
   * @param history 对话历史
   * @param knowledgeEnhancedMode 是否启用知识增强模式
   * @returns 增强的意图分析结果
   */
  async analyzeIntentEnhanced(
    message: string,
    availableTools: AgentTool[],
    history: ChatMessage[] = [],
    knowledgeEnhancedMode: boolean = true
  ): Promise<EnhancedIntentAnalysis> {
    // 1. 获取基础意图分析
    const baseAnalysis = await this.analyzeIntent(message, availableTools, history);
    
    // 2. 分类问题类型
    const questionType = this.classifyQuestionType(message);
    
    // 3. 检测是否需要知识检索
    const requiresKnowledgeSearch = this.detectKnowledgeSearchNeed(message);
    
    // 4. 提取搜索关键词
    const knowledgeSearchTerms = this.extractSearchTerms(message);
    
    // 5. 确定工具优先级
    const toolPriority = this.determineToolPriority(questionType, knowledgeEnhancedMode);
    
    // 6. 构建增强的意图分析结果
    const enhancedAnalysis: EnhancedIntentAnalysis = {
      ...baseAnalysis,
      questionType,
      requiresKnowledgeSearch,
      knowledgeSearchTerms,
      toolPriority,
    };
    
    // 7. 如果需要知识检索但工具列表中没有 knowledge_search，添加它
    if (requiresKnowledgeSearch || knowledgeEnhancedMode) {
      const hasKnowledgeSearch = enhancedAnalysis.tools.some(t => t.name === 'knowledge_search');
      if (!hasKnowledgeSearch) {
        // 在工具列表开头添加 knowledge_search
        enhancedAnalysis.tools.unshift({
          name: 'knowledge_search',
          params: {
            query: message,
            limit: 5,
          },
          reason: knowledgeEnhancedMode 
            ? '知识增强模式下优先查询知识库' 
            : '检测到需要知识检索的关键词',
        });
        enhancedAnalysis.requiresMultiStep = true;
      }
    }
    
    logger.info('Enhanced intent analysis completed', {
      intent: enhancedAnalysis.intent,
      questionType,
      requiresKnowledgeSearch,
      toolCount: enhancedAnalysis.tools.length,
      toolPriority: toolPriority.slice(0, 3),
    });
    
    return enhancedAnalysis;
  }
}

// 导出单例实例
export const intentAnalyzer = new IntentAnalyzer();
