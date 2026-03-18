/**
 * SkillRegistry - Skill 注册表
 * 
 * 管理所有已注册的 Skill
 * 
 * Requirements: 4.1-4.8
 * - 4.1: 提供 register 方法添加 Skill
 * - 4.2: 提供 get 方法获取 Skill
 * - 4.3: 提供 list 方法列出所有 Skill
 * - 4.4: 提供 unregister 方法移除 Skill
 * - 4.5: 内置 Skill 不可注销
 * - 4.6: 维护默认 'generalist' Skill
 * - 4.7: 重复注册时更新现有 Skill
 * - 4.8: 独立跟踪 Skill 启用状态
 */

import { logger } from '../../../utils/logger';
import { Skill } from '../../../types/skill';

/**
 * Skill 过滤选项
 */
export interface SkillFilterOptions {
  /** 是否内置 */
  builtin?: boolean;
  /** 是否启用 */
  enabled?: boolean;
  /** 标签过滤 */
  tags?: string[];
}

/**
 * SkillRegistry 类
 * 管理所有已注册的 Skill
 */
export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private enabledStatus: Map<string, boolean> = new Map();

  constructor() {
    logger.info('SkillRegistry created');
  }

  /**
   * 注册 Skill
   * Requirements: 4.1, 4.7
   */
  register(skill: Skill): void {
    const name = skill.metadata.name;

    if (this.skills.has(name)) {
      logger.info('Updating existing Skill', { name });
    } else {
      logger.info('Registering new Skill', { name, isBuiltin: skill.isBuiltin });
    }

    this.skills.set(name, skill);

    // 保持启用状态（如果已存在）
    if (!this.enabledStatus.has(name)) {
      this.enabledStatus.set(name, skill.enabled);
    }

    logger.debug('Skill registered', {
      name,
      isBuiltin: skill.isBuiltin,
      triggers: skill.metadata.triggers?.length || 0,
      allowedTools: skill.config.allowedTools.length,
    });
  }

  /**
   * 获取 Skill
   * Requirements: 4.2
   */
  get(name: string): Skill | undefined {
    const skill = this.skills.get(name);
    if (skill) {
      // 返回带有当前启用状态的 Skill
      return {
        ...skill,
        enabled: this.enabledStatus.get(name) ?? true,
      };
    }
    return undefined;
  }

  /**
   * 检查 Skill 是否存在
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 列出所有 Skill
   * Requirements: 4.3
   */
  list(filter?: SkillFilterOptions): Skill[] {
    let skills = Array.from(this.skills.values());

    // 应用过滤条件
    if (filter?.builtin !== undefined) {
      skills = skills.filter(s => s.isBuiltin === filter.builtin);
    }

    if (filter?.enabled !== undefined) {
      skills = skills.filter(s => 
        (this.enabledStatus.get(s.metadata.name) ?? true) === filter.enabled
      );
    }

    if (filter?.tags && filter.tags.length > 0) {
      skills = skills.filter(s => 
        s.metadata.tags?.some(tag => filter.tags!.includes(tag))
      );
    }

    // 返回带有当前启用状态的 Skill 列表
    return skills.map(s => ({
      ...s,
      enabled: this.enabledStatus.get(s.metadata.name) ?? true,
    }));
  }

  /**
   * 注销 Skill
   * Requirements: 4.4, 4.5
   */
  unregister(name: string): boolean {
    const skill = this.skills.get(name);

    if (!skill) {
      logger.warn('Skill not found for unregister', { name });
      return false;
    }

    // Requirement 4.5: 内置 Skill 不可注销
    if (skill.isBuiltin) {
      logger.error('Cannot unregister builtin Skill', { name });
      throw new Error(`Cannot unregister builtin Skill: ${name}`);
    }

    this.skills.delete(name);
    this.enabledStatus.delete(name);

    logger.info('Skill unregistered', { name });
    return true;
  }

  /**
   * 切换 Skill 启用状态
   * Requirements: 4.8
   */
  toggle(name: string, enabled: boolean): boolean {
    if (!this.skills.has(name)) {
      logger.warn('Skill not found for toggle', { name });
      return false;
    }

    this.enabledStatus.set(name, enabled);
    logger.info('Skill toggled', { name, enabled });
    return true;
  }

  /**
   * 检查 Skill 是否启用
   */
  isEnabled(name: string): boolean {
    return this.enabledStatus.get(name) ?? true;
  }

  /**
   * 获取所有 Skill 名称
   */
  getNames(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * 获取 Skill 数量
   */
  size(): number {
    return this.skills.size;
  }

  /**
   * 检查 generalist Skill 是否存在
   * Requirements: 4.6
   */
  hasGeneralist(): boolean {
    return this.skills.has('generalist');
  }

  /**
   * 获取 generalist Skill
   * Requirements: 4.6
   */
  getGeneralist(): Skill | undefined {
    return this.get('generalist');
  }

  /**
   * 清空所有 Skill（仅用于测试）
   */
  clear(): void {
    this.skills.clear();
    this.enabledStatus.clear();
    logger.info('SkillRegistry cleared');
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    builtin: number;
    custom: number;
    enabled: number;
    disabled: number;
  } {
    const skills = Array.from(this.skills.values());
    const builtinCount = skills.filter(s => s.isBuiltin).length;
    const enabledCount = skills.filter(s => this.enabledStatus.get(s.metadata.name) ?? true).length;

    return {
      total: skills.length,
      builtin: builtinCount,
      custom: skills.length - builtinCount,
      enabled: enabledCount,
      disabled: skills.length - enabledCount,
    };
  }
}

// 导出单例实例
export const skillRegistry = new SkillRegistry();
