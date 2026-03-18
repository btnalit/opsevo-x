/**
 * System Routes
 * 定义系统管理相关的路由（Scheduler 和 Script）
 */

import { Router } from 'express';
import {
  // Scheduler
  getAllSchedulers,
  getSchedulerById,
  addScheduler,
  updateScheduler,
  deleteScheduler,
  enableScheduler,
  disableScheduler,
  // Script
  getAllScripts,
  getScriptById,
  addScript,
  updateScript,
  deleteScript,
  runScript,
  // Power Management
  rebootSystem,
  shutdownSystem,
} from '../controllers/systemController';

const router = Router();

// ==================== Scheduler 路由 ====================

// GET /api/system/scheduler - 获取所有计划任务
router.get('/scheduler', getAllSchedulers);

// GET /api/system/scheduler/:id - 获取单个计划任务
router.get('/scheduler/:id', getSchedulerById);

// POST /api/system/scheduler - 添加计划任务
router.post('/scheduler', addScheduler);

// PATCH /api/system/scheduler/:id - 更新计划任务
router.patch('/scheduler/:id', updateScheduler);

// DELETE /api/system/scheduler/:id - 删除计划任务
router.delete('/scheduler/:id', deleteScheduler);

// POST /api/system/scheduler/:id/enable - 启用计划任务
router.post('/scheduler/:id/enable', enableScheduler);

// POST /api/system/scheduler/:id/disable - 禁用计划任务
router.post('/scheduler/:id/disable', disableScheduler);

// ==================== Script 路由 ====================

// GET /api/system/scripts - 获取所有脚本
router.get('/scripts', getAllScripts);

// GET /api/system/scripts/:id - 获取单个脚本
router.get('/scripts/:id', getScriptById);

// POST /api/system/scripts - 添加脚本
router.post('/scripts', addScript);

// PATCH /api/system/scripts/:id - 更新脚本
router.patch('/scripts/:id', updateScript);

// DELETE /api/system/scripts/:id - 删除脚本
router.delete('/scripts/:id', deleteScript);

// POST /api/system/scripts/:id/run - 运行脚本
router.post('/scripts/:id/run', runScript);

// ==================== 电源管理路由 ====================

// POST /api/system/reboot - 重启系统
router.post('/reboot', rebootSystem);

// POST /api/system/shutdown - 关闭系统
router.post('/shutdown', shutdownSystem);

export default router;
