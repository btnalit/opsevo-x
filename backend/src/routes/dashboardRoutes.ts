/**
 * Dashboard 路由
 * 系统资源监控相关 API
 */

import { Router } from 'express';
import { getSystemResource } from '../controllers/dashboardController';

const router = Router();

// GET /api/dashboard/resource - 获取系统资源信息
router.get('/resource', getSystemResource);

export default router;
