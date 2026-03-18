/**
 * SnapshotHandler 快照任务处理器
 * 负责执行自动快照任务
 */

import { ScheduledTask } from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { scheduler } from './scheduler';
import { configSnapshotService } from './configSnapshotService';

/**
 * 执行快照任务
 */
export async function executeSnapshotTask(task: ScheduledTask): Promise<void> {
    logger.info(`Executing snapshot task: ${task.name} (${task.id})`);

    try {
        // 从任务中获取 tenantId 和 deviceId
        // scheduler.ts 中的任务对象包含这些字段
        const tenantId = (task as any).tenant_id;
        const deviceId = (task as any).device_id;

        if (!tenantId) {
            logger.warn(`Snapshot task ${task.id} missing tenant_id, using 'default'`);
        }

        // 调用 snapshot service 创建快照
        //以此处传递 'auto' 作为触发类型
        await configSnapshotService.createSnapshot('auto', tenantId || 'default', deviceId || undefined);

        logger.info(`Snapshot task completed: ${task.id}`);
    } catch (error) {
        logger.error(`Failed to execute snapshot task ${task.id}:`, error);
        throw error; // 抛出错误以便 scheduler 记录失败状态
    }
}

/**
 * 注册快照处理器到调度器
 */
export function registerSnapshotHandler(): void {
    // 假设任务类型为 'backup' 或 'snapshot'，根据实际调度器配置调整
    // 检查 scheduler.ts 或数据库中实际使用的 type
    scheduler.registerHandler('backup', executeSnapshotTask);
    scheduler.registerHandler('snapshot', executeSnapshotTask);
    logger.info('Snapshot handlers registered to scheduler');
}

/**
 * 初始化快照处理器
 */
export function initializeSnapshotHandler(): void {
    registerSnapshotHandler();
}
