/**
 * FeatureFlagManager - 特性开关管理器
 *
 * 双层 Flag 体系：
 * 1. Flow Flags（原有）：按流程粒度控制状态机编排 vs 原有逻辑
 *    - isEnabled(flowId) / setEnabled(flowId, enabled) / route() / runComparison()
 * 2. Control Point Flags（新增）：按模块粒度控制新旧实现切换
 *    - isControlPointEnabled(key) / setControlPointEnabled(key, enabled)
 *    - 支持依赖关系校验、PostgreSQL 持久化
 *
 * 需求: 9.3, 9.4, 9.5, I5.14
 */

import { logger } from '../../../utils/logger';
import type { DataStore } from '../../dataStore';

// ============================================================
// Types
// ============================================================

export type FlowId = 'react-orchestration' | 'alert-orchestration' | 'iteration-orchestration';

export interface FeatureFlagConfig {
  /** 各流程是否启用状态机编排 */
  flags: Record<FlowId, boolean>;
  /** 对比模式配置 */
  comparisonMode: {
    enabled: boolean;
    enabledFor: string[];
    logLevel: 'debug' | 'info' | 'warn';
  };
}

export interface ComparisonResult<T = unknown> {
  flowId: string;
  stateMachineResult?: T;
  legacyResult?: T;
  stateMachineError?: string;
  legacyError?: string;
  hasDifferences: boolean;
  differences?: string[];
  timestamp: number;
}

/** 控制点 Flag 键名 */
export type ControlPointKey =
  | 'use_pg_datastore'
  | 'use_python_core'
  | 'use_event_bus'
  | 'use_brain_loop_engine'
  | 'use_device_driver'
  | 'use_skill_capsule'
  | 'use_alert_pipeline'
  | 'use_vector_search_tools'
  | 'use_syslog_manager'
  | 'use_snmp_trap_receiver';

export interface ControlPointDefinition {
  key: ControlPointKey;
  description: string;
  dependencies: ControlPointKey[];
}

export interface ControlPointState {
  key: ControlPointKey;
  enabled: boolean;
  description: string;
  dependencies: ControlPointKey[];
}

export interface DependencyError {
  flag: string;
  missingDependencies?: string[];
  dependentFlags?: string[];
  message: string;
}

// ============================================================
// Control Point Registry (I5.14)
// ============================================================

export const CONTROL_POINT_DEFINITIONS: readonly ControlPointDefinition[] = [
  { key: 'use_pg_datastore', description: '切换 PostgreSQL / SQLite', dependencies: [] },
  { key: 'use_python_core', description: '切换 Python Core / 本地处理', dependencies: ['use_pg_datastore'] },
  { key: 'use_event_bus', description: '切换 EventBus / setInterval', dependencies: ['use_pg_datastore'] },
  { key: 'use_brain_loop_engine', description: '切换 BrainLoopEngine / AutonomousBrainService', dependencies: ['use_pg_datastore', 'use_event_bus'] },
  { key: 'use_device_driver', description: '切换 DeviceDriver / routerosClient', dependencies: ['use_pg_datastore'] },
  { key: 'use_skill_capsule', description: '切换 SkillCapsule / 旧 SkillLoader', dependencies: ['use_pg_datastore'] },
  { key: 'use_alert_pipeline', description: '切换新 AlertPipeline / 旧流程', dependencies: ['use_pg_datastore', 'use_event_bus'] },
  { key: 'use_vector_search_tools', description: '切换向量检索 / 硬编码映射', dependencies: ['use_pg_datastore', 'use_python_core'] },
  { key: 'use_syslog_manager', description: '切换 SyslogManager / 旧 syslogReceiver', dependencies: ['use_pg_datastore', 'use_event_bus'] },
  { key: 'use_snmp_trap_receiver', description: '启用/禁用 SNMP Trap 接收', dependencies: ['use_pg_datastore', 'use_event_bus'] },
];

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: FeatureFlagConfig = {
  flags: {
    'react-orchestration': false,
    'alert-orchestration': false,
    'iteration-orchestration': false,
  },
  comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
};

const KNOWN_FLOW_IDS: Set<string> = new Set([
  'react-orchestration',
  'alert-orchestration',
  'iteration-orchestration',
]);

const KNOWN_CONTROL_POINTS: Set<string> = new Set(
  CONTROL_POINT_DEFINITIONS.map((d) => d.key),
);

// ============================================================
// Implementation
// ============================================================

export class FeatureFlagManager {
  private config: FeatureFlagConfig;
  private comparisonLog: ComparisonResult[] = [];
  private controlPoints: Map<ControlPointKey, boolean> = new Map();
  private dataStore: DataStore | null = null;

  constructor(config?: FeatureFlagConfig) {
    this.config = config ? this.deepClone(config) : this.deepClone(DEFAULT_CONFIG);
    // Initialize all control points to OFF
    for (const def of CONTROL_POINT_DEFINITIONS) {
      this.controlPoints.set(def.key, false);
    }
  }

  // ============================================================
  // DataStore integration
  // ============================================================

  /**
   * Set the DataStore for PostgreSQL persistence.
   * Call loadFromStore() after this to hydrate state.
   */
  setDataStore(store: DataStore): void {
    this.dataStore = store;
  }

  /**
   * Load control point flags from PostgreSQL.
   * If the table has no rows yet, seeds it with defaults (all OFF).
   */
  async loadFromStore(): Promise<void> {
    if (!this.dataStore) return;
    try {
      const rows = await this.dataStore.query<{
        flag_key: string;
        enabled: boolean;
      }>('SELECT flag_key, enabled FROM feature_flags');

      if (rows.length === 0) {
        await this.seedControlPoints();
        return;
      }
      for (const row of rows) {
        if (KNOWN_CONTROL_POINTS.has(row.flag_key)) {
          this.controlPoints.set(row.flag_key as ControlPointKey, row.enabled);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[FeatureFlagManager] loadFromStore failed: ${msg}`);
    }
  }

  /**
   * Seed all control point definitions into PostgreSQL (all OFF).
   */
  private async seedControlPoints(): Promise<void> {
    if (!this.dataStore) return;
    for (const def of CONTROL_POINT_DEFINITIONS) {
      await this.dataStore.execute(
        `INSERT INTO feature_flags (flag_key, enabled, description, dependencies)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (flag_key) DO NOTHING`,
        [def.key, false, def.description, JSON.stringify(def.dependencies)],
      );
      this.controlPoints.set(def.key, false);
    }
  }

  /**
   * Persist a single control point flag to PostgreSQL.
   */
  private async persistFlag(key: ControlPointKey, enabled: boolean): Promise<void> {
    if (!this.dataStore) return;
    try {
      await this.dataStore.execute(
        `UPDATE feature_flags SET enabled = $1, updated_at = NOW() WHERE flag_key = $2`,
        [enabled, key],
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[FeatureFlagManager] persistFlag(${key}) failed: ${msg}`);
    }
  }

  // ============================================================
  // Control Point API (I5.14)
  // ============================================================

  /** Check if a control point flag is enabled. */
  isControlPointEnabled(key: ControlPointKey): boolean {
    return this.controlPoints.get(key) ?? false;
  }

  /**
   * Enable or disable a control point flag with dependency validation.
   * Persists to PostgreSQL if DataStore is configured.
   *
   * When enabling: all dependencies must already be enabled.
   * When disabling: no other enabled flag may depend on this one.
   */
  async setControlPointEnabled(
    key: ControlPointKey,
    enabled: boolean,
  ): Promise<DependencyError | null> {
    if (!KNOWN_CONTROL_POINTS.has(key)) {
      return { flag: key, message: `Unknown control point: ${key}` };
    }

    if (enabled) {
      const error = this.validateEnableDependencies(key);
      if (error) return error;
    } else {
      const error = this.validateDisableDependents(key);
      if (error) return error;
    }

    this.controlPoints.set(key, enabled);
    await this.persistFlag(key, enabled);
    return null;
  }

  /** Get all control point states. */
  getAllControlPoints(): ControlPointState[] {
    return CONTROL_POINT_DEFINITIONS.map((def) => ({
      key: def.key,
      enabled: this.controlPoints.get(def.key) ?? false,
      description: def.description,
      dependencies: [...def.dependencies],
    }));
  }

  /** Validate that all dependencies are enabled before enabling a flag. */
  private validateEnableDependencies(key: ControlPointKey): DependencyError | null {
    const def = CONTROL_POINT_DEFINITIONS.find((d) => d.key === key);
    if (!def) return null;

    const missing = def.dependencies.filter(
      (dep) => !this.controlPoints.get(dep),
    );
    if (missing.length > 0) {
      return {
        flag: key,
        missingDependencies: missing,
        message: `Cannot enable '${key}': dependencies not enabled: ${missing.join(', ')}`,
      };
    }
    return null;
  }

  /** Validate that no enabled flags depend on this one before disabling. */
  private validateDisableDependents(key: ControlPointKey): DependencyError | null {
    const dependents = CONTROL_POINT_DEFINITIONS
      .filter((d) => d.dependencies.includes(key) && this.controlPoints.get(d.key))
      .map((d) => d.key);

    if (dependents.length > 0) {
      return {
        flag: key,
        dependentFlags: dependents,
        message: `Cannot disable '${key}': depended on by enabled flags: ${dependents.join(', ')}`,
      };
    }
    return null;
  }

  // ============================================================
  // Flow Flag API (backward compatible — Req 9.3, 9.4, 9.5)
  // ============================================================

  isEnabled(flowId: string): boolean {
    if (!KNOWN_FLOW_IDS.has(flowId)) return false;
    return this.config.flags[flowId as FlowId] ?? false;
  }

  setEnabled(flowId: FlowId, enabled: boolean): void {
    this.config.flags[flowId] = enabled;
  }

  getConfig(): FeatureFlagConfig {
    return this.deepClone(this.config);
  }

  updateConfig(config: FeatureFlagConfig): void {
    this.config = this.deepClone(config);
  }

  isComparisonModeEnabled(): boolean {
    return this.config.comparisonMode.enabled;
  }

  isComparisonEnabledFor(flowId: string): boolean {
    if (!this.config.comparisonMode.enabled) return false;
    return this.config.comparisonMode.enabledFor.includes(flowId);
  }

  async route<T>(
    flowId: string,
    stateMachineFn: () => Promise<T>,
    legacyFn: () => Promise<T>,
  ): Promise<T> {
    if (this.isComparisonEnabledFor(flowId)) {
      const comparison = await this.runComparison(flowId, stateMachineFn, legacyFn);
      if (comparison.legacyError) throw new Error(comparison.legacyError);
      return comparison.legacyResult as T;
    }
    if (this.isEnabled(flowId)) return stateMachineFn();
    return legacyFn();
  }

  async runComparison<T>(
    flowId: string,
    stateMachineFn: () => Promise<T>,
    legacyFn: () => Promise<T>,
  ): Promise<ComparisonResult<T>> {
    const result: ComparisonResult<T> = {
      flowId,
      hasDifferences: false,
      timestamp: Date.now(),
    };

    const [smSettled, legacySettled] = await Promise.allSettled([
      stateMachineFn(),
      legacyFn(),
    ]);

    if (smSettled.status === 'fulfilled') {
      result.stateMachineResult = smSettled.value;
    } else {
      result.stateMachineError = smSettled.reason instanceof Error
        ? smSettled.reason.message : String(smSettled.reason);
    }

    if (legacySettled.status === 'fulfilled') {
      result.legacyResult = legacySettled.value;
    } else {
      result.legacyError = legacySettled.reason instanceof Error
        ? legacySettled.reason.message : String(legacySettled.reason);
    }

    if (result.stateMachineError || result.legacyError) {
      result.hasDifferences = true;
      result.differences = [];
      if (result.stateMachineError) result.differences.push(`State machine error: ${result.stateMachineError}`);
      if (result.legacyError) result.differences.push(`Legacy error: ${result.legacyError}`);
    } else {
      const diffs = this.findDifferences(result.stateMachineResult, result.legacyResult);
      if (diffs.length > 0) { result.hasDifferences = true; result.differences = diffs; }
    }

    if (result.hasDifferences) this.logComparison(flowId, result);
    this.comparisonLog.push(result as ComparisonResult);
    return result;
  }

  getComparisonLog(): ComparisonResult[] {
    return [...this.comparisonLog];
  }

  clearComparisonLog(): void {
    this.comparisonLog = [];
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private findDifferences(a: unknown, b: unknown, path = ''): string[] {
    const diffs: string[] = [];
    if (a === b) return diffs;
    if (typeof a !== typeof b) {
      diffs.push(`${path || 'root'}: type mismatch (${typeof a} vs ${typeof b})`);
      return diffs;
    }
    if (a === null || b === null) {
      if (a !== b) diffs.push(`${path || 'root'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
      return diffs;
    }
    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
      for (const key of allKeys) {
        const subPath = path ? `${path}.${key}` : key;
        if (!(key in aObj)) diffs.push(`${subPath}: missing in state machine result`);
        else if (!(key in bObj)) diffs.push(`${subPath}: missing in legacy result`);
        else diffs.push(...this.findDifferences(aObj[key], bObj[key], subPath));
      }
      return diffs;
    }
    if (a !== b) diffs.push(`${path || 'root'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return diffs;
  }

  private logComparison(flowId: string, result: ComparisonResult): void {
    const logLevel = this.config.comparisonMode.logLevel;
    const message = `[FeatureFlagManager] Comparison differences for flow '${flowId}': ${JSON.stringify(result.differences)}`;
    try {
      switch (logLevel) {
        case 'debug': logger.debug(message); break;
        case 'warn': logger.warn(message); break;
        case 'info': default: logger.info(message); break;
      }
    } catch {
      // Logger may not be available in test environments
    }
  }

  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }
}
