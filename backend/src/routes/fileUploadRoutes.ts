/**
 * File Upload Routes
 * 文件上传 API 端点
 *
 * 路由：
 * - POST /api/ai-ops/rag/knowledge/upload - 上传文件到知识库
 * - POST /api/ai-ops/rag/knowledge/upload/batch - 批量上传文件
 * - GET /api/ai-ops/rag/knowledge/upload/types - 获取支持的文件类型
 * - POST /api/ai-ops/rag/knowledge/upload/validate - 验证文件
 *
 * Requirements: 11.6, 12.1, 12.2, 12.3, 12.4, 12.7
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { fileProcessor, SUPPORTED_FILE_TYPES, type UploadedFile, type ProcessedFileResult } from '../services/ai-ops/rag/fileProcessor';
import { logger } from '../utils/logger';

const router = Router();

// ==================== Multer 配置 ====================

/**
 * 内存存储配置
 * 文件存储在内存中，便于直接处理
 */
const storage = multer.memoryStorage();

/**
 * 文件过滤器
 * 验证文件类型
 */
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const ext = getExtension(file.originalname);
  const isSupported = SUPPORTED_FILE_TYPES.some(t => t.extension === ext);

  if (isSupported) {
    cb(null, true);
  } else {
    cb(new Error(`不支持的文件类型: ${ext}。支持的类型: ${SUPPORTED_FILE_TYPES.map(t => t.extension).join(', ')}`));
  }
};

/**
 * 获取最大文件大小
 */
const getMaxFileSize = (): number => {
  return Math.max(...SUPPORTED_FILE_TYPES.map(t => t.maxSize));
};

/**
 * Multer 上传配置
 */
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: getMaxFileSize(),
    files: 10, // 最多同时上传 10 个文件
  },
});

/**
 * 获取文件扩展名
 */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
}

/**
 * 转换 Multer 文件为 UploadedFile
 * 修复中文文件名编码问题
 */
function toUploadedFile(file: Express.Multer.File): UploadedFile {
  // 修复中文文件名编码问题
  // multer 可能将 UTF-8 文件名错误解码，需要重新编码
  let filename = file.originalname;
  try {
    // 尝试修复 Latin-1 编码的 UTF-8 字符串
    const decoded = Buffer.from(filename, 'latin1').toString('utf-8');
    // 检查解码后是否包含有效的中文字符
    if (/[\u4e00-\u9fa5]/.test(decoded)) {
      filename = decoded;
    }
  } catch {
    // 解码失败，保持原样
  }
  
  return {
    filename,
    mimetype: file.mimetype,
    size: file.size,
    buffer: file.buffer,
  };
}

// ==================== 上传进度追踪 ====================

/**
 * 上传进度信息
 */
interface UploadProgress {
  id: string;
  filename: string;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  message?: string;
  result?: ProcessedFileResult;
  startedAt: number;
  completedAt?: number;
}

/**
 * 进度存储（简单内存存储，生产环境可用 Redis）
 */
const progressStore = new Map<string, UploadProgress>();

/**
 * 生成进度 ID
 */
function generateProgressId(): string {
  return `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 更新进度
 */
function updateProgress(
  id: string,
  updates: Partial<UploadProgress>
): void {
  const existing = progressStore.get(id);
  if (existing) {
    progressStore.set(id, { ...existing, ...updates });
  }
}

/**
 * 清理过期进度（1小时后）
 */
function cleanupOldProgress(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, progress] of progressStore) {
    if (progress.startedAt < oneHourAgo) {
      progressStore.delete(id);
    }
  }
}

// 定期清理（使用 unref() 确保不阻止进程退出）
const cleanupTimer = setInterval(cleanupOldProgress, 10 * 60 * 1000); // 每 10 分钟清理一次
cleanupTimer.unref();

// ==================== API 端点 ====================

/**
 * GET /api/ai-ops/rag/knowledge/upload/types
 * 获取支持的文件类型
 * Requirements: 11.1
 */
router.get('/types', (_req: Request, res: Response) => {
  try {
    const types = fileProcessor.getSupportedTypes();
    res.json({
      success: true,
      data: types,
    });
  } catch (error) {
    logger.error('Failed to get supported file types', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/upload/validate
 * 验证文件（不实际上传）
 * Requirements: 11.1
 */
router.post('/validate', upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      res.status(400).json({
        success: false,
        error: '没有上传文件',
      });
      return;
    }

    const uploadedFiles = files.map(toUploadedFile);
    const validationResults = fileProcessor.validateFiles(uploadedFiles);

    res.json({
      success: true,
      data: validationResults,
      summary: {
        total: validationResults.length,
        valid: validationResults.filter(r => r.valid).length,
        invalid: validationResults.filter(r => !r.valid).length,
      },
    });
  } catch (error) {
    logger.error('Failed to validate files', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/upload
 * 上传单个文件到知识库
 * Requirements: 11.6, 12.1, 12.2, 12.3, 12.4
 */
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  const progressId = generateProgressId();

  try {
    const file = req.file;

    if (!file) {
      res.status(400).json({
        success: false,
        error: '没有上传文件',
      });
      return;
    }

    // 初始化进度
    progressStore.set(progressId, {
      id: progressId,
      filename: file.originalname,
      status: 'uploading',
      progress: 10,
      message: '文件已接收，准备处理...',
      startedAt: Date.now(),
    });

    // 确保 FileProcessor 已初始化
    if (!fileProcessor.isInitialized()) {
      updateProgress(progressId, { progress: 20, message: '初始化处理服务...' });
      await fileProcessor.initialize();
    }

    // 转换文件格式
    const uploadedFile = toUploadedFile(file);

    // 更新进度
    updateProgress(progressId, {
      status: 'processing',
      progress: 30,
      message: '正在解析文件...',
    });

    // 处理文件
    const result = await fileProcessor.processFile(uploadedFile);

    // 更新进度
    updateProgress(progressId, {
      status: result.success ? 'completed' : 'failed',
      progress: 100,
      message: result.success ? '处理完成' : result.error,
      result,
      completedAt: Date.now(),
    });

    if (result.success) {
      res.status(201).json({
        success: true,
        data: result,
        progressId,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        data: result,
        progressId,
      });
    }
  } catch (error) {
    logger.error('Failed to upload file', { error });

    updateProgress(progressId, {
      status: 'failed',
      progress: 100,
      message: (error as Error).message,
      completedAt: Date.now(),
    });

    res.status(500).json({
      success: false,
      error: (error as Error).message,
      progressId,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/upload/batch
 * 批量上传文件到知识库
 * Requirements: 11.6, 12.7
 */
router.post('/batch', upload.array('files', 10), async (req: Request, res: Response) => {
  const progressId = generateProgressId();

  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      res.status(400).json({
        success: false,
        error: '没有上传文件',
      });
      return;
    }

    // 初始化进度
    progressStore.set(progressId, {
      id: progressId,
      filename: `批量上传 (${files.length} 个文件)`,
      status: 'uploading',
      progress: 5,
      message: `已接收 ${files.length} 个文件，准备处理...`,
      startedAt: Date.now(),
    });

    // 确保 FileProcessor 已初始化
    if (!fileProcessor.isInitialized()) {
      updateProgress(progressId, { progress: 10, message: '初始化处理服务...' });
      await fileProcessor.initialize();
    }

    // 转换文件格式
    const uploadedFiles = files.map(toUploadedFile);

    // 处理文件并报告进度
    const results: ProcessedFileResult[] = [];
    const totalFiles = uploadedFiles.length;

    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      const fileProgress = Math.round(15 + (i / totalFiles) * 80);

      updateProgress(progressId, {
        status: 'processing',
        progress: fileProgress,
        message: `正在处理 ${file.filename} (${i + 1}/${totalFiles})...`,
      });

      const result = await fileProcessor.processFile(file);
      results.push(result);
    }

    // 汇总结果
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const totalEntries = results.reduce((sum, r) => sum + r.entries.length, 0);

    // 更新最终进度
    updateProgress(progressId, {
      status: failedCount === totalFiles ? 'failed' : 'completed',
      progress: 100,
      message: `处理完成: ${successCount} 成功, ${failedCount} 失败, 共创建 ${totalEntries} 个知识条目`,
      completedAt: Date.now(),
    });

    res.status(successCount > 0 ? 201 : 400).json({
      success: successCount > 0,
      data: results,
      summary: {
        total: totalFiles,
        success: successCount,
        failed: failedCount,
        entriesCreated: totalEntries,
      },
      progressId,
    });
  } catch (error) {
    logger.error('Failed to batch upload files', { error });

    updateProgress(progressId, {
      status: 'failed',
      progress: 100,
      message: (error as Error).message,
      completedAt: Date.now(),
    });

    res.status(500).json({
      success: false,
      error: (error as Error).message,
      progressId,
    });
  }
});

/**
 * GET /api/ai-ops/rag/knowledge/upload/progress/:id
 * 获取上传进度
 * Requirements: 11.6
 */
router.get('/progress/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const progress = progressStore.get(id);

    if (!progress) {
      res.status(404).json({
        success: false,
        error: '进度信息不存在或已过期',
      });
      return;
    }

    res.json({
      success: true,
      data: progress,
    });
  } catch (error) {
    logger.error('Failed to get upload progress', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * Multer 错误处理中间件
 */
router.use((error: Error, _req: Request, res: Response, next: Function) => {
  if (error instanceof multer.MulterError) {
    let message = '文件上传错误';

    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        message = '文件大小超过限制';
        break;
      case 'LIMIT_FILE_COUNT':
        message = '文件数量超过限制（最多 10 个）';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = '意外的文件字段';
        break;
      default:
        message = error.message;
    }

    res.status(400).json({
      success: false,
      error: message,
      code: error.code,
    });
  } else if (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  } else {
    next();
  }
});

export default router;
