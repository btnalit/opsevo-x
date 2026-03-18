/**
 * System Controller
 * 处理设备系统管理相关的 API 请求（Scheduler 和 Script）
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { serviceRegistry } from '../services/serviceRegistry';
import { SERVICE_NAMES } from '../services/bootstrap';

/**
 * 从请求对象获取设备客户端
 * 通过 req.deviceId + DevicePool 获取设备连接
 */
function getClient(req: Request, res: Response): any | null {
  // 通过 DevicePool 获取设备专属连接
  if (req.deviceId) {
    try {
      const devicePool = serviceRegistry.tryGet<any>(SERVICE_NAMES.DEVICE_POOL);
      if (devicePool) {
        // DevicePool.getConnection 是异步的，但 getClient 是同步的
        // 同步场景下返回 devicePool 本身作为标记，调用方需异步获取
        logger.debug('systemController: deviceId available, will use DevicePool', { deviceId: req.deviceId });
      }
    } catch {
      // ignore
    }
  }
  
  // 无设备连接可用
  res.status(500).json({ success: false, error: '未建立设备连接' });
  return null;
}

const SCHEDULER_PATH = '/system/scheduler';
const SCRIPT_PATH = '/system/script';

// ==================== Scheduler 相关 ====================

/**
 * 获取所有计划任务
 * GET /api/system/scheduler
 */
export async function getAllSchedulers(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const schedulers = await client.print(SCHEDULER_PATH);

    res.json({
      success: true,
      data: schedulers,
    });
  } catch (error) {
    logger.error('Failed to get schedulers:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取计划任务列表失败',
    });
  }
}

/**
 * 获取单个计划任务
 * GET /api/system/scheduler/:id
 */
export async function getSchedulerById(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少计划任务 ID',
      });
      return;
    }

    const scheduler = await client.getById(SCHEDULER_PATH, id);

    if (!scheduler) {
      res.status(404).json({
        success: false,
        error: '计划任务不存在',
      });
      return;
    }

    res.json({
      success: true,
      data: scheduler,
    });
  } catch (error) {
    logger.error('Failed to get scheduler:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取计划任务详情失败',
    });
  }
}


/**
 * 验证设备时间间隔格式
 * 支持格式: 1d, 1h30m, 00:30:00, 1w2d3h4m5s 等
 * @param interval 时间间隔字符串
 * @returns 是否有效
 */
function isValidInterval(interval: string): boolean {
  if (!interval || interval.trim() === '') {
    return false;
  }

  // 格式1: HH:MM:SS 或 HH:MM
  const timeFormat = /^(\d{1,2}):(\d{2})(:(\d{2}))?$/;
  if (timeFormat.test(interval)) {
    return true;
  }

  // 格式2: 组合格式如 1w2d3h4m5s, 1d, 1h30m 等
  // 支持 w(周), d(天), h(小时), m(分钟), s(秒)
  const durationFormat = /^(\d+w)?(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;
  if (durationFormat.test(interval) && interval.length > 0) {
    // 确保至少有一个时间单位
    return /\d+[wdhms]/.test(interval);
  }

  return false;
}

/**
 * 添加计划任务
 * POST /api/system/scheduler
 */
export async function addScheduler(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const schedulerData = req.body;

    // 验证必填字段
    if (!schedulerData.name) {
      res.status(400).json({
        success: false,
        error: '缺少必填字段：name',
      });
      return;
    }

    // 验证时间间隔格式（如果提供）
    if (schedulerData.interval && !isValidInterval(schedulerData.interval)) {
      res.status(400).json({
        success: false,
        error: '时间间隔格式无效，请使用有效格式（如 1d, 1h30m, 00:30:00）',
      });
      return;
    }

    const newScheduler = await client.add(SCHEDULER_PATH, schedulerData);

    res.status(201).json({
      success: true,
      data: newScheduler,
      message: '计划任务已添加',
    });
  } catch (error) {
    logger.error('Failed to add scheduler:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '添加计划任务失败',
    });
  }
}

/**
 * 更新计划任务
 * PATCH /api/system/scheduler/:id
 */
export async function updateScheduler(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;
    const updateData = req.body;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少计划任务 ID',
      });
      return;
    }

    if (!updateData || Object.keys(updateData).length === 0) {
      res.status(400).json({
        success: false,
        error: '缺少更新数据',
      });
      return;
    }

    // 如果更新时间间隔，验证格式
    if (updateData.interval && !isValidInterval(updateData.interval)) {
      res.status(400).json({
        success: false,
        error: '时间间隔格式无效，请使用有效格式（如 1d, 1h30m, 00:30:00）',
      });
      return;
    }

    const updatedScheduler = await client.set(
      SCHEDULER_PATH,
      id,
      updateData
    );

    res.json({
      success: true,
      data: updatedScheduler,
      message: '计划任务已更新',
    });
  } catch (error) {
    logger.error('Failed to update scheduler:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新计划任务失败',
    });
  }
}

/**
 * 删除计划任务
 * DELETE /api/system/scheduler/:id
 */
export async function deleteScheduler(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少计划任务 ID',
      });
      return;
    }

    await client.remove(SCHEDULER_PATH, id);

    res.json({
      success: true,
      message: '计划任务已删除',
    });
  } catch (error) {
    logger.error('Failed to delete scheduler:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '删除计划任务失败',
    });
  }
}

/**
 * 启用计划任务
 * POST /api/system/scheduler/:id/enable
 */
export async function enableScheduler(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少计划任务 ID',
      });
      return;
    }

    await client.enable(SCHEDULER_PATH, id);
    const updatedScheduler = await client.getById(SCHEDULER_PATH, id);

    res.json({
      success: true,
      data: updatedScheduler,
      message: '计划任务已启用',
    });
  } catch (error) {
    logger.error('Failed to enable scheduler:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '启用计划任务失败',
    });
  }
}

/**
 * 禁用计划任务
 * POST /api/system/scheduler/:id/disable
 */
export async function disableScheduler(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少计划任务 ID',
      });
      return;
    }

    await client.disable(SCHEDULER_PATH, id);
    const updatedScheduler = await client.getById(SCHEDULER_PATH, id);

    res.json({
      success: true,
      data: updatedScheduler,
      message: '计划任务已禁用',
    });
  } catch (error) {
    logger.error('Failed to disable scheduler:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '禁用计划任务失败',
    });
  }
}


// ==================== Script 相关 ====================

/**
 * 获取所有脚本
 * GET /api/system/scripts
 */
export async function getAllScripts(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const scripts = await client.print(SCRIPT_PATH);

    res.json({
      success: true,
      data: scripts,
    });
  } catch (error) {
    logger.error('Failed to get scripts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取脚本列表失败',
    });
  }
}

/**
 * 获取单个脚本
 * GET /api/system/scripts/:id
 */
export async function getScriptById(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少脚本 ID',
      });
      return;
    }

    const script = await client.getById(SCRIPT_PATH, id);

    if (!script) {
      res.status(404).json({
        success: false,
        error: '脚本不存在',
      });
      return;
    }

    res.json({
      success: true,
      data: script,
    });
  } catch (error) {
    logger.error('Failed to get script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取脚本详情失败',
    });
  }
}

/**
 * 添加脚本
 * POST /api/system/scripts
 */
export async function addScript(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const scriptData = req.body;

    // 验证必填字段
    if (!scriptData.name) {
      res.status(400).json({
        success: false,
        error: '缺少必填字段：name',
      });
      return;
    }

    if (!scriptData.source && scriptData.source !== '') {
      res.status(400).json({
        success: false,
        error: '缺少必填字段：source',
      });
      return;
    }

    const newScript = await client.add(SCRIPT_PATH, scriptData);

    res.status(201).json({
      success: true,
      data: newScript,
      message: '脚本已添加',
    });
  } catch (error) {
    logger.error('Failed to add script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '添加脚本失败',
    });
  }
}

/**
 * 更新脚本
 * PATCH /api/system/scripts/:id
 */
export async function updateScript(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;
    const updateData = req.body;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少脚本 ID',
      });
      return;
    }

    if (!updateData || Object.keys(updateData).length === 0) {
      res.status(400).json({
        success: false,
        error: '缺少更新数据',
      });
      return;
    }

    const updatedScript = await client.set(
      SCRIPT_PATH,
      id,
      updateData
    );

    res.json({
      success: true,
      data: updatedScript,
      message: '脚本已更新',
    });
  } catch (error) {
    logger.error('Failed to update script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新脚本失败',
    });
  }
}

/**
 * 删除脚本
 * DELETE /api/system/scripts/:id
 */
export async function deleteScript(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少脚本 ID',
      });
      return;
    }

    await client.remove(SCRIPT_PATH, id);

    res.json({
      success: true,
      message: '脚本已删除',
    });
  } catch (error) {
    logger.error('Failed to delete script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '删除脚本失败',
    });
  }
}

/**
 * 运行脚本
 * POST /api/system/scripts/:id/run
 */
export async function runScript(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: '缺少脚本 ID',
      });
      return;
    }

    await client.runScript(id);

    res.json({
      success: true,
      message: '脚本已执行',
    });
  } catch (error) {
    logger.error('Failed to run script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '运行脚本失败',
    });
  }
}


// ==================== 电源管理相关 ====================

/**
 * 重启系统
 * POST /api/system/reboot
 */
export async function rebootSystem(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    logger.warn('System reboot requested');
    await client.execute('/system/reboot');

    res.json({
      success: true,
      message: '系统正在重启...',
    });
  } catch (error) {
    logger.error('Failed to reboot system:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '重启系统失败',
    });
  }
}

/**
 * 关闭系统
 * POST /api/system/shutdown
 */
export async function shutdownSystem(req: Request, res: Response): Promise<void> {
  try {
    const client = getClient(req, res);
    if (!client) return;

    logger.warn('System shutdown requested');
    await client.execute('/system/shutdown');

    res.json({
      success: true,
      message: '系统正在关机...',
    });
  } catch (error) {
    logger.error('Failed to shutdown system:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '关闭系统失败',
    });
  }
}
