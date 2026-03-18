/**
 * AI-OPS 智能进化系统配置
 * 
 * 本配置文件定义了 AI-OPS 智能进化系统的八大能力配置：
 * 1. 反思与自我修正 (Reflection)
 * 2. 长短期记忆管理 (Experience/Memory)
 * 3. 计划动态修订 (Plan Revision)
 * 4. 工具使用反馈闭环 (Tool Feedback)
 * 5. 主动式运维伙伴 (Proactive Operations)
 * 6. Intent-Driven 自动化 (Intent-Driven)
 * 7. Self-Healing 自愈能力 (Self-Healing)
 * 8. 持续学习与进化 (Continuous Learning)
 * 9. 分布式追踪 (Tracing)
 * 
 * @requirements 10.2.1 所有新能力支持独立开关
 * @requirements 10.2.2 关键参数（阈值、超时、重试次数）可通过配置调整
 * @requirements 10.2.3 配置变更无需重启服务
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * 配置文件路径
 * 注意：服务从 backend 目录启动，所以路径不需要包含 backend 前缀
 */
const CONFIG_FILE_PATH = path.join(
  'data',
  'ai-ops',
  'evolution-config.json'
);

/**
 * 配置变更监听器类型
 */
export type ConfigChangeListener = (
  newConfig: AIEvolutionConfig,
  oldConfig: AIEvolutionConfig
) => void;

/**
 * 配置变更监听器列表
 */
const configChangeListeners: ConfigChangeListener[] = [];

/**
 * 文件监视器实例
 */
let fileWatcher: fs.FSWatcher | null = null;

/**
 * 是否已初始化
 */
let isInitialized = false;

/**
 * 自动修复授权级别
 * - disabled: 禁用自动修复
 * - notify: 仅通知，不自动修复
 * - low_risk: 仅自动修复低风险操作 (L1)
 * - full: 全自动修复
 */
export type AutoHealingLevel = 'disabled' | 'notify' | 'low_risk' | 'full';

/**
 * 风险等级
 * - L1: 低风险
 * - L2: 中风险
 * - L3: 高风险
 * - L4: 极高风险
 */
export type RiskLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * 反思配置
 */
export interface ReflectionConfig {
  /** 是否启用反思能力 */
  enabled: boolean;
  /** 最大反思重试次数，防止死循环 */
  maxRetries: number;
  /** 反思超时时间（毫秒） */
  timeoutMs: number;
}

/**
 * 经验管理配置
 */
export interface ExperienceConfig {
  /** 是否启用经验提取和管理 */
  enabled: boolean;
  /** 经验检索的最小相似度分数阈值 */
  minScoreForRetrieval: number;
  /** 最大 Few-Shot 示例数量 */
  maxFewShotExamples: number;
  /** 是否自动批准新提取的经验 */
  autoApprove: boolean;
}

/**
 * 计划修订配置
 */
export interface PlanRevisionConfig {
  /** 是否启用动态计划修订 */
  enabled: boolean;
  /** 触发修订的质量评分阈值 */
  qualityThreshold: number;
  /** 修订时允许添加的最大额外步骤数 */
  maxAdditionalSteps: number;
}

/**
 * 工具反馈配置
 */
export interface ToolFeedbackConfig {
  /** 是否启用工具反馈收集 */
  enabled: boolean;
  /** 工具指标保留天数 */
  metricsRetentionDays: number;
  /** 是否启用基于指标的工具优先级优化 */
  priorityOptimizationEnabled: boolean;
}

/**
 * 主动运维配置
 */
export interface ProactiveOpsConfig {
  /** 是否启用主动运维能力 */
  enabled: boolean;
  /** 健康检查间隔（秒） */
  healthCheckIntervalSeconds: number;
  /** 预测时间窗口（分钟） */
  predictionTimeWindowMinutes: number;
  /** 预测置信度阈值，超过此值才生成预警 */
  predictionConfidenceThreshold: number;
  /** 主动巡检间隔（小时） */
  inspectionIntervalHours: number;
  /** 是否启用上下文感知对话 */
  contextAwareChatEnabled: boolean;
}

/**
 * 意图驱动配置
 */
export interface IntentDrivenConfig {
  /** 是否启用意图驱动自动化 */
  enabled: boolean;
  /** 意图解析置信度阈值，低于此值需要用户确认 */
  confidenceThreshold: number;
  /** 确认超时时间（分钟） */
  confirmationTimeoutMinutes: number;
  /** 需要人工确认的最低风险等级 */
  riskLevelForConfirmation: RiskLevel;
}

/**
 * 自愈配置
 */
export interface SelfHealingConfig {
  /** 是否启用自愈能力 */
  enabled: boolean;
  /** 自动修复授权级别 */
  autoHealingLevel: AutoHealingLevel;
  /** 故障检测间隔（秒） */
  faultDetectionIntervalSeconds: number;
  /** 根因分析超时时间（秒） */
  rootCauseAnalysisTimeoutSeconds: number;
}

/**
 * 持续学习配置
 */
export interface ContinuousLearningConfig {
  /** 是否启用持续学习 */
  enabled: boolean;
  /** 是否启用操作模式学习 */
  patternLearningEnabled: boolean;
  /** 模式学习生效延迟（天） */
  patternLearningDelayDays: number;
  /** 最佳实践提取阈值（正面反馈次数） */
  bestPracticeThreshold: number;
  /** 策略评估间隔（天） */
  strategyEvaluationIntervalDays: number;
  /** 知识图谱更新间隔（小时） */
  knowledgeGraphUpdateIntervalHours: number;
}

/**
 * 分布式追踪配置
 */
export interface TracingConfig {
  /** 是否启用分布式追踪 */
  enabled: boolean;
  /** 追踪数据保留天数 */
  traceRetentionDays: number;
  /** 长时任务阈值（分钟） */
  longTaskThresholdMinutes: number;
  /** 心跳上报间隔（秒） */
  heartbeatIntervalSeconds: number;
  /** 是否启用 OpenTelemetry 导出 */
  enableOpenTelemetryExport: boolean;
}

/**
 * 自主大脑配置
 */
export interface AutonomousBrainConfig {
  /** 是否启用自主大脑 */
  enabled: boolean;
  /** 大脑轮询心跳间隔（分钟） */
  tickIntervalMinutes: number;
  /** 每日大模型 Token 消耗预算预警阈值 */
  dailyTokenBudget: number;
  /** 是否允许免审执行高危动作 (L3/L4)，若为 false 则推送到审批队列 */
  autoApproveHighRisk: boolean;
}

/**
 * AI-OPS 智能进化系统完整配置接口
 */
export interface AIEvolutionConfig {
  /** 反思配置 */
  reflection: ReflectionConfig;
  /** 经验管理配置 */
  experience: ExperienceConfig;
  /** 计划修订配置 */
  planRevision: PlanRevisionConfig;
  /** 工具反馈配置 */
  toolFeedback: ToolFeedbackConfig;
  /** 主动运维配置 */
  proactiveOps: ProactiveOpsConfig;
  /** 意图驱动配置 */
  intentDriven: IntentDrivenConfig;
  /** 自愈配置 */
  selfHealing: SelfHealingConfig;
  /** 持续学习配置 */
  continuousLearning: ContinuousLearningConfig;
  /** 分布式追踪配置 */
  tracing: TracingConfig;
  /** 自主大脑配置 */
  autonomousBrain: AutonomousBrainConfig;
  /** MCP Client 配置（外部 MCP Server 连接） */
  mcpClient?: {
    enabled: boolean;
    servers: Array<{
      serverId: string;
      name: string;
      transport: 'stdio' | 'sse' | 'http';
      enabled: boolean;
      connectionParams: {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      };
      oauth?: {
        token_url: string;
        grant_type: 'client_credentials' | 'refresh_token';
        client_id: string;
        client_secret: string;
        refresh_token?: string;
        scope?: string;
        refresh_skew_seconds?: number;
        token_field?: string;
        token_type_field?: string;
        expires_in_field?: string;
      };
    }>;
  };
  /** MCP Server 配置 */
  mcpServer?: {
    enabled: boolean;
    enableDeviceExecuteCommand: boolean;
  };
}

/**
 * 默认配置值
 * 
 * 所有能力默认禁用，需要显式启用
 * 参数值基于需求文档中的默认值设定
 */
export const DEFAULT_EVOLUTION_CONFIG: AIEvolutionConfig = {
  // 反思配置
  reflection: {
    enabled: false,
    maxRetries: 2,           // Requirements 1.2.2: 最多允许 2 次反思重试
    timeoutMs: 5000,         // Requirements 1.1.1: 5 秒内生成失败分析报告
  },

  // 经验管理配置
  experience: {
    enabled: false,
    minScoreForRetrieval: 0.7,  // Requirements 2.3.3: 默认 0.7
    maxFewShotExamples: 2,      // Requirements 2.3.2: 最多注入 2 条
    autoApprove: false,         // Requirements 2.4.1: 默认需要审核
  },

  // 计划修订配置
  planRevision: {
    enabled: false,
    qualityThreshold: 60,       // Requirements 3.3.3: 质量评分 < 60 时触发
    maxAdditionalSteps: 2,      // Requirements 3.2.2: 最多添加 2 个额外阶段
  },

  // 工具反馈配置
  toolFeedback: {
    enabled: false,
    metricsRetentionDays: 7,    // Requirements 4.1.2: 最近 7 天的统计
    priorityOptimizationEnabled: false,  // Requirements 4.2.4: 可配置开关
  },

  // 主动运维配置
  proactiveOps: {
    enabled: false,
    healthCheckIntervalSeconds: 60,      // Requirements 5.1.1: 每 60 秒采集
    predictionTimeWindowMinutes: 30,     // Requirements 5.2.5: 默认 30 分钟
    predictionConfidenceThreshold: 0.7,  // Requirements 5.2.3: 置信度 > 70%
    inspectionIntervalHours: 4,          // Requirements 5.3.1: 每 4 小时一次
    contextAwareChatEnabled: false,      // Requirements 5.4.4: 可配置开关
  },

  // 意图驱动配置
  intentDriven: {
    enabled: false,
    confidenceThreshold: 0.8,            // Requirements 6.1.3: 默认 0.8
    confirmationTimeoutMinutes: 5,       // Requirements 6.3.4: 默认 5 分钟
    riskLevelForConfirmation: 'L3',      // Requirements 6.3.2: L3 及以上需确认
  },

  // 自愈配置
  selfHealing: {
    enabled: false,
    autoHealingLevel: 'notify',          // Requirements 7.4.1: 默认仅通知
    faultDetectionIntervalSeconds: 30,   // Requirements 7.1.2: 检测延迟 < 30 秒
    rootCauseAnalysisTimeoutSeconds: 60, // Requirements 7.2.1: 60 秒内完成
  },

  // 持续学习配置
  continuousLearning: {
    enabled: false,
    patternLearningEnabled: false,       // Requirements 8.1.5: 可配置开关
    patternLearningDelayDays: 7,         // Requirements 8.1.3: 7 天后生效
    bestPracticeThreshold: 3,            // Requirements 8.2.1: 3 次正面反馈
    strategyEvaluationIntervalDays: 7,   // Requirements 8.3.1: 每周评估
    knowledgeGraphUpdateIntervalHours: 24, // Requirements 8.4.5: 每日更新
  },

  // 分布式追踪配置
  tracing: {
    enabled: true,                       // 默认启用追踪
    traceRetentionDays: 30,              // Requirements 9.1.5: 保留 30 天
    longTaskThresholdMinutes: 5,         // Requirements 9.4.1: 默认 5 分钟
    heartbeatIntervalSeconds: 30,        // Requirements 9.4.5: 每 30 秒心跳
    enableOpenTelemetryExport: false,    // Requirements 9.3.2: 默认不导出
  },

  // 自主大脑配置
  autonomousBrain: {
    enabled: false,                      // 默认禁用，需要显式启用
    tickIntervalMinutes: 30,             // 默认30分钟醒来一次做全局巡检
    dailyTokenBudget: 500000,            // 默认每日 50万 token 预算
    autoApproveHighRisk: false,          // 默认高危动作需要人工审批
  },
};

/**
 * 当前运行时配置
 * 支持热更新
 */
let currentConfig: AIEvolutionConfig = { ...DEFAULT_EVOLUTION_CONFIG };

/**
 * 深度克隆配置对象
 * @param obj 要克隆的对象
 * @returns 克隆后的对象
 */
function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as unknown as T;
  }

  const cloned = {} as T;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      (cloned as Record<string, unknown>)[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}

/**
 * 深度合并配置对象
 * @param target 目标配置
 * @param source 源配置（部分配置）
 * @returns 合并后的配置
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return (source !== undefined ? source : target) as T;
  }

  const result = deepClone(target);

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key as keyof T];
      const targetValue = target[key as keyof T];

      if (
        sourceValue !== null &&
        sourceValue !== undefined &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        // 递归合并嵌套对象
        (result as Record<string, unknown>)[key] = deepMerge(
          targetValue,
          sourceValue as Partial<typeof targetValue>
        );
      } else if (sourceValue !== undefined) {
        (result as Record<string, unknown>)[key] = sourceValue;
      }
    }
  }

  return result;
}

function sanitizeEvolutionConfig(
  config: Partial<AIEvolutionConfig> | Record<string, unknown>
): Partial<AIEvolutionConfig> {
  const sanitized: Partial<AIEvolutionConfig> = {};
  const knownKeys = new Set(Object.keys(DEFAULT_EVOLUTION_CONFIG));

  for (const [key, value] of Object.entries(config)) {
    if (knownKeys.has(key)) {
      (sanitized as Record<string, unknown>)[key] = value;
    }
  }

  return sanitized;
}
/**
 * 获取当前配置
 * @returns 当前的 AI 进化配置
 */
export function getEvolutionConfig(): AIEvolutionConfig {
  return deepClone(currentConfig);
}

/**
 * 获取特定能力的配置
 * @param capability 能力名称
 * @returns 该能力的配置
 */
export function getCapabilityConfig<K extends keyof AIEvolutionConfig>(
  capability: K
): AIEvolutionConfig[K] {
  return deepClone(currentConfig[capability]);
}

/**
 * 检查特定能力是否启用
 * @param capability 能力名称
 * @returns 是否启用
 */
export function isCapabilityEnabled(
  capability: keyof AIEvolutionConfig
): boolean {
  const config = currentConfig[capability];
  if (!config || typeof config !== 'object') return false;
  return 'enabled' in config ? (config as { enabled: boolean }).enabled : false;
}

/**
 * P6 FIX: 订阅配置变更事件
 * @param listener 配置变更时触发的回调
 */
export function onConfigChange(listener: ConfigChangeListener): void {
  configChangeListeners.push(listener);
}

/**
 * 更新配置（支持热更新）
 * @param updates 部分配置更新
 * @requirements 10.2.3 配置变更无需重启服务
 */
export function updateEvolutionConfig(
  updates: Partial<AIEvolutionConfig>
): void {
  const oldConfig = deepClone(currentConfig);
  currentConfig = deepMerge(currentConfig, sanitizeEvolutionConfig(updates));
  // 通知所有监听器
  for (const listener of configChangeListeners) {
    try {
      listener(deepClone(currentConfig), oldConfig);
    } catch { /* non-critical */ }
  }
}

/**
 * 更新特定能力的配置
 * @param capability 能力名称
 * @param updates 该能力的部分配置更新
 */
export function updateCapabilityConfig<K extends keyof AIEvolutionConfig>(
  capability: K,
  updates: Partial<AIEvolutionConfig[K]>
): void {
  currentConfig = {
    ...currentConfig,
    [capability]: deepMerge(currentConfig[capability], updates),
  };
}

/**
 * 启用特定能力
 * @param capability 能力名称
 */
export function enableCapability(capability: keyof AIEvolutionConfig): void {
  const config = currentConfig[capability];
  if (config && typeof config === 'object' && 'enabled' in config) {
    (config as { enabled: boolean }).enabled = true;
  }
}

/**
 * 禁用特定能力
 * @param capability 能力名称
 */
export function disableCapability(capability: keyof AIEvolutionConfig): void {
  const config = currentConfig[capability];
  if (config && typeof config === 'object' && 'enabled' in config) {
    (config as { enabled: boolean }).enabled = false;
  }
}

/**
 * 重置配置为默认值
 */
export function resetEvolutionConfig(): void {
  currentConfig = deepClone(DEFAULT_EVOLUTION_CONFIG);
}

/**
 * 从环境变量加载配置覆盖
 * 环境变量格式: AI_EVOLUTION_{CAPABILITY}_{PARAM}
 * 例如: AI_EVOLUTION_REFLECTION_ENABLED=true
 */
export function loadConfigFromEnv(): void {
  const envPrefix = 'AI_EVOLUTION_';

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(envPrefix)) continue;

    const parts = key.slice(envPrefix.length).toLowerCase().split('_');
    if (parts.length < 2) continue;

    const capability = parts[0] as keyof AIEvolutionConfig;
    const param = parts.slice(1).join('_');

    if (!(capability in currentConfig)) continue;

    // Use type assertion through unknown to avoid strict type checking
    const capabilityConfig = currentConfig[capability] as unknown as Record<string, unknown>;

    // 转换驼峰命名
    const camelParam = param.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

    if (!(camelParam in capabilityConfig)) continue;

    // 类型转换
    let parsedValue: unknown = value;
    const currentValue = capabilityConfig[camelParam];

    if (typeof currentValue === 'boolean') {
      parsedValue = value?.toLowerCase() === 'true';
    } else if (typeof currentValue === 'number') {
      parsedValue = parseFloat(value || '0');
    }

    capabilityConfig[camelParam] = parsedValue;
  }
}

/**
 * 验证配置有效性
 * @param config 要验证的配置
 * @returns 验证结果，包含是否有效和错误信息
 */
export function validateConfig(
  config: Partial<AIEvolutionConfig>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 验证反思配置
  if (config.reflection) {
    if (config.reflection.maxRetries !== undefined && config.reflection.maxRetries < 0) {
      errors.push('reflection.maxRetries must be non-negative');
    }
    if (config.reflection.timeoutMs !== undefined && config.reflection.timeoutMs < 0) {
      errors.push('reflection.timeoutMs must be non-negative');
    }
  }

  // 验证经验配置
  if (config.experience) {
    if (config.experience.minScoreForRetrieval !== undefined) {
      if (config.experience.minScoreForRetrieval < 0 || config.experience.minScoreForRetrieval > 1) {
        errors.push('experience.minScoreForRetrieval must be between 0 and 1');
      }
    }
    if (config.experience.maxFewShotExamples !== undefined && config.experience.maxFewShotExamples < 0) {
      errors.push('experience.maxFewShotExamples must be non-negative');
    }
  }

  // 验证计划修订配置
  if (config.planRevision) {
    if (config.planRevision.qualityThreshold !== undefined) {
      if (config.planRevision.qualityThreshold < 0 || config.planRevision.qualityThreshold > 100) {
        errors.push('planRevision.qualityThreshold must be between 0 and 100');
      }
    }
    if (config.planRevision.maxAdditionalSteps !== undefined && config.planRevision.maxAdditionalSteps < 0) {
      errors.push('planRevision.maxAdditionalSteps must be non-negative');
    }
  }

  // 验证主动运维配置
  if (config.proactiveOps) {
    if (config.proactiveOps.predictionConfidenceThreshold !== undefined) {
      if (config.proactiveOps.predictionConfidenceThreshold < 0 ||
        config.proactiveOps.predictionConfidenceThreshold > 1) {
        errors.push('proactiveOps.predictionConfidenceThreshold must be between 0 and 1');
      }
    }
    if (config.proactiveOps.healthCheckIntervalSeconds !== undefined &&
      config.proactiveOps.healthCheckIntervalSeconds < 1) {
      errors.push('proactiveOps.healthCheckIntervalSeconds must be at least 1');
    }
  }

  // 验证意图驱动配置
  if (config.intentDriven) {
    if (config.intentDriven.confidenceThreshold !== undefined) {
      if (config.intentDriven.confidenceThreshold < 0 || config.intentDriven.confidenceThreshold > 1) {
        errors.push('intentDriven.confidenceThreshold must be between 0 and 1');
      }
    }
    if (config.intentDriven.confirmationTimeoutMinutes !== undefined &&
      config.intentDriven.confirmationTimeoutMinutes < 1) {
      errors.push('intentDriven.confirmationTimeoutMinutes must be at least 1');
    }
  }

  // 验证自愈配置
  if (config.selfHealing) {
    if (config.selfHealing.faultDetectionIntervalSeconds !== undefined &&
      config.selfHealing.faultDetectionIntervalSeconds < 1) {
      errors.push('selfHealing.faultDetectionIntervalSeconds must be at least 1');
    }
    if (config.selfHealing.rootCauseAnalysisTimeoutSeconds !== undefined &&
      config.selfHealing.rootCauseAnalysisTimeoutSeconds < 1) {
      errors.push('selfHealing.rootCauseAnalysisTimeoutSeconds must be at least 1');
    }
  }

  // 验证持续学习配置
  if (config.continuousLearning) {
    if (config.continuousLearning.bestPracticeThreshold !== undefined &&
      config.continuousLearning.bestPracticeThreshold < 1) {
      errors.push('continuousLearning.bestPracticeThreshold must be at least 1');
    }
  }

  // 验证追踪配置
  if (config.tracing) {
    if (config.tracing.traceRetentionDays !== undefined && config.tracing.traceRetentionDays < 1) {
      errors.push('tracing.traceRetentionDays must be at least 1');
    }
    if (config.tracing.longTaskThresholdMinutes !== undefined &&
      config.tracing.longTaskThresholdMinutes < 1) {
      errors.push('tracing.longTaskThresholdMinutes must be at least 1');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 获取所有能力的启用状态摘要
 * @returns 能力启用状态映射
 */
export function getCapabilityStatusSummary(): Record<keyof AIEvolutionConfig, boolean> {
  return {
    reflection: currentConfig.reflection.enabled,
    experience: currentConfig.experience.enabled,
    planRevision: currentConfig.planRevision.enabled,
    toolFeedback: currentConfig.toolFeedback.enabled,
    proactiveOps: currentConfig.proactiveOps.enabled,
    intentDriven: currentConfig.intentDriven.enabled,
    selfHealing: currentConfig.selfHealing.enabled,
    continuousLearning: currentConfig.continuousLearning.enabled,
    tracing: currentConfig.tracing.enabled,
    autonomousBrain: currentConfig.autonomousBrain.enabled,
    mcpClient: currentConfig.mcpClient?.enabled ?? false,
    mcpServer: currentConfig.mcpServer?.enabled ?? false,
  };
}

/**
 * 从 JSON 文件加载配置
 * @param filePath 配置文件路径，默认为 data/ai-ops/evolution-config.json
 * @returns 是否成功加载
 * @requirements 10.2.3 配置变更无需重启服务
 */
export function loadConfigFromFile(filePath: string = CONFIG_FILE_PATH): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      // 配置文件不存在，使用默认配置
      return false;
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const fileConfig = sanitizeEvolutionConfig(
      JSON.parse(fileContent) as Partial<AIEvolutionConfig>
    );

    // 验证配置
    const validation = validateConfig(fileConfig);
    if (!validation.valid) {
      console.error('Invalid config file:', validation.errors);
      return false;
    }

    // 保存旧配置用于通知监听器
    const oldConfig = deepClone(currentConfig);

    // 合并配置
    currentConfig = deepMerge(DEFAULT_EVOLUTION_CONFIG, fileConfig);

    // 通知监听器
    notifyConfigChange(currentConfig, oldConfig);

    return true;
  } catch (error) {
    console.error('Failed to load config from file:', error);
    return false;
  }
}

/**
 * 将当前配置保存到 JSON 文件
 * @param filePath 配置文件路径，默认为 data/ai-ops/evolution-config.json
 * @returns 是否成功保存
 */
export function saveConfigToFile(filePath: string = CONFIG_FILE_PATH): boolean {
  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(currentConfig, null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch (error) {
    console.error('Failed to save config to file:', error);
    return false;
  }
}

/**
 * 启动配置文件监视器，实现热更新
 * @param filePath 配置文件路径，默认为 data/ai-ops/evolution-config.json
 * @requirements 10.2.3 配置变更无需重启服务
 */
export function startConfigFileWatcher(filePath: string = CONFIG_FILE_PATH): void {
  // 如果已有监视器，先停止
  stopConfigFileWatcher();

  // 确保目录存在
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 使用防抖来避免重复触发
  let debounceTimer: NodeJS.Timeout | null = null;

  try {
    // 监视目录而不是文件，因为文件可能不存在
    fileWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename === path.basename(filePath)) {
        // 防抖处理
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          loadConfigFromFile(filePath);
        }, 100);
      }
    });

    fileWatcher.on('error', (error) => {
      console.error('Config file watcher error:', error);
    });
  } catch (error) {
    console.error('Failed to start config file watcher:', error);
  }
}

/**
 * 停止配置文件监视器
 */
export function stopConfigFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

/**
 * 添加配置变更监听器
 * @param listener 监听器函数
 * @returns 取消监听的函数
 */
export function addConfigChangeListener(
  listener: ConfigChangeListener
): () => void {
  configChangeListeners.push(listener);
  return () => {
    const index = configChangeListeners.indexOf(listener);
    if (index > -1) {
      configChangeListeners.splice(index, 1);
    }
  };
}

/**
 * 通知所有配置变更监听器
 * @param newConfig 新配置
 * @param oldConfig 旧配置
 */
function notifyConfigChange(
  newConfig: AIEvolutionConfig,
  oldConfig: AIEvolutionConfig
): void {
  for (const listener of configChangeListeners) {
    try {
      listener(newConfig, oldConfig);
    } catch (error) {
      console.error('Config change listener error:', error);
    }
  }
}

/**
 * 初始化进化配置系统
 * 加载配置文件并启动文件监视器
 * @param options 初始化选项
 * @returns 是否成功初始化
 * @requirements 10.2.3 配置变更无需重启服务
 */
export function initializeEvolutionConfig(options?: {
  configFilePath?: string;
  enableFileWatcher?: boolean;
  loadFromEnv?: boolean;
}): boolean {
  if (isInitialized) {
    return true;
  }

  const {
    configFilePath = CONFIG_FILE_PATH,
    enableFileWatcher = true,
    loadFromEnv = true,
  } = options || {};

  try {
    // 首先重置为默认配置
    resetEvolutionConfig();

    // 从文件加载配置
    loadConfigFromFile(configFilePath);

    // 从环境变量加载配置（覆盖文件配置）
    if (loadFromEnv) {
      loadConfigFromEnv();
    }

    // 启动文件监视器
    if (enableFileWatcher) {
      startConfigFileWatcher(configFilePath);
    }

    isInitialized = true;
    return true;
  } catch (error) {
    console.error('Failed to initialize evolution config:', error);
    return false;
  }
}

/**
 * 关闭进化配置系统
 * 停止文件监视器并清理资源
 */
export function shutdownEvolutionConfig(): void {
  stopConfigFileWatcher();
  configChangeListeners.length = 0;
  isInitialized = false;
}

/**
 * 获取配置文件路径
 * @returns 配置文件路径
 */
export function getConfigFilePath(): string {
  return CONFIG_FILE_PATH;
}

/**
 * 检查配置系统是否已初始化
 * @returns 是否已初始化
 */
export function isEvolutionConfigInitialized(): boolean {
  return isInitialized;
}
