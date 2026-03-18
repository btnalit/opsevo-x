/**
 * ScriptExecutorService - 脚本执行服务
 *
 * 执行 AI 生成的 RouterOS 脚本，管理执行历史记录
 *
 * 功能：
 * - 执行 RouterOS 脚本（直接透传到设备）
 * - 基本脚本验证
 * - 记录执行历史
 * - 执行日志记录
 *
 * 设计原则：
 * - 简单透传：将 AI 生成的命令转换为 API 格式后直接发送到设备
 * - 原始响应：设备返回什么就显示什么，包括错误信息
 * - 最小转换：只做必要的 CLI -> API 格式转换
 *
 * Requirements: 4.5, 4.6, 4.7, 6.4
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  IScriptExecutor,
  ScriptExecuteRequest,
  ScriptExecuteResult,
  ScriptValidationResult,
  ScriptHistory,
  AIAgentData,
  AIAgentSettings,
} from '../../types/ai';
import { routerosClient } from '../routerosClient';
import { logger } from '../../utils/logger';
import { convertToApiFormat as sharedConvertToApiFormat } from '../../utils/routerosCliParser';

/**
 * 数据文件路径配置
 */
const DATA_DIR = path.join(process.cwd(), 'data');
const AI_DATA_FILE = path.join(DATA_DIR, 'ai-agent.json');

/**
 * 默认 AI Agent 设置
 */
const DEFAULT_SETTINGS: AIAgentSettings = {
  rateLimitPerMinute: 60,
  maxContextTokens: 4096,
};

/**
 * 默认 AI Agent 数据结构
 */
const DEFAULT_AI_DATA: AIAgentData = {
  apiConfigs: [],
  sessions: [],
  scriptHistory: [],
  settings: DEFAULT_SETTINGS,
};

/**
 * 危险命令关键词 - 仅用于警告日志
 */
const DANGEROUS_KEYWORDS = [
  'reset-configuration',
  'reboot',
  'shutdown',
  'remove',
];


/**
 * ScriptExecutorService 实现类
 *
 * 采用直接透传方式：将命令发送到 RouterOS，返回设备的原始响应
 */
export class ScriptExecutorService implements IScriptExecutor {
  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.access(DATA_DIR);
    } catch {
      await fs.mkdir(DATA_DIR, { recursive: true });
      logger.info(`Created AI data directory: ${DATA_DIR}`);
    }
  }

  /**
   * 加载 AI Agent 数据
   */
  private async loadData(): Promise<AIAgentData> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(AI_DATA_FILE, 'utf-8');
      const parsed = JSON.parse(data) as AIAgentData;

      if (!parsed.scriptHistory) {
        parsed.scriptHistory = [];
      }

      parsed.scriptHistory = parsed.scriptHistory.map(history => ({
        ...history,
        createdAt: new Date(history.createdAt),
        result: {
          ...history.result,
          executedAt: new Date(history.result.executedAt),
        },
      }));

      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No AI agent data file found, using defaults');
        return { ...DEFAULT_AI_DATA };
      }
      logger.error('Failed to load AI agent data:', error);
      throw new Error('加载 AI 配置数据失败');
    }
  }

  /**
   * 保存 AI Agent 数据
   */
  private async saveData(data: AIAgentData): Promise<void> {
    try {
      await this.ensureDataDir();
      const jsonData = JSON.stringify(data, null, 2);
      await fs.writeFile(AI_DATA_FILE, jsonData, 'utf-8');
      logger.info('Saved AI agent data to file');
    } catch (error) {
      logger.error('Failed to save AI agent data:', error);
      throw new Error('保存 AI 配置数据失败');
    }
  }

  /**
   * 执行 RouterOS 脚本
   * 直接透传命令到设备，返回设备的原始响应或错误
   */
  async execute(request: ScriptExecuteRequest): Promise<ScriptExecuteResult> {
    const { script, dryRun = false } = request;
    const executedAt = new Date();

    logger.info(`Script execution attempt - dryRun: ${dryRun}, script length: ${script.length}`);
    logger.info(`Script content:\n${script}`);

    // 基本验证
    const validation = await this.validate(script);
    if (!validation.valid) {
      return {
        success: false,
        error: `脚本验证失败: ${validation.errors?.join(', ')}`,
        executedAt,
      };
    }

    // dry run 模式
    if (dryRun) {
      return {
        success: true,
        output: '脚本验证通过（dry run 模式，未实际执行）',
        executedAt,
      };
    }

    // 多设备支持：使用请求级客户端，回退到全局单例
    // Requirements: 8.1, 8.2
    const client = request.routerosClient || routerosClient;

    // 检查连接状态
    if (!client.isConnected()) {
      return {
        success: false,
        error: '未连接到 RouterOS 设备',
        executedAt,
      };
    }

    try {
      const output = await this.executeScript(script, client);
      return {
        success: true,
        output: output || '命令执行成功（无返回数据）',
        executedAt,
      };
    } catch (error) {
      // 直接返回设备的错误信息
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        executedAt,
      };
    }
  }

  /**
   * 执行脚本并返回输出
   */
  private async executeScript(script: string, client?: import('../routerosClient').RouterOSClient): Promise<string> {
    const lines = script
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    const outputs: string[] = [];

    for (const line of lines) {
      try {
        const output = await this.executeCommand(line, client);
        if (output) {
          outputs.push(output);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`命令 "${line}" 执行失败: ${errorMessage}`);
      }
    }

    return outputs.join('\n');
  }

  /**
   * 执行单个 RouterOS 命令
   * 将 CLI 格式转换为 API 格式，然后透传到设备
   * 
   * @param command RouterOS 命令
   * @param client 可选的请求级 RouterOS 客户端（Requirements: 8.1, 8.2）
   */
  private async executeCommand(command: string, client?: import('../routerosClient').RouterOSClient): Promise<string> {
    const { apiCommand, params } = this.convertToApiFormat(command);
    
    logger.info(`Executing: ${apiCommand}, params: ${JSON.stringify(params)}`);
    
    // 多设备支持：使用请求级客户端，回退到全局单例
    // Requirements: 8.1, 8.2
    const effectiveClient = client || routerosClient;
    
    // 直接透传到设备
    const response = await effectiveClient.executeRaw(apiCommand, params);
    
    // 格式化输出
    if (response === null || response === undefined) {
      return '';
    }
    
    if (Array.isArray(response)) {
      return response.length === 0 ? '' : JSON.stringify(response, null, 2);
    }
    
    if (typeof response === 'object') {
      return JSON.stringify(response, null, 2);
    }
    
    return String(response);
  }


  /**
   * 将 CLI 格式命令转换为 API 格式
   * 委托给共享工具函数，统一修复引号参数、where 子句、特殊字符等边界情况
   */
  private convertToApiFormat(command: string): { apiCommand: string; params: string[] } {
    return sharedConvertToApiFormat(command);
  }

  /**
   * 验证脚本语法（基本验证）
   */
  async validate(script: string): Promise<ScriptValidationResult> {
    if (!script || script.trim().length === 0) {
      return {
        valid: false,
        errors: ['脚本内容不能为空'],
      };
    }

    const errors: string[] = [];
    const lines = script.split('\n');
    let lineNumber = 0;

    for (const line of lines) {
      lineNumber++;
      const trimmedLine = line.trim();

      // 跳过空行和注释
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // 命令必须以 / 开头
      if (!trimmedLine.startsWith('/')) {
        errors.push(`第 ${lineNumber} 行: 命令应以 '/' 开头`);
        continue;
      }

      // 检查危险命令（仅警告）
      for (const keyword of DANGEROUS_KEYWORDS) {
        if (trimmedLine.toLowerCase().includes(keyword)) {
          logger.warn(`Script contains potentially dangerous command at line ${lineNumber}: ${keyword}`);
          break;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * 检查脚本是否包含危险命令
   */
  checkDangerousCommands(script: string): string[] {
    const found: string[] = [];
    const lines = script.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase();
      for (const keyword of DANGEROUS_KEYWORDS) {
        if (trimmedLine.includes(keyword)) {
          found.push(keyword);
        }
      }
    }

    return [...new Set(found)];
  }


  /**
   * 获取脚本执行历史
   */
  async getHistory(sessionId?: string): Promise<ScriptHistory[]> {
    const data = await this.loadData();
    let history = data.scriptHistory || [];

    if (sessionId) {
      history = history.filter(h => h.sessionId === sessionId);
    }

    return history.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * 添加脚本执行历史记录
   */
  async addHistory(
    script: string,
    result: ScriptExecuteResult,
    sessionId: string
  ): Promise<ScriptHistory> {
    const data = await this.loadData();

    const history: ScriptHistory = {
      id: uuidv4(),
      script,
      result,
      sessionId,
      createdAt: new Date(),
    };

    if (!data.scriptHistory) {
      data.scriptHistory = [];
    }

    data.scriptHistory.push(history);

    // 限制历史记录数量
    const MAX_HISTORY = 1000;
    if (data.scriptHistory.length > MAX_HISTORY) {
      data.scriptHistory = data.scriptHistory
        .sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
        .slice(0, MAX_HISTORY);
    }

    await this.saveData(data);
    logger.info(`Script execution recorded - ID: ${history.id}, Session: ${sessionId}, Success: ${result.success}`);

    return history;
  }

  /**
   * 删除指定的历史记录
   */
  async deleteHistory(id: string): Promise<void> {
    const data = await this.loadData();

    const index = data.scriptHistory?.findIndex(h => h.id === id);
    if (index === undefined || index === -1) {
      throw new Error(`历史记录不存在: ${id}`);
    }

    data.scriptHistory.splice(index, 1);
    await this.saveData(data);
    logger.info(`Script history deleted: ${id}`);
  }

  /**
   * 清除指定会话的所有历史记录
   */
  async clearSessionHistory(sessionId: string): Promise<void> {
    const data = await this.loadData();

    const originalLength = data.scriptHistory?.length || 0;
    data.scriptHistory = (data.scriptHistory || []).filter(
      h => h.sessionId !== sessionId
    );

    const deletedCount = originalLength - data.scriptHistory.length;
    await this.saveData(data);
    logger.info(`Cleared ${deletedCount} history records for session: ${sessionId}`);
  }

  /**
   * 清除所有历史记录
   */
  async clearAllHistory(): Promise<void> {
    const data = await this.loadData();
    const count = data.scriptHistory?.length || 0;

    data.scriptHistory = [];
    await this.saveData(data);
    logger.info(`Cleared all ${count} script history records`);
  }

  /**
   * 执行脚本并记录历史
   */
  async executeAndRecord(
    request: ScriptExecuteRequest,
    sessionId: string
  ): Promise<{ result: ScriptExecuteResult; history: ScriptHistory }> {
    const result = await this.execute(request);
    const history = await this.addHistory(request.script, result, sessionId);

    return { result, history };
  }
}

/**
 * 默认 ScriptExecutorService 单例实例
 */
export const scriptExecutorService = new ScriptExecutorService();

export default scriptExecutorService;
