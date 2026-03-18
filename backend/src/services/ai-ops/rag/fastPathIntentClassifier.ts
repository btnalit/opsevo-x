/**
 * FastPathIntentClassifier - 快速路径意图分类器
 * 
 * 基于规则的快速意图分类，用于在 ReAct 循环之前快速判断查询类型。
 * 设计目标：在 50ms 内完成分类，不依赖 LLM。
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 * - 2.1: 在 50ms 内分类查询意图
 * - 2.2: knowledge_query 优先知识库检索
 * - 2.3: realtime_query 跳过知识库检索
 * - 2.4: hybrid_query 并行执行
 * - 2.5: 返回分类置信度
 */

import { logger } from '../../../utils/logger';
import {
  QueryIntent,
  IntentClassification,
  IntentClassificationRule,
} from '../../../types/fast-path';

// ==================== 内置分类规则 ====================

/**
 * 知识类查询关键词
 * 历史案例、解决方案、配置、文档等
 */
const KNOWLEDGE_KEYWORDS = [
  // 问题解决
  '怎么解决', '如何解决', '解决方案', '解决办法', '怎么处理', '如何处理',
  '怎么修复', '如何修复', '修复方法', '修复步骤',
  // 历史案例
  '之前', '以前', '历史', '案例', '经验', '遇到过',
  // 配置相关
  '怎么配置', '如何配置', '配置方法', '配置步骤', '配置示例',
  '怎么设置', '如何设置', '设置方法',
  // 文档查询
  '文档', '说明', '教程', '指南', '手册',
  // 原因分析
  '为什么', '原因', '根因', '分析',
  // 最佳实践
  '最佳实践', '推荐', '建议', '标准',
];

/**
 * 实时类查询关键词
 * 当前状态、实时数据、监控等
 */
const REALTIME_KEYWORDS = [
  // 当前状态
  '当前', '现在', '目前', '实时', '最新',
  // 状态查询
  '状态', '运行状态', '连接状态', '在线状态',
  // 监控数据
  '监控', 'CPU', '内存', '流量', '带宽', '负载',
  // 接口信息
  '接口', '端口', 'IP', '地址',
  // 查看操作
  '查看', '检查', '获取', '显示', '列出',
  // 告警相关
  '告警', '警告', '异常', '错误',
];

/**
 * 混合类查询关键词
 * 需要结合知识和实时数据
 */
const HYBRID_KEYWORDS = [
  // 诊断分析
  '诊断', '排查', '排障', '故障排除',
  // 对比分析
  '对比', '比较', '差异',
  // 优化建议
  '优化', '改进', '提升',
  // 健康检查
  '健康检查', '巡检', '评估',
];

/**
 * 知识类查询模式（正则表达式）
 */
const KNOWLEDGE_PATTERNS = [
  /怎么(解决|处理|修复|配置|设置)/,
  /如何(解决|处理|修复|配置|设置)/,
  /(解决|处理|修复|配置|设置)(方案|方法|步骤|办法)/,
  /有没有.*?(案例|经验|文档)/,
  /.*?(之前|以前|历史).*?(遇到|出现|发生)/,
  /为什么.*?(会|出现|发生)/,
  /.*?的(原因|根因)是什么/,
];

/**
 * 实时类查询模式（正则表达式）
 */
const REALTIME_PATTERNS = [
  /(当前|现在|目前|实时).*?(状态|情况|数据)/,
  /查看.*?(状态|接口|端口|流量|CPU|内存)/,
  /获取.*?(信息|数据|列表)/,
  /.*?(是否|有没有).*?(在线|连接|运行)/,
  /显示.*?(所有|全部|列表)/,
  /列出.*?(接口|端口|地址|规则)/,
];

/**
 * 混合类查询模式（正则表达式）
 */
const HYBRID_PATTERNS = [
  /诊断.*?(问题|故障|异常)/,
  /排查.*?(原因|问题)/,
  /(分析|评估).*?(性能|状态|健康)/,
  /优化.*?(建议|方案)/,
  /.*?(对比|比较).*?(配置|状态)/,
];

// ==================== 默认分类规则 ====================

const DEFAULT_RULES: IntentClassificationRule[] = [
  // 知识类规则
  {
    id: 'knowledge_solution',
    name: '解决方案查询',
    patterns: KNOWLEDGE_PATTERNS.map(p => p.source),
    keywords: KNOWLEDGE_KEYWORDS.slice(0, 12),
    targetIntent: 'knowledge_query',
    priority: 10,
    enabled: true,
  },
  {
    id: 'knowledge_history',
    name: '历史案例查询',
    patterns: [],
    keywords: KNOWLEDGE_KEYWORDS.slice(12, 18),
    targetIntent: 'knowledge_query',
    priority: 9,
    enabled: true,
  },
  {
    id: 'knowledge_config',
    name: '配置文档查询',
    patterns: [],
    keywords: KNOWLEDGE_KEYWORDS.slice(18),
    targetIntent: 'knowledge_query',
    priority: 8,
    enabled: true,
  },
  // 实时类规则
  {
    id: 'realtime_status',
    name: '实时状态查询',
    patterns: REALTIME_PATTERNS.map(p => p.source),
    keywords: REALTIME_KEYWORDS.slice(0, 10),
    targetIntent: 'realtime_query',
    priority: 10,
    enabled: true,
  },
  {
    id: 'realtime_monitor',
    name: '监控数据查询',
    patterns: [],
    keywords: REALTIME_KEYWORDS.slice(10),
    targetIntent: 'realtime_query',
    priority: 9,
    enabled: true,
  },
  // 混合类规则
  {
    id: 'hybrid_diagnose',
    name: '诊断分析查询',
    patterns: HYBRID_PATTERNS.map(p => p.source),
    keywords: HYBRID_KEYWORDS,
    targetIntent: 'hybrid_query',
    priority: 10,
    enabled: true,
  },
];

// ==================== FastPathIntentClassifier 类 ====================

/**
 * FastPathIntentClassifier 配置
 */
export interface FastPathIntentClassifierConfig {
  /** 分类超时时间（毫秒），默认 50 */
  timeout: number;
  /** 默认置信度（无法分类时），默认 0.5 */
  defaultConfidence: number;
  /** 自定义规则 */
  customRules?: IntentClassificationRule[];
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: FastPathIntentClassifierConfig = {
  timeout: 50,
  defaultConfidence: 0.5,
};

/**
 * FastPathIntentClassifier 类
 * 
 * 基于规则的快速意图分类器，在 50ms 内完成分类。
 */
export class FastPathIntentClassifier {
  private config: FastPathIntentClassifierConfig;
  private rules: IntentClassificationRule[];
  private compiledPatterns: Map<string, RegExp[]> = new Map();

  constructor(config?: Partial<FastPathIntentClassifierConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rules = [...DEFAULT_RULES, ...(config?.customRules || [])];
    this.compilePatterns();
    logger.info('FastPathIntentClassifier created', { 
      rulesCount: this.rules.length,
      timeout: this.config.timeout,
    });
  }

  /**
   * 预编译正则表达式模式
   */
  private compilePatterns(): void {
    for (const rule of this.rules) {
      if (rule.patterns.length > 0) {
        const compiled = rule.patterns.map(p => new RegExp(p, 'i'));
        this.compiledPatterns.set(rule.id, compiled);
      }
    }
  }

  /**
   * 分类查询意图
   * Requirements: 2.1, 2.5
   * 
   * @param query 用户查询
   * @returns 意图分类结果
   */
  classify(query: string): IntentClassification {
    const startTime = performance.now();
    
    try {
      // 提取关键词
      const keywords = this.extractKeywords(query);
      
      // 计算各意图的得分
      const scores = this.calculateScores(query, keywords);
      
      // 确定最终意图
      const result = this.determineIntent(scores, keywords);
      
      const classificationTime = performance.now() - startTime;
      
      // 确保在超时时间内完成
      if (classificationTime > this.config.timeout) {
        logger.warn('Intent classification exceeded timeout', {
          query: query.substring(0, 50),
          time: classificationTime,
          timeout: this.config.timeout,
        });
      }
      
      return {
        ...result,
        classificationTime,
      };
    } catch (error) {
      logger.error('Intent classification failed', { error, query: query.substring(0, 50) });
      
      // 返回默认结果
      return {
        intent: 'hybrid_query',
        confidence: this.config.defaultConfidence,
        classificationTime: performance.now() - startTime,
        keywords: [],
        reason: '分类失败，使用默认混合意图',
      };
    }
  }

  /**
   * 批量分类
   * 
   * @param queries 查询列表
   * @returns 分类结果列表
   */
  classifyBatch(queries: string[]): IntentClassification[] {
    return queries.map(q => this.classify(q));
  }

  /**
   * 提取关键词
   */
  private extractKeywords(query: string): string[] {
    const keywords: string[] = [];
    const normalizedQuery = query.toLowerCase();
    
    // 检查知识类关键词
    for (const kw of KNOWLEDGE_KEYWORDS) {
      if (normalizedQuery.includes(kw.toLowerCase())) {
        keywords.push(kw);
      }
    }
    
    // 检查实时类关键词
    for (const kw of REALTIME_KEYWORDS) {
      if (normalizedQuery.includes(kw.toLowerCase())) {
        keywords.push(kw);
      }
    }
    
    // 检查混合类关键词
    for (const kw of HYBRID_KEYWORDS) {
      if (normalizedQuery.includes(kw.toLowerCase())) {
        keywords.push(kw);
      }
    }
    
    return [...new Set(keywords)]; // 去重
  }

  /**
   * 计算各意图的得分
   */
  private calculateScores(
    query: string,
    keywords: string[]
  ): Record<QueryIntent, { score: number; matchedRules: string[]; reason: string }> {
    const scores: Record<QueryIntent, { score: number; matchedRules: string[]; reason: string }> = {
      knowledge_query: { score: 0, matchedRules: [], reason: '' },
      realtime_query: { score: 0, matchedRules: [], reason: '' },
      hybrid_query: { score: 0, matchedRules: [], reason: '' },
    };
    
    const normalizedQuery = query.toLowerCase();
    
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      let ruleScore = 0;
      let matched = false;
      
      // 检查模式匹配
      const patterns = this.compiledPatterns.get(rule.id);
      if (patterns) {
        for (const pattern of patterns) {
          if (pattern.test(query)) {
            ruleScore += 0.4 * rule.priority / 10;
            matched = true;
            break;
          }
        }
      }
      
      // 检查关键词匹配
      let keywordMatches = 0;
      for (const kw of rule.keywords) {
        if (normalizedQuery.includes(kw.toLowerCase())) {
          keywordMatches++;
        }
      }
      
      if (keywordMatches > 0) {
        // 关键词匹配得分：匹配数量 / 总关键词数量 * 优先级权重
        const keywordScore = (keywordMatches / Math.max(rule.keywords.length, 1)) * 0.6 * rule.priority / 10;
        ruleScore += keywordScore;
        matched = true;
      }
      
      if (matched) {
        scores[rule.targetIntent].score += ruleScore;
        scores[rule.targetIntent].matchedRules.push(rule.name);
      }
    }
    
    // 生成原因说明
    for (const intent of Object.keys(scores) as QueryIntent[]) {
      if (scores[intent].matchedRules.length > 0) {
        scores[intent].reason = `匹配规则: ${scores[intent].matchedRules.join(', ')}`;
      }
    }
    
    return scores;
  }

  /**
   * 确定最终意图
   */
  private determineIntent(
    scores: Record<QueryIntent, { score: number; matchedRules: string[]; reason: string }>,
    keywords: string[]
  ): Omit<IntentClassification, 'classificationTime'> {
    // 找出最高得分的意图
    let maxIntent: QueryIntent = 'hybrid_query';
    let maxScore = 0;
    
    for (const [intent, data] of Object.entries(scores) as [QueryIntent, { score: number; matchedRules: string[]; reason: string }][]) {
      if (data.score > maxScore) {
        maxScore = data.score;
        maxIntent = intent;
      }
    }
    
    // 计算置信度
    // 如果最高分很低，降低置信度
    let confidence = Math.min(maxScore, 1.0);
    
    // 如果多个意图得分接近，降低置信度（表示不确定）
    const sortedScores = Object.values(scores).map(s => s.score).sort((a, b) => b - a);
    if (sortedScores.length >= 2 && sortedScores[0] > 0 && sortedScores[1] > 0) {
      const ratio = sortedScores[1] / sortedScores[0];
      if (ratio > 0.7) {
        // 第二高分接近最高分，降低置信度
        confidence *= (1 - ratio * 0.3);
      }
    }
    
    // 如果没有任何匹配，使用默认置信度
    if (maxScore === 0) {
      confidence = this.config.defaultConfidence;
      maxIntent = 'hybrid_query';
    }
    
    // 确保置信度在 0-1 范围内
    confidence = Math.max(0, Math.min(1, confidence));
    
    return {
      intent: maxIntent,
      confidence,
      keywords,
      reason: scores[maxIntent].reason || '无明确匹配，使用默认意图',
    };
  }

  /**
   * 添加自定义规则
   */
  addRule(rule: IntentClassificationRule): void {
    this.rules.push(rule);
    if (rule.patterns.length > 0) {
      const compiled = rule.patterns.map(p => new RegExp(p, 'i'));
      this.compiledPatterns.set(rule.id, compiled);
    }
    logger.info('Added custom intent classification rule', { ruleId: rule.id, ruleName: rule.name });
  }

  /**
   * 移除规则
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index >= 0) {
      this.rules.splice(index, 1);
      this.compiledPatterns.delete(ruleId);
      logger.info('Removed intent classification rule', { ruleId });
      return true;
    }
    return false;
  }

  /**
   * 启用/禁用规则
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      logger.info('Updated rule enabled status', { ruleId, enabled });
      return true;
    }
    return false;
  }

  /**
   * 获取所有规则
   */
  getRules(): IntentClassificationRule[] {
    return [...this.rules];
  }

  /**
   * 获取配置
   */
  getConfig(): FastPathIntentClassifierConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<FastPathIntentClassifierConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.customRules) {
      this.rules = [...DEFAULT_RULES, ...config.customRules];
      this.compiledPatterns.clear();
      this.compilePatterns();
    }
    logger.info('FastPathIntentClassifier config updated', { config: this.config });
  }
}

// 导出单例实例
export const fastPathIntentClassifier = new FastPathIntentClassifier();
