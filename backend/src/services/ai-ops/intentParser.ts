/**
 * IntentParser - 意图解析器
 * 
 * 实现 Intent-Driven 自动化能力的意图解析功能
 * 
 * Requirements: 6.1.1, 6.1.2, 6.1.3, 6.1.4, 6.1.5
 * - 6.1.1: 意图解析逻辑
 * - 6.1.2: 意图结构化表示
 * - 6.1.3: 置信度计算
 * - 6.1.4: 意图消歧
 * - 6.1.5: 参数提取
 */

import { logger } from '../../utils/logger';

/**
 * 意图类型
 */
export type IntentCategory = 
  | 'query'           // 查询类：获取信息
  | 'configure'       // 配置类：修改设置
  | 'diagnose'        // 诊断类：排查问题
  | 'remediate'       // 修复类：解决问题
  | 'monitor'         // 监控类：观察状态
  | 'automate'        // 自动化类：批量操作
  | 'unknown';        // 未知类型

/**
 * 解析后的意图
 */
export interface ParsedIntent {
  /** 意图 ID */
  id: string;
  /** 意图类别 */
  category: IntentCategory;
  /** 意图动作 */
  action: string;
  /** 目标对象 */
  target?: string;
  /** 提取的参数 */
  parameters: Record<string, unknown>;
  /** 置信度 (0-1) */
  confidence: number;
  /** 是否需要确认 */
  requiresConfirmation: boolean;
  /** 消歧候选（如果有多个可能的意图） */
  alternatives?: ParsedIntent[];
  /** 原始输入 */
  originalInput: string;
  /** 解析时间 */
  parsedAt: number;
  /** 是否应用了消歧逻辑 */
  disambiguationApplied: boolean;
}

/**
 * 意图模式定义
 */
interface IntentPattern {
  category: IntentCategory;
  action: string;
  keywords: string[];
  parameterPatterns?: Record<string, RegExp>;
  confirmationRequired: boolean;
}

/** 置信度计算结果 */
interface ConfidenceResult {
  confidence: number;
  disambiguationApplied: boolean;
}

/**
 * 意图解析配置
 */
export interface IntentParserConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 最小置信度阈值（低于此值需要确认） */
  minConfidenceThreshold: number;
  /** 消歧阈值（多个意图置信度差距小于此值时需要消歧） */
  disambiguationThreshold: number;
  /** 高风险操作的类别 */
  highRiskCategories: IntentCategory[];
}

const DEFAULT_CONFIG: IntentParserConfig = {
  enabled: true,
  minConfidenceThreshold: 0.7,
  disambiguationThreshold: 0.15,
  highRiskCategories: ['configure', 'remediate', 'automate'],
};

/**
 * 预定义的意图模式
 */
const INTENT_PATTERNS: IntentPattern[] = [
  // 查询类
  {
    category: 'query',
    action: 'get_status',
    keywords: ['状态', '查看', '显示', '获取', 'status', 'show', 'get', 'list'],
    confirmationRequired: false,
  },
  {
    category: 'query',
    action: 'get_config',
    keywords: ['配置', '设置', '参数', 'config', 'setting'],
    confirmationRequired: false,
  },
  // 配置类
  {
    category: 'configure',
    action: 'add',
    keywords: ['添加', '新增', '创建', 'add', 'create', 'new'],
    confirmationRequired: true,
  },
  {
    category: 'configure',
    action: 'modify',
    keywords: ['修改', '更改', '设置', '调整', 'modify', 'change', 'set', 'update'],
    confirmationRequired: true,
  },
  {
    category: 'configure',
    action: 'delete',
    keywords: ['删除', '移除', '清除', 'delete', 'remove', 'clear'],
    confirmationRequired: true,
  },
  // 诊断类
  {
    category: 'diagnose',
    action: 'troubleshoot',
    keywords: ['排查', '诊断', '检查', '分析', 'troubleshoot', 'diagnose', 'check', 'analyze'],
    confirmationRequired: false,
  },
  {
    category: 'diagnose',
    action: 'find_cause',
    keywords: ['原因', '为什么', '问题', 'why', 'cause', 'reason', 'problem'],
    confirmationRequired: false,
  },
  // 修复类
  {
    category: 'remediate',
    action: 'fix',
    keywords: ['修复', '解决', '处理', '恢复', 'fix', 'solve', 'resolve', 'repair', 'restore'],
    confirmationRequired: true,
  },
  {
    category: 'remediate',
    action: 'restart',
    keywords: ['重启', '重新启动', 'restart', 'reboot'],
    confirmationRequired: true,
  },
  // 监控类
  {
    category: 'monitor',
    action: 'watch',
    keywords: ['监控', '观察', '跟踪', 'monitor', 'watch', 'track'],
    confirmationRequired: false,
  },
  // 自动化类
  {
    category: 'automate',
    action: 'batch',
    keywords: ['批量', '所有', '全部', 'batch', 'all', 'bulk'],
    confirmationRequired: true,
  },
  {
    category: 'automate',
    action: 'schedule',
    keywords: ['定时', '计划', '自动', 'schedule', 'auto', 'cron'],
    confirmationRequired: true,
  },
];

/**
 * 目标对象关键词
 */
const TARGET_KEYWORDS: Record<string, string[]> = {
  interface: ['接口', '端口', 'interface', 'port', 'eth', 'ether'],
  firewall: ['防火墙', '规则', 'firewall', 'filter', 'rule'],
  route: ['路由', '路由表', 'route', 'routing'],
  ip: ['IP', '地址', 'ip', 'address'],
  dns: ['DNS', '域名', 'dns', 'domain'],
  dhcp: ['DHCP', 'dhcp'],
  vpn: ['VPN', 'vpn', 'ipsec', 'l2tp', 'pptp'],
  system: ['系统', '设备', 'system', 'device', 'router'],
  log: ['日志', '记录', 'log', 'history'],
};

/**
 * IntentParser 类
 */
export class IntentParser {
  private config: IntentParserConfig;
  private intentIdCounter = 0;

  constructor(config?: Partial<IntentParserConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('IntentParser created', { config: this.config });
  }


  /**
   * 解析用户输入的意图
   * Requirements: 6.1.1, 6.1.2
   */
  async parse(input: string): Promise<ParsedIntent> {
    const now = Date.now();
    const intentId = `intent_${++this.intentIdCounter}_${now}`;

    try {
      // 预处理输入
      const normalizedInput = this.normalizeInput(input);

      // 匹配意图模式
      const matches = this.matchPatterns(normalizedInput);

      if (matches.length === 0) {
        // 未匹配到任何模式
        return this.createUnknownIntent(intentId, input, now);
      }

      // 选择最佳匹配
      const bestMatch = matches[0];
      const alternatives = matches.slice(1);

      // 提取目标对象
      const target = this.extractTarget(normalizedInput);

      // 提取参数
      const parameters = this.extractParameters(normalizedInput, bestMatch.pattern);

      // 计算置信度
      // 中文没有空格分词，用字符数 / 2 近似词数（平均每个中文词 2 字符）
      const inputWordCount = Math.max(1, Math.ceil(normalizedInput.replace(/\s+/g, '').length / 2));
      const confidenceResult = this.calculateConfidence(bestMatch.score, bestMatch.matchedCount, inputWordCount, matches);
      const confidence = confidenceResult.confidence;

      // 判断是否需要确认
      const requiresConfirmation = this.shouldRequireConfirmation(
        bestMatch.pattern,
        confidence
      );

      // 判断是否应用了消歧逻辑
      const disambiguationApplied = this.needsDisambiguation(confidenceResult);

      // 构建解析结果
      const intent: ParsedIntent = {
        id: intentId,
        category: bestMatch.pattern.category,
        action: bestMatch.pattern.action,
        target,
        parameters,
        confidence,
        requiresConfirmation,
        originalInput: input,
        parsedAt: now,
        disambiguationApplied,
      };

      // 如果有多个候选且置信度接近，添加备选
      if (alternatives.length > 0 && disambiguationApplied) {
        intent.alternatives = alternatives.slice(0, 3).map((alt, idx) => ({
          id: `${intentId}_alt_${idx}`,
          category: alt.pattern.category,
          action: alt.pattern.action,
          target,
          parameters: this.extractParameters(normalizedInput, alt.pattern),
          confidence: this.calculateConfidence(alt.score, alt.matchedCount, inputWordCount, [alt]).confidence,
          requiresConfirmation: this.shouldRequireConfirmation(alt.pattern, alt.score),
          originalInput: input,
          parsedAt: now,
          disambiguationApplied: false,
        }));
      }

      logger.info('Intent parsed', {
        id: intentId,
        category: intent.category,
        action: intent.action,
        confidence: intent.confidence,
        requiresConfirmation: intent.requiresConfirmation,
      });

      return intent;
    } catch (error) {
      logger.error('Intent parsing failed', { error, input });
      return this.createUnknownIntent(intentId, input, now);
    }
  }

  /**
   * 消歧意图
   * Requirements: 6.1.4
   */
  async disambiguate(
    intent: ParsedIntent,
    userChoice: number
  ): Promise<ParsedIntent> {
    if (!intent.alternatives || intent.alternatives.length === 0) {
      return intent;
    }

    if (userChoice < 0 || userChoice >= intent.alternatives.length) {
      return intent;
    }

    const chosen = intent.alternatives[userChoice];
    
    // 提升选中意图的置信度
    chosen.confidence = Math.min(1, chosen.confidence + 0.2);
    // 从原始模式中查找 confirmationRequired，避免丢失高风险操作的确认要求
    const originalPattern = INTENT_PATTERNS.find(
      p => p.category === chosen.category && p.action === chosen.action
    );
    chosen.requiresConfirmation = this.shouldRequireConfirmation(
      originalPattern ?? { category: chosen.category, action: chosen.action, keywords: [], confirmationRequired: true },
      chosen.confidence
    );

    logger.info('Intent disambiguated', {
      originalId: intent.id,
      chosenId: chosen.id,
      category: chosen.category,
      action: chosen.action,
    });

    return chosen;
  }

  /**
   * 验证意图参数
   * Requirements: 6.1.5
   */
  validateParameters(intent: ParsedIntent): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 检查必需参数
    if (intent.category === 'configure' && !intent.target) {
      errors.push('配置操作需要指定目标对象');
    }

    if (intent.action === 'delete' && Object.keys(intent.parameters).length === 0) {
      errors.push('删除操作需要指定具体条目');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 获取意图的风险等级
   * Requirements: 6.3.1
   */
  getRiskLevel(intent: ParsedIntent): 'low' | 'medium' | 'high' {
    // 高风险类别
    if (this.config.highRiskCategories.includes(intent.category)) {
      // 删除操作是高风险
      if (intent.action === 'delete') {
        return 'high';
      }
      // 批量操作是高风险
      if (intent.action === 'batch') {
        return 'high';
      }
      // 其他配置/修复操作是中等风险
      return 'medium';
    }

    // 查询和监控是低风险
    return 'low';
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<IntentParserConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('IntentParser config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): IntentParserConfig {
    return { ...this.config };
  }

  // ==================== 私有方法 ====================

  private normalizeInput(input: string): string {
    return input.toLowerCase().trim();
  }

  private matchPatterns(input: string): Array<{ pattern: IntentPattern; score: number; matchedCount: number }> {
    const matches: Array<{ pattern: IntentPattern; score: number; matchedCount: number }> = [];

    for (const pattern of INTENT_PATTERNS) {
      let matchedKeywords = 0;

      for (const keyword of pattern.keywords) {
        if (input.includes(keyword.toLowerCase())) {
          matchedKeywords++;
        }
      }

      if (matchedKeywords > 0 && pattern.keywords.length > 0) {
        // FIX: 用 sqrt 归一化，避免关键词多的模式被不公平地惩罚
        // 1/sqrt(6) = 0.41 vs 旧的 1/6 = 0.17
        const score = Math.min(1, matchedKeywords / Math.sqrt(pattern.keywords.length));
        matches.push({ pattern, score, matchedCount: matchedKeywords });
      }
    }

    // 按分数降序排列
    return matches.sort((a, b) => b.score - a.score);
  }

  private extractTarget(input: string): string | undefined {
    for (const [target, keywords] of Object.entries(TARGET_KEYWORDS)) {
      for (const keyword of keywords) {
        if (input.includes(keyword.toLowerCase())) {
          return target;
        }
      }
    }
    return undefined;
  }

  private extractParameters(input: string, pattern: IntentPattern): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    // 提取 IP 地址
    const ipMatch = input.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?/);
    if (ipMatch) {
      params.ip = ipMatch[0];
    }

    // 提取端口号
    const portMatch = input.match(/端口\s*(\d+)|port\s*(\d+)/i);
    if (portMatch) {
      params.port = parseInt(portMatch[1] || portMatch[2], 10);
    }

    // 提取接口名称
    const interfaceMatch = input.match(/ether\d+|eth\d+|bridge\d*|vlan\d+/i);
    if (interfaceMatch) {
      params.interface = interfaceMatch[0];
    }

    // 如果有自定义参数模式，应用它们
    if (pattern.parameterPatterns) {
      for (const [paramName, regex] of Object.entries(pattern.parameterPatterns)) {
        const match = input.match(regex);
        if (match) {
          params[paramName] = match[1] || match[0];
        }
      }
    }

    return params;
  }

  private calculateConfidence(
    score: number,
    matchedCount: number,
    inputWordCount: number,
    allMatches: Array<{ score: number }>,
  ): ConfidenceResult {
    // Signal 1: 匹配质量（score 已经用 sqrt 归一化）
    const baseConfidence = Math.min(1, score);

    // Signal 2: 匹配密度 — 关键词命中数 / 输入词数
    const DENSITY_AMPLIFIER = 5;
    const density = inputWordCount > 0 ? matchedCount / inputWordCount : 0;
    const densityFactor = Math.min(1, density * DENSITY_AMPLIFIER);

    // 融合：密度作为调节因子，基础权重 0.6 + 密度贡献 0.4
    let confidence = baseConfidence * (0.6 + 0.4 * densityFactor);

    // Signal 3: 匹配唯一性 — 统一消歧逻辑（原 needsDisambiguation 的逻辑移入此处）
    let disambiguationApplied = false;
    if (allMatches.length === 1) {
      confidence = Math.min(1, confidence + 0.1); // 唯一匹配加分
    } else if (allMatches.length > 1) {
      const gap = score - allMatches[1].score;
      if (gap < this.config.disambiguationThreshold) {
        disambiguationApplied = true;
        const threshold = this.config.disambiguationThreshold;
        const penalty = threshold > 0
          ? 0.1 * (1 - gap / threshold)
          : 0.1;
        confidence = Math.max(0, confidence - penalty);
      }
    }

    return { confidence: Math.round(confidence * 100) / 100, disambiguationApplied };
  }

  private shouldRequireConfirmation(
    pattern: IntentPattern | { category: IntentCategory; action: string; keywords: string[]; confirmationRequired: boolean },
    confidence: number
  ): boolean {
    // 模式要求确认
    if (pattern.confirmationRequired) {
      return true;
    }

    // 置信度低于阈值
    if (confidence < this.config.minConfidenceThreshold) {
      return true;
    }

    // 高风险类别
    if (this.config.highRiskCategories.includes(pattern.category)) {
      return true;
    }

    return false;
  }

  private needsDisambiguation(confidenceResult: ConfidenceResult): boolean {
    return confidenceResult.disambiguationApplied;
  }

  private createUnknownIntent(id: string, input: string, timestamp: number): ParsedIntent {
    return {
      id,
      category: 'unknown',
      action: 'unknown',
      parameters: {},
      confidence: 0,
      requiresConfirmation: true,
      originalInput: input,
      parsedAt: timestamp,
      disambiguationApplied: false,
    };
  }
}

// 导出单例实例
export const intentParser = new IntentParser();
