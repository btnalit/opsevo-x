/**
 * Scheduler 调度器服务
 * 负责管理和执行定时任务（巡检、备份等）
 *
 * Requirements: 4.1, 4.2, 5.1
 * - 4.1: 支持配置巡检任务的执行周期（每日、每周、自定义 cron）
 * - 4.2: 巡检任务执行时采集当前系统状态快照
 * - 5.1: 支持配置自动备份任务的执行周期
 */

import fs from 'fs/promises';
import path from 'path';
import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import {
  IScheduler,
  ScheduledTask,
  ScheduledTaskType,
  TaskExecution,
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { auditLogger } from './auditLogger';
import type { DataStore } from '../core/dataStore';
import { CronExpressionParser } from 'cron-parser';

const SCHEDULER_DIR = path.join(process.cwd(), 'data', 'ai-ops', 'scheduler');
const TASKS_FILE = path.join(SCHEDULER_DIR, 'tasks.json');
const EXECUTIONS_DIR = path.join(SCHEDULER_DIR, 'executions');

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取执行记录文件路径
 */
function getExecutionsFilePath(dateStr: string): string {
  return path.join(EXECUTIONS_DIR, `${dateStr}.json`);
}


/**
 * 任务执行处理器类型
 */
type TaskHandler = (task: ScheduledTask) => Promise<unknown>;

export class Scheduler implements IScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, CronScheduledTask> = new Map();
  private isRunning: boolean = false;
  private taskHandlers: Map<string, TaskHandler> = new Map();

  // ==================== DataStore 集成 ====================
  // Requirements: 2.1, 2.2 - 使用 SQLite 替代 JSON 文件存储，注入 tenant_id
  private dataStore: DataStore | null = null;

  /**
   * 设置 DataStore 实例
   * 当 DataStore 可用时，调度任务将使用 SQLite 存储
   * Requirements: 2.1, 2.2
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('Scheduler: DataStore backend configured, using SQLite for scheduled tasks storage');
  }

  /**
   * 确保目录存在
   */
  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(SCHEDULER_DIR, { recursive: true });
      await fs.mkdir(EXECUTIONS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create scheduler directories:', error);
    }
  }

  /**
   * 加载任务列表
   * Requirements: 2.1 - 当 DataStore 可用时从 scheduled_tasks 表读取
   */
  private async loadTasks(): Promise<void> {
    // 当 DataStore 可用时，从 SQLite 读取
    if (this.dataStore) {
      try {
        const rows = this.dataStore.query<{
          id: string;
          tenant_id: string;
          device_id: string | null;
          name: string;
          type: string;
          cron_expression: string;
          config: string;
          enabled: number;
          last_run: string | null;
          next_run: string | null;
          created_at: string;
        }>('SELECT * FROM scheduled_tasks');

        this.tasks.clear();
        let i = 0;
        for (const row of rows) {
          if (++i % 100 === 0) {
            // Break tight loops for very large dataset loading
            await new Promise(resolve => setImmediate(resolve));
          }
          const config = JSON.parse(row.config || '{}');
          const task: ScheduledTask = {
            id: row.id,
            name: row.name,
            type: row.type as ScheduledTaskType,
            cron: row.cron_expression,
            enabled: row.enabled === 1,
            lastRunAt: row.last_run ? new Date(row.last_run).getTime() : undefined,
            nextRunAt: row.next_run ? new Date(row.next_run).getTime() : undefined,
            config,
            createdAt: new Date(row.created_at).getTime(),
            tenantId: row.tenant_id,
            deviceId: row.device_id || undefined,
          };
          this.tasks.set(task.id, task);
        }
        logger.info(`Loaded ${this.tasks.size} scheduled tasks from DataStore`);
        return;
      } catch (error) {
        logger.error('Failed to load scheduled tasks from DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 从 JSON 文件读取
    try {
      const data = await fs.readFile(TASKS_FILE, 'utf-8');
      const tasks = JSON.parse(data) as ScheduledTask[];
      this.tasks.clear();
      for (const task of tasks) {
        this.tasks.set(task.id, task);
      }
      logger.info(`Loaded ${tasks.length} scheduled tasks`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load scheduled tasks:', error);
      }
      this.tasks.clear();
    }
  }

  /**
   * 保存任务列表
   * Requirements: 2.1 - 当 DataStore 可用时写入 scheduled_tasks 表
   */
  private async saveTasks(): Promise<void> {
    // 当 DataStore 可用时，写入 SQLite
    if (this.dataStore) {
      try {
        this.dataStore.transaction(() => {
          for (const task of this.tasks.values()) {
            const tenantId = task.tenantId || 'default';
            const deviceId = task.deviceId || null;
            const config = JSON.stringify(task.config || {});
            const createdAt = new Date(task.createdAt).toISOString();
            const lastRun = task.lastRunAt ? new Date(task.lastRunAt).toISOString() : null;
            const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null;

            this.dataStore!.run(
              `INSERT OR REPLACE INTO scheduled_tasks (id, tenant_id, device_id, name, type, cron_expression, config, enabled, last_run, next_run, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [task.id, tenantId, deviceId, task.name, task.type, task.cron, config, task.enabled ? 1 : 0, lastRun, nextRun, createdAt]
            );
          }
        });
        return;
      } catch (error) {
        logger.error('Failed to save tasks to DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 写入 JSON 文件
    await this.ensureDirectories();
    const tasks = Array.from(this.tasks.values());
    await fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
  }

  /**
   * 读取指定日期的执行记录
   */
  private async readExecutionsFile(dateStr: string): Promise<TaskExecution[]> {
    const filePath = getExecutionsFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as TaskExecution[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read executions file ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * 写入执行记录文件
   */
  private async writeExecutionsFile(dateStr: string, executions: TaskExecution[]): Promise<void> {
    const filePath = getExecutionsFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(executions, null, 2), 'utf-8');
  }

  /**
   * 保存执行记录
   */
  private async saveExecution(execution: TaskExecution): Promise<void> {
    await this.ensureDirectories();
    const dateStr = getDateString(execution.startedAt);
    const executions = await this.readExecutionsFile(dateStr);

    // 查找是否已存在该执行记录
    const existingIndex = executions.findIndex((e) => e.id === execution.id);
    if (existingIndex >= 0) {
      executions[existingIndex] = execution;
    } else {
      executions.push(execution);
    }

    await this.writeExecutionsFile(dateStr, executions);
  }


  /**
   * 验证 cron 表达式
   */
  private validateCron(cronExpression: string): boolean {
    return cron.validate(cronExpression);
  }

  /**
   * 计算下次执行时间
   * 基于 cron 表达式计算下一次执行的时间戳
   */
  calculateNextRunTime(cronExpression: string): number | null {
    if (!this.validateCron(cronExpression)) {
      return null;
    }

    // 使用 cron-parser 库计算下次执行时间
    return this.parseNextCronTime(cronExpression);
  }

  /**
   * 解析 cron 表达式并计算下次执行时间
   * 使用 cron-parser 库替代手动逐分钟迭代
   * 支持标准 5 字段 cron 格式: 分 时 日 月 周
   * 以及 6 字段格式（含秒）: 秒 分 时 日 月 周
   */
  private parseNextCronTime(cronExpression: string): number | null {
    try {
      const interval = CronExpressionParser.parse(cronExpression);
      const next = interval.next();
      return next.getTime();
    } catch (error) {
      logger.error(`Failed to parse cron expression: ${cronExpression}`, error);
      return null;
    }
  }

  /**
   * 注册任务处理器
   * 允许外部模块注册特定类型任务的处理逻辑
   */
  registerHandler(type: string, handler: TaskHandler): void {
    this.taskHandlers.set(type, handler);
    logger.info(`Registered task handler for type: ${type}`);
  }

  /**
   * 任务执行超时时间（毫秒）
   * 防止 handler 挂起导致任务永远处于 running 状态
   */
  private readonly TASK_EXECUTION_TIMEOUT_MS = 300000; // 5 分钟

  /**
   * 执行任务
   */
  private async executeTask(task: ScheduledTask): Promise<TaskExecution> {
    // Break the event loop tightly executing the tasks triggered exactly at a time tick
    await new Promise(resolve => setImmediate(resolve));

    const execution: TaskExecution = {
      id: uuidv4(),
      taskId: task.id,
      taskName: task.name,
      type: task.type,
      status: 'running',
      startedAt: Date.now(),
    };

    // 保存执行开始状态
    await this.saveExecution(execution);

    try {
      // 获取任务处理器
      const handler = this.taskHandlers.get(task.type);

      if (handler) {
        // P1-1 FIX: 存储超时 ID 以在成功时清除，防止 Promise.race 计时器泄漏
        let timeoutId: NodeJS.Timeout;
        execution.result = await Promise.race([
          handler(task),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(
              `Task execution timeout after ${this.TASK_EXECUTION_TIMEOUT_MS}ms`
            )), this.TASK_EXECUTION_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timeoutId!);
      } else {
        // 默认处理：记录日志
        logger.info(`Executing task: ${task.name} (${task.type})`);
        execution.result = { message: 'Task executed (no handler registered)' };
      }

      execution.status = 'success';
      execution.completedAt = Date.now();

      // 更新任务的最后执行时间
      task.lastRunAt = execution.startedAt;
      task.nextRunAt = this.calculateNextRunTime(task.cron) || undefined;
      await this.saveTasks();

      // 记录审计日志
      await auditLogger.log({
        action: 'script_execute',
        actor: 'system',
        details: {
          trigger: `scheduled_task:${task.type}`,
          result: 'success',
          metadata: {
            taskId: task.id,
            taskName: task.name,
            executionId: execution.id,
          },
        },
      });

      logger.info(`Task ${task.name} completed successfully`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('Task execution timeout');

      execution.status = isTimeout ? 'timeout' : 'failed';
      execution.error = errorMessage;
      execution.completedAt = Date.now();

      // 记录审计日志
      await auditLogger.log({
        action: 'script_execute',
        actor: 'system',
        details: {
          trigger: `scheduled_task:${task.type}`,
          result: isTimeout ? 'timeout' : 'failed',
          error: execution.error,
          metadata: {
            taskId: task.id,
            taskName: task.name,
            executionId: execution.id,
          },
        },
      });

      if (isTimeout) {
        logger.error(`Task ${task.name} timed out after ${this.TASK_EXECUTION_TIMEOUT_MS}ms`);
      } else {
        logger.error(`Task ${task.name} failed:`, error);
      }
    }

    // 保存执行结果
    await this.saveExecution(execution);

    return execution;
  }

  /**
   * 为任务创建 cron job
   */
  private scheduleCronJob(task: ScheduledTask): void {
    // 如果已存在，先停止
    this.stopCronJob(task.id);

    if (!task.enabled) {
      return;
    }

    if (!this.validateCron(task.cron)) {
      logger.error(`Invalid cron expression for task ${task.name}: ${task.cron}`);
      return;
    }

    const job = cron.schedule(task.cron, async () => {
      logger.info(`Cron triggered for task: ${task.name}`);
      await this.executeTask(task);
    });

    this.cronJobs.set(task.id, job);
    logger.info(`Scheduled cron job for task: ${task.name} (${task.cron})`);
  }

  /**
   * 停止任务的 cron job
   */
  private stopCronJob(taskId: string): void {
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
  }


  /**
   * 启动调度器
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    this.ensureDirectories().then(() => {
      this.loadTasks().then(() => {
        // 为所有启用的任务创建 cron job
        for (const task of this.tasks.values()) {
          if (task.enabled) {
            // 更新下次执行时间
            task.nextRunAt = this.calculateNextRunTime(task.cron) || undefined;
            this.scheduleCronJob(task);
          }
        }

        // 保存更新后的任务列表
        this.saveTasks();

        this.isRunning = true;
        logger.info(`Scheduler started with ${this.tasks.size} tasks`);
      });
    });
  }

  /**
   * 停止调度器
   */
  stop(): void {
    // 停止所有 cron jobs
    for (const [taskId, job] of this.cronJobs) {
      job.stop();
      logger.debug(`Stopped cron job for task: ${taskId}`);
    }
    this.cronJobs.clear();

    this.isRunning = false;
    logger.info('Scheduler stopped');
  }

  /**
   * 创建定时任务
   * Requirements: 2.2 - 支持 tenant_id 和 device_id 关联
   */
  async createTask(input: CreateScheduledTaskInput & { tenantId?: string; deviceId?: string | null }): Promise<ScheduledTask> {
    await this.ensureDirectories();

    // 验证 cron 表达式
    if (!this.validateCron(input.cron)) {
      throw new Error(`Invalid cron expression: ${input.cron}`);
    }

    const { tenantId, deviceId, ...taskInput } = input;
    const task: ScheduledTask = {
      id: uuidv4(),
      name: taskInput.name,
      type: taskInput.type,
      cron: taskInput.cron,
      enabled: taskInput.enabled ?? true,
      lastRunAt: taskInput.lastRunAt,
      config: taskInput.config,
      createdAt: Date.now(),
      nextRunAt: this.calculateNextRunTime(taskInput.cron) || undefined,
      tenantId,
      deviceId: deviceId || undefined,
    };

    this.tasks.set(task.id, task);
    await this.saveTasks();

    // 如果调度器正在运行且任务已启用，创建 cron job
    if (this.isRunning && task.enabled) {
      this.scheduleCronJob(task);
    }

    logger.info(`Created scheduled task: ${task.name} (${task.id})`);
    return task;
  }

  /**
   * 更新定时任务
   */
  async updateTask(id: string, updates: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // 如果更新了 cron 表达式，验证它
    if (updates.cron !== undefined && !this.validateCron(updates.cron)) {
      throw new Error(`Invalid cron expression: ${updates.cron}`);
    }

    // 应用更新
    const updatedTask: ScheduledTask = {
      ...task,
      ...updates,
      id: task.id, // 确保 ID 不变
      createdAt: task.createdAt, // 确保创建时间不变
    };

    // 如果 cron 表达式变了，重新计算下次执行时间
    if (updates.cron !== undefined) {
      updatedTask.nextRunAt = this.calculateNextRunTime(updates.cron) || undefined;
    }

    this.tasks.set(id, updatedTask);
    await this.saveTasks();

    // 如果调度器正在运行，更新 cron job
    if (this.isRunning) {
      if (updatedTask.enabled) {
        this.scheduleCronJob(updatedTask);
      } else {
        this.stopCronJob(id);
      }
    }

    logger.info(`Updated scheduled task: ${updatedTask.name} (${id})`);
    return updatedTask;
  }

  /**
   * 删除定时任务
   * Requirements: 2.1 - 当 DataStore 可用时从 scheduled_tasks 表删除
   */
  async deleteTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // 停止 cron job
    this.stopCronJob(id);

    // 从列表中删除
    this.tasks.delete(id);

    // 当 DataStore 可用时，直接从 SQLite 删除
    if (this.dataStore) {
      try {
        this.dataStore.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
        logger.info(`Deleted scheduled task from DataStore: ${task.name} (${id})`);
        return;
      } catch (error) {
        logger.error('Failed to delete task from DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 保存到 JSON 文件
    await this.saveTasks();

    logger.info(`Deleted scheduled task: ${task.name} (${id})`);
  }


  /**
   * 获取所有定时任务
   */
  async getTasks(deviceId?: string): Promise<ScheduledTask[]> {
    await this.ensureDirectories();

    // 如果任务列表为空，尝试从文件加载
    if (this.tasks.size === 0) {
      await this.loadTasks();
    }

    const tasks = Array.from(this.tasks.values());
    if (deviceId) {
      return tasks.filter((t) => !t.deviceId || t.deviceId === deviceId);
    }
    return tasks;
  }

  /**
   * 根据 ID 获取定时任务
   */
  async getTaskById(id: string): Promise<ScheduledTask | null> {
    await this.ensureDirectories();

    // 如果任务列表为空，尝试从文件加载
    if (this.tasks.size === 0) {
      await this.loadTasks();
    }

    return this.tasks.get(id) || null;
  }

  /**
   * 立即执行任务
   * @param id 任务 ID
   * @param deviceId 强制要求的设备 ID
   */
  async runTaskNow(id: string, deviceId: string): Promise<TaskExecution> {
    await this.loadTasks();
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // 验证任务是否属于该设备
    if (task.deviceId && task.deviceId !== deviceId) {
      throw new Error(`Task ${id} does not belong to device ${deviceId}`);
    }

    return this.executeTask(task);
  }

  /**
   * 获取执行历史
   * @param taskId 可选，指定任务 ID 过滤
   * @param limit 可选，限制返回数量
   */
  async getExecutions(taskId?: string, limit?: number): Promise<TaskExecution[]> {
    await this.ensureDirectories();

    // 列出所有执行记录文件
    const files = await this.listExecutionFiles();

    // 按日期降序排序（最新的在前）
    files.sort((a, b) => b.localeCompare(a));

    const allExecutions: TaskExecution[] = [];

    for (const dateStr of files) {
      const executions = await this.readExecutionsFile(dateStr);

      // Yield event loop
      await new Promise(resolve => setImmediate(resolve));

      // 如果指定了 taskId，过滤
      const filtered = taskId
        ? executions.filter((e) => e.taskId === taskId)
        : executions;

      allExecutions.push(...filtered);

      // 如果已经收集够了，提前退出
      if (limit && allExecutions.length >= limit) {
        break;
      }
    }

    // 按开始时间降序排序
    allExecutions.sort((a, b) => b.startedAt - a.startedAt);

    // 应用限制
    if (limit && limit > 0) {
      return allExecutions.slice(0, limit);
    }

    return allExecutions;
  }

  /**
   * 列出所有执行记录文件
   */
  private async listExecutionFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(EXECUTIONS_DIR);
      return files
        .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
        .map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * 检查服务是否正在运行
   */
  isServiceRunning(): boolean {
    return this.isRunning;
  }

  /**
   * 获取所有活跃的 cron jobs 数量
   */
  getActiveCronJobsCount(): number {
    return this.cronJobs.size;
  }
}

// 导出单例实例
export const scheduler = new Scheduler();
