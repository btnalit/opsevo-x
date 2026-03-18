/**
 * SkillLoader - Skill 文件系统加载器
 * 
 * 负责从文件系统扫描和加载 Skill 目录
 * 
 * Requirements: 3.1-3.9
 * - 3.1: 扫描 data/ai-ops/skills 目录
 * - 3.2: 通过 SKILL.md 文件识别有效 Skill 目录
 * - 3.3: 解析 YAML frontmatter 提取元数据
 * - 3.4: 加载 config.json，不存在时使用默认配置
 * - 3.5: 格式错误时记录日志并跳过
 * - 3.6: 支持嵌套目录结构
 * - 3.7-3.9: 文件监视和热重载
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { spawn, ChildProcess } from 'child_process';
import { FSWatcher, watch } from 'chokidar';
import { logger } from '../../../utils/logger';
import {
  Skill,
  SkillMetadata,
  SkillConfig,
  SkillSuggestion,
  DEFAULT_SKILL_CONFIG,
} from '../../../types/skill';
import {
  SkillCapsule,
  LoadedSkillCapsule,
  SkillCapsuleExecutionResult,
  validateSkillCapsule,
  parseSkillCapsule,
} from '../../../types/skillCapsule';

/**
 * SkillLoader 配置
 */
export interface SkillLoaderConfig {
  /** Skills 目录路径 */
  skillsDir: string;
  /** 是否启用文件监视 */
  enableWatch: boolean;
  /** 监视深度 */
  watchDepth: number;
  /** Skill Capsule 热加载扫描周期（毫秒），默认 30000 (Requirements: E1.4) */
  capsuleScanIntervalMs: number;
  /** Python 可执行文件路径，默认 'python3' (Requirements: E1.5) */
  pythonExecutable: string;
  /** Skill Capsule 执行超时（毫秒），默认 30000 */
  capsuleExecutionTimeoutMs: number;
}

/**
 * 默认配置
 */
const DEFAULT_LOADER_CONFIG: SkillLoaderConfig = {
  skillsDir: 'data/ai-ops/skills',
  enableWatch: true,
  watchDepth: 3,
  capsuleScanIntervalMs: 30000,
  pythonExecutable: process.env.PYTHON_EXECUTABLE || 'python3',
  capsuleExecutionTimeoutMs: 30000,
};

/**
 * SkillLoader 类
 * 负责从文件系统扫描和加载 Skill
 */
export class SkillLoader {
  private config: SkillLoaderConfig;
  private watcher: FSWatcher | null = null;
  private onChangeCallback: ((skill: Skill) => void) | null = null;
  private onRemoveCallback: ((skillName: string) => void) | null = null;

  /** Loaded Skill Capsules (Requirements: E1.3) */
  private capsules: Map<string, LoadedSkillCapsule> = new Map();
  /** Capsule scan timer for hot reload (Requirements: E1.4) */
  private capsuleScanTimer: NodeJS.Timeout | null = null;
  /** Capsule change callback */
  private onCapsuleChangeCallback: ((capsule: LoadedSkillCapsule) => void) | null = null;
  /** Capsule remove callback */
  private onCapsuleRemoveCallback: ((capsuleId: string) => void) | null = null;
  /** File modification timestamps for capsule hot reload detection */
  private capsuleFileTimestamps: Map<string, number> = new Map();

  constructor(config?: Partial<SkillLoaderConfig>) {
    this.config = { ...DEFAULT_LOADER_CONFIG, ...config };
    logger.info('SkillLoader created', { config: this.config });
  }

  /**
   * 扫描并加载所有 Skill
   * Requirements: 3.1, 3.6
   */
  async loadAll(): Promise<Skill[]> {
    const skills: Skill[] = [];

    // 记录详细的路径信息，方便调试
    logger.info('SkillLoader.loadAll starting', { 
      skillsDir: this.config.skillsDir,
      cwd: process.cwd(),
      absolutePath: path.resolve(this.config.skillsDir),
    });

    // 扫描 builtin 目录
    const builtinDir = path.join(this.config.skillsDir, 'builtin');
    logger.info('Checking builtin directory', { 
      builtinDir,
      absolutePath: path.resolve(builtinDir),
    });
    
    if (await this.dirExists(builtinDir)) {
      logger.info('Builtin directory exists, scanning...');
      const builtinSkills = await this.scanDirectory(builtinDir, true);
      skills.push(...builtinSkills);
      logger.info('Loaded builtin skills', { count: builtinSkills.length, names: builtinSkills.map(s => s.metadata.name) });
    } else {
      logger.error('Builtin directory does NOT exist!', { builtinDir });
    }

    // 扫描 custom 目录
    const customDir = path.join(this.config.skillsDir, 'custom');
    if (await this.dirExists(customDir)) {
      const customSkills = await this.scanDirectory(customDir, false);
      skills.push(...customSkills);
      logger.info('Loaded custom skills', { count: customSkills.length });
    }

    logger.info('All skills loaded', { totalCount: skills.length });
    return skills;
  }

  /**
   * 扫描目录中的 Skill
   * Requirements: 3.2, 3.6
   */
  private async scanDirectory(dir: string, isBuiltin: boolean): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(dir, entry.name);
          const skill = await this.loadSkill(skillPath, isBuiltin);
          if (skill) {
            skills.push(skill);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to scan directory', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return skills;
  }

  /**
   * 加载单个 Skill
   * Requirements: 3.2, 3.3, 3.4, 3.5
   */
  async loadSkill(skillPath: string, isBuiltin: boolean): Promise<Skill | null> {
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    // 检查 SKILL.md 是否存在
    if (!(await this.fileExists(skillMdPath))) {
      logger.debug('Skill directory missing SKILL.md', { skillPath });
      return null;
    }

    try {
      // 读取 SKILL.md
      const content = await fs.readFile(skillMdPath, 'utf-8');
      const { metadata, body } = this.parseSkillMd(content);

      // 读取 config.json（可选）
      const config = await this.loadConfig(skillPath);

      // 获取文件列表
      const files = await this.listFiles(skillPath);

      // 获取文件状态
      const stat = await fs.stat(skillMdPath);

      const skill: Skill = {
        metadata,
        config,
        content: body,
        path: skillPath,
        files,
        isBuiltin,
        enabled: true,
        loadedAt: new Date(),
        modifiedAt: stat.mtime,
      };

      logger.info('Skill loaded', {
        name: metadata.name,
        isBuiltin,
        triggers: metadata.triggers?.length || 0,
      });

      return skill;
    } catch (error) {
      // Requirement 3.5: 格式错误时记录日志并跳过
      logger.error('Failed to load Skill', {
        skillPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 解析 SKILL.md 文件
   * Requirements: 3.3
   */
  parseSkillMd(content: string): { metadata: SkillMetadata; body: string } {
    // 匹配 YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

    if (!frontmatterMatch) {
      throw new Error('Invalid SKILL.md format: missing frontmatter');
    }

    const frontmatterStr = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();

    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = yaml.parse(frontmatterStr);
    } catch (parseError) {
      throw new Error(`Invalid YAML frontmatter: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }

    // 验证必需字段
    if (!frontmatter.name || typeof frontmatter.name !== 'string') {
      throw new Error('Invalid SKILL.md: missing required field "name"');
    }
    if (!frontmatter.description || typeof frontmatter.description !== 'string') {
      throw new Error('Invalid SKILL.md: missing required field "description"');
    }

    const metadata: SkillMetadata = {
      name: frontmatter.name,
      description: frontmatter.description,
      version: typeof frontmatter.version === 'string' ? frontmatter.version : undefined,
      author: typeof frontmatter.author === 'string' ? frontmatter.author : undefined,
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((t): t is string => typeof t === 'string') : undefined,
      triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers.filter((t): t is string => typeof t === 'string') : undefined,
      suggestedSkills: this.parseSuggestedSkills(frontmatter.suggestedSkills),
    };

    return { metadata, body };
  }

  /**
   * 解析 suggestedSkills 字段
   * Requirements: 18.6
   */
  private parseSuggestedSkills(suggestedSkills: unknown): SkillSuggestion[] | undefined {
    if (!Array.isArray(suggestedSkills)) {
      return undefined;
    }

    return suggestedSkills
      .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
      .map((s) => ({
        skillName: typeof s.skillName === 'string' ? s.skillName : '',
        condition: typeof s.condition === 'string' ? s.condition : '',
        triggers: Array.isArray(s.triggers) 
          ? s.triggers.filter((t): t is string => typeof t === 'string') 
          : undefined,
        autoSwitch: typeof s.autoSwitch === 'boolean' ? s.autoSwitch : false,
        priority: typeof s.priority === 'number' ? s.priority : 100,
      }))
      .filter((s) => s.skillName && s.condition); // 过滤无效的建议
  }

  /**
   * 加载 config.json
   * Requirements: 3.4
   */
  private async loadConfig(skillPath: string): Promise<SkillConfig> {
    const configPath = path.join(skillPath, 'config.json');

    if (!(await this.fileExists(configPath))) {
      return { ...DEFAULT_SKILL_CONFIG };
    }

    try {
      const configContent = await fs.readFile(configPath, 'utf-8');
      const parsedConfig = JSON.parse(configContent);

      // 合并默认配置
      return this.mergeConfig(DEFAULT_SKILL_CONFIG, parsedConfig);
    } catch (error) {
      logger.warn('Failed to load config.json, using defaults', {
        skillPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...DEFAULT_SKILL_CONFIG };
    }
  }

  /**
   * 合并配置
   */
  private mergeConfig(defaults: SkillConfig, overrides: Partial<SkillConfig>): SkillConfig {
    return {
      allowedTools: overrides.allowedTools ?? defaults.allowedTools,
      toolPriority: overrides.toolPriority ?? defaults.toolPriority,
      toolDefaults: { ...defaults.toolDefaults, ...overrides.toolDefaults },
      toolConstraints: { ...defaults.toolConstraints, ...overrides.toolConstraints },
      caps: { ...defaults.caps, ...overrides.caps },
      knowledgeConfig: { ...defaults.knowledgeConfig, ...overrides.knowledgeConfig },
      outputFormat: overrides.outputFormat ?? defaults.outputFormat,
      requireCitations: overrides.requireCitations ?? defaults.requireCitations,
      extends: overrides.extends,
    };
  }

  /**
   * 列出 Skill 目录中的文件
   */
  private async listFiles(skillPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(skillPath, { withFileTypes: true });
      return entries
        .filter(e => e.isFile())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * 检查目录是否存在
   */
  private async dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch (error) {
      // 记录详细错误信息，方便调试
      logger.debug('Directory check failed', {
        dirPath,
        absolutePath: path.resolve(dirPath),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 启动文件监视
   * Requirements: 3.7, 3.8, 3.9
   */
  startWatching(
    onChange: (skill: Skill) => void,
    onRemove?: (skillName: string) => void
  ): void {
    if (!this.config.enableWatch) {
      logger.info('File watching disabled');
      return;
    }

    // 如果已有 watcher，先关闭防止泄漏
    if (this.watcher) {
      logger.warn('Already watching, closing previous watcher');
      void this.watcher.close();
      this.watcher = null;
    }

    this.onChangeCallback = onChange;
    this.onRemoveCallback = onRemove || null;

    this.watcher = watch(this.config.skillsDir, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      depth: this.config.watchDepth,
      ignoreInitial: true,
    });

    // 文件变更事件
    this.watcher.on('change', async (filePath) => {
      await this.handleFileChange(filePath);
    });

    // 文件添加事件
    this.watcher.on('add', async (filePath) => {
      if (filePath.endsWith('SKILL.md') || filePath.endsWith('capsule.json')) {
        await this.handleFileChange(filePath);
      }
    });

    // 文件删除事件
    this.watcher.on('unlink', async (filePath) => {
      if (filePath.endsWith('SKILL.md') && this.onRemoveCallback) {
        const skillPath = path.dirname(filePath);
        const skillName = path.basename(skillPath);
        this.onRemoveCallback(skillName);
        logger.info('Skill removed', { skillName });
      }

      // Handle capsule.json deletion
      if (filePath.endsWith('capsule.json') && this.onCapsuleRemoveCallback) {
        const capsulePath = path.dirname(filePath);
        // Find and remove the capsule by path
        for (const [id, loaded] of this.capsules) {
          if (loaded.path === capsulePath) {
            this.capsules.delete(id);
            this.capsuleFileTimestamps.delete(capsulePath);
            this.onCapsuleRemoveCallback(id);
            logger.info('Capsule removed via watcher', { id, name: loaded.capsule.name });
            break;
          }
        }
      }
    });

    logger.info('File watching started', { skillsDir: this.config.skillsDir });
  }

  /**
   * 处理文件变更
   */
  private async handleFileChange(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);

    // Handle capsule.json changes via chokidar as well (immediate detection)
    if (fileName === 'capsule.json') {
      await this.handleCapsuleFileChange(filePath);
      return;
    }

    if (!this.onChangeCallback) return;

    // 只处理 SKILL.md 和 config.json 的变更
    if (fileName !== 'SKILL.md' && fileName !== 'config.json') {
      return;
    }

    const skillPath = path.dirname(filePath);
    const isBuiltin = skillPath.includes(path.join('skills', 'builtin'));

    try {
      const skill = await this.loadSkill(skillPath, isBuiltin);
      if (skill) {
        this.onChangeCallback(skill);
        logger.info('Skill hot-reloaded', { name: skill.metadata.name });
      }
    } catch (error) {
      logger.error('Failed to hot-reload skill', {
        skillPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 处理 capsule.json 文件变更（通过 chokidar 即时检测）
   */
  private async handleCapsuleFileChange(filePath: string): Promise<void> {
    if (!this.onCapsuleChangeCallback) return;

    const capsulePath = path.dirname(filePath);
    const isBuiltin = capsulePath.includes(path.join('skills', 'builtin'));

    try {
      const capsule = await this.loadCapsule(capsulePath, isBuiltin);
      if (capsule) {
        // 保留旧版本的 enabled 状态
        const existing = this.capsules.get(capsule.capsule.id);
        if (existing) {
          capsule.enabled = existing.enabled;
        }

        this.capsules.set(capsule.capsule.id, capsule);
        this.onCapsuleChangeCallback(capsule);
        logger.info('Capsule hot-reloaded via watcher', {
          id: capsule.capsule.id,
          name: capsule.capsule.name,
        });
      }
    } catch (error) {
      logger.error('Failed to hot-reload capsule', {
        capsulePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 停止文件监视
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.onChangeCallback = null;
      this.onRemoveCallback = null;
      logger.info('File watching stopped');
    }

    // 同时停止 Capsule 热加载
    this.stopCapsuleHotReload();
  }

  /**
   * 获取配置
   */
  getConfig(): SkillLoaderConfig {
    return { ...this.config };
  }

  // ==================== Skill Capsule 支持 (Requirements: E1.1-E1.5) ====================

  /**
   * 扫描并加载所有 Skill Capsule
   * Requirements: E1.3
   * 
   * Skill Capsule 通过目录中的 capsule.json 文件识别（区别于 SKILL.md 格式）
   */
  async loadAllCapsules(): Promise<LoadedSkillCapsule[]> {
    const capsules: LoadedSkillCapsule[] = [];

    logger.info('SkillLoader.loadAllCapsules starting', {
      skillsDir: this.config.skillsDir,
    });

    // 扫描 builtin 目录
    const builtinDir = path.join(this.config.skillsDir, 'builtin');
    if (await this.dirExists(builtinDir)) {
      const builtinCapsules = await this.scanCapsuleDirectory(builtinDir, true);
      capsules.push(...builtinCapsules);
    }

    // 扫描 custom 目录
    const customDir = path.join(this.config.skillsDir, 'custom');
    if (await this.dirExists(customDir)) {
      const customCapsules = await this.scanCapsuleDirectory(customDir, false);
      capsules.push(...customCapsules);
    }

    // 扫描 capsules 专用目录（如果存在）
    const capsulesDir = path.join(this.config.skillsDir, 'capsules');
    if (await this.dirExists(capsulesDir)) {
      const dedicatedCapsules = await this.scanCapsuleDirectory(capsulesDir, false);
      capsules.push(...dedicatedCapsules);
    }

    // 更新内部缓存
    for (const capsule of capsules) {
      this.capsules.set(capsule.capsule.id, capsule);
    }

    logger.info('All Skill Capsules loaded', { totalCount: capsules.length });
    return capsules;
  }

  /**
   * 扫描目录中的 Skill Capsule
   * Requirements: E1.3
   */
  private async scanCapsuleDirectory(dir: string, isBuiltin: boolean): Promise<LoadedSkillCapsule[]> {
    const capsules: LoadedSkillCapsule[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const capsulePath = path.join(dir, entry.name);
          const capsule = await this.loadCapsule(capsulePath, isBuiltin);
          if (capsule) {
            capsules.push(capsule);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to scan capsule directory', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return capsules;
  }

  /**
   * 加载单个 Skill Capsule
   * Requirements: E1.1, E1.2, E1.3
   * 
   * 通过 capsule.json 文件识别 Skill Capsule 目录
   */
  async loadCapsule(capsulePath: string, isBuiltin: boolean): Promise<LoadedSkillCapsule | null> {
    const capsuleJsonPath = path.join(capsulePath, 'capsule.json');

    // 只有包含 capsule.json 的目录才是 Skill Capsule
    if (!(await this.fileExists(capsuleJsonPath))) {
      return null;
    }

    try {
      const content = await fs.readFile(capsuleJsonPath, 'utf-8');
      const rawData = JSON.parse(content);

      // 验证 capsule.json
      const validation = validateSkillCapsule(rawData);
      if (!validation.valid) {
        logger.error('Invalid capsule.json', {
          capsulePath,
          errors: validation.errors,
        });
        return null;
      }

      const capsule = parseSkillCapsule(rawData);

      // 验证 entrypoint 文件存在
      const entrypointPath = path.join(capsulePath, capsule.entrypoint);
      if (!(await this.fileExists(entrypointPath))) {
        logger.error('Capsule entrypoint not found', {
          capsulePath,
          entrypoint: capsule.entrypoint,
        });
        return null;
      }

      const stat = await fs.stat(capsuleJsonPath);

      // 记录文件时间戳用于热加载检测
      this.capsuleFileTimestamps.set(capsulePath, stat.mtimeMs);

      const loaded: LoadedSkillCapsule = {
        capsule,
        path: capsulePath,
        isBuiltin,
        enabled: true,
        loadedAt: new Date(),
        modifiedAt: stat.mtime,
        healthy: true,
      };

      logger.info('Skill Capsule loaded', {
        id: capsule.id,
        name: capsule.name,
        version: capsule.version,
        runtime: capsule.runtime,
        capabilities: capsule.capabilities,
        isBuiltin,
      });

      return loaded;
    } catch (error) {
      logger.error('Failed to load Skill Capsule', {
        capsulePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 获取已加载的 Skill Capsule
   */
  getCapsule(capsuleId: string): LoadedSkillCapsule | undefined {
    return this.capsules.get(capsuleId);
  }

  /**
   * 获取所有已加载的 Skill Capsule
   */
  getAllCapsules(): LoadedSkillCapsule[] {
    return Array.from(this.capsules.values());
  }

  /**
   * 启动 Skill Capsule 热加载扫描
   * Requirements: E1.4 — 默认 30s 扫描周期
   */
  startCapsuleHotReload(
    onChange: (capsule: LoadedSkillCapsule) => void,
    onRemove?: (capsuleId: string) => void
  ): void {
    if (this.capsuleScanTimer) {
      logger.warn('Capsule hot reload already running, stopping previous timer');
      this.stopCapsuleHotReload();
    }

    this.onCapsuleChangeCallback = onChange;
    this.onCapsuleRemoveCallback = onRemove || null;

    const intervalMs = this.config.capsuleScanIntervalMs;

    this.capsuleScanTimer = setInterval(async () => {
      await this.scanForCapsuleChanges();
    }, intervalMs);

    logger.info('Capsule hot reload started', { intervalMs });
  }

  /**
   * 停止 Skill Capsule 热加载扫描
   */
  stopCapsuleHotReload(): void {
    if (this.capsuleScanTimer) {
      clearInterval(this.capsuleScanTimer);
      this.capsuleScanTimer = null;
      this.onCapsuleChangeCallback = null;
      this.onCapsuleRemoveCallback = null;
      logger.info('Capsule hot reload stopped');
    }
  }

  /**
   * 扫描 Capsule 变更（新增、修改、删除）
   * Requirements: E1.4
   */
  private async scanForCapsuleChanges(): Promise<void> {
    const currentPaths = new Set<string>();

    // 收集所有目录中的 capsule 路径
    const dirsToScan = [
      { dir: path.join(this.config.skillsDir, 'builtin'), isBuiltin: true },
      { dir: path.join(this.config.skillsDir, 'custom'), isBuiltin: false },
      { dir: path.join(this.config.skillsDir, 'capsules'), isBuiltin: false },
    ];

    for (const { dir, isBuiltin } of dirsToScan) {
      if (!(await this.dirExists(dir))) continue;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const capsulePath = path.join(dir, entry.name);
          const capsuleJsonPath = path.join(capsulePath, 'capsule.json');

          if (!(await this.fileExists(capsuleJsonPath))) continue;

          currentPaths.add(capsulePath);

          try {
            const stat = await fs.stat(capsuleJsonPath);
            const previousTimestamp = this.capsuleFileTimestamps.get(capsulePath);

            // 新增或修改
            if (previousTimestamp === undefined || stat.mtimeMs > previousTimestamp) {
              const capsule = await this.loadCapsule(capsulePath, isBuiltin);
              if (capsule) {
                // 保留旧版本的 enabled 状态
                const existing = this.capsules.get(capsule.capsule.id);
                if (existing) {
                  capsule.enabled = existing.enabled;
                }

                this.capsules.set(capsule.capsule.id, capsule);

                if (this.onCapsuleChangeCallback) {
                  this.onCapsuleChangeCallback(capsule);
                }

                logger.info('Capsule hot-reloaded', {
                  id: capsule.capsule.id,
                  name: capsule.capsule.name,
                  isNew: previousTimestamp === undefined,
                });
              }
            }
          } catch (error) {
            logger.error('Error checking capsule for changes', {
              capsulePath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        logger.error('Error scanning directory for capsule changes', {
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 检测删除的 capsule
    for (const [id, loaded] of this.capsules) {
      if (!currentPaths.has(loaded.path)) {
        this.capsules.delete(id);
        this.capsuleFileTimestamps.delete(loaded.path);

        if (this.onCapsuleRemoveCallback) {
          this.onCapsuleRemoveCallback(id);
        }

        logger.info('Capsule removed', { id, name: loaded.capsule.name });
      }
    }
  }

  /**
   * 执行 Skill Capsule
   * Requirements: E1.5 — 根据 runtime 分发执行
   */
  async executeCapsule(
    capsuleId: string,
    input: Record<string, unknown>
  ): Promise<SkillCapsuleExecutionResult> {
    const loaded = this.capsules.get(capsuleId);
    if (!loaded) {
      return {
        success: false,
        error: `Capsule not found: ${capsuleId}`,
        durationMs: 0,
      };
    }

    if (!loaded.enabled) {
      return {
        success: false,
        error: `Capsule is disabled: ${loaded.capsule.name}`,
        durationMs: 0,
      };
    }

    const { capsule } = loaded;
    const entrypointPath = path.join(loaded.path, capsule.entrypoint);

    switch (capsule.runtime) {
      case 'node':
        return this.executeNodeCapsule(entrypointPath, input);
      case 'python':
        return this.executePythonCapsule(entrypointPath, input);
      case 'bash':
        return this.executeBashCapsule(entrypointPath, input);
      default:
        return {
          success: false,
          error: `Unsupported runtime: ${capsule.runtime}`,
          durationMs: 0,
        };
    }
  }

  /**
   * 执行 Node.js Skill Capsule
   */
  private async executeNodeCapsule(
    entrypointPath: string,
    input: Record<string, unknown>
  ): Promise<SkillCapsuleExecutionResult> {
    const startTime = Date.now();

    try {
      // Dynamic require for Node.js capsules
      const absolutePath = path.resolve(entrypointPath);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(absolutePath);
      const handler = module.default || module.handler || module.execute;

      if (typeof handler !== 'function') {
        return {
          success: false,
          error: `No handler function found in ${entrypointPath} (expected default, handler, or execute export)`,
          durationMs: Date.now() - startTime,
        };
      }

      const output = await handler(input);
      return {
        success: true,
        output,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 执行 Python Skill Capsule（通过子进程）
   * Requirements: E1.5
   */
  private executePythonCapsule(
    entrypointPath: string,
    input: Record<string, unknown>
  ): Promise<SkillCapsuleExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = this.config.capsuleExecutionTimeoutMs;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc: ChildProcess = spawn(this.config.pythonExecutable, [entrypointPath], {
        cwd: path.dirname(entrypointPath),
        env: {
          ...process.env,
          CAPSULE_INPUT: JSON.stringify(input),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 通过 stdin 传递输入（备用通道）
      if (proc.stdin) {
        proc.stdin.write(JSON.stringify(input));
        proc.stdin.end();
      }

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      // 超时处理
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        // 给进程 5 秒优雅退出，否则强制杀死
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (killed) {
          resolve({
            success: false,
            error: `Python capsule execution timed out after ${timeoutMs}ms`,
            durationMs,
            exitCode: code ?? -1,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            error: stderr || `Python process exited with code ${code}`,
            durationMs,
            exitCode: code ?? -1,
          });
          return;
        }

        // 尝试解析 JSON 输出
        let output: unknown;
        try {
          output = JSON.parse(stdout.trim());
        } catch {
          // 非 JSON 输出也是合法的
          output = stdout.trim();
        }

        resolve({
          success: true,
          output,
          durationMs,
          exitCode: 0,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Failed to spawn Python process: ${error.message}`,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * 执行 Bash Skill Capsule（通过子进程）
   */
  private executeBashCapsule(
    entrypointPath: string,
    input: Record<string, unknown>
  ): Promise<SkillCapsuleExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = this.config.capsuleExecutionTimeoutMs;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc: ChildProcess = spawn('bash', [entrypointPath], {
        cwd: path.dirname(entrypointPath),
        env: {
          ...process.env,
          CAPSULE_INPUT: JSON.stringify(input),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (proc.stdin) {
        proc.stdin.write(JSON.stringify(input));
        proc.stdin.end();
      }

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (killed) {
          resolve({
            success: false,
            error: `Bash capsule execution timed out after ${timeoutMs}ms`,
            durationMs,
            exitCode: code ?? -1,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            success: false,
            error: stderr || `Bash process exited with code ${code}`,
            durationMs,
            exitCode: code ?? -1,
          });
          return;
        }

        let output: unknown;
        try {
          output = JSON.parse(stdout.trim());
        } catch {
          output = stdout.trim();
        }

        resolve({
          success: true,
          output,
          durationMs,
          exitCode: 0,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Failed to spawn Bash process: ${error.message}`,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * 创建新 Skill
   * Requirements: 13.3
   */
  async createSkill(
    name: string,
    options: {
      description: string;
      content?: string;
      config?: Partial<SkillConfig>;
    }
  ): Promise<Skill> {
    const customDir = path.join(this.config.skillsDir, 'custom');
    const skillPath = path.join(customDir, name);

    // 确保 custom 目录存在
    await fs.mkdir(customDir, { recursive: true });

    // 检查是否已存在
    if (await this.dirExists(skillPath)) {
      throw new Error(`Skill directory already exists: ${name}`);
    }

    // 创建 Skill 目录
    await fs.mkdir(skillPath, { recursive: true });

    // 创建 SKILL.md
    const skillMdContent = this.generateSkillMd({
      name,
      description: options.description,
      version: '1.0.0',
      author: 'custom',
      tags: ['custom'],
      triggers: [],
    }, options.content || `# ${name}\n\n${options.description}`);

    await fs.writeFile(path.join(skillPath, 'SKILL.md'), skillMdContent, 'utf-8');

    // 创建 config.json
    const config = { ...DEFAULT_SKILL_CONFIG, ...options.config };
    await fs.writeFile(
      path.join(skillPath, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    );

    // 加载并返回创建的 Skill
    const skill = await this.loadSkill(skillPath, false);
    if (!skill) {
      throw new Error('Failed to load created skill');
    }

    logger.info('Skill created', { name, path: skillPath });
    return skill;
  }

  /**
   * 更新 Skill
   * Requirements: 13.4
   */
  async updateSkill(
    name: string,
    options: {
      description?: string;
      content?: string;
      config?: Partial<SkillConfig>;
    }
  ): Promise<Skill> {
    const customDir = path.join(this.config.skillsDir, 'custom');
    const skillPath = path.join(customDir, name);

    // 检查是否存在
    if (!(await this.dirExists(skillPath))) {
      throw new Error(`Skill not found: ${name}`);
    }

    // 读取现有 SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const existingContent = await fs.readFile(skillMdPath, 'utf-8');
    const { metadata: existingMetadata, body: existingBody } = this.parseSkillMd(existingContent);

    // 更新元数据
    const updatedMetadata: SkillMetadata = {
      ...existingMetadata,
      description: options.description || existingMetadata.description,
    };

    // 更新内容
    const updatedBody = options.content !== undefined ? options.content : existingBody;

    // 写入更新后的 SKILL.md
    const updatedSkillMd = this.generateSkillMd(updatedMetadata, updatedBody);
    await fs.writeFile(skillMdPath, updatedSkillMd, 'utf-8');

    // 更新 config.json（如果提供）
    if (options.config) {
      const configPath = path.join(skillPath, 'config.json');
      let existingConfig = { ...DEFAULT_SKILL_CONFIG };
      
      if (await this.fileExists(configPath)) {
        try {
          const configContent = await fs.readFile(configPath, 'utf-8');
          existingConfig = JSON.parse(configContent);
        } catch {
          // 使用默认配置
        }
      }

      const updatedConfig = this.mergeConfig(existingConfig, options.config);
      await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2), 'utf-8');
    }

    // 重新加载并返回
    const skill = await this.loadSkill(skillPath, false);
    if (!skill) {
      throw new Error('Failed to reload updated skill');
    }

    logger.info('Skill updated', { name });
    return skill;
  }

  /**
   * 删除 Skill
   * Requirements: 13.5
   */
  async deleteSkill(name: string): Promise<void> {
    const customDir = path.join(this.config.skillsDir, 'custom');
    const skillPath = path.join(customDir, name);

    // 检查是否存在
    if (!(await this.dirExists(skillPath))) {
      throw new Error(`Skill not found: ${name}`);
    }

    // 递归删除目录
    await fs.rm(skillPath, { recursive: true, force: true });

    logger.info('Skill deleted', { name, path: skillPath });
  }

  /**
   * 克隆 Skill
   * Requirements: 13.13
   */
  async cloneSkill(sourceName: string, newName: string): Promise<Skill> {
    // 查找源 Skill
    let sourcePath: string | null = null;
    let isSourceBuiltin = false;

    const builtinPath = path.join(this.config.skillsDir, 'builtin', sourceName);
    const customPath = path.join(this.config.skillsDir, 'custom', sourceName);

    if (await this.dirExists(builtinPath)) {
      sourcePath = builtinPath;
      isSourceBuiltin = true;
    } else if (await this.dirExists(customPath)) {
      sourcePath = customPath;
    }

    if (!sourcePath) {
      throw new Error(`Source skill not found: ${sourceName}`);
    }

    // 目标路径（总是在 custom 目录）
    const targetPath = path.join(this.config.skillsDir, 'custom', newName);

    if (await this.dirExists(targetPath)) {
      throw new Error(`Target skill already exists: ${newName}`);
    }

    // 复制目录
    await this.copyDirectory(sourcePath, targetPath);

    // 更新 SKILL.md 中的名称
    const skillMdPath = path.join(targetPath, 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    const { metadata, body } = this.parseSkillMd(content);

    const updatedMetadata: SkillMetadata = {
      ...metadata,
      name: newName,
      author: 'custom',
      tags: [...(metadata.tags || []), 'cloned'],
    };

    const updatedContent = this.generateSkillMd(updatedMetadata, body);
    await fs.writeFile(skillMdPath, updatedContent, 'utf-8');

    // 加载并返回克隆的 Skill
    const skill = await this.loadSkill(targetPath, false);
    if (!skill) {
      throw new Error('Failed to load cloned skill');
    }

    logger.info('Skill cloned', { source: sourceName, target: newName, isSourceBuiltin });
    return skill;
  }

  /**
   * 读取 Skill 文件内容
   * Requirements: 13.17
   * 
   * 安全性：验证文件路径防止路径遍历攻击
   */
  async readSkillFile(skillName: string, filename: string): Promise<string> {
    // 验证 filename 不包含路径遍历字符
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid filename: path traversal not allowed`);
    }

    // 查找 Skill 路径
    let skillPath: string | null = null;

    const builtinPath = path.join(this.config.skillsDir, 'builtin', skillName);
    const customPath = path.join(this.config.skillsDir, 'custom', skillName);

    if (await this.dirExists(builtinPath)) {
      skillPath = builtinPath;
    } else if (await this.dirExists(customPath)) {
      skillPath = customPath;
    }

    if (!skillPath) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    const filePath = path.join(skillPath, filename);
    
    // 额外验证：确保解析后的路径仍在 Skill 目录内
    const resolvedFilePath = path.resolve(filePath);
    const resolvedSkillPath = path.resolve(skillPath);
    if (!resolvedFilePath.startsWith(resolvedSkillPath + path.sep)) {
      throw new Error(`Invalid filename: path traversal not allowed`);
    }

    if (!(await this.fileExists(filePath))) {
      throw new Error(`File not found: ${filename}`);
    }

    return fs.readFile(filePath, 'utf-8');
  }

  /**
   * 写入 Skill 文件内容
   * Requirements: 13.18
   * 
   * 安全性：验证文件路径防止路径遍历攻击
   */
  async writeSkillFile(skillName: string, filename: string, content: string): Promise<void> {
    // 验证 filename 不包含路径遍历字符
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid filename: path traversal not allowed`);
    }

    // 只允许写入 custom 目录中的 Skill
    const customPath = path.join(this.config.skillsDir, 'custom', skillName);

    if (!(await this.dirExists(customPath))) {
      throw new Error(`Custom skill not found: ${skillName}`);
    }

    const filePath = path.join(customPath, filename);
    
    // 额外验证：确保解析后的路径仍在 Skill 目录内
    const resolvedFilePath = path.resolve(filePath);
    const resolvedSkillPath = path.resolve(customPath);
    if (!resolvedFilePath.startsWith(resolvedSkillPath + path.sep)) {
      throw new Error(`Invalid filename: path traversal not allowed`);
    }

    await fs.writeFile(filePath, content, 'utf-8');
    logger.info('Skill file written', { skillName, filename });
  }

  /**
   * 重新加载 Skill
   * Requirements: 3.8
   */
  async reloadSkill(skillName: string): Promise<Skill | null> {
    // 查找 Skill 路径
    let skillPath: string | null = null;
    let isBuiltin = false;

    const builtinPath = path.join(this.config.skillsDir, 'builtin', skillName);
    const customPath = path.join(this.config.skillsDir, 'custom', skillName);

    if (await this.dirExists(builtinPath)) {
      skillPath = builtinPath;
      isBuiltin = true;
    } else if (await this.dirExists(customPath)) {
      skillPath = customPath;
    }

    if (!skillPath) {
      logger.warn('Skill not found for reload', { skillName });
      return null;
    }

    const skill = await this.loadSkill(skillPath, isBuiltin);
    if (skill) {
      logger.info('Skill reloaded', { name: skillName });
    }
    return skill;
  }

  /**
   * 生成 SKILL.md 内容
   */
  private generateSkillMd(metadata: SkillMetadata, body: string): string {
    const frontmatter: Record<string, unknown> = {
      name: metadata.name,
      description: metadata.description,
    };

    if (metadata.version) frontmatter.version = metadata.version;
    if (metadata.author) frontmatter.author = metadata.author;
    if (metadata.tags && metadata.tags.length > 0) frontmatter.tags = metadata.tags;
    if (metadata.triggers && metadata.triggers.length > 0) frontmatter.triggers = metadata.triggers;

    const yamlStr = yaml.stringify(frontmatter);
    return `---\n${yamlStr}---\n${body}`;
  }

  /**
   * 复制目录
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}

// 导出单例实例
export const skillLoader = new SkillLoader();


/**
 * 从 ZIP Buffer 导入 Skill
 * Requirements: 13.11
 * 
 * ZIP 文件结构应为:
 * skill-name/           (可选的根目录)
 *   SKILL.md            (必需)
 *   config.json         (可选)
 *   scripts/            (可选)
 *     *.py, *.sh, *.ts
 *   *.md                (可选资源文件)
 */
import AdmZip from 'adm-zip';

/**
 * ZIP 导入结果
 */
export interface ZipImportResult {
  success: boolean;
  skillName: string;
  skill?: Skill;
  error?: string;
}

/**
 * 从 ZIP Buffer 导入 Skill
 * Requirements: 13.11
 * 
 * @param buffer ZIP 文件的 Buffer
 * @param overwrite 是否覆盖已存在的 Skill
 * @returns 导入结果
 */
export async function importSkillFromZip(
  buffer: Buffer,
  overwrite: boolean = false
): Promise<ZipImportResult> {
  const loader = skillLoader;
  
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    
    // 查找 SKILL.md 文件（大小写不敏感）
    let skillMdEntry = entries.find(e => {
      const name = e.entryName.toLowerCase();
      return name === 'skill.md' || name.endsWith('/skill.md');
    });
    
    if (!skillMdEntry) {
      return {
        success: false,
        skillName: '',
        error: 'ZIP 文件中未找到 SKILL.md 文件',
      };
    }
    
    // 确定根目录前缀（大小写不敏感）
    const rootPrefix = skillMdEntry.entryName.replace(/skill\.md$/i, '');
    
    // 解析 SKILL.md 获取 Skill 名称
    const skillMdContent = skillMdEntry.getData().toString('utf-8');
    const { metadata } = loader.parseSkillMd(skillMdContent);
    const skillName = metadata.name;
    
    if (!skillName) {
      return {
        success: false,
        skillName: '',
        error: 'SKILL.md 中缺少 name 字段',
      };
    }
    
    // 检查是否已存在
    const customDir = path.join(loader.getConfig().skillsDir, 'custom');
    const skillPath = path.join(customDir, skillName);
    
    if (await loader['dirExists'](skillPath)) {
      if (!overwrite) {
        return {
          success: false,
          skillName,
          error: `Skill "${skillName}" 已存在，设置 overwrite=true 以覆盖`,
        };
      }
      // 删除已存在的目录
      await fs.rm(skillPath, { recursive: true, force: true });
    }
    
    // 确保 custom 目录存在
    await fs.mkdir(customDir, { recursive: true });
    
    // 创建 Skill 目录
    await fs.mkdir(skillPath, { recursive: true });
    
    // 解压所有文件
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      
      // 移除根目录前缀
      let relativePath = entry.entryName;
      if (rootPrefix && relativePath.startsWith(rootPrefix)) {
        relativePath = relativePath.substring(rootPrefix.length);
      }
      
      if (!relativePath) continue;
      
      // 安全检查：防止路径遍历
      if (relativePath.includes('..')) {
        logger.warn('Skipping file with path traversal attempt', { path: relativePath });
        continue;
      }
      
      const targetPath = path.join(skillPath, relativePath);
      const targetDir = path.dirname(targetPath);
      
      // 确保目标目录存在
      await fs.mkdir(targetDir, { recursive: true });
      
      // 写入文件
      await fs.writeFile(targetPath, entry.getData());
      logger.debug('Extracted file', { path: relativePath });
    }
    
    // 加载并返回创建的 Skill
    const skill = await loader.loadSkill(skillPath, false);
    if (!skill) {
      // 清理失败的导入
      await fs.rm(skillPath, { recursive: true, force: true });
      return {
        success: false,
        skillName,
        error: '导入的 Skill 加载失败',
      };
    }
    
    logger.info('Skill imported from ZIP', { name: skillName, path: skillPath });
    
    return {
      success: true,
      skillName,
      skill,
    };
  } catch (error) {
    logger.error('Failed to import skill from ZIP', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      skillName: '',
      error: error instanceof Error ? error.message : '导入失败',
    };
  }
}

/**
 * 导出 Skill 为 ZIP Buffer
 * Requirements: 13.10
 * 
 * @param skillName Skill 名称
 * @returns ZIP Buffer
 */
export async function exportSkillToZip(skillName: string): Promise<Buffer> {
  const loader = skillLoader;
  
  // 查找 Skill 路径
  let skillPath: string | null = null;
  
  const builtinPath = path.join(loader.getConfig().skillsDir, 'builtin', skillName);
  const customPath = path.join(loader.getConfig().skillsDir, 'custom', skillName);
  
  if (await loader['dirExists'](builtinPath)) {
    skillPath = builtinPath;
  } else if (await loader['dirExists'](customPath)) {
    skillPath = customPath;
  }
  
  if (!skillPath) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  
  const zip = new AdmZip();
  
  // 递归添加目录中的所有文件
  async function addDirectory(dirPath: string, zipPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
      
      if (entry.isDirectory()) {
        await addDirectory(fullPath, entryZipPath);
      } else {
        const content = await fs.readFile(fullPath);
        zip.addFile(entryZipPath, content);
      }
    }
  }
  
  await addDirectory(skillPath, skillName);
  
  return zip.toBuffer();
}

