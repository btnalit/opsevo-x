/**
 * DocumentProcessor 文档处理器服务
 * 负责文档分块、向量化和索引管理
 *
 * Requirements: 3.6
 * - 3.6: 索引文档时将长文档分割成可配置重叠的块
 */

import { EmbeddingService, embeddingService } from './embeddingService';
import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

// ==================== 类型定义 ====================

/**
 * 分块选项
 */
export interface ChunkOptions {
  chunkSize: number;      // 分块大小（字符数），默认 500
  chunkOverlap: number;   // 分块重叠（字符数），默认 50
  separator?: string;     // 分隔符，默认 '\n'
}

/**
 * 处理后的文档
 */
export interface ProcessedDocument {
  id: string;
  originalId: string;     // 原始文档 ID
  chunkIndex: number;
  content: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

/**
 * 文档来源
 */
export interface DocumentSource {
  type: 'alert' | 'remediation' | 'config' | 'pattern' | 'manual' | 'feedback' | 'learning' | 'experience';
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

// 默认分块选项
const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  chunkSize: 500,
  chunkOverlap: 50,
  separator: '\n',
};

/**
 * DocumentProcessor 文档处理器类
 */
export class DocumentProcessor {
  private embeddingService: EmbeddingService;
  private options: ChunkOptions;

  constructor(
    embeddingServiceInstance?: EmbeddingService,
    options?: Partial<ChunkOptions>
  ) {
    this.embeddingService = embeddingServiceInstance || embeddingService;
    this.options = { ...DEFAULT_CHUNK_OPTIONS, ...options };
    logger.info('DocumentProcessor created', { options: this.options });
  }

  /**
   * 处理单个文档
   * 将文档分块并向量化
   */
  async process(source: DocumentSource): Promise<ProcessedDocument[]> {
    try {
      // 分块
      const chunks = this.chunk(source.content);
      
      if (chunks.length === 0) {
        logger.warn('Document produced no chunks', { sourceId: source.id });
        return [];
      }

      // 批量向量化
      const embeddings = await this.embeddingService.embedBatch(chunks);

      // 构建处理后的文档
      const processedDocs: ProcessedDocument[] = chunks.map((content, index) => ({
        id: `${source.id}_chunk_${index}`,
        originalId: source.id,
        chunkIndex: index,
        content,
        vector: embeddings[index].vector,
        metadata: {
          ...source.metadata,
          source: source.type,
          originalId: source.id,
          chunkIndex: index,
          totalChunks: chunks.length,
          timestamp: Date.now(),
        },
      }));

      logger.debug(`Processed document ${source.id} into ${processedDocs.length} chunks`);
      return processedDocs;
    } catch (error) {
      logger.error(`Failed to process document ${source.id}`, { error });
      throw error;
    }
  }

  /**
   * 批量处理文档
   */
  async processBatch(sources: DocumentSource[]): Promise<ProcessedDocument[]> {
    const allProcessed: ProcessedDocument[] = [];

    for (const source of sources) {
      try {
        const processed = await this.process(source);
        allProcessed.push(...processed);
      } catch (error) {
        logger.error(`Failed to process document ${source.id} in batch`, { error });
        // 继续处理其他文档
      }
    }

    logger.info(`Batch processed ${sources.length} documents into ${allProcessed.length} chunks`);
    return allProcessed;
  }

  /**
   * 文本分块
   * 将长文本分割成指定大小的块，支持重叠
   */
  chunk(text: string, options?: Partial<ChunkOptions>): string[] {
    const opts = { ...this.options, ...options };
    const { chunkSize, chunkOverlap, separator } = opts;

    // 验证参数
    if (chunkSize <= 0) {
      throw new Error('chunkSize must be positive');
    }
    if (chunkOverlap < 0) {
      throw new Error('chunkOverlap must be non-negative');
    }
    if (chunkOverlap >= chunkSize) {
      throw new Error('chunkOverlap must be less than chunkSize');
    }

    // 空文本返回空数组
    if (!text || text.trim().length === 0) {
      return [];
    }

    // 如果文本长度小于等于 chunkSize，直接返回
    if (text.length <= chunkSize) {
      return [text.trim()];
    }

    const chunks: string[] = [];
    const step = chunkSize - chunkOverlap;

    // 首先按分隔符分割
    const segments = separator ? text.split(separator) : [text];
    
    let currentChunk = '';
    
    for (const segment of segments) {
      const segmentWithSeparator = segment + (separator || '');
      
      // 如果当前段落本身就超过 chunkSize，需要强制分割
      if (segmentWithSeparator.length > chunkSize) {
        // 先保存当前累积的内容
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());
          // 保留重叠部分
          currentChunk = this.getOverlapText(currentChunk, chunkOverlap);
        }
        
        // 强制分割长段落
        const forcedChunks = this.forceChunk(segmentWithSeparator, chunkSize, chunkOverlap);
        chunks.push(...forcedChunks.slice(0, -1));
        currentChunk = forcedChunks[forcedChunks.length - 1] || '';
      } else if (currentChunk.length + segmentWithSeparator.length > chunkSize) {
        // 当前块已满，保存并开始新块
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());
        }
        // 保留重叠部分
        currentChunk = this.getOverlapText(currentChunk, chunkOverlap) + segmentWithSeparator;
      } else {
        // 继续累积
        currentChunk += segmentWithSeparator;
      }
    }

    // 保存最后一个块
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * 强制分割长文本
   */
  private forceChunk(text: string, chunkSize: number, chunkOverlap: number): string[] {
    const chunks: string[] = [];
    const step = chunkSize - chunkOverlap;
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const chunk = text.slice(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      start += step;
    }

    return chunks;
  }

  /**
   * 获取重叠文本
   */
  private getOverlapText(text: string, overlapSize: number): string {
    if (overlapSize <= 0 || text.length <= overlapSize) {
      return '';
    }
    return text.slice(-overlapSize);
  }

  /**
   * 获取当前选项
   */
  getOptions(): ChunkOptions {
    return { ...this.options };
  }

  /**
   * 更新选项
   */
  updateOptions(options: Partial<ChunkOptions>): void {
    this.options = { ...this.options, ...options };
    logger.info('DocumentProcessor options updated', { options: this.options });
  }

  /**
   * 设置嵌入服务（用于测试）
   */
  setEmbeddingService(service: EmbeddingService): void {
    this.embeddingService = service;
  }
}

// 导出单例实例
export const documentProcessor = new DocumentProcessor();
