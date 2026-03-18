/**
 * FaultHealer 故障自愈服务
 * 负责故障模式管理、故障匹配和自动修复
 *
 * Requirements: 7.1-7.12
 * - 7.1: 支持预定义常见故障模式和对应的修复脚本
 * - 7.2: 内置故障模式：CPU 过载降级、内存不足清理、接口 down 重启
 * - 7.3: 支持用户自定义故障模式和修复脚本
 * - 7.4: 告警触发时检查是否匹配已定义的故障模式
 * - 7.5: 匹配到故障模式时调用 AI 服务确认故障诊断
 * - 7.6: AI 确认故障诊断后执行对应的修复脚本
 * - 7.7: 执行修复脚本前创建配置快照作为回滚点
 * - 7.8: 修复脚本执行完成时验证故障是否已修复
 * - 7.9: 故障修复成功时发送修复成功通知
 * - 7.10: 故障修复失败时发送修复失败通知并建议人工介入
 * - 7.11: 支持配置每个故障模式的自动修复开关
 * - 7.12: 自动修复被禁用时仅发送告警和修复建议，不执行脚本
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  FaultPattern,
  FaultCondition,
  CreateFaultPatternInput,
  UpdateFaultPatternInput,
  RemediationExecution,
  RemediationExecutionConfig,
  RollbackResult,
  IFaultHealer,
  AlertEvent,
  AlertOperator,
  MetricType,
  FaultPatternStatus,
  RootCauseAnalysis,
  HealResult,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { isCapabilityEnabled, getCapabilityConfig } from './evolutionConfig';
import { auditLogger } from './auditLogger';
import { notificationService } from './notificationService';
import { configSnapshotService } from './configSnapshotService';
import { getServiceAsync, SERVICE_NAMES } from '../bootstrap';
import { DevicePool } from '../device/devicePool';
import type { DeviceDriver } from '../../types/device-driver';
import { knowledgeBase } from './rag';
import type { DeviceManager } from '../device/deviceManager';
import type { EventBus } from '../eventBus';
import type { RemediationAdvisor } from './remediationAdvisor';
import type { ScriptSynthesizer } from './scriptSynthesizer';
import type { FaultPatternLibrary } from './faultPatternLibrary';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const PATTERNS_DIR = path.join(DATA_DIR, 'patterns');
const PATTERNS_FILE = path.join(PATTERNS_DIR, 'patterns.json');
const REMEDIATIONS_DIR = path.join(DATA_DIR, 'remediations');

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取修复执行记录文件路径
 */
function getRemediationsFilePath(dateStr: string): string {
  return path.join(REMEDIATIONS_DIR, `${dateStr}.json`);
}

/**
 * 内置故障模式定义（通用 AIOps 示例模板）
 * 注意：脚本使用设备无关的操作意图格式 "intent:category/operation param=value"
 * 实际执行时由 DeviceDriver 将意图翻译为具体设备命令
 */
const BUILTIN_PATTERNS: Omit<FaultPattern, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'CPU 过载自动降级',
    description: '当设备 CPU 使用率持续过高时，自动执行降级策略减轻负载',
    enabled: true,
    autoHeal: false, // 默认禁用自动修复，需要用户手动启用
    builtin: true,
    conditions: [
      {
        metric: 'cpu',
        operator: 'gt',
        threshold: 95,
      },
    ],
    remediationScript: `# 操作意图：执行 CPU 过载降级策略
# 具体命令由设备驱动根据 CapabilityManifest 翻译
intent:system/diagnostics action=cpu-profile
intent:service/degrade level=non-critical`,
    rollbackScript: `intent:service/restore level=all`,
    verificationScript: `intent:system/resource action=print`,
  },
  {
    name: '内存不足清理',
    description: '当设备内存使用率过高时，自动清理缓存释放内存',
    enabled: true,
    autoHeal: false,
    builtin: true,
    conditions: [
      {
        metric: 'memory',
        operator: 'gt',
        threshold: 95,
      },
    ],
    remediationScript: `# 操作意图：清理设备缓存释放内存
intent:system/cache action=flush
intent:system/resource action=reclaim`,
    rollbackScript: `# 缓存清理无需回滚`,
    verificationScript: `intent:system/resource action=print`,
  },
  {
    name: '接口 Down 重启',
    description: '当网络接口异常断开时，自动重启接口恢复连接',
    enabled: true,
    autoHeal: false,
    builtin: true,
    conditions: [
      {
        metric: 'interface_status',
        operator: 'eq',
        threshold: 0,
      },
    ],
    remediationScript: `# 接口重启脚本，metricLabel 指定具体接口名称
# intent:interface/disable name={metricLabel}
# intent:system/delay seconds=3
# intent:interface/enable name={metricLabel}`,
    rollbackScript: `# 回滚接口状态
# intent:interface/disable name={metricLabel}`,
    verificationScript: `intent:interface/print name={metricLabel}`,
  },
];

/**
 * 默认修复执行配置
 */
const DEFAULT_REMEDIATION_CONFIG: RemediationExecutionConfig = {
  maxRetries: 3,
  retryDelayMs: 5000,
  enableAutoRollback: true,
  rollbackTimeoutMs: 30000,
  verificationRetries: 2,
  scriptTimeoutMs: 30000, // 脚本执行超时时间，默认 30 秒 (Requirements: 2.3)
};

/**
 * 安全模式配置 (Requirements: 3.4, 3.5)
 */
interface SafeModeConfig {
  /** 自动恢复检查间隔（毫秒），默认 300000 (5分钟) */
  autoRecoveryIntervalMs: number;
  /** 安全模式最大持续时间（毫秒），默认 3600000 (1小时) */
  maxSafeModeDurationMs: number;
}

export class FaultHealer implements IFaultHealer {
  private patterns: FaultPattern[] = [];
  private initialized = false;

  // 写锁：防止并发 read-modify-write 竞态条件
  private patternsWriteLock: Promise<void> = Promise.resolve();
  private remediationWriteLocks: Map<string, Promise<void>> = new Map();

  // 安全模式相关 (Requirements: 4.4, 4.6)
  private safeMode = false;
  private safeModeReason = '';
  private safeModeActivatedAt?: number;

  // 安全模式自动恢复定时器 (Requirements: 3.1, 3.2)
  private safeModeRecoveryTimer: NodeJS.Timeout | null = null;
  private safeModeConfig: SafeModeConfig = {
    autoRecoveryIntervalMs: 5 * 60 * 1000,  // 5 分钟
    maxSafeModeDurationMs: 60 * 60 * 1000,  // 1 小时
  };

  // 修复执行配置 (Requirements: 4.1, 4.3, 4.5)
  private config: RemediationExecutionConfig = { ...DEFAULT_REMEDIATION_CONFIG };

  // 周期性健康检查定时器 (Requirements: 4.3)
  private detectionTimer: NodeJS.Timeout | null = null;

  // ==================== 设备无关依赖注入 (H3.11) ====================
  private deviceManager: DeviceManager | null = null;
  private eventBus: EventBus | null = null;
  private remediationAdvisorRef: RemediationAdvisor | null = null;
  private scriptSynthesizerRef: ScriptSynthesizer | null = null;
  private faultPatternLibrary: FaultPatternLibrary | null = null;

  /** 注入 DeviceManager（通过 DeviceDriver 执行修复） */
  setDeviceManager(dm: DeviceManager): void {
    this.deviceManager = dm;
    logger.info('FaultHealer: DeviceManager injected');
  }

  /** 注入 EventBus（发布自愈事件） */
  setEventBus(eb: EventBus): void {
    this.eventBus = eb;
    logger.info('FaultHealer: EventBus injected');
  }

  /** 注入 RemediationAdvisor（利用已有的设备无关修复方案生成） */
  setRemediationAdvisor(ra: RemediationAdvisor): void {
    this.remediationAdvisorRef = ra;
    logger.info('FaultHealer: RemediationAdvisor injected');
  }

  /** 注入 ScriptSynthesizer（利用已有的脚本合成能力） */
  setScriptSynthesizer(ss: ScriptSynthesizer): void {
    this.scriptSynthesizerRef = ss;
    logger.info('FaultHealer: ScriptSynthesizer injected');
  }

  /** 注入 FaultPatternLibrary（故障模式库匹配） */
  setFaultPatternLibrary(fpl: FaultPatternLibrary): void {
    this.faultPatternLibrary = fpl;
    logger.info('FaultHealer: FaultPatternLibrary injected');
  }

  // ==================== 完整自愈流程 (H3.11, H3.12, H3.13, H3.14) ====================

  /**
   * 完整自愈流程：
   * 1. 查询故障模式库匹配 (H4.15)
   * 2. 生成设备无关修复方案 (H3.12, PH.3)
   * 3. 创建配置快照 (H3.13)
   * 4. 通过 DeviceDriver 执行修复
   * 5. 失败时回滚 (PH.4)
   * 6. 发布自愈结果事件
   */
  async heal(alert: AlertEvent, analysis: RootCauseAnalysis): Promise<HealResult> {
    const startTime = Date.now();
    const stepResults: HealResult['steps'] = [];
    let snapshotId: string | undefined;
    let planId: string | undefined;

    const deviceId = alert.deviceId;
    const tenantId = alert.tenantId;

    if (!deviceId || !tenantId) {
      return {
        success: false,
        error: 'Missing deviceId or tenantId in alert',
        steps: [],
        duration: Date.now() - startTime,
      };
    }

    try {
      await this.initialize();

      // Step 1: 查询故障模式库匹配
      const matchedPattern = await this.matchPattern(alert);
      logger.info(`[heal] Pattern match for alert ${alert.id}: ${matchedPattern?.name ?? 'none'}`);

      // Step 1.5: 如果内置匹配未命中，尝试 FaultPatternLibrary 匹配 (H4.15)
      if (!matchedPattern && this.faultPatternLibrary) {
        try {
          const rootCauseDescriptions = analysis.rootCauses?.map((rc) => rc.description) ?? [];
          const libraryMatch = await this.faultPatternLibrary.findMatch({
            summary: rootCauseDescriptions.join('; ') || alert.message || '',
            details: analysis.impact?.affectedResources?.join(', '),
            recommendations: analysis.similarIncidents?.map((si) => si.resolution).filter(Boolean) as string[] | undefined,
          });
          if (libraryMatch) {
            logger.info(`[heal] FaultPatternLibrary match for alert ${alert.id}: ${libraryMatch.name}`);
          }
        } catch (err) {
          logger.warn('[heal] FaultPatternLibrary.findMatch failed:', err);
        }
      }

      // Step 2: 生成设备无关修复方案 via RemediationAdvisor
      if (!this.remediationAdvisorRef) {
        return {
          success: false,
          error: 'RemediationAdvisor not injected',
          steps: [],
          duration: Date.now() - startTime,
        };
      }

      const plan = await this.remediationAdvisorRef.generatePlan(analysis);
      planId = plan.id;
      logger.info(`[heal] Generated repair plan ${plan.id} with ${plan.steps.length} steps`);

      if (plan.steps.length === 0) {
        return {
          success: false,
          planId,
          error: 'Generated plan has no steps',
          steps: [],
          duration: Date.now() - startTime,
        };
      }

      // Step 3: 创建配置快照 (H3.13)
      try {
        const snapshot = await configSnapshotService.createSnapshot('pre-remediation', tenantId, deviceId);
        snapshotId = snapshot.id;
        logger.info(`[heal] Created pre-remediation snapshot: ${snapshotId}`);
      } catch (snapErr) {
        logger.error('[heal] Failed to create pre-remediation snapshot, aborting heal to prevent unrecoverable changes:', snapErr);
        return {
          success: false,
          planId,
          error: '无法创建修复前配置快照，中止修复以防止不可回滚的变更',
          steps: [],
          duration: Date.now() - startTime,
        };
      }

      // Step 4: 通过 DeviceDriver 执行修复步骤
      let allStepsSucceeded = true;

      for (const step of plan.steps) {
        const stepResult: HealResult['steps'][number] = {
          description: step.description,
          success: false,
        };

        try {
          // 使用 DevicePool 获取连接并执行操作意图命令
          // 操作意图格式: "action_type:category/operation [params]"
          const devicePool = await getServiceAsync<DevicePool>(SERVICE_NAMES.DEVICE_POOL);
          const client = await devicePool.getConnection(tenantId, deviceId);

          if (!client.isConnected()) {
            stepResult.error = 'Device not connected';
            allStepsSucceeded = false;
            stepResults.push(stepResult);
            break;
          }

          // 解析操作意图并通过客户端执行
          const { apiCommand, params } = this.convertIntentToCommand(step.command);
          if (apiCommand) {
            const response = await client.executeRaw(apiCommand, params);
            stepResult.success = true;
            stepResult.output = response ? JSON.stringify(response) : 'OK';
          } else {
            // 跳过注释或空命令
            stepResult.success = true;
            stepResult.output = 'Skipped (comment/empty)';
          }
        } catch (execErr) {
          stepResult.error = execErr instanceof Error ? execErr.message : String(execErr);
          allStepsSucceeded = false;
          stepResults.push(stepResult);
          break; // 停止执行后续步骤
        }

        stepResults.push(stepResult);
      }

      // Step 5: 失败时回滚 (PH.4)
      if (!allStepsSucceeded && snapshotId) {
        logger.info(`[heal] Repair failed, rolling back via snapshot ${snapshotId}`);
        try {
          const rollbackResult = await configSnapshotService.restoreSnapshot(snapshotId);
          logger.info(`[heal] Rollback result: ${rollbackResult.success ? 'success' : rollbackResult.message}`);
        } catch (rollbackErr) {
          logger.error('[heal] Rollback failed:', rollbackErr);
        }
      }

      const healResult: HealResult = {
        success: allStepsSucceeded,
        snapshotId,
        planId,
        error: allStepsSucceeded ? undefined : stepResults.find(s => s.error)?.error,
        steps: stepResults,
        duration: Date.now() - startTime,
      };

      // Step 6: 发布自愈结果事件
      if (this.eventBus) {
        try {
          await this.eventBus.publish({
            type: 'internal',
            source: 'fault-healer',
            priority: allStepsSucceeded ? 'medium' : 'high',
            schemaVersion: '1.0.0',
            payload: {
              action: 'heal_completed',
              alertId: alert.id,
              deviceId,
              tenantId,
              success: allStepsSucceeded,
              planId,
              snapshotId,
              duration: healResult.duration,
            },
          });
        } catch (pubErr) {
          logger.warn('[heal] Failed to publish heal event:', pubErr);
        }
      }

      // 记录审计日志
      await auditLogger.log({
        action: 'remediation_execute',
        actor: 'system',
        details: {
          trigger: 'heal_flow',
          result: allStepsSucceeded ? 'success' : 'failed',
          metadata: {
            alertId: alert.id,
            planId,
            snapshotId,
            stepsExecuted: stepResults.length,
            duration: healResult.duration,
          },
        },
      });

      return healResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[heal] Unexpected error during heal flow:`, error);

      return {
        success: false,
        snapshotId,
        planId,
        error: errorMessage,
        steps: stepResults,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 将操作意图描述转换为可执行命令
   * 操作意图格式: "action_type:category/operation [params]"
   * 例如: "query:system/resource", "execute:interface/enable filter=not-running"
   */
  private convertIntentToCommand(intent: string): { apiCommand: string; params: string[] } {
    const trimmed = intent.trim();

    // 跳过注释和空行
    if (!trimmed || trimmed.startsWith('#')) {
      return { apiCommand: '', params: [] };
    }

    // 解析操作意图格式: "action_type:category/operation [params]"
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const afterColon = trimmed.substring(colonIdx + 1).trim();
      // 分离路径和参数
      const parts = afterColon.split(/\s+/);
      const pathPart = parts[0]; // e.g. "system/resource"
      const paramParts = parts.slice(1);

      const apiCommand = '/' + pathPart.replace(/\./g, '/');
      const params = paramParts
        .filter(p => p.includes('='))
        .map(p => `=${p}`);

      return { apiCommand, params };
    }

    // 尝试作为简单路径格式解析: "/path/to/action param=value"
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const apiCommand = parts[0];
      const params = parts.slice(1)
        .filter(p => p.includes('='))
        .map(p => `=${p}`);
      return { apiCommand, params };
    }

    // 无法识别的格式
    logger.warn(`Unrecognized intent format: ${trimmed}`);
    return { apiCommand: '', params: [] };
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(PATTERNS_DIR, { recursive: true });
      await fs.mkdir(REMEDIATIONS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create fault healer directories:', error);
    }
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureDataDir();
    await this.loadPatterns();
    await this.ensureBuiltinPatterns();
    this.initialized = true;
    logger.info('FaultHealer initialized');
  }


  /**
   * 加载故障模式
   */
  private async loadPatterns(): Promise<void> {
    try {
      const data = await fs.readFile(PATTERNS_FILE, 'utf-8');
      this.patterns = JSON.parse(data) as FaultPattern[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.patterns = [];
        await this.savePatterns();
      } else {
        logger.error('Failed to load fault patterns:', error);
        this.patterns = [];
      }
    }
  }

  /**
   * 保存故障模式
   */
  private async savePatterns(): Promise<void> {
    // 使用写锁防止并发 read-modify-write 竞态
    const prevLock = this.patternsWriteLock;
    const currentLock = prevLock.then(async () => {
      await this.ensureDataDir();
      await fs.writeFile(PATTERNS_FILE, JSON.stringify(this.patterns, null, 2), 'utf-8');
    }).catch((err) => {
      logger.error('Failed to save fault patterns:', err);
    });

    this.patternsWriteLock = currentLock;
    await currentLock;
  }

  /**
   * 确保内置故障模式存在
   */
  private async ensureBuiltinPatterns(): Promise<void> {
    const now = Date.now();
    let updated = false;

    for (const builtinPattern of BUILTIN_PATTERNS) {
      const existing = this.patterns.find(
        (p) => p.builtin && p.name === builtinPattern.name
      );

      if (!existing) {
        const pattern: FaultPattern = {
          id: uuidv4(),
          createdAt: now,
          updatedAt: now,
          ...builtinPattern,
        };
        this.patterns.push(pattern);
        updated = true;
        logger.info(`Added builtin fault pattern: ${pattern.name}`);
      }
    }

    if (updated) {
      await this.savePatterns();
    }
  }

  /**
   * 读取指定日期的修复执行记录
   */
  private async readRemediationsFile(dateStr: string): Promise<RemediationExecution[]> {
    const filePath = getRemediationsFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as RemediationExecution[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read remediations file ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * 写入修复执行记录
   */
  private async writeRemediationsFile(
    dateStr: string,
    remediations: RemediationExecution[]
  ): Promise<void> {
    await this.ensureDataDir();
    const filePath = getRemediationsFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(remediations, null, 2), 'utf-8');
  }

  /**
   * 保存修复执行记录
   */
  private async saveRemediation(remediation: RemediationExecution): Promise<void> {
    const dateStr = getDateString(remediation.startedAt);

    // 使用 per-date 写锁防止并发 read-modify-write 竞态
    const prevLock = this.remediationWriteLocks.get(dateStr) ?? Promise.resolve();
    const currentLock = prevLock.then(async () => {
      const remediations = await this.readRemediationsFile(dateStr);
      const existingIndex = remediations.findIndex((r) => r.id === remediation.id);
      if (existingIndex >= 0) {
        remediations[existingIndex] = remediation;
      } else {
        remediations.push(remediation);
      }
      await this.writeRemediationsFile(dateStr, remediations);
    }).catch((err) => {
      logger.error(`Failed to save remediation ${remediation.id}:`, err);
    }).finally(() => {
      // 清理已完成的写锁条目，防止 Map 无限增长
      if (this.remediationWriteLocks.get(dateStr) === currentLock) {
        this.remediationWriteLocks.delete(dateStr);
      }
    });

    this.remediationWriteLocks.set(dateStr, currentLock);
    await currentLock;
  }

  /**
   * Propose a new fault pattern (pending review)
   */
  async proposePattern(input: CreateFaultPatternInput): Promise<FaultPattern> {
    await this.initialize();

    // Force status to pending_review
    const pattern = await this.createPattern({
      ...input,
      status: 'pending_review',
      source: 'learned'
    });

    logger.info(`Proposed new fault pattern: ${pattern.name} (${pattern.id})`);
    return pattern;
  }

  // ==================== 故障模式管理 ====================

  /**
   * 获取所有故障模式
   */
  async getPatterns(status?: FaultPatternStatus, deviceId?: string): Promise<FaultPattern[]> {
    await this.initialize();
    let patterns = this.patterns;

    if (status) {
      patterns = patterns.filter(p => p.status === status);
    }

    if (deviceId) {
      // Return global patterns and device-specific patterns
      patterns = patterns.filter(p => !p.deviceId || p.deviceId === deviceId);
    }

    return [...patterns];
  }

  /**
   * 根据 ID 获取故障模式
   */
  async getPatternById(id: string): Promise<FaultPattern | null> {
    await this.initialize();
    return this.patterns.find((p) => p.id === id) || null;
  }

  /**
   * 创建故障模式
   */
  async createPattern(input: CreateFaultPatternInput): Promise<FaultPattern> {
    await this.initialize();

    const now = Date.now();
    const pattern: FaultPattern = {
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
      builtin: false, // 用户创建的模式不是内置的
      status: input.status || 'active', // Default to active if not specified
      source: input.source || 'user',   // Default to user if not specified
      ...input,
    };

    this.patterns.push(pattern);
    await this.savePatterns();

    // 索引到知识库 (Requirements: 3.4 - 故障模式创建时自动索引)
    try {
      if (pattern.status === 'active') {
        await knowledgeBase.indexPattern(pattern);
        logger.debug(`Fault pattern indexed to knowledge base: ${pattern.id}`);
      }
    } catch (error) {
      logger.warn(`Failed to index fault pattern to knowledge base: ${pattern.id}`, error);
    }

    logger.info(`Created fault pattern: ${pattern.name} (${pattern.id})`);
    return pattern;
  }

  /**
   * 更新故障模式
   */
  async updatePattern(id: string, updates: UpdateFaultPatternInput): Promise<FaultPattern> {
    await this.initialize();

    const index = this.patterns.findIndex((p) => p.id === id);
    if (index === -1) {
      throw new Error(`Fault pattern not found: ${id}`);
    }

    const pattern = this.patterns[index];
    const updatedPattern: FaultPattern = {
      ...pattern,
      ...updates,
      updatedAt: Date.now(),
    };

    this.patterns[index] = updatedPattern;
    await this.savePatterns();

    // 索引到知识库 (Requirements: 3.4 - 故障模式更新时自动索引)
    try {
      await knowledgeBase.indexPattern(updatedPattern);
      logger.debug(`Fault pattern indexed to knowledge base: ${updatedPattern.id}`);
    } catch (error) {
      logger.warn(`Failed to index fault pattern to knowledge base: ${updatedPattern.id}`, error);
    }

    logger.info(`Updated fault pattern: ${updatedPattern.name} (${id})`);
    return updatedPattern;
  }

  /**
   * 删除故障模式
   */
  async deletePattern(id: string): Promise<void> {
    await this.initialize();

    const index = this.patterns.findIndex((p) => p.id === id);
    if (index === -1) {
      throw new Error(`Fault pattern not found: ${id}`);
    }

    const pattern = this.patterns[index];

    // 内置模式不能删除，只能禁用
    if (pattern.builtin) {
      throw new Error('Cannot delete builtin fault pattern. You can disable it instead.');
    }

    this.patterns.splice(index, 1);
    await this.savePatterns();

    logger.info(`Deleted fault pattern: ${pattern.name} (${id})`);
  }

  /**
   * 启用自动修复
   */
  async enableAutoHeal(id: string): Promise<void> {
    await this.updatePattern(id, { autoHeal: true });
    logger.info(`Enabled auto-heal for fault pattern: ${id}`);
  }

  /**
   * 禁用自动修复
   */
  async disableAutoHeal(id: string): Promise<void> {
    await this.updatePattern(id, { autoHeal: false });
    logger.info(`Disabled auto-heal for fault pattern: ${id}`);
  }

  /**
   * 启用故障模式
   */
  async enablePattern(id: string): Promise<void> {
    await this.updatePattern(id, { enabled: true });
    logger.info(`Enabled fault pattern: ${id}`);
  }

  /**
   * 禁用故障模式
   */
  async disablePattern(id: string): Promise<void> {
    await this.updatePattern(id, { enabled: false });
    logger.info(`Disabled fault pattern: ${id}`);
  }


  // ==================== 故障匹配 ====================

  /**
   * 评估条件运算符
   */
  private evaluateCondition(
    value: number,
    operator: AlertOperator,
    threshold: number
  ): boolean {
    switch (operator) {
      case 'gt':
        return value > threshold;
      case 'lt':
        return value < threshold;
      case 'eq':
        return value === threshold;
      case 'ne':
        return value !== threshold;
      case 'gte':
        return value >= threshold;
      case 'lte':
        return value <= threshold;
      default:
        return false;
    }
  }

  /**
   * 检查单个条件是否匹配告警事件
   */
  private evaluateSingleCondition(
    alertEvent: AlertEvent,
    condition: FaultCondition
  ): boolean {
    // 检查指标类型是否匹配
    if (condition.metric !== alertEvent.metric) {
      return false;
    }

    // 检查指标标签是否匹配（如接口名称）
    if (condition.metricLabel) {
      if (!alertEvent.metricLabel || condition.metricLabel !== alertEvent.metricLabel) {
        return false;
      }
    }

    // 检查条件阈值是否满足
    return this.evaluateCondition(
      alertEvent.currentValue,
      condition.operator,
      condition.threshold
    );
  }

  /**
   * 检查告警事件是否匹配故障模式的条件
   * 支持 conditionLogic: 'AND'（所有条件必须满足）| 'OR'（任一条件满足，默认）
   */
  private matchesConditions(
    alertEvent: AlertEvent,
    pattern: FaultPattern
  ): boolean {
    if (pattern.conditions.length === 0) {
      return false;
    }

    const logic = pattern.conditionLogic ?? 'OR';

    if (logic === 'AND') {
      // AND 模式：所有条件都必须匹配
      return pattern.conditions.every(c => this.evaluateSingleCondition(alertEvent, c));
    }

    // OR 模式（默认）：至少一个条件匹配
    return pattern.conditions.some(c => this.evaluateSingleCondition(alertEvent, c));
  }

  /**
   * 匹配告警事件到故障模式
   */
  async matchPattern(alertEvent: AlertEvent): Promise<FaultPattern | null> {
    await this.initialize();

    const eventDeviceId = alertEvent.deviceId;
    const eventTenantId = alertEvent.tenantId;

    if (!eventDeviceId) {
      logger.warn(`Alert event ${alertEvent.id} missing deviceId, skipping pattern matching to prevent cross-device logic drift`);
      return null;
    }

    // 遍历所有启用的故障模式
    for (const pattern of this.patterns) {
      if (!pattern.enabled) {
        continue;
      }

      // 强制租户和设备匹配
      if (pattern.tenantId && pattern.tenantId !== eventTenantId) continue;
      // 如果模式绑定了设备，必须匹配；如果模式未绑定设备，视为全局规则（仅在设备匹配的前提下使用）
      if (pattern.deviceId && pattern.deviceId !== eventDeviceId) continue;

      // 检查是否匹配指标条件
      if (this.matchesConditions(alertEvent, pattern)) {
        logger.info(
          `Alert event ${alertEvent.id} matched fault pattern: ${pattern.name} (device: ${eventDeviceId})`
        );
        return pattern;
      }
    }

    return null;
  }

  // ==================== 故障修复执行 ====================

  /**
   * 获取 AI 故障诊断确认（占位实现，后续集成 AIAnalyzer）
   */
  private async getAIConfirmation(
    pattern: FaultPattern,
    alertEvent: AlertEvent
  ): Promise<{ confirmed: boolean; confidence: number; reasoning: string }> {
    // TODO: 集成 AIAnalyzer 服务进行故障诊断确认
    // 目前返回基础确认
    return {
      confirmed: true,
      confidence: 0.85,
      reasoning: `告警事件 "${alertEvent.message}" 与故障模式 "${pattern.name}" 的条件匹配。建议执行修复脚本。`,
    };
  }

  /**
   * 获取 AI 故障诊断确认（带超时控制）
   * Requirements: 4.4 - 根因分析执行时间超过 rootCauseAnalysisTimeoutSeconds 时终止分析并返回超时错误
   * 
   * 使用 Promise.race 将根因分析调用与超时 Promise 竞争，
   * 如果分析在配置的超时时间内未完成，返回超时错误结果。
   */
  private async getAIConfirmationWithTimeout(
    pattern: FaultPattern,
    alertEvent: AlertEvent
  ): Promise<{ confirmed: boolean; confidence: number; reasoning: string }> {
    let timeoutSeconds = 60; // 默认 60 秒
    try {
      if (isCapabilityEnabled('selfHealing')) {
        const config = getCapabilityConfig('selfHealing');
        if (config.rootCauseAnalysisTimeoutSeconds && config.rootCauseAnalysisTimeoutSeconds > 0) {
          timeoutSeconds = config.rootCauseAnalysisTimeoutSeconds;
        }
      }
    } catch (error) {
      logger.warn('Failed to read rootCauseAnalysisTimeoutSeconds config, using default:', error);
    }

    const timeoutMs = timeoutSeconds * 1000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Root cause analysis timed out after ${timeoutSeconds}s`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.getAIConfirmation(pattern, alertEvent),
        timeoutPromise,
      ]);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('timed out')) {
        logger.error(`Root cause analysis timeout: ${errorMessage}`, {
          patternName: pattern.name,
          alertEventId: alertEvent.id,
          timeoutSeconds,
        });
      }

      return {
        confirmed: false,
        confidence: 0,
        reasoning: `根因分析超时（${timeoutSeconds}秒）: ${errorMessage}`,
      };
    }
  }

  /**
   * 通过 DeviceDriver 执行修复脚本
   */
  private async executeScript(script: string, tenantId?: string, deviceId?: string): Promise<{ output: string; error?: string }> {
    if (!tenantId || !deviceId) {
      return { output: '', error: 'Missing tenantId or deviceId for script execution' };
    }

    try {
      const devicePool = await getServiceAsync<DevicePool>(SERVICE_NAMES.DEVICE_POOL);

      // 优先使用 DeviceDriver（插件化设备抽象），回退到连接池直连
      const driver = devicePool.getDeviceDriver(deviceId);
      if (!driver) {
        const client = await devicePool.getConnection(tenantId, deviceId);
        if (!client.isConnected()) {
          return { output: '', error: 'Device client not connected' };
        }
      }

      const lines = script
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      const outputs: string[] = [];
      let lastError: string | undefined;

      for (const line of lines) {
        try {
          // 处理延迟意图: "intent:system/delay seconds=N" 或旧格式 ":delay Ns"
          const delayIntentMatch = line.match(/^intent:system\/delay\s+seconds=(\d+)/);
          const legacyDelayMatch = !delayIntentMatch ? line.match(/^:delay\s+(\d+)s?/) : null;
          if (delayIntentMatch || legacyDelayMatch) {
            const match = delayIntentMatch || legacyDelayMatch;
            const seconds = parseInt(match![1], 10);
            await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
            outputs.push(`Delayed ${seconds} seconds`);
            continue;
          }

          // 解析意图格式命令
          const { apiCommand, params } = this.convertIntentToCommand(line);
          if (!apiCommand) {
            continue;
          }

          // 通过 DeviceDriver 执行（设备无关）
          if (driver) {
            const actionType = apiCommand.replace(/^\//, '');
            const payload: Record<string, unknown> = {};
            for (const p of params) {
              const clean = p.replace(/^[=?]/, '');
              const eqIdx = clean.indexOf('=');
              if (eqIdx > 0) {
                payload[clean.substring(0, eqIdx)] = clean.substring(eqIdx + 1);
              }
            }
            const result = await driver.execute(actionType, payload);
            if (result.data !== null && result.data !== undefined) {
              outputs.push(JSON.stringify(result.data, null, 2));
            }
            outputs.push(`Executed: ${line}`);
          } else {
            // 回退: 通过连接池直连执行
            const client = await devicePool.getConnection(tenantId, deviceId);
            const response = await client.executeRaw(apiCommand, params);
            if (response !== null && response !== undefined) {
              if (Array.isArray(response) && response.length > 0) {
                outputs.push(JSON.stringify(response, null, 2));
              } else if (typeof response === 'object') {
                outputs.push(JSON.stringify(response, null, 2));
              }
            }
            outputs.push(`Executed: ${line}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          lastError = `命令 "${line}" 执行失败: ${errorMessage}`;
          outputs.push(lastError);
          logger.warn(`Script line failed: ${line}`, error);
        }
      }

      return {
        output: outputs.join('\n') || '脚本执行完成',
        error: lastError,
      };
    } catch (error) {
      return { output: '', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 通过 DeviceDriver 执行修复脚本（带超时保护）
   * Requirements: 2.1, 2.2
   * 使用 Promise.race 添加超时保护，防止脚本执行卡住导致系统阻塞
   */
  private async executeScriptWithTimeout(
    script: string,
    tenantId?: string,
    deviceId?: string,
    timeoutMs?: number
  ): Promise<{ output: string; error?: string }> {
    const timeout = timeoutMs ?? this.config.scriptTimeoutMs ?? 30000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Script execution timeout after ${timeout}ms`));
      }, timeout);
    });

    try {
      const result = await Promise.race([
        this.executeScript(script, tenantId, deviceId),
        timeoutPromise,
      ]);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 记录超时日志 (Requirements: 2.4)
      if (errorMessage.includes('timeout')) {
        logger.error(`Script execution timeout: ${errorMessage}`, {
          scriptPreview: script.substring(0, 200),
          timeoutMs: timeout,
        });

        // 发送超时告警通知 (Requirements: 2.4)
        this.sendScriptTimeoutNotification(script, timeout).catch(err => {
          logger.warn('Failed to send script timeout notification:', err);
        });
      }

      return {
        output: '',
        error: errorMessage,
      };
    }
  }

  /**
   * 发送脚本执行超时通知 (Requirements: 2.4)
   */
  private async sendScriptTimeoutNotification(script: string, timeoutMs: number): Promise<void> {
    try {
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels
        .filter((c) => c.enabled)
        .map((c) => c.id);

      if (enabledChannelIds.length === 0) {
        return;
      }

      await notificationService.send(enabledChannelIds, {
        type: 'alert',
        title: '⚠️ 脚本执行超时',
        body: `设备脚本执行超时（${timeoutMs}ms）。\n\n` +
          `脚本预览:\n\`\`\`\n${script.substring(0, 500)}${script.length > 500 ? '\n...' : ''}\n\`\`\`\n\n` +
          `建议检查设备连接状态和脚本内容。`,
        data: {
          type: 'script_timeout',
          timeoutMs,
          scriptPreview: script.substring(0, 200),
        },
      });
    } catch (error) {
      logger.warn('Failed to send script timeout notification:', error);
    }
  }

  /**
   * 执行验证脚本
   */
  private async executeVerification(
    pattern: FaultPattern,
    alertEvent: AlertEvent,
    tenantId?: string,
    deviceId?: string
  ): Promise<{ passed: boolean; message: string; details?: string }> {
    if (!pattern.verificationScript) {
      return { passed: true, message: '无验证脚本，假定修复成功' };
    }

    try {
      const result = await this.executeScript(pattern.verificationScript, tenantId, deviceId);

      // 简单验证：如果脚本执行没有错误，认为验证通过
      // 实际应用中应该解析输出并检查具体状态
      if (!result.error) {
        return { passed: true, message: `验证通过: ${result.output}` };
      } else {
        return {
          passed: false,
          message: `验证失败: ${result.error}`,
          details: result.output
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        message: `验证脚本执行失败: ${errorMessage}`,
        details: this.generateManualFixSuggestion(pattern, errorMessage)
      };
    }
  }

  /**
   * 生成手动修复建议 (Requirements: 4.2)
   */
  private generateManualFixSuggestion(pattern: FaultPattern, error: string): string {
    const suggestions: string[] = [
      `故障模式: ${pattern.name}`,
      `错误信息: ${error}`,
      '',
      '建议的手动修复步骤:',
      '1. 检查设备连接状态',
      '2. 验证修复脚本语法是否正确',
      '3. 手动执行以下修复脚本:',
      '```',
      pattern.remediationScript,
      '```',
    ];

    if (pattern.rollbackScript) {
      suggestions.push(
        '',
        '如需回滚，可执行以下脚本:',
        '```',
        pattern.rollbackScript,
        '```'
      );
    }

    if (pattern.verificationScript) {
      suggestions.push(
        '',
        '验证修复结果:',
        '```',
        pattern.verificationScript,
        '```'
      );
    }

    return suggestions.join('\n');
  }

  /**
   * 验证回滚脚本有效性 (Requirements: 4.5)
   */
  private async validateRollbackScript(pattern: FaultPattern): Promise<{ valid: boolean; message: string }> {
    if (!pattern.rollbackScript) {
      return { valid: false, message: '未配置回滚脚本' };
    }

    // 检查脚本是否为空或只有注释
    const lines = pattern.rollbackScript
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    if (lines.length === 0) {
      return { valid: false, message: '回滚脚本为空或只包含注释' };
    }

    // 基本格式检查：每行应为意图格式 (intent:xxx) 或路径格式 (/xxx)
    for (const line of lines) {
      // 允许意图格式: "intent:category/operation params"
      if (line.includes(':') && !line.startsWith('/')) {
        const colonIdx = line.indexOf(':');
        const prefix = line.substring(0, colonIdx);
        if (!/^[a-z_]+$/i.test(prefix)) {
          return { valid: false, message: `回滚脚本包含无法识别的命令格式: ${line}` };
        }
        continue;
      }
      // 允许路径格式: "/category/operation params"
      if (line.startsWith('/')) {
        continue;
      }
      // 不识别的格式
      return { valid: false, message: `回滚脚本包含无法识别的命令格式: ${line}` };
    }

    return { valid: true, message: '回滚脚本验证通过' };
  }

  /**
   * 执行回滚脚本 (Requirements: 4.1)
   */
  private async executeRollback(pattern: FaultPattern, tenantId?: string, deviceId?: string): Promise<RollbackResult> {
    const startTime = Date.now();

    if (!pattern.rollbackScript) {
      return {
        success: false,
        error: '未配置回滚脚本',
        duration: Date.now() - startTime,
      };
    }

    if (!tenantId || !deviceId) {
      return {
        success: false,
        error: 'Missing tenantId or deviceId for rollback',
        duration: Date.now() - startTime,
      };
    }

    try {
      // 检查设备连接
      const devicePool = await getServiceAsync<DevicePool>(SERVICE_NAMES.DEVICE_POOL);
      const client = await devicePool.getConnection(tenantId, deviceId);
      if (!client.isConnected()) {
        return {
          success: false,
          error: '设备未连接，无法执行回滚',
          duration: Date.now() - startTime,
        };
      }

      const result = await this.executeScript(pattern.rollbackScript, tenantId, deviceId);

      return {
        success: !result.error,
        output: result.output,
        error: result.error,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 延迟函数（用于重试间隔）
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 执行故障修复（带重试和回滚机制）
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
   */
  async executeRemediation(
    patternId: string,
    alertEventId: string,
    tenantId?: string,
    deviceId?: string
  ): Promise<RemediationExecution> {
    await this.initialize();

    const pattern = await this.getPatternById(patternId);
    if (!pattern) {
      throw new Error(`Fault pattern not found: ${patternId}`);
    }

    const now = Date.now();

    // 创建修复执行记录
    const remediation: RemediationExecution = {
      id: uuidv4(),
      patternId,
      patternName: pattern.name,
      alertEventId,
      tenantId,
      deviceId,
      status: 'pending',
      retryCount: 0,
      startedAt: now,
    };

    // 检查安全模式 (Requirements: 4.4, 4.6)
    if (this.safeMode) {
      remediation.status = 'skipped';
      remediation.completedAt = Date.now();
      remediation.executionResult = {
        output: '',
        error: `系统处于安全模式，自动修复已禁用。原因: ${this.safeModeReason}`,
      };
      await this.saveRemediation(remediation);

      logger.warn(
        `Remediation skipped (safe mode): ${pattern.name} for alert ${alertEventId}`
      );
      return remediation;
    }

    // 检查自动修复是否启用
    if (!pattern.autoHeal) {
      // 自动修复被禁用，跳过执行
      remediation.status = 'skipped';
      remediation.completedAt = Date.now();
      await this.saveRemediation(remediation);

      // 发送修复建议通知（Requirements 7.12）
      await this.sendRemediationSuggestionNotification(pattern, alertEventId);

      logger.info(
        `Remediation skipped (auto-heal disabled): ${pattern.name} for alert ${alertEventId}`
      );
      return remediation;
    }

    // 获取 AI 确认（Requirements 7.5）
    try {
      // 创建一个模拟的 AlertEvent 用于 AI 确认
      // Requirements: 8.1 - 包含 metricLabel 字段
      const mockAlertEvent: AlertEvent = {
        id: alertEventId,
        ruleId: '',
        ruleName: '',
        severity: 'warning',
        metric: pattern.conditions[0]?.metric || 'cpu',
        metricLabel: pattern.conditions[0]?.metricLabel,  // 从故障模式条件复制指标标签
        currentValue: pattern.conditions[0]?.threshold || 0,
        threshold: pattern.conditions[0]?.threshold || 0,
        message: `故障模式匹配: ${pattern.name}`,
        status: 'active',
        triggeredAt: now,
      };

      const aiConfirmation = await this.getAIConfirmationWithTimeout(pattern, mockAlertEvent);
      remediation.aiConfirmation = aiConfirmation;

      if (!aiConfirmation.confirmed) {
        // AI 不确认故障诊断，跳过修复
        remediation.status = 'skipped';
        remediation.completedAt = Date.now();
        await this.saveRemediation(remediation);

        logger.info(
          `Remediation skipped (AI not confirmed): ${pattern.name} for alert ${alertEventId}`
        );
        return remediation;
      }
    } catch (error) {
      logger.warn('Failed to get AI confirmation, proceeding with remediation:', error);
    }

    // 验证回滚脚本有效性 (Requirements: 4.5)
    if (this.config.enableAutoRollback && pattern.rollbackScript) {
      const rollbackValidation = await this.validateRollbackScript(pattern);
      if (!rollbackValidation.valid) {
        logger.warn(`Rollback script validation failed: ${rollbackValidation.message}`);
        // 继续执行，但记录警告
      }
    }

    // 更新状态为执行中
    remediation.status = 'executing';
    await this.saveRemediation(remediation);

    // 创建修复前配置快照（Requirements 7.7）
    try {
      const preSnapshot = await configSnapshotService.createSnapshot('pre-remediation', tenantId, deviceId);
      remediation.preSnapshotId = preSnapshot.id;
      await this.saveRemediation(remediation);
      logger.info(`Created pre-remediation snapshot: ${preSnapshot.id}`);
    } catch (error) {
      logger.error('Failed to create pre-remediation snapshot, aborting remediation:', error);
      remediation.status = 'failed';
      remediation.completedAt = Date.now();
      remediation.executionResult = {
        output: '',
        error: '无法创建修复前配置快照，中止修复以防止不可回滚的变更',
      };
      await this.saveRemediation(remediation);
      return remediation;
    }

    // 记录执行意图到审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      details: {
        trigger: `fault_pattern:${pattern.name}`,
        script: pattern.remediationScript,
        metadata: {
          remediationId: remediation.id,
          patternId,
          alertEventId,
          preSnapshotId: remediation.preSnapshotId,
        },
      },
    });

    // 执行修复脚本（带重试机制）(Requirements: 4.3)
    let lastError: string | undefined;
    let executionSuccess = false;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      remediation.retryCount = attempt;

      if (attempt > 0) {
        // 指数退避重试
        const delayMs = this.config.retryDelayMs * Math.pow(2, attempt - 1);
        logger.info(`Retry attempt ${attempt}/${this.config.maxRetries} after ${delayMs}ms delay`);
        await this.delay(delayMs);
      }

      try {
        // 检查设备连接
        // Note: Connection check is now implicit in executeScript (via DevicePool)
        if (!tenantId || !deviceId) {
          throw new Error('TenantId and DeviceId required for remediation');
        }

        // 使用带超时保护的脚本执行 (Requirements: 2.1, 2.2, 2.3)
        const result = await this.executeScriptWithTimeout(pattern.remediationScript, tenantId, deviceId);
        remediation.executionResult = result;

        if (result.error) {
          lastError = result.error;
          logger.warn(`Remediation attempt ${attempt + 1} failed: ${result.error}`);
          continue;
        }

        // 执行验证脚本（带重试）(Requirements 7.8)
        let verificationPassed = false;
        for (let verifyAttempt = 0; verifyAttempt < this.config.verificationRetries; verifyAttempt++) {
          if (verifyAttempt > 0) {
            await this.delay(2000); // 验证重试间隔 2 秒
          }

          const verification = await this.executeVerification(pattern, {
            id: alertEventId,
            ruleId: '',
            ruleName: '',
            severity: 'warning',
            metric: pattern.conditions[0]?.metric || 'cpu',
            currentValue: 0,
            threshold: 0,
            message: '',
            status: 'active',
            triggeredAt: now,
          }, tenantId, deviceId);
          remediation.verificationResult = verification;

          if (verification.passed) {
            verificationPassed = true;
            break;
          }

          logger.warn(`Verification attempt ${verifyAttempt + 1} failed: ${verification.message}`);
        }

        if (verificationPassed) {
          executionSuccess = true;
          break;
        } else {
          lastError = remediation.verificationResult?.message || '验证失败';
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logger.warn(`Remediation attempt ${attempt + 1} exception: ${lastError}`);
      }
    }

    // 处理执行结果
    if (executionSuccess) {
      remediation.status = 'success';
      remediation.completedAt = Date.now();
      await this.saveRemediation(remediation);

      // 发送修复成功通知（Requirements 7.9）
      await this.sendRemediationSuccessNotification(remediation, pattern);

      // 记录执行结果到审计日志
      await auditLogger.log({
        action: 'remediation_execute',
        actor: 'system',
        details: {
          trigger: `fault_pattern:${pattern.name}`,
          result: 'success',
          metadata: {
            remediationId: remediation.id,
            patternId,
            alertEventId,
            output: remediation.executionResult?.output,
            retryCount: remediation.retryCount,
          },
        },
      });

      logger.info(
        `Remediation success: ${pattern.name} for alert ${alertEventId} (retries: ${remediation.retryCount})`
      );
      return remediation;
    }

    // 执行失败，尝试回滚 (Requirements: 4.1)
    if (this.config.enableAutoRollback && pattern.rollbackScript) {
      logger.info(`Attempting rollback for failed remediation: ${remediation.id}`);

      const rollbackResult = await this.executeRollback(pattern, tenantId, deviceId);
      remediation.rollbackResult = rollbackResult;

      if (rollbackResult.success) {
        remediation.status = 'rolled_back';
        logger.info(`Rollback successful for remediation: ${remediation.id}`);

        // 记录回滚成功到审计日志
        await auditLogger.log({
          action: 'remediation_execute',
          actor: 'system',
          details: {
            trigger: `fault_pattern:${pattern.name}`,
            result: 'rolled_back',
            metadata: {
              remediationId: remediation.id,
              patternId,
              alertEventId,
              rollbackOutput: rollbackResult.output,
              rollbackDuration: rollbackResult.duration,
            },
          },
        });
      } else {
        // 回滚失败，进入安全模式 (Requirements: 4.6)
        remediation.status = 'failed';
        const safeModeReason = `回滚失败: ${rollbackResult.error}`;
        this.enterSafeMode(safeModeReason);

        logger.error(`Rollback failed, entering safe mode: ${rollbackResult.error}`);

        // 发送紧急通知 (Requirements: 4.4)
        await this.sendEmergencyNotification(remediation, pattern, safeModeReason);

        // 记录回滚失败到审计日志
        await auditLogger.log({
          action: 'remediation_execute',
          actor: 'system',
          details: {
            trigger: `fault_pattern:${pattern.name}`,
            result: 'rollback_failed',
            error: rollbackResult.error,
            metadata: {
              remediationId: remediation.id,
              patternId,
              alertEventId,
              safeModeActivated: true,
            },
          },
        });
      }
    } else {
      remediation.status = 'failed';
    }

    remediation.executionResult = {
      output: remediation.executionResult?.output || '',
      error: lastError,
    };
    remediation.completedAt = Date.now();
    await this.saveRemediation(remediation);

    // 发送修复失败通知（Requirements 7.10）
    await this.sendRemediationFailureNotification(remediation, pattern);

    // 记录执行失败到审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      details: {
        trigger: `fault_pattern:${pattern.name}`,
        result: 'failed',
        error: lastError,
        metadata: {
          remediationId: remediation.id,
          patternId,
          alertEventId,
          retryCount: remediation.retryCount,
          rollbackAttempted: !!remediation.rollbackResult,
          rollbackSuccess: remediation.rollbackResult?.success,
        },
      },
    });

    logger.error(`Remediation failed: ${pattern.name} for alert ${alertEventId}`, lastError);
    return remediation;
  }

  // ==================== 安全模式管理 (Requirements: 4.4, 4.6, 3.1-3.6) ====================

  /**
   * 检查是否处于安全模式
   */
  isInSafeMode(): boolean {
    return this.safeMode;
  }

  /**
   * 进入安全模式
   * Requirements: 3.1, 3.5
   */
  enterSafeMode(reason: string): void {
    this.safeMode = true;
    this.safeModeReason = reason;
    this.safeModeActivatedAt = Date.now();

    // 启动自动恢复检查定时器 (Requirements: 3.1)
    this.startSafeModeRecoveryTimer();

    logger.warn(`FaultHealer entered safe mode: ${reason}`);

    // 记录审计日志 (Requirements: 3.6)
    auditLogger.log({
      action: 'config_restore',
      actor: 'system',
      details: {
        trigger: 'safe_mode_enter',
        metadata: { reason, activatedAt: this.safeModeActivatedAt },
      },
    }).catch(err => logger.warn('Failed to log safe mode entry:', err));
  }

  /**
   * 启动安全模式自动恢复检查定时器
   * Requirements: 3.1, 3.2
   */
  private startSafeModeRecoveryTimer(): void {
    // 清除已有的定时器
    if (this.safeModeRecoveryTimer) {
      clearInterval(this.safeModeRecoveryTimer);
    }

    this.safeModeRecoveryTimer = setInterval(async () => {
      await this.checkSafeModeRecovery();
    }, this.safeModeConfig.autoRecoveryIntervalMs);

    logger.info(`Safe mode recovery timer started (interval: ${this.safeModeConfig.autoRecoveryIntervalMs}ms)`);
  }

  /**
   * 检查安全模式恢复条件
   * Requirements: 3.2, 3.3, 3.5
   */
  private async checkSafeModeRecovery(): Promise<void> {
    if (!this.safeMode || !this.safeModeActivatedAt) return;

    const duration = Date.now() - this.safeModeActivatedAt;

    // 检查是否超过最大持续时间 (Requirements: 3.5)
    if (duration >= this.safeModeConfig.maxSafeModeDurationMs) {
      await this.exitSafeModeWithReason('Maximum safe mode duration exceeded');
      return;
    }

    // 执行恢复检查（检查设备连接状态）(Requirements: 3.3)
    try {
      // 简单检查连接池是否有任何活动连接
      const devicePool = await getServiceAsync<DevicePool>(SERVICE_NAMES.DEVICE_POOL);
      const stats = devicePool.getPoolStats();
      if (stats.connected > 0) {
        await this.exitSafeModeWithReason('Device connection(s) restored');
      }
    } catch (error) {
      logger.debug('Safe mode recovery check failed:', error);
    }
  }

  /**
   * 退出安全模式（带原因）
   * Requirements: 3.3, 3.4, 3.6
   */
  private async exitSafeModeWithReason(reason: string): Promise<void> {
    const duration = this.safeModeActivatedAt ? Date.now() - this.safeModeActivatedAt : 0;

    this.safeMode = false;
    this.safeModeReason = '';
    this.safeModeActivatedAt = undefined;

    // 清除恢复检查定时器
    if (this.safeModeRecoveryTimer) {
      clearInterval(this.safeModeRecoveryTimer);
      this.safeModeRecoveryTimer = null;
    }

    // 记录审计日志 (Requirements: 3.6)
    await auditLogger.log({
      action: 'config_restore',
      actor: 'system',
      details: {
        trigger: 'safe_mode_exit',
        metadata: { reason, duration },
      },
    });

    logger.info(`FaultHealer exited safe mode: ${reason} (was active for ${duration}ms)`);
  }

  /**
   * 退出安全模式（手动调用）
   */
  exitSafeMode(): void {
    const duration = this.safeModeActivatedAt ? Date.now() - this.safeModeActivatedAt : 0;
    logger.info(`FaultHealer exiting safe mode (was active for ${duration}ms)`);

    this.safeMode = false;
    this.safeModeReason = '';
    this.safeModeActivatedAt = undefined;

    // 清除恢复检查定时器
    if (this.safeModeRecoveryTimer) {
      clearInterval(this.safeModeRecoveryTimer);
      this.safeModeRecoveryTimer = null;
    }
  }

  /**
   * 获取安全模式状态
   */
  getSafeModeStatus(): { active: boolean; reason: string; activatedAt?: number } {
    return {
      active: this.safeMode,
      reason: this.safeModeReason,
      activatedAt: this.safeModeActivatedAt,
    };
  }

  /**
   * 更新安全模式配置
   * Requirements: 3.4, 3.5
   */
  updateSafeModeConfig(config: Partial<SafeModeConfig>): void {
    this.safeModeConfig = { ...this.safeModeConfig, ...config };
    logger.info('Safe mode config updated:', this.safeModeConfig);
  }

  /**
   * 发送紧急通知 (Requirements: 4.4)
   */
  private async sendEmergencyNotification(
    remediation: RemediationExecution,
    pattern: FaultPattern,
    reason: string
  ): Promise<void> {
    try {
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels
        .filter((c) => c.enabled)
        .map((c) => c.id);

      if (enabledChannelIds.length === 0) {
        logger.debug('No enabled notification channels for emergency notification');
        return;
      }

      await notificationService.send(enabledChannelIds, {
        type: 'alert',
        title: `🚨 紧急: 系统进入安全模式 - ${pattern.name}`,
        body: `故障修复和回滚均失败，系统已进入安全模式。\n\n` +
          `修复 ID: ${remediation.id}\n` +
          `故障模式: ${pattern.name}\n` +
          `告警事件 ID: ${remediation.alertEventId}\n` +
          `原因: ${reason}\n\n` +
          `⚠️ 自动修复已被禁用，请立即人工介入！\n\n` +
          `建议操作:\n` +
          `1. 检查系统状态\n` +
          `2. 手动执行修复或回滚\n` +
          `3. 确认系统正常后退出安全模式`,
        data: {
          remediationId: remediation.id,
          patternId: pattern.id,
          patternName: pattern.name,
          alertEventId: remediation.alertEventId,
          status: 'emergency',
          safeModeActivated: true,
          reason,
          preSnapshotId: remediation.preSnapshotId,
        },
      });

      logger.info(`Emergency notification sent for: ${pattern.name}`);
    } catch (error) {
      logger.error('Failed to send emergency notification:', error);
    }
  }

  /**
   * 更新修复执行配置
   */
  updateConfig(config: Partial<RemediationExecutionConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('FaultHealer config updated:', this.config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): RemediationExecutionConfig {
    return { ...this.config };
  }


  // ==================== 通知发送 ====================

  /**
   * 发送修复成功通知（Requirements 7.9）
   */
  private async sendRemediationSuccessNotification(
    remediation: RemediationExecution,
    pattern: FaultPattern
  ): Promise<void> {
    try {
      // 获取所有启用的通知渠道
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels
        .filter((c) => c.enabled)
        .map((c) => c.id);

      if (enabledChannelIds.length === 0) {
        logger.debug('No enabled notification channels for remediation success');
        return;
      }

      await notificationService.send(enabledChannelIds, {
        type: 'remediation',
        title: `✅ 故障修复成功 - ${pattern.name}`,
        body: `故障模式 "${pattern.name}" 的修复脚本已成功执行。\n\n` +
          `修复 ID: ${remediation.id}\n` +
          `告警事件 ID: ${remediation.alertEventId}\n` +
          (remediation.verificationResult
            ? `验证结果: ${remediation.verificationResult.message}`
            : ''),
        data: {
          remediationId: remediation.id,
          patternId: pattern.id,
          patternName: pattern.name,
          alertEventId: remediation.alertEventId,
          status: 'success',
          preSnapshotId: remediation.preSnapshotId,
        },
      });

      logger.info(`Remediation success notification sent for: ${pattern.name}`);
    } catch (error) {
      logger.error('Failed to send remediation success notification:', error);
    }
  }

  /**
   * 发送修复失败通知（Requirements 7.10, 4.2）
   */
  private async sendRemediationFailureNotification(
    remediation: RemediationExecution,
    pattern: FaultPattern
  ): Promise<void> {
    try {
      // 获取所有启用的通知渠道
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels
        .filter((c) => c.enabled)
        .map((c) => c.id);

      if (enabledChannelIds.length === 0) {
        logger.debug('No enabled notification channels for remediation failure');
        return;
      }

      const errorMessage = remediation.executionResult?.error || '未知错误';
      const verificationMessage = remediation.verificationResult?.message || '';
      const retryInfo = remediation.retryCount !== undefined && remediation.retryCount > 0
        ? `重试次数: ${remediation.retryCount}\n`
        : '';
      const rollbackInfo = remediation.rollbackResult
        ? `回滚状态: ${remediation.rollbackResult.success ? '成功' : '失败'}\n` +
        (remediation.rollbackResult.error ? `回滚错误: ${remediation.rollbackResult.error}\n` : '')
        : '';

      // 生成手动修复建议 (Requirements: 4.2)
      const manualFixSuggestion = this.generateManualFixSuggestion(pattern, errorMessage);

      await notificationService.send(enabledChannelIds, {
        type: 'remediation',
        title: `❌ 故障修复失败 - ${pattern.name}`,
        body: `故障模式 "${pattern.name}" 的修复脚本执行失败，建议人工介入。\n\n` +
          `修复 ID: ${remediation.id}\n` +
          `告警事件 ID: ${remediation.alertEventId}\n` +
          `错误信息: ${errorMessage}\n` +
          retryInfo +
          (verificationMessage ? `验证结果: ${verificationMessage}\n` : '') +
          rollbackInfo +
          (remediation.preSnapshotId
            ? `\n可使用快照 ${remediation.preSnapshotId} 进行回滚。\n`
            : '') +
          `\n--- 手动修复建议 ---\n${manualFixSuggestion}`,
        data: {
          remediationId: remediation.id,
          patternId: pattern.id,
          patternName: pattern.name,
          alertEventId: remediation.alertEventId,
          status: remediation.status,
          error: errorMessage,
          retryCount: remediation.retryCount,
          rollbackResult: remediation.rollbackResult,
          preSnapshotId: remediation.preSnapshotId,
          manualFixSuggestion,
        },
      });

      logger.info(`Remediation failure notification sent for: ${pattern.name}`);
    } catch (error) {
      logger.error('Failed to send remediation failure notification:', error);
    }
  }

  /**
   * 发送修复建议通知（当自动修复被禁用时）（Requirements 7.12）
   */
  private async sendRemediationSuggestionNotification(
    pattern: FaultPattern,
    alertEventId: string
  ): Promise<void> {
    try {
      // 获取所有启用的通知渠道
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels
        .filter((c) => c.enabled)
        .map((c) => c.id);

      if (enabledChannelIds.length === 0) {
        logger.debug('No enabled notification channels for remediation suggestion');
        return;
      }

      await notificationService.send(enabledChannelIds, {
        type: 'alert',
        title: `🔧 故障修复建议 - ${pattern.name}`,
        body: `检测到与故障模式 "${pattern.name}" 匹配的告警。\n\n` +
          `告警事件 ID: ${alertEventId}\n` +
          `故障描述: ${pattern.description}\n\n` +
          `自动修复已禁用，建议手动执行以下修复脚本:\n\n` +
          `\`\`\`\n${pattern.remediationScript}\n\`\`\`\n\n` +
          `如需启用自动修复，请在故障模式管理中开启。`,
        data: {
          patternId: pattern.id,
          patternName: pattern.name,
          alertEventId,
          autoHealDisabled: true,
          remediationScript: pattern.remediationScript,
        },
      });

      logger.info(`Remediation suggestion notification sent for: ${pattern.name}`);
    } catch (error) {
      logger.error('Failed to send remediation suggestion notification:', error);
    }
  }

  // ==================== 修复历史 ====================

  /**
   * 获取修复执行历史
   */
  async getRemediationHistory(limit?: number, deviceId?: string): Promise<RemediationExecution[]> {
    await this.initialize();

    // 获取最近 30 天的日期
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const dates = this.getDateRange(thirtyDaysAgo, now);

    let allRemediations: RemediationExecution[] = [];

    for (const dateStr of dates) {
      const remediations = await this.readRemediationsFile(dateStr);
      allRemediations = allRemediations.concat(remediations);
    }

    // Filter by deviceId if provided
    if (deviceId) {
      allRemediations = allRemediations.filter(r => r.deviceId === deviceId);
    }

    // 按时间降序排序
    allRemediations.sort((a, b) => b.startedAt - a.startedAt);

    // 应用限制
    if (limit && limit > 0) {
      allRemediations = allRemediations.slice(0, limit);
    }

    return allRemediations;
  }

  /**
   * 根据 ID 获取修复执行记录
   */
  async getRemediationById(id: string): Promise<RemediationExecution | null> {
    await this.initialize();

    // 搜索最近 30 天的记录
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const dates = this.getDateRange(thirtyDaysAgo, now);

    for (const dateStr of dates) {
      const remediations = await this.readRemediationsFile(dateStr);
      const found = remediations.find((r) => r.id === id);
      if (found) {
        return found;
      }
    }

    return null;
  }

  /**
   * 获取日期范围内的所有日期字符串
   */
  private getDateRange(from: number, to: number): string[] {
    const dates: string[] = [];
    const current = new Date(from);
    current.setHours(0, 0, 0, 0);
    const endDate = new Date(to);
    endDate.setHours(23, 59, 59, 999);

    while (current <= endDate) {
      dates.push(getDateString(current.getTime()));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  // ==================== 周期性健康检查 (Requirements: 4.3) ====================

  /**
   * 启动周期性健康检查定时器
   * 按指定间隔调用系统健康检查，检测异常时生成告警事件并触发 handleAlertEvent
   * 
   * Requirements: 4.3 - faultDetectionIntervalSeconds 配置指定检测间隔
   */
  startPeriodicDetection(intervalSeconds: number): void {
    // 先停止已有的定时器
    this.stopPeriodicDetection();

    if (intervalSeconds <= 0) {
      logger.warn(`Invalid detection interval: ${intervalSeconds}s, skipping periodic detection`);
      return;
    }

    this.detectionTimer = setInterval(async () => {
      try {
        // 动态导入 healthMonitor 避免循环依赖
        const { healthMonitor } = await import('./healthMonitor');

        // 收集健康指标
        const metrics = await healthMonitor.collectMetrics();
        const score = healthMonitor.calculateScore(metrics);

        // 检测异常：当健康评分等级为 critical 或 warning 时生成告警
        if (score.level === 'critical' || score.level === 'warning') {
          const severity = score.level === 'critical' ? 'critical' : 'warning';

          // 根据具体异常指标生成告警事件
          const alertEvents: AlertEvent[] = [];

          // 检查 CPU 使用率
          if (metrics.cpuUsage > 90) {
            alertEvents.push({
              id: uuidv4(),
              ruleId: 'periodic-detection-cpu',
              ruleName: 'Periodic CPU Detection',
              severity,
              metric: 'cpu',
              currentValue: metrics.cpuUsage,
              threshold: 90,
              message: `CPU 使用率异常: ${metrics.cpuUsage}%`,
              status: 'active',
              triggeredAt: Date.now(),
            });
          }

          // 检查内存使用率
          if (metrics.memoryUsage > 90) {
            alertEvents.push({
              id: uuidv4(),
              ruleId: 'periodic-detection-memory',
              ruleName: 'Periodic Memory Detection',
              severity,
              metric: 'memory',
              currentValue: metrics.memoryUsage,
              threshold: 90,
              message: `内存使用率异常: ${metrics.memoryUsage}%`,
              status: 'active',
              triggeredAt: Date.now(),
            });
          }

          // 检查磁盘使用率
          if (metrics.diskUsage > 90) {
            alertEvents.push({
              id: uuidv4(),
              ruleId: 'periodic-detection-disk',
              ruleName: 'Periodic Disk Detection',
              severity,
              metric: 'disk',
              currentValue: metrics.diskUsage,
              threshold: 90,
              message: `磁盘使用率异常: ${metrics.diskUsage}%`,
              status: 'active',
              triggeredAt: Date.now(),
            });
          }

          // 如果没有具体指标超标但整体评分异常，生成通用告警
          if (alertEvents.length === 0) {
            alertEvents.push({
              id: uuidv4(),
              ruleId: 'periodic-detection-health',
              ruleName: 'Periodic Health Detection',
              severity,
              metric: 'cpu',
              currentValue: 100 - score.overall,
              threshold: 50,
              message: `系统健康评分异常: ${score.overall}/100 (${score.level})`,
              status: 'active',
              triggeredAt: Date.now(),
            });
          }

          // 对每个告警事件触发自愈处理
          for (const alertEvent of alertEvents) {
            try {
              await this.handleAlertEvent(alertEvent);
            } catch (error) {
              logger.error(`Failed to handle periodic detection alert: ${alertEvent.id}`, error);
            }
          }
        }

        logger.debug(`Periodic health detection completed: score=${score.overall}, level=${score.level}`);
      } catch (error) {
        logger.error('Periodic health detection failed:', error);
      }
    }, intervalSeconds * 1000);

    logger.info(`Periodic fault detection started (interval: ${intervalSeconds}s)`);
  }

  /**
   * 停止周期性健康检查定时器
   * 
   * Requirements: 4.3, 4.5
   */
  stopPeriodicDetection(): void {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
      logger.info('Periodic fault detection stopped');
    }
  }

  /**
   * 关闭服务，清理资源
   * 清理 safeModeRecoveryTimer、detectionTimer 等定时器，防止内存泄漏
   */
  shutdown(): void {
    // 停止周期性健康检查定时器
    this.stopPeriodicDetection();

    // 清理安全模式恢复定时器
    if (this.safeModeRecoveryTimer) {
      clearInterval(this.safeModeRecoveryTimer);
      this.safeModeRecoveryTimer = null;
      logger.debug('Safe mode recovery timer cleared');
    }

    // 重置状态
    this.safeMode = false;
    this.safeModeReason = '';
    this.safeModeActivatedAt = undefined;
    this.initialized = false;

    logger.info('FaultHealer shutdown complete');
  }

  /**
   * 获取故障模式的修复统计
   */
  async getPatternRemediationStats(
    patternId: string,
    from: number,
    to: number
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    skipped: number;
  }> {
    const dates = this.getDateRange(from, to);
    let allRemediations: RemediationExecution[] = [];

    for (const dateStr of dates) {
      const remediations = await this.readRemediationsFile(dateStr);
      allRemediations = allRemediations.concat(remediations);
    }

    // 过滤指定模式的记录
    const patternRemediations = allRemediations.filter(
      (r) => r.patternId === patternId && r.startedAt >= from && r.startedAt <= to
    );

    return {
      total: patternRemediations.length,
      success: patternRemediations.filter((r) => r.status === 'success').length,
      failed: patternRemediations.filter((r) => r.status === 'failed').length,
      skipped: patternRemediations.filter((r) => r.status === 'skipped').length,
    };
  }

  /**
   * 处理告警事件并尝试自动修复
   * 这是一个便捷方法，用于从告警引擎调用
   * 
   * 根据 Evolution_Config 的 selfHealing 配置决定修复行为：
   * - 能力未启用或 autoHealingLevel='disabled': 记录日志并返回 null
   * - 'notify' (manual): 仅发送修复建议通知，不执行修复
   * - 'low_risk' (semi-auto): 仅对低风险告警（info/warning）自动执行修复
   * - 'full' (full-auto): 对所有匹配模式自动执行修复
   * 
   * Requirements: 4.1, 4.2
   */
  async handleAlertEvent(alertEvent: AlertEvent): Promise<RemediationExecution | null> {
    // 检查 selfHealing 能力是否启用
    if (!isCapabilityEnabled('selfHealing')) {
      logger.debug('Self-healing disabled, skipping alert handling');
      return null;
    }

    const config = getCapabilityConfig('selfHealing');

    // autoHealingLevel 为 disabled 时等同于能力未启用
    if (config.autoHealingLevel === 'disabled') {
      logger.debug('Self-healing autoHealingLevel is disabled, skipping alert handling');
      return null;
    }

    await this.initialize();

    // 匹配故障模式
    const pattern = await this.matchPattern(alertEvent);
    if (!pattern) {
      logger.debug(`No fault pattern matched for alert: ${alertEvent.id}`);
      return null;
    }

    // 根据 autoHealingLevel 决定修复行为
    switch (config.autoHealingLevel) {
      case 'notify':
        // manual 级别：仅记录建议，不执行修复
        logger.info(
          `Self-healing level 'notify': sending suggestion for pattern "${pattern.name}" (alert: ${alertEvent.id})`
        );
        await this.sendRemediationSuggestionNotification(pattern, alertEvent.id);
        return null;

      case 'low_risk':
        // semi-auto 级别：仅对低风险告警自动执行修复
        if (alertEvent.severity === 'info' || alertEvent.severity === 'warning') {
          logger.info(
            `Self-healing level 'low_risk': auto-executing remediation for low-risk alert "${pattern.name}" (severity: ${alertEvent.severity})`
          );
          return this.executeRemediation(pattern.id, alertEvent.id, alertEvent.tenantId, alertEvent.deviceId);
        }
        // 高风险告警仅发送建议
        logger.info(
          `Self-healing level 'low_risk': severity "${alertEvent.severity}" too high, sending suggestion for pattern "${pattern.name}"`
        );
        await this.sendRemediationSuggestionNotification(pattern, alertEvent.id);
        return null;

      case 'full':
        // full-auto 级别：对所有匹配模式自动执行修复
        logger.info(
          `Self-healing level 'full': auto-executing remediation for pattern "${pattern.name}" (alert: ${alertEvent.id})`
        );
        return this.executeRemediation(pattern.id, alertEvent.id, alertEvent.tenantId, alertEvent.deviceId);

      default:
        logger.warn(`Unknown autoHealingLevel: ${config.autoHealingLevel}, skipping alert handling`);
        return null;
    }
  }
}

// 导出单例实例
export const faultHealer = new FaultHealer();
