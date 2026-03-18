/**
 * AI-OPS Skill System 类型定义
 * 
 * Skill 是一个"角色配置层"，让同一个 AI Agent 能够根据不同任务场景快速切换专业能力。
 * 每个 Skill 是一个包含 SKILL.md 文件的目录，支持渐进式加载（Progressive Disclosure）。
 * 
 * 核心公式：Skill = SKILL.md (指令+元数据) + 资源文件 + 脚本工具
 * 
 * Requirements: 1.1, 1.2, 2.1-2.10
 */

// ==================== Skill 元数据类型 ====================

/**
 * Skill 元数据（从 SKILL.md frontmatter 解析）
 * Requirements: 2.1, 2.2, 18.6
 */
export interface SkillMetadata {
  /** kebab-case 标识符 */
  name: string;
  /** Skill 描述 */
  description: string;
  /** 版本号 */
  version?: string;
  /** 作者 */
  author?: string;
  /** 标签 */
  tags?: string[];
  /** 触发模式（关键词或正则） */
  triggers?: string[];
  /** 建议的后续 Skill（用于链式调用） */
  suggestedSkills?: SkillSuggestion[];
}

/**
 * Skill 建议配置（用于链式调用）
 * Requirements: 18.6
 */
export interface SkillSuggestion {
  /** 建议的 Skill 名称 */
  skillName: string;
  /** 触发条件描述 */
  condition: string;
  /** 触发关键词或模式 */
  triggers?: string[];
  /** 是否自动切换（无需用户确认） */
  autoSwitch?: boolean;
  /** 优先级（数字越小优先级越高） */
  priority?: number;
}

// ==================== 工具配置类型 ====================

/**
 * 工具约束配置
 * Requirements: 2.6
 */
export interface ToolConstraint {
  /** 默认值 */
  defaultValue?: unknown;
  /** 允许的值列表 */
  allowedValues?: unknown[];
  /** 最小值 */
  minValue?: number;
  /** 最大值 */
  maxValue?: number;
  /** 是否必需 */
  required?: boolean;
}

/**
 * Skill 能力限制
 * Requirements: 2.7
 */
export interface SkillCaps {
  /** 最大 token 数 */
  maxTokens: number;
  /** 温度参数 */
  temperature: number;
  /** 最大迭代次数 */
  maxIterations: number;
}

/**
 * 知识配置
 * Requirements: 2.8
 */
export interface KnowledgeConfig {
  /** 是否启用知识检索 */
  enabled: boolean;
  /** 优先知识类型 */
  priorityTypes: string[];
  /** 最小相关度阈值 */
  minScore: number;
}

// ==================== Skill 配置类型 ====================

/**
 * Skill 配置（从 config.json 解析）
 * Requirements: 2.3-2.10
 */
export interface SkillConfig {
  /** 工具白名单 */
  allowedTools: string[];
  /** 工具优先级 */
  toolPriority: string[];
  /** 工具默认参数 */
  toolDefaults: Record<string, Record<string, unknown>>;
  /** 工具约束 */
  toolConstraints: Record<string, Record<string, ToolConstraint>>;
  /** 能力限制 */
  caps: SkillCaps;
  /** 知识配置 */
  knowledgeConfig: KnowledgeConfig;
  /** 输出格式 */
  outputFormat: 'detailed' | 'concise' | 'structured';
  /** 是否要求引用 */
  requireCitations: boolean;
  /** 继承的 Skill 名称 */
  extends?: string;
}

/**
 * 默认 Skill 配置
 */
export const DEFAULT_SKILL_CONFIG: SkillConfig = {
  allowedTools: [],
  toolPriority: [],
  toolDefaults: {},
  toolConstraints: {},
  caps: {
    maxTokens: 4096,
    temperature: 0.5,
    maxIterations: 10,
  },
  knowledgeConfig: {
    enabled: true,
    priorityTypes: [],
    minScore: 0.3,
  },
  outputFormat: 'detailed',
  requireCitations: false,
};

// ==================== 完整 Skill 类型 ====================

/**
 * 完整的 Skill 定义
 * Requirements: 1.1, 1.2
 */
export interface Skill {
  /** 元数据 */
  metadata: SkillMetadata;
  /** 配置 */
  config: SkillConfig;
  /** SKILL.md 完整内容 */
  content: string;
  /** Skill 目录路径 */
  path: string;
  /** 目录中的文件列表 */
  files: string[];
  /** 是否内置 */
  isBuiltin: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 加载时间 */
  loadedAt: Date;
  /** 最后修改时间 */
  modifiedAt: Date;
}

// ==================== Skill 匹配类型 ====================

/**
 * 匹配类型枚举
 * Requirements: 6.1
 */
export enum SkillMatchType {
  /** 显式指定 @skill-name */
  EXPLICIT = 'explicit',
  /** 触发词匹配 */
  TRIGGER = 'trigger',
  /** 意图映射 */
  INTENT = 'intent',
  /** 语义相似度 */
  SEMANTIC = 'semantic',
  /** 上下文延续 */
  CONTEXT = 'context',
  /** 兜底 */
  FALLBACK = 'fallback',
}

/**
 * Skill 匹配结果
 * Requirements: 6.6
 */
export interface SkillMatchResult {
  /** 匹配的 Skill */
  skill: Skill;
  /** 置信度 (0-1) */
  confidence: number;
  /** 匹配类型 */
  matchType: SkillMatchType;
  /** 匹配原因 */
  matchReason: string;
}

// ==================== Skill 使用指标类型 ====================

/**
 * Skill 使用指标
 * Requirements: 11.1-11.7
 */
export interface SkillUsageMetrics {
  /** Skill 名称 */
  skillName: string;
  /** 使用次数 */
  usageCount: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 总响应时间（毫秒） */
  totalResponseTime: number;
  /** 平均响应时间（毫秒） */
  avgResponseTime: number;
  /** 成功率 */
  successRate: number;
  /** 最后使用时间 */
  lastUsedAt: Date | null;
  /** 匹配类型分布 */
  matchTypeDistribution: Record<SkillMatchType, number>;
  /** 反馈统计 */
  feedbackStats: {
    positive: number;
    negative: number;
    satisfaction: number;
  };
}

/**
 * 默认 Skill 使用指标
 */
export const createDefaultSkillMetrics = (skillName: string): SkillUsageMetrics => ({
  skillName,
  usageCount: 0,
  successCount: 0,
  failureCount: 0,
  totalResponseTime: 0,
  avgResponseTime: 0,
  successRate: 0,
  lastUsedAt: null,
  matchTypeDistribution: {
    [SkillMatchType.EXPLICIT]: 0,
    [SkillMatchType.TRIGGER]: 0,
    [SkillMatchType.INTENT]: 0,
    [SkillMatchType.SEMANTIC]: 0,
    [SkillMatchType.CONTEXT]: 0,
    [SkillMatchType.FALLBACK]: 0,
  },
  feedbackStats: {
    positive: 0,
    negative: 0,
    satisfaction: 0,
  },
});

// ==================== 意图-Skill 映射类型 ====================

/**
 * 意图-Skill 映射配置
 * Requirements: 6.8-6.11
 */
export interface SkillMappingConfig {
  /** 意图类型到 Skill 的映射 */
  intentMapping: Record<string, string>;
  /** 关键词到 Skill 的映射 */
  keywordMapping: Record<string, string>;
  /** 默认 Skill */
  defaultSkill: string;
  /** 语义匹配阈值 */
  semanticMatchThreshold: number;
  /** 上下文延续阈值 */
  contextContinuationThreshold: number;
}

/**
 * 默认映射配置
 */
export const DEFAULT_SKILL_MAPPING: SkillMappingConfig = {
  intentMapping: {
    TROUBLESHOOTING: 'diagnostician',
    CONFIGURATION: 'configurator',
    MONITORING: 'optimizer',
    HISTORICAL_ANALYSIS: 'diagnostician',
    GENERAL: 'generalist',
  },
  keywordMapping: {
    '安全审计': 'auditor',
    '安全检查': 'auditor',
    '拓扑': 'topology-mapper',
    '网络图': 'topology-mapper',
    '性能优化': 'optimizer',
    '带宽优化': 'optimizer',
  },
  defaultSkill: 'generalist',
  semanticMatchThreshold: 0.6,
  contextContinuationThreshold: 0.75,
};

// ==================== 会话 Skill 管理类型 ====================

/**
 * 会话 Skill 状态
 * Requirements: 17.1-17.8, 18.6, 18.7
 */
export interface SessionSkillState {
  /** 当前活跃的 Skill */
  currentSkill: Skill | null;
  /** Skill 切换历史 */
  switchHistory: Array<{
    skillName: string;
    matchType: SkillMatchType;
    timestamp: Date;
  }>;
  /** 最后切换时间 */
  lastSwitchAt: Date | null;
  /** 当前链 ID（用于追踪链式调用） */
  chainId?: string;
  /** 链式执行历史 */
  chainHistory?: SkillChainStep[];
}

/**
 * Skill 链式执行步骤
 * Requirements: 18.7
 */
export interface SkillChainStep {
  /** 步骤 ID */
  stepId: string;
  /** Skill 名称 */
  skillName: string;
  /** 进入时间 */
  enteredAt: Date;
  /** 退出时间 */
  exitedAt?: Date;
  /** 执行状态 */
  status: 'active' | 'completed' | 'failed' | 'skipped';
  /** 触发原因 */
  triggerReason: string;
  /** 是否自动切换 */
  autoSwitched: boolean;
  /** 执行结果摘要 */
  resultSummary?: string;
}

/**
 * Skill 链配置
 * Requirements: 18.6
 */
export interface SkillChainConfig {
  /** 是否启用自动链式调用 */
  enabled: boolean;
  /** 最大链深度（防止无限循环） */
  maxChainDepth: number;
  /** 链超时时间（毫秒） */
  chainTimeoutMs: number;
  /** 是否需要用户确认切换 */
  requireConfirmation: boolean;
}

/**
 * 默认 Skill 链配置
 */
export const DEFAULT_SKILL_CHAIN_CONFIG: SkillChainConfig = {
  enabled: true,
  maxChainDepth: 5,
  chainTimeoutMs: 300000, // 5 分钟
  requireConfirmation: false,
};

// ==================== Skill 系统配置类型 ====================

/**
 * Skill 系统全局配置
 * Requirements: 15.4, 15.5, 18.6
 */
export interface SkillSystemConfig {
  /** 是否启用 Skill 系统 */
  enabled: boolean;
  /** Skills 目录路径 */
  skillsDir: string;
  /** 是否启用热重载 */
  enableHotReload: boolean;
  /** 最小切换间隔（毫秒） */
  minSwitchIntervalMs: number;
  /** Skill 链配置 */
  chainConfig?: SkillChainConfig;
}

/**
 * 默认 Skill 系统配置
 */
export const DEFAULT_SKILL_SYSTEM_CONFIG: SkillSystemConfig = {
  enabled: process.env.SKILL_SYSTEM_ENABLED !== 'false',
  skillsDir: 'data/ai-ops/skills',
  enableHotReload: true,
  minSwitchIntervalMs: 5000,
  chainConfig: DEFAULT_SKILL_CHAIN_CONFIG,
};
