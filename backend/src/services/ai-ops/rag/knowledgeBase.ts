/**
 * KnowledgeBase 知识库服务
 * 管理运维知识的收集、索引和检索
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8
 * - 3.1: 告警解决时索引告警详情、分析和解决方案
 * - 3.2: 修复方案执行成功后索引方案详情和执行结果
 * - 3.3: 配置快照创建时索引配置变更及其上下文
 * - 3.4: 故障模式创建或更新时索引模式用于相似度匹配
 * - 3.5: 支持通过 API 手动添加知识条目
 * - 3.7: 维护文档元数据包括来源、时间戳、类别和标签
 * - 3.8: 查询知识库时支持语义搜索和元数据过滤
 * 
 * 智能混合检索系统增强 (Requirements: 5.1, 5.2, 5.3)
 * - 5.1: HybridSearchEngine 集成到 search() 方法
 * - 5.2: 兼容现有 KnowledgeQuery 参数
 * - 5.3: 支持启用/禁用混合检索
 */

import { SQLiteVectorStore } from './sqliteVectorStore';
import type { VectorDocument, SearchOptions, SearchResult } from './vectorDatabase';
import { DocumentProcessor, documentProcessor, DocumentSource } from './documentProcessor';
import { EmbeddingService, embeddingService } from './embeddingService';
import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  AlertEvent,
  RootCauseAnalysis,
  RemediationPlan,
  ExecutionResult,
  ConfigSnapshot,
  SnapshotDiff,
  FaultPattern,
} from '../../../types/ai-ops';

// 混合检索系统导入
import { HybridSearchEngine } from './hybridSearchEngine';
import { MetadataEnhancer } from './metadataEnhancer';
import { KeywordIndexManager } from './keywordIndexManager';
import { RRFRanker } from './rrfRanker';
import { EnhancedMetadata } from './types/hybridSearch';
import type { VectorStoreClient } from './vectorStoreClient';

// ==================== 类型定义 ====================

/**
 * 知识条目类型
 * - alert: 告警历史记录
 * - remediation: 修复方案
 * - config: 配置知识
 * - pattern: 故障模式
 * - manual: 手动添加的知识
 * - feedback: 用户反馈（自动索引）
 * - learning: 学习条目（Critic/Reflector 自动索引）
 * - experience: 经验条目（FeedbackService 自动索引）
 */
export type KnowledgeEntryType = 'alert' | 'remediation' | 'config' | 'pattern' | 'manual' | 'feedback' | 'learning' | 'experience';

/**
 * 知识条目元数据
 */
export interface KnowledgeMetadata {
  source: string;
  timestamp: number;
  category: string;
  tags: string[];
  usageCount: number;
  feedbackScore: number;
  feedbackCount: number;
  lastUsed?: number;
  relatedIds?: string[];
  originalData?: Record<string, unknown>;
  // 规则关联
  linkedRuleIds?: string[];
  /** 反馈来源追踪 */
  createdFromFeedback?: boolean;
  feedbackSourceId?: string;
  /** 对话来源追溯 */
  createdFromConversation?: boolean;
  sourceSessionId?: string;
  sourceMessageIds?: string[];
  /** 效果追踪 */
  effectiveness?: KnowledgeEffectiveness;
  /** 指标类型（用于告警和反馈的分类匹配） */
  metricType?: string;
  /** 新增：语义标签 (Requirements: Truth Report V5) */
  semanticTags?: string[];
  /** 新增：协议约束标记 */
  protocolConstraint?: boolean;
  // 新增：自动增强字段 (Requirements: 1.6 - 智能混合检索系统)
  /** 自动提取的关键词 */
  autoKeywords?: string[];
  /** 自动生成的问题示例 */
  questionExamples?: string[];
  /** 自动生成的同义词 */
  autoSynonyms?: Record<string, string[]>;
  /** 合并后的可搜索文本 */
  searchableText?: string;
  /** 元数据增强时间 */
  enhancedAt?: number;
  /** 增强来源 */
  enhancementSource?: 'llm' | 'fallback';
  // 经验审核状态 (Requirements: 2.4.1, 2.4.2, 2.4.3)
  /** 审核状态：pending-待审核, approved-已批准, rejected-已拒绝 */
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  /** 审核时间 */
  reviewedAt?: number;
  /** 审核人 */
  reviewedBy?: string;
  /** 审核备注 */
  reviewNote?: string;
  /** 质量评分 (0-100) */
  qualityScore?: number;
}

/**
 * 经验审核输入
 * Requirements: 2.4.2
 */
export interface ExperienceReviewInput {
  /** 审核状态 */
  status: 'approved' | 'rejected';
  /** 审核人 */
  reviewedBy?: string;
  /** 审核备注 */
  note?: string;
  /** 质量评分 (0-100) */
  qualityScore?: number;
}

/**
 * 知识条目效果追踪
 */
export interface KnowledgeEffectiveness {
  resolvedAlerts: number;      // 帮助解决的告警数量
  avgResolutionTime: number;   // 平均解决时间（毫秒）
  successRate: number;         // 成功率 (0-1)
  lastEffectiveAt?: number;    // 最后一次有效使用时间
  totalApplications: number;   // 总应用次数
}

/**
 * 知识条目
 */
export interface KnowledgeEntry {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  content: string;
  metadata: KnowledgeMetadata;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/**
 * 排序选项
 * Requirements: 13.1 - 支持在查询时指定排序参数
 */
export interface KnowledgeSortOptions {
  /** 时效性权重 (0-1)，默认 0.2。值越高，越新的文档排名越靠前 */
  recencyWeight?: number;
  /** 时效性计算的最大时间范围（毫秒），默认 90 天 */
  maxAgeMs?: number;
  /** 是否启用混合排序（相似度 + 时效性 + 效果），默认 true */
  enableHybridSort?: boolean;
  /** 效果权重 (0-1)，默认 0.15。值越高，成功率高的条目排名越靠前 */
  effectivenessWeight?: number;
}

/**
 * 知识查询参数
 */
export interface KnowledgeQuery {
  query: string;
  type?: KnowledgeEntryType;
  category?: string;
  tags?: string[];
  /** 按告警指标类型过滤 - Requirements: 2.1, 2.5 */
  metricType?: string;
  dateRange?: { from: number; to: number };
  limit?: number;
  minScore?: number;
  /** 排序选项 - Requirements: 13.1, 13.2 */
  sortOptions?: KnowledgeSortOptions;
  /** 新增：协议约束过滤 */
  protocolConstraint?: boolean;
}

/**
 * 知识搜索结果
 */
export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  score: number;
  highlights?: string[];
}

/**
 * 知识库统计
 */
export interface KnowledgeStats {
  totalEntries: number;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  recentAdditions: number;
  staleEntries: number;
  averageFeedbackScore: number;
}

/**
 * 反馈转知识条目输入
 */
export interface FeedbackToKnowledgeInput {
  feedbackId: string;
  alertId: string;
  ruleId?: string;
  ruleName: string;
  alertMessage: string;
  userComment?: string;
  resolution?: string;
  tags?: string[];
  context?: {
    metric?: string;
    currentValue?: number;
    threshold?: number;
    severity?: string;
  };
}

/**
 * 存储的知识条目（包含向量 ID）
 */
interface StoredKnowledgeEntry extends KnowledgeEntry {
  vectorId: string;
  contentHash: string;
}

// 知识库数据目录
const KNOWLEDGE_DATA_DIR = 'data/ai-ops/rag/knowledge';
const KNOWLEDGE_INDEX_FILE = 'index.json';

// 集合名称映射
const COLLECTION_MAP: Record<KnowledgeEntryType, string> = {
  alert: 'alerts_kb',
  remediation: 'remediations_kb',
  config: 'configs_kb',
  pattern: 'patterns_kb',
  manual: 'alerts_kb', // manual 条目存储在 alerts_kb 中
  feedback: 'alerts_kb', // feedback 条目也存储在 alerts_kb 中，便于与告警一起检索
  learning: 'remediations_kb', // learning 条目存储在 remediations_kb 中，便于与修复方案一起检索
  experience: 'remediations_kb', // experience 条目存储在 remediations_kb 中，便于与修复方案一起检索
};


/**
 * KnowledgeBase 知识库服务类
 */
export class KnowledgeBase {
  private _vectorDatabase: SQLiteVectorStore | null;
  private documentProcessor: DocumentProcessor;
  private embeddingService: EmbeddingService;
  private entries: Map<string, StoredKnowledgeEntry> = new Map();
  private initialized: boolean = false;
  /** 防止并发初始化的 Promise 缓存 */
  private initPromise: Promise<void> | null = null;
  private dataDir: string;
  /** 防止 recordEffectiveness 并发写入同一条目的锁 */
  private effectivenessLocks = new Map<string, Promise<void>>();

  // 低效条目标记/恢复阈值
  private static readonly LOW_EFFECTIVENESS_MIN_APPLICATIONS = 5;
  private static readonly LOW_EFFECTIVENESS_RATE_THRESHOLD = 0.3;
  private static readonly RECOVERY_RATE_THRESHOLD = 0.5;
  // applyHybridSort 毒药条目硬底线阈值
  private static readonly TOXIC_MIN_APPLICATIONS = 5;
  private static readonly TOXIC_RATE_THRESHOLD = 0.2;

  /**
   * 获取向量数据库实例（确保已初始化）
   */
  private get vectorDatabase(): SQLiteVectorStore {
    if (!this._vectorDatabase) {
      throw new Error('VectorDatabase 未初始化，请先调用 initialize()');
    }
    return this._vectorDatabase;
  }

  // 混合检索系统组件 (Requirements: 5.1)
  private hybridSearchEngine: HybridSearchEngine | null = null;
  private metadataEnhancer: MetadataEnhancer | null = null;
  private keywordIndexManager: KeywordIndexManager | null = null;
  private rrfRanker: RRFRanker | null = null;

  // Python Core 向量检索客户端（Requirements: J5.12, J5.13, J5.14）
  private vectorClient: VectorStoreClient | null = null;

  // 混合检索配置
  private hybridSearchConfig: {
    enabled: boolean;
    keywordWeight: number;
    vectorWeight: number;
  } = {
      enabled: true,
      keywordWeight: 0.4,
      vectorWeight: 0.6,
    };

  constructor(
    vectorDb?: SQLiteVectorStore,
    docProcessor?: DocumentProcessor,
    embeddingSvc?: EmbeddingService,
    dataDir?: string,
    // 混合检索组件（可选，用于依赖注入）
    hybridSearchEngine?: HybridSearchEngine,
    metadataEnhancer?: MetadataEnhancer,
    keywordIndexManager?: KeywordIndexManager,
    rrfRanker?: RRFRanker
  ) {
    this._vectorDatabase = vectorDb || null;
    this.documentProcessor = docProcessor || documentProcessor;
    this.embeddingService = embeddingSvc || embeddingService;
    this.dataDir = dataDir || KNOWLEDGE_DATA_DIR;

    // 混合检索组件（如果提供则使用，否则在初始化时创建）
    this.hybridSearchEngine = hybridSearchEngine || null;
    this.metadataEnhancer = metadataEnhancer || null;
    this.keywordIndexManager = keywordIndexManager || null;
    this.rrfRanker = rrfRanker || null;

    logger.info('KnowledgeBase created');
  }

  /**
   * 设置 VectorStoreClient（通过 Python Core 执行向量检索）
   * Requirements: J5.12, J5.13, J5.14
   */
  setVectorClient(client: VectorStoreClient): void {
    this.vectorClient = client;
    // 如果 HybridSearchEngine 已创建，立即转发
    if (this.hybridSearchEngine) {
      this.hybridSearchEngine.setVectorClient(client);
    }
    logger.info('KnowledgeBase: VectorStoreClient set for Python Core vector search');
  }

  /**
   * 初始化知识库
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // 并发安全：多个调用共享同一个初始化 Promise，避免重复初始化
    if (!this.initPromise) {
      this.initPromise = this._doInitialize();
    }
    return this.initPromise;
  }

  /**
   * 实际的初始化逻辑（仅由 initialize() 通过 initPromise 调用一次）
   */
  private async _doInitialize(): Promise<void> {    try {
      // 确保数据目录存在
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.mkdir(path.join(this.dataDir, 'entries'), { recursive: true });

      // 初始化向量数据库
      if (!this._vectorDatabase) {
        // 从服务注册表获取 SQLiteVectorStore 实例
        try {
          const { getService } = await import('../../bootstrap');
          this._vectorDatabase = getService<SQLiteVectorStore>('vectorDatabase');
        } catch {
          throw new Error('VectorDatabase 服务未注册，请先初始化 SQLiteVectorStore 或通过构造函数注入');
        }
      }
      if (!this._vectorDatabase.isInitialized()) {
        await this._vectorDatabase.initialize();
      }

      // 初始化嵌入服务
      if (!this.embeddingService.isInitialized()) {
        await this.embeddingService.initialize();
      }

      // 加载现有知识条目索引
      await this.loadIndex();

      // 初始化混合检索组件 (Requirements: 5.5)
      await this.initializeHybridSearch();

      // 自动同步向量索引（确保所有条目都有对应的向量）
      await this.syncVectorIndex();

      this.initialized = true;
      logger.info('KnowledgeBase initialized', {
        entriesCount: this.entries.size,
        hybridSearchEnabled: this.hybridSearchConfig.enabled,
      });
    } catch (error) {
      // 初始化失败时清除 Promise 缓存，允许下次重试
      this.initPromise = null;
      logger.error('Failed to initialize KnowledgeBase', { error });
      throw error;
    }
  }

  /**
   * 初始化混合检索组件
   * Requirements: 5.5
   */
  private async initializeHybridSearch(): Promise<void> {
    try {
      // 创建关键词索引管理器（如果未提供）
      if (!this.keywordIndexManager) {
        this.keywordIndexManager = new KeywordIndexManager({
          persistPath: path.join(this.dataDir, 'keyword-index'),
        });
      }
      await this.keywordIndexManager.initialize();

      // 创建元数据增强器（如果未提供）
      if (!this.metadataEnhancer) {
        this.metadataEnhancer = new MetadataEnhancer();
      }

      // 创建 RRF 排序器（如果未提供）
      if (!this.rrfRanker) {
        this.rrfRanker = new RRFRanker();
      }

      // 创建混合检索引擎（如果未提供）
      if (!this.hybridSearchEngine) {
        this.hybridSearchEngine = new HybridSearchEngine(
          this.keywordIndexManager,
          this.vectorDatabase,
          this.embeddingService,
          this.rrfRanker
        );
      }

      // 设置条目缓存引用
      this.hybridSearchEngine.setEntryCache(this.entries as Map<string, KnowledgeEntry>);

      // 转发 VectorStoreClient（如果已设置）
      if (this.vectorClient) {
        this.hybridSearchEngine.setVectorClient(this.vectorClient);
      }

      // 同步关键词索引（确保所有条目都已索引）
      await this.syncKeywordIndex();

      logger.info('Hybrid search components initialized');
    } catch (error) {
      logger.warn('Failed to initialize hybrid search, falling back to vector-only search', { error });
      this.hybridSearchConfig.enabled = false;
    }
  }

  /**
   * 同步关键词索引
   * 确保所有知识条目都已添加到关键词索引
   */
  private async syncKeywordIndex(): Promise<void> {
    if (!this.keywordIndexManager) return;

    let synced = 0;
    for (const [entryId, entry] of this.entries) {
      if (!this.keywordIndexManager.hasEntry(entryId)) {
        this.keywordIndexManager.addEntry(entryId, {
          title: entry.title,
          content: entry.content,
          tags: entry.metadata.tags || [],
          autoKeywords: entry.metadata.autoKeywords || [],
          questionExamples: entry.metadata.questionExamples || [],
        });
        synced++;
      }
    }

    if (synced > 0) {
      await this.keywordIndexManager.persist();
      logger.info('Synced keyword index', { synced });
    }
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('KnowledgeBase not initialized. Call initialize() first.');
    }
  }

  // ==================== 知识条目管理 ====================

  /**
   * 添加知识条目
   */
  async add(entry: Omit<KnowledgeEntry, 'id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<KnowledgeEntry> {
    this.ensureInitialized();

    const now = Date.now();
    const id = uuidv4();
    const contentHash = this.hashContent(entry.content);

    // 创建完整的知识条目
    const fullEntry: StoredKnowledgeEntry = {
      ...entry,
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      vectorId: '',
      contentHash,
      metadata: {
        ...entry.metadata,
        usageCount: entry.metadata.usageCount || 0,
        feedbackScore: entry.metadata.feedbackScore || 0,
        feedbackCount: entry.metadata.feedbackCount || 0,
      },
    };

    // 尝试向量化，失败时降级保存（条目可见但语义搜索不可用）
    let vectorized = false;
    try {
      const docSource: DocumentSource = {
        type: entry.type,
        id,
        content: `${entry.title}\n\n${entry.content}`,
        metadata: {
          ...entry.metadata,
          entryId: id,
          entryType: entry.type,
        },
      };

      const processedDocs = await this.documentProcessor.process(docSource);

      // 存储到向量数据库
      const collection = COLLECTION_MAP[entry.type];
      const vectorDocs: VectorDocument[] = processedDocs.map(doc => ({
        id: doc.id,
        content: doc.content,
        vector: doc.vector,
        metadata: {
          source: entry.type,
          category: entry.metadata.category,
          timestamp: now,
          tags: entry.metadata.tags,
          entryId: id,
          chunkIndex: doc.chunkIndex,
        },
      }));

      await this.vectorDatabase.insert(collection, vectorDocs);
      fullEntry.vectorId = processedDocs[0]?.id || '';
      vectorized = true;
    } catch (vectorError) {
      logger.warn(`Vectorization failed for entry ${id}, saving in degraded mode (no semantic search)`, { error: vectorError });
      fullEntry.vectorId = '';
    }

    try {
      // 添加到关键词索引 (Requirements: 5.2)
      if (this.keywordIndexManager) {
        this.keywordIndexManager.addEntry(id, {
          title: fullEntry.title,
          content: fullEntry.content,
          tags: fullEntry.metadata.tags || [],
          autoKeywords: fullEntry.metadata.autoKeywords || [],
          questionExamples: fullEntry.metadata.questionExamples || [],
        });
      }

      // 保存到内存和文件（无论向量化是否成功都保存）
      this.entries.set(id, fullEntry);
      await this.saveEntry(fullEntry);
      await this.saveIndex();

      // 异步增强元数据 (Requirements: 1.4, 5.2)
      this.scheduleMetadataEnhancement(fullEntry);

      logger.info(`Added knowledge entry: ${id}`, { type: entry.type, title: entry.title, vectorized });
      return this.toKnowledgeEntry(fullEntry);
    } catch (error) {
      logger.error(`Failed to add knowledge entry`, { error });
      throw error;
    }
  }

  /**
   * 更新知识条目
   */
  async update(id: string, updates: Partial<Omit<KnowledgeEntry, 'id' | 'createdAt'>>): Promise<KnowledgeEntry> {
    this.ensureInitialized();

    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Knowledge entry ${id} not found`);
    }

    const now = Date.now();
    const contentChanged = updates.content && updates.content !== existing.content;
    const newContentHash = contentChanged ? this.hashContent(updates.content!) : existing.contentHash;

    // 更新条目
    const updated: StoredKnowledgeEntry = {
      ...existing,
      ...updates,
      id,
      createdAt: existing.createdAt,
      updatedAt: now,
      version: existing.version + 1,
      contentHash: newContentHash,
      metadata: {
        ...existing.metadata,
        ...(updates.metadata || {}),
      },
    };

    try {
      // 如果内容变化，需要重新向量化
      if (contentChanged) {
        const collection = COLLECTION_MAP[updated.type];

        // 删除旧的向量
        const oldVectorIds = Array.from(this.entries.values())
          .filter(e => e.id === id)
          .map(e => e.vectorId)
          .filter(Boolean);

        if (oldVectorIds.length > 0) {
          await this.vectorDatabase.delete(collection, oldVectorIds);
        }

        // 重新处理文档
        const docSource: DocumentSource = {
          type: updated.type,
          id,
          content: `${updated.title}\n\n${updated.content}`,
          metadata: {
            ...updated.metadata,
            entryId: id,
            entryType: updated.type,
          },
        };

        const processedDocs = await this.documentProcessor.process(docSource);

        // 存储新向量
        const vectorDocs: VectorDocument[] = processedDocs.map(doc => ({
          id: doc.id,
          content: doc.content,
          vector: doc.vector,
          metadata: {
            source: updated.type,
            category: updated.metadata.category,
            timestamp: now,
            tags: updated.metadata.tags,
            entryId: id,
            chunkIndex: doc.chunkIndex,
          },
        }));

        await this.vectorDatabase.insert(collection, vectorDocs);
        updated.vectorId = processedDocs[0]?.id || '';
      }

      // 保存更新
      this.entries.set(id, updated);
      await this.saveEntry(updated);
      await this.saveIndex();

      // 更新关键词索引 (Requirements: 5.4)
      if (this.keywordIndexManager) {
        this.keywordIndexManager.updateEntry(id, {
          title: updated.title,
          content: updated.content,
          tags: updated.metadata.tags || [],
          autoKeywords: updated.metadata.autoKeywords || [],
          questionExamples: updated.metadata.questionExamples || [],
        });
      }

      // 如果内容变化，重新增强元数据
      if (contentChanged) {
        this.scheduleMetadataEnhancement(updated);
      }

      logger.info(`Updated knowledge entry: ${id}`);
      return this.toKnowledgeEntry(updated);
    } catch (error) {
      logger.error(`Failed to update knowledge entry ${id}`, { error });
      throw error;
    }
  }

  /**
   * 删除知识条目
   */
  async delete(id: string): Promise<void> {
    this.ensureInitialized();

    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Knowledge entry ${id} not found`);
    }

    try {
      // 从向量数据库删除
      const collection = COLLECTION_MAP[existing.type];

      // 查找所有相关的向量文档（可能有多个分块）
      const vectorIds = [`${id}_chunk_0`]; // 至少删除第一个分块
      for (let i = 1; i < 100; i++) {
        const chunkId = `${id}_chunk_${i}`;
        try {
          const doc = await this.vectorDatabase.get(collection, chunkId);
          if (doc) {
            vectorIds.push(chunkId);
          } else {
            break;
          }
        } catch {
          break;
        }
      }

      await this.vectorDatabase.delete(collection, vectorIds);

      // 从关键词索引删除 (Requirements: 5.4)
      if (this.keywordIndexManager) {
        this.keywordIndexManager.removeEntry(id);
      }

      // 从内存和文件删除
      this.entries.delete(id);
      await this.deleteEntryFile(id);
      await this.saveIndex();

      logger.info(`Deleted knowledge entry: ${id}`);
    } catch (error) {
      logger.error(`Failed to delete knowledge entry ${id}`, { error });
      throw error;
    }
  }

  /**
   * 获取知识条目
   */
  async get(id: string): Promise<KnowledgeEntry | null> {
    this.ensureInitialized();

    const entry = this.entries.get(id);
    return entry ? this.toKnowledgeEntry(entry) : null;
  }


  // ==================== 语义检索 ====================

  /**
   * 语义检索知识条目
   * Requirements: 13.1, 13.2, 13.3 - 支持数据库层面排序和限制返回数据量
   * Requirements: 5.1, 5.2, 5.3 - 混合检索集成
   * 
   * 增强功能：
   * - 混合检索：同时使用关键词检索和向量检索
   * - 搜索时自动修复：检测并修复索引不一致
   */
  async search(query: KnowledgeQuery): Promise<KnowledgeSearchResult[]> {
    this.ensureInitialized();

    try {
      // 确定要搜索的集合
      const collections = query.type
        ? [COLLECTION_MAP[query.type]]
        : Object.values(COLLECTION_MAP).filter((v, i, a) => a.indexOf(v) === i); // 去重

      const topK = query.limit || 10;

      // 如果启用混合检索，使用 HybridSearchEngine (Requirements: 5.1, 5.3)
      if (this.hybridSearchConfig.enabled && this.hybridSearchEngine) {
        try {
          const { results, metrics } = await this.hybridSearchEngine.search(
            query.query,
            collections,
            {
              topK,
              minScore: query.minScore || 0.3,
              keywordWeight: this.hybridSearchConfig.keywordWeight,
              vectorWeight: this.hybridSearchConfig.vectorWeight,
            }
          );

          // 转换为 KnowledgeSearchResult 格式
          let searchResults: KnowledgeSearchResult[] = results.map(r => ({
            entry: r.entry,
            score: r.score,
            highlights: r.matchedKeywords ? [`匹配关键词: ${r.matchedKeywords.join(', ')}`] : undefined,
          }));

          // 应用元数据过滤
          searchResults = searchResults.filter(r =>
            this.matchesFilter(this.entries.get(r.entry.id)!, query)
          );

          // 获取排序选项
          const sortOptions: Required<KnowledgeSortOptions> = {
            recencyWeight: query.sortOptions?.recencyWeight ?? 0.2,
            maxAgeMs: query.sortOptions?.maxAgeMs ?? (90 * 24 * 60 * 60 * 1000),
            enableHybridSort: query.sortOptions?.enableHybridSort ?? true,
            effectivenessWeight: query.sortOptions?.effectivenessWeight ?? 0.15,
          };

          // 应用时效性混合排序
          if (sortOptions.enableHybridSort) {
            searchResults = this.applyHybridSort(searchResults, sortOptions);
          }

          logger.debug(`Hybrid search found ${searchResults.length} results`, {
            query: query.query,
            keywordHits: metrics.keywordHits,
            vectorHits: metrics.vectorHits,
            totalTime: metrics.totalTime,
          });

          return searchResults.slice(0, topK);
        } catch (error) {
          logger.warn('Hybrid search failed, falling back to vector-only search', {
            error: error instanceof Error ? error.message : String(error),
          });
          // 降级到向量检索
        }
      }

      // 降级：使用原有的纯向量检索
      return this.vectorOnlySearch(query, collections, topK);
    } catch (error) {
      logger.error('Knowledge search failed', { error, query: query.query });
      throw error;
    }
  }

  /**
   * 纯向量检索（降级方法）
   * Requirements: 7.1, 7.2 - 降级保证
   */
  private async vectorOnlySearch(
    query: KnowledgeQuery,
    collections: string[],
    topK: number
  ): Promise<KnowledgeSearchResult[]> {
    // 生成查询向量
    const queryEmbedding = await this.embeddingService.embed(query.query);

    const allResults: KnowledgeSearchResult[] = [];

    // 获取排序选项，使用默认值
    const sortOptions: Required<KnowledgeSortOptions> = {
      recencyWeight: query.sortOptions?.recencyWeight ?? 0.2,
      maxAgeMs: query.sortOptions?.maxAgeMs ?? (90 * 24 * 60 * 60 * 1000), // 90 天
      enableHybridSort: query.sortOptions?.enableHybridSort ?? true,
      effectivenessWeight: query.sortOptions?.effectivenessWeight ?? 0.15,
    };

    // 用于追踪需要修复的条目
    const orphanedVectorIds: Set<string> = new Set();
    const missingVectorEntryIds: Set<string> = new Set();

    for (const collection of collections) {
      // 构建搜索选项
      const searchOptions: SearchOptions = {
        topK: sortOptions.enableHybridSort ? topK * 3 : topK,
        minScore: query.minScore || 0.3,
        includeVector: false,
      };

      // 执行向量搜索
      const results = await this.vectorDatabase.search(collection, queryEmbedding.vector, searchOptions);

      // 转换为知识搜索结果
      for (const result of results) {
        const entryId = result.document.metadata.entryId as string;
        if (!entryId) {
          orphanedVectorIds.add(result.document.id);
          continue;
        }

        const entry = this.entries.get(entryId);
        if (!entry) {
          orphanedVectorIds.add(result.document.id);
          logger.warn(`Vector references non-existent entry: ${entryId}`, {
            vectorId: result.document.id,
            collection
          });
          continue;
        }

        // 应用元数据过滤
        if (!this.matchesFilter(entry, query)) continue;

        // 检查是否已添加
        const existingIndex = allResults.findIndex(r => r.entry.id === entryId);
        if (existingIndex >= 0) {
          if (result.score > allResults[existingIndex].score) {
            allResults[existingIndex].score = result.score;
          }
        } else {
          allResults.push({
            entry: this.toKnowledgeEntry(entry),
            score: result.score,
            highlights: [result.document.content.substring(0, 200)],
          });
        }
      }
    }

    // 检查是否有 entries 没有被搜索到
    if (allResults.length < topK && this.entries.size > 0) {
      await this.checkAndRepairMissingVectors(missingVectorEntryIds, collections);
    }

    // 异步触发修复
    if (orphanedVectorIds.size > 0 || missingVectorEntryIds.size > 0) {
      this.scheduleAutoRepair(orphanedVectorIds, missingVectorEntryIds);
    }

    // 应用混合排序
    let sortedResults: KnowledgeSearchResult[];
    if (sortOptions.enableHybridSort) {
      sortedResults = this.applyHybridSort(allResults, sortOptions);
    } else {
      sortedResults = allResults.sort((a, b) => b.score - a.score);
    }

    const limitedResults = sortedResults.slice(0, topK);

    logger.debug(`Vector-only search found ${limitedResults.length} results`, { query: query.query });
    return limitedResults;
  }

  /**
   * 检查并记录缺失向量的条目
   * 
   * @param missingVectorEntryIds 用于记录缺失向量的条目 ID
   * @param collections 要检查的集合列表
   */
  private async checkAndRepairMissingVectors(
    missingVectorEntryIds: Set<string>,
    collections: string[]
  ): Promise<void> {
    // 抽样检查一部分条目（避免每次搜索都全量检查）
    const sampleSize = Math.min(10, this.entries.size);
    const entryIds = Array.from(this.entries.keys());
    const sampledIds = this.sampleArray(entryIds, sampleSize);

    for (const entryId of sampledIds) {
      const entry = this.entries.get(entryId);
      if (!entry) continue;

      const collection = COLLECTION_MAP[entry.type];
      if (!collections.includes(collection)) continue;

      const hasVector = await this.checkEntryHasVector(entryId, collection);
      if (!hasVector) {
        missingVectorEntryIds.add(entryId);
        logger.warn(`Entry missing vector: ${entryId}`, { type: entry.type, title: entry.title });
      }
    }
  }

  /**
   * 从数组中随机抽样
   */
  private sampleArray<T>(array: T[], size: number): T[] {
    if (size >= array.length) return array;

    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, size);
  }

  /**
   * 调度自动修复任务（异步执行，不阻塞搜索）
   * 
   * @param orphanedVectorIds 孤立向量 ID 集合
   * @param missingVectorEntryIds 缺失向量的条目 ID 集合
   */
  private scheduleAutoRepair(
    orphanedVectorIds: Set<string>,
    missingVectorEntryIds: Set<string>
  ): void {
    // 使用 setImmediate 异步执行，不阻塞当前搜索
    setImmediate(async () => {
      try {
        // 修复缺失向量的条目
        if (missingVectorEntryIds.size > 0) {
          logger.info(`Auto-repairing ${missingVectorEntryIds.size} entries with missing vectors`);

          for (const entryId of missingVectorEntryIds) {
            const entry = this.entries.get(entryId);
            if (entry) {
              try {
                await this.reindexEntry(entry);
                logger.info(`Auto-repaired entry: ${entryId}`);
              } catch (error) {
                logger.error(`Failed to auto-repair entry: ${entryId}`, { error });
              }
            }
          }
        }

        // 记录孤立向量（暂不自动删除，避免误删）
        if (orphanedVectorIds.size > 0) {
          logger.warn(`Found ${orphanedVectorIds.size} orphaned vectors`, {
            vectorIds: Array.from(orphanedVectorIds).slice(0, 10),
          });
        }
      } catch (error) {
        logger.error('Auto-repair failed', { error });
      }
    });
  }

  /**
   * 应用混合排序（相似度 + 时效性）
   * Requirements: 13.2 - 在数据库层面完成相似度和时效性的混合排序
   * 
   * @param documents 待排序的文档列表
   * @param sortOptions 排序选项
   * @returns 排序后的文档列表
   */
  private applyHybridSort(
    documents: KnowledgeSearchResult[],
    sortOptions: Required<KnowledgeSortOptions>
  ): KnowledgeSearchResult[] {
    const now = Date.now();
    const { recencyWeight, maxAgeMs, effectivenessWeight } = sortOptions;

    // 权重合法性校验
    if (recencyWeight + effectivenessWeight > 1) {
      logger.warn(
        `Sort weights exceed 1: recencyWeight=${recencyWeight}, effectivenessWeight=${effectivenessWeight}. ` +
        `Similarity score will be ignored.`
      );
    }

    // 相似度权重 = 剩余权重（确保三项权重之和为 1）
    const similarityWeight = Math.max(0, 1 - recencyWeight - effectivenessWeight);

    return documents
      .map(doc => {
        // 计算时效性分数：越新的文档分数越高
        const age = now - doc.entry.metadata.timestamp;
        const recencyScore = Math.max(0, 1 - age / maxAgeMs);

        // 计算效果分数：基于 successRate 和 totalApplications
        const effectiveness = doc.entry.metadata.effectiveness;
        let effectivenessScore: number;

        if (!effectiveness || effectiveness.totalApplications === 0) {
          // 没有使用记录的条目，给中性分 0.5（不奖不罚）
          effectivenessScore = 0.5;
        } else if (
          effectiveness.totalApplications >= KnowledgeBase.TOXIC_MIN_APPLICATIONS &&
          effectiveness.successRate < KnowledgeBase.TOXIC_RATE_THRESHOLD
        ) {
          // 硬底线：多次应用但成功率极低的"毒药"条目，直接压到接近零
          effectivenessScore = 0.05;
        } else {
          // 基础分 = 成功率
          effectivenessScore = effectiveness.successRate;
          // 经验加成：使用次数越多且成功率高，微调上升（log 平滑避免无限放大）
          const usageBoost = Math.log1p(effectiveness.totalApplications) * 0.02;
          effectivenessScore = Math.min(1, effectivenessScore + usageBoost);
        }

        // 三维混合分数 = 相似度 * simWeight + 时效性 * recencyWeight + 效果 * effectivenessWeight
        const combinedScore =
          doc.score * similarityWeight +
          recencyScore * recencyWeight +
          effectivenessScore * effectivenessWeight;

        return {
          ...doc,
          // 保存原始相似度分数，使用混合分数进行排序
          _combinedScore: combinedScore,
        };
      })
      .sort((a, b) => (b as any)._combinedScore - (a as any)._combinedScore)
      .map(doc => {
        // 移除内部排序字段
        const { _combinedScore: __, ...result } = doc as any;
        return result as KnowledgeSearchResult;
      });
  }

  /**
   * 检查条目是否匹配过滤条件
   */
  private matchesFilter(entry: StoredKnowledgeEntry, query: KnowledgeQuery): boolean {
    // 类型过滤
    if (query.type && entry.type !== query.type) {
      return false;
    }

    // 类别过滤
    if (query.category && entry.metadata.category !== query.category) {
      return false;
    }

    // 标签过滤
    if (query.tags && query.tags.length > 0) {
      const hasAllTags = query.tags.every(tag => entry.metadata.tags.includes(tag));
      if (!hasAllTags) return false;
    }

    // 日期范围过滤
    if (query.dateRange) {
      if (entry.metadata.timestamp < query.dateRange.from) return false;
      if (entry.metadata.timestamp > query.dateRange.to) return false;
    }

    // metricType / Category 过滤 - Requirements: 2.1, 2.2
    // 优先检查 metadata.category，然后检查 metadata.metricType
    if (query.category) {
      if (entry.metadata.category !== query.category) {
        return false;
      }
    } else if (query.metricType) {
      // 如果没有指定 category，回退到 metricType 过滤
      if (entry.metadata.metricType) {
        if (entry.metadata.metricType !== query.metricType) {
          return false;
        }
      } else if (entry.metadata.category !== query.metricType) {
        return false;
      }
    }

    return true;
  }

  // ==================== 自动索引 ====================

  /**
   * 索引告警事件
   */
  async indexAlert(alertEvent: AlertEvent, analysis?: RootCauseAnalysis): Promise<void> {
    this.ensureInitialized();

    try {
      const content = this.buildAlertContent(alertEvent, analysis);

      const tags: string[] = [alertEvent.severity, alertEvent.status, alertEvent.metric];
      const semanticTags: string[] = [];
      if (analysis?.metadata?.aiCategory) tags.push(analysis.metadata.aiCategory);
      if (analysis?.metadata?.isProtocolIssue) {
        tags.push('protocol-issue');
        semanticTags.push('protocol-first');
      }

      // Phase 2: 将 AI 提取的 subCategory 和 keywords 强制写入 tags 和 semanticTags
      const aiMetadata = analysis?.metadata as any;
      if (aiMetadata?.subCategory) {
        tags.push(aiMetadata.subCategory);
        semanticTags.push(aiMetadata.subCategory);
      }
      if (aiMetadata?.searchKeywords && Array.isArray(aiMetadata.searchKeywords)) {
        tags.push(...aiMetadata.searchKeywords);
        semanticTags.push(...aiMetadata.searchKeywords);
      }

      await this.add({
        type: 'alert',
        title: `告警: ${alertEvent.ruleName} - ${alertEvent.message}`,
        content,
        metadata: {
          source: 'alert_engine',
          timestamp: alertEvent.triggeredAt,
          category: analysis?.metadata?.aiCategory || alertEvent.metric,
          tags,
          semanticTags,
          usageCount: 0,
          feedbackScore: 0,
          feedbackCount: 0,
          relatedIds: analysis ? [analysis.id] : undefined,
          metricType: alertEvent.metric, // 用于兼容旧版过滤
          protocolConstraint: analysis?.metadata?.isProtocolIssue,
          originalData: {
            alertId: alertEvent.id,
            ruleId: alertEvent.ruleId,
            severity: alertEvent.severity,
            metric: alertEvent.metric,
            threshold: alertEvent.threshold,
            currentValue: alertEvent.currentValue,
            aiClassification: analysis?.metadata,
          },
        },
      });

      logger.info(`Indexed alert: ${alertEvent.id}`);
    } catch (error) {
      logger.error(`Failed to index alert ${alertEvent.id}`, { error });
      // 不抛出错误，避免影响主流程
    }
  }

  /**
   * 索引修复方案
   */
  async indexRemediation(plan: RemediationPlan, results: ExecutionResult[]): Promise<void> {
    this.ensureInitialized();

    try {
      const content = this.buildRemediationContent(plan, results);
      const successRate = results.filter(r => r.success).length / results.length;

      await this.add({
        type: 'remediation',
        title: `修复方案: ${plan.id}`,
        content,
        metadata: {
          source: 'remediation_advisor',
          timestamp: plan.timestamp,
          category: plan.overallRisk,
          tags: [plan.status, plan.overallRisk, `success_rate_${Math.round(successRate * 100)}`],
          usageCount: 0,
          feedbackScore: 0,
          feedbackCount: 0,
          relatedIds: [plan.alertId, plan.rootCauseId],
          originalData: {
            planId: plan.id,
            alertId: plan.alertId,
            rootCauseId: plan.rootCauseId,
            status: plan.status,
            overallRisk: plan.overallRisk,
            successRate,
          },
        },
      });

      logger.info(`Indexed remediation plan: ${plan.id}`);
    } catch (error) {
      logger.error(`Failed to index remediation plan ${plan.id}`, { error });
    }
  }

  /**
   * 索引配置快照
   */
  async indexConfig(snapshot: ConfigSnapshot, diff?: SnapshotDiff): Promise<void> {
    this.ensureInitialized();

    try {
      const content = this.buildConfigContent(snapshot, diff);

      await this.add({
        type: 'config',
        title: `配置快照: ${snapshot.id}`,
        content,
        metadata: {
          source: 'config_snapshot_service',
          timestamp: snapshot.timestamp,
          category: snapshot.trigger,
          tags: [snapshot.trigger, ...(diff?.aiAnalysis?.riskLevel ? [diff.aiAnalysis.riskLevel] : [])],
          usageCount: 0,
          feedbackScore: 0,
          feedbackCount: 0,
          originalData: {
            snapshotId: snapshot.id,
            trigger: snapshot.trigger,
            size: snapshot.size,
            checksum: snapshot.checksum,
            hasChanges: diff ? (diff.additions.length + diff.modifications.length + diff.deletions.length) > 0 : false,
          },
        },
      });

      logger.info(`Indexed config snapshot: ${snapshot.id}`);
    } catch (error) {
      logger.error(`Failed to index config snapshot ${snapshot.id}`, { error });
    }
  }

  /**
   * 索引故障模式
   */
  async indexPattern(pattern: FaultPattern): Promise<void> {
    this.ensureInitialized();

    try {
      const content = this.buildPatternContent(pattern);

      await this.add({
        type: 'pattern',
        title: `故障模式: ${pattern.name}`,
        content,
        metadata: {
          source: 'fault_healer',
          timestamp: pattern.updatedAt || pattern.createdAt,
          category: pattern.builtin ? 'builtin' : 'custom',
          tags: [
            pattern.enabled ? 'enabled' : 'disabled',
            pattern.autoHeal ? 'auto_heal' : 'manual',
            ...pattern.conditions.map(c => c.metric),
          ],
          usageCount: 0,
          feedbackScore: 0,
          feedbackCount: 0,
          originalData: {
            patternId: pattern.id,
            name: pattern.name,
            enabled: pattern.enabled,
            autoHeal: pattern.autoHeal,
            builtin: pattern.builtin,
          },
        },
      });

      logger.info(`Indexed fault pattern: ${pattern.id}`);
    } catch (error) {
      logger.error(`Failed to index fault pattern ${pattern.id}`, { error });
    }
  }


  // ==================== 批量操作 ====================

  /**
   * 批量添加知识条目
   */
  async bulkAdd(entries: Array<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'updatedAt' | 'version'>>): Promise<KnowledgeEntry[]> {
    this.ensureInitialized();

    const results: KnowledgeEntry[] = [];

    for (const entry of entries) {
      try {
        const added = await this.add(entry);
        results.push(added);
      } catch (error) {
        logger.error('Failed to add entry in bulk operation', { error, title: entry.title });
      }
    }

    logger.info(`Bulk added ${results.length}/${entries.length} knowledge entries`);
    return results;
  }

  /**
   * 批量删除知识条目
   */
  async bulkDelete(ids: string[]): Promise<void> {
    this.ensureInitialized();

    let deleted = 0;
    for (const id of ids) {
      try {
        await this.delete(id);
        deleted++;
      } catch (error) {
        logger.error(`Failed to delete entry ${id} in bulk operation`, { error });
      }
    }

    logger.info(`Bulk deleted ${deleted}/${ids.length} knowledge entries`);
  }

  // ==================== 导入导出 ====================

  /**
   * 导出知识条目
   */
  async export(filter?: Partial<KnowledgeQuery>): Promise<KnowledgeEntry[]> {
    this.ensureInitialized();

    let entries = Array.from(this.entries.values()).map(e => this.toKnowledgeEntry(e));

    // 应用过滤
    if (filter) {
      if (filter.type) {
        entries = entries.filter(e => e.type === filter.type);
      }
      if (filter.category) {
        entries = entries.filter(e => e.metadata.category === filter.category);
      }
      if (filter.tags && filter.tags.length > 0) {
        entries = entries.filter(e =>
          filter.tags!.every(tag => e.metadata.tags.includes(tag))
        );
      }
      if (filter.dateRange) {
        entries = entries.filter(e =>
          e.metadata.timestamp >= filter.dateRange!.from &&
          e.metadata.timestamp <= filter.dateRange!.to
        );
      }
    }

    logger.info(`Exported ${entries.length} knowledge entries`);
    return entries;
  }

  /**
   * 导入知识条目
   */
  async import(entries: KnowledgeEntry[]): Promise<{ success: number; failed: number }> {
    this.ensureInitialized();

    let success = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        // 检查是否已存在
        const existing = this.entries.get(entry.id);
        if (existing) {
          // 更新现有条目
          await this.update(entry.id, {
            title: entry.title,
            content: entry.content,
            type: entry.type,
            metadata: entry.metadata,
          });
        } else {
          // 添加新条目
          await this.add({
            type: entry.type,
            title: entry.title,
            content: entry.content,
            metadata: entry.metadata,
          });
        }
        success++;
      } catch (error) {
        logger.error(`Failed to import entry ${entry.id}`, { error });
        failed++;
      }
    }

    logger.info(`Imported knowledge entries: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  // ==================== 维护 ====================

  /**
   * 标记过期条目
   */
  async markStale(olderThanDays: number): Promise<number> {
    this.ensureInitialized();

    const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let count = 0;

    for (const [_, entry] of this.entries) {
      if (entry.metadata.timestamp < threshold && !entry.metadata.tags.includes('stale')) {
        entry.metadata.tags.push('stale');
        entry.updatedAt = Date.now();
        await this.saveEntry(entry);
        count++;
      }
    }

    if (count > 0) {
      await this.saveIndex();
    }

    logger.info(`Marked ${count} entries as stale`);
    return count;
  }

  /**
   * 清理过期条目
   */
  async cleanup(olderThanDays: number): Promise<number> {
    this.ensureInitialized();

    const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const [id, entry] of this.entries) {
      if (entry.metadata.timestamp < threshold && entry.metadata.usageCount === 0) {
        toDelete.push(id);
      }
    }

    await this.bulkDelete(toDelete);
    logger.info(`Cleaned up ${toDelete.length} stale entries`);
    return toDelete.length;
  }

  /**
   * 重建索引
   */
  async reindex(): Promise<void> {
    this.ensureInitialized();

    logger.info('Starting knowledge base reindex...');
    const entries = Array.from(this.entries.values());

    // 清空向量数据库中的所有集合
    const collections = Object.values(COLLECTION_MAP).filter((v, i, a) => a.indexOf(v) === i);
    for (const collection of collections) {
      try {
        await this.vectorDatabase.dropCollection(collection);
        await this.vectorDatabase.createCollection(collection);
      } catch (error) {
        logger.warn(`Failed to reset collection ${collection}`, { error });
      }
    }

    // 重新索引所有条目
    for (const entry of entries) {
      try {
        const docSource: DocumentSource = {
          type: entry.type,
          id: entry.id,
          content: `${entry.title}\n\n${entry.content}`,
          metadata: {
            ...entry.metadata,
            entryId: entry.id,
            entryType: entry.type,
          },
        };

        const processedDocs = await this.documentProcessor.process(docSource);
        const collection = COLLECTION_MAP[entry.type];

        const vectorDocs: VectorDocument[] = processedDocs.map(doc => ({
          id: doc.id,
          content: doc.content,
          vector: doc.vector,
          metadata: {
            source: entry.type,
            category: entry.metadata.category,
            timestamp: entry.metadata.timestamp,
            tags: entry.metadata.tags,
            entryId: entry.id,
            chunkIndex: doc.chunkIndex,
          },
        }));

        await this.vectorDatabase.insert(collection, vectorDocs);
        entry.vectorId = processedDocs[0]?.id || '';
      } catch (error) {
        logger.error(`Failed to reindex entry ${entry.id}`, { error });
      }
    }

    await this.saveIndex();
    logger.info(`Reindex completed for ${entries.length} entries`);
  }

  // ==================== 统计 ====================

  /**
   * 获取知识库统计
   */
  async getStats(): Promise<KnowledgeStats> {
    this.ensureInitialized();

    const entries = Array.from(this.entries.values());
    const now = Date.now();
    const recentThreshold = now - 7 * 24 * 60 * 60 * 1000; // 7 天内
    const staleThreshold = now - 90 * 24 * 60 * 60 * 1000; // 90 天

    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let recentAdditions = 0;
    let staleEntries = 0;
    let totalFeedbackScore = 0;
    let feedbackCount = 0;

    for (const entry of entries) {
      // 按类型统计
      byType[entry.type] = (byType[entry.type] || 0) + 1;

      // 按类别统计
      byCategory[entry.metadata.category] = (byCategory[entry.metadata.category] || 0) + 1;

      // 最近添加
      if (entry.createdAt > recentThreshold) {
        recentAdditions++;
      }

      // 过期条目
      if (entry.metadata.timestamp < staleThreshold && entry.metadata.usageCount === 0) {
        staleEntries++;
      }

      // 反馈分数
      if (entry.metadata.feedbackCount > 0) {
        totalFeedbackScore += entry.metadata.feedbackScore;
        feedbackCount += entry.metadata.feedbackCount;
      }
    }

    return {
      totalEntries: entries.length,
      byType,
      byCategory,
      recentAdditions,
      staleEntries,
      averageFeedbackScore: feedbackCount > 0 ? totalFeedbackScore / feedbackCount : 0,
    };
  }

  // ==================== 反馈 ====================

  /**
   * 记录使用
   */
  async recordUsage(id: string): Promise<void> {
    this.ensureInitialized();

    const entry = this.entries.get(id);
    if (!entry) {
      logger.warn(`Cannot record usage for non-existent entry: ${id}`);
      return;
    }

    entry.metadata.usageCount++;
    entry.metadata.lastUsed = Date.now();
    entry.updatedAt = Date.now();

    await this.saveEntry(entry);
    logger.debug(`Recorded usage for entry: ${id}`);
  }

  /**
   * 记录反馈
   */
  async recordFeedback(id: string, score: number): Promise<void> {
    this.ensureInitialized();

    const entry = this.entries.get(id);
    if (!entry) {
      logger.warn(`Cannot record feedback for non-existent entry: ${id}`);
      return;
    }

    // 计算新的平均分数
    const totalScore = entry.metadata.feedbackScore * entry.metadata.feedbackCount + score;
    entry.metadata.feedbackCount++;
    entry.metadata.feedbackScore = totalScore / entry.metadata.feedbackCount;
    entry.updatedAt = Date.now();

    await this.saveEntry(entry);
    logger.debug(`Recorded feedback for entry: ${id}, score: ${score}`);
  }

  /**
   * 增加使用计数（别名方法）
   * Requirements: 4.4, 11.1 - 智能知识应用系统
   * 
   * @param id 知识条目 ID
   */
  async incrementUsage(id: string): Promise<void> {
    return this.recordUsage(id);
  }

  /**
   * 更新反馈分数（别名方法）
   * Requirements: 4.5, 11.4 - 智能知识应用系统
   * 
   * @param id 知识条目 ID
   * @param score 反馈分数 (1-5)
   */
  async updateFeedback(id: string, score: number): Promise<void> {
    return this.recordFeedback(id, score);
  }

  /**
   * 记录解决结果
   * Requirements: 11.5, 12.1, 12.2 - 智能知识应用系统
   * 
   * 记录知识条目在问题解决中的应用结果，用于追踪知识的有效性
   * 
   * @param id 知识条目 ID
   * @param success 是否成功解决问题
   * @param context 解决上下文
   */
  async recordResolution(
    id: string,
    success: boolean,
    context?: {
      alertId?: string;
      resolutionTimeMs?: number;
      query?: string;
      feedback?: number;
    }
  ): Promise<void> {
    this.ensureInitialized();

    const entry = this.entries.get(id);
    if (!entry) {
      logger.warn(`Cannot record resolution for non-existent entry: ${id}`);
      return;
    }

    // 记录效果
    await this.recordEffectiveness(id, success, context?.resolutionTimeMs);

    // 如果有反馈分数，也记录反馈
    if (context?.feedback !== undefined) {
      await this.recordFeedback(id, context.feedback);
    }

    // 记录使用
    await this.recordUsage(id);

    logger.info(`Recorded resolution for entry ${id}`, {
      success,
      alertId: context?.alertId,
      resolutionTimeMs: context?.resolutionTimeMs,
    });
  }

  // ==================== 规则关联 ====================

  /**
   * 关联知识条目与告警规则
   * Requirements: 6.1
   */
  async linkToRule(entryId: string, ruleId: string): Promise<void> {
    this.ensureInitialized();

    const entry = this.entries.get(entryId);
    if (!entry) {
      throw new Error(`Knowledge entry ${entryId} not found`);
    }

    // 初始化 linkedRuleIds 数组
    if (!entry.metadata.linkedRuleIds) {
      entry.metadata.linkedRuleIds = [];
    }

    // 避免重复关联
    if (!entry.metadata.linkedRuleIds.includes(ruleId)) {
      entry.metadata.linkedRuleIds.push(ruleId);
      entry.updatedAt = Date.now();
      await this.saveEntry(entry);
      await this.saveIndex();
      logger.info(`Linked knowledge entry ${entryId} to rule ${ruleId}`);
    }
  }

  /**
   * 取消知识条目与告警规则的关联
   * Requirements: 6.1
   */
  async unlinkFromRule(entryId: string, ruleId: string): Promise<void> {
    this.ensureInitialized();

    const entry = this.entries.get(entryId);
    if (!entry) {
      throw new Error(`Knowledge entry ${entryId} not found`);
    }

    if (entry.metadata.linkedRuleIds) {
      const index = entry.metadata.linkedRuleIds.indexOf(ruleId);
      if (index !== -1) {
        entry.metadata.linkedRuleIds.splice(index, 1);
        entry.updatedAt = Date.now();
        await this.saveEntry(entry);
        await this.saveIndex();
        logger.info(`Unlinked knowledge entry ${entryId} from rule ${ruleId}`);
      }
    }
  }

  /**
   * 获取规则关联的知识条目
   * Requirements: 6.2
   */
  async getEntriesByRule(ruleId: string): Promise<KnowledgeEntry[]> {
    this.ensureInitialized();

    const results: KnowledgeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.metadata.linkedRuleIds?.includes(ruleId)) {
        results.push(this.toKnowledgeEntry(entry));
      }
    }

    return results;
  }

  /**
   * 获取知识条目关联的规则
   * Requirements: 6.3
   */
  async getRulesByEntry(entryId: string): Promise<string[]> {
    this.ensureInitialized();

    const entry = this.entries.get(entryId);
    if (!entry) {
      throw new Error(`Knowledge entry ${entryId} not found`);
    }

    return entry.metadata.linkedRuleIds || [];
  }

  /**
   * 基于内容相似度建议关联
   * Requirements: 6.4
   * 
   * @param ruleId 告警规则 ID
   * @param ruleName 告警规则名称
   * @param ruleDescription 告警规则描述（可选）
   * @param minScore 最小相似度阈值，默认 0.5
   * @param limit 返回结果数量限制，默认 5
   */
  async suggestAssociations(
    ruleId: string,
    ruleName: string,
    ruleDescription?: string,
    minScore: number = 0.5,
    limit: number = 5
  ): Promise<KnowledgeSearchResult[]> {
    this.ensureInitialized();

    // 构建查询文本
    const queryText = ruleDescription
      ? `${ruleName} ${ruleDescription}`
      : ruleName;

    try {
      // 使用语义搜索查找相似的知识条目
      const results = await this.search({
        query: queryText,
        limit: limit * 2, // 获取更多结果以便过滤
        minScore,
      });

      // 过滤掉已经关联的条目
      const filteredResults = results.filter(result => {
        const linkedRules = result.entry.metadata.linkedRuleIds || [];
        return !linkedRules.includes(ruleId);
      });

      // 限制返回数量
      return filteredResults.slice(0, limit);
    } catch (error) {
      logger.error(`Failed to suggest associations for rule ${ruleId}`, { error });
      return [];
    }
  }

  // ==================== 反馈转换 ====================

  /**
   * 从反馈创建知识条目
   * Requirements: 5.5, 5.6
   * 
   * @param feedbackData 反馈数据
   */
  async createFromFeedback(feedbackData: FeedbackToKnowledgeInput): Promise<KnowledgeEntry> {
    this.ensureInitialized();

    const {
      feedbackId,
      alertId,
      ruleId,
      ruleName,
      alertMessage,
      userComment,
      resolution,
      tags = [],
    } = feedbackData;

    // 构建知识条目内容
    const content = this.buildFeedbackContent(feedbackData);

    // 生成标题
    const title = resolution
      ? `解决方案: ${ruleName} - ${resolution.substring(0, 50)}${resolution.length > 50 ? '...' : ''}`
      : `反馈: ${ruleName} - ${alertMessage.substring(0, 50)}${alertMessage.length > 50 ? '...' : ''}`;

    // 创建知识条目
    const entry = await this.add({
      type: 'manual',
      title,
      content,
      metadata: {
        source: 'feedback_conversion',
        timestamp: Date.now(),
        category: 'feedback',
        tags: ['from_feedback', ...tags],
        usageCount: 0,
        feedbackScore: 0,
        feedbackCount: 0,
        relatedIds: [alertId],
        linkedRuleIds: ruleId ? [ruleId] : [],
        createdFromFeedback: true,
        feedbackSourceId: feedbackId,
        metricType: feedbackData.context?.metric, // 确保记录了指标类型以便过滤
        originalData: {
          feedbackId,
          alertId,
          ruleId,
          ruleName,
          userComment, // 记录原始注释
        },
      },
    });

    logger.info(`Created knowledge entry from feedback: ${entry.id}`, {
      feedbackId,
      alertId,
      ruleId,
    });

    return entry;
  }

  /**
   * 构建反馈内容
   */
  private buildFeedbackContent(feedbackData: FeedbackToKnowledgeInput): string {
    const {
      ruleName,
      alertMessage,
      userComment,
      resolution,
      context,
    } = feedbackData;

    let content = `## 告警信息\n\n`;
    content += `- **规则名称**: ${ruleName}\n`;
    content += `- **告警消息**: ${alertMessage}\n\n`;

    if (context) {
      content += `## 上下文\n\n`;
      if (context.metric) {
        content += `- **指标类型**: ${context.metric}\n`;
      }
      if (context.currentValue !== undefined) {
        content += `- **当前值**: ${context.currentValue}\n`;
      }
      if (context.threshold !== undefined) {
        content += `- **阈值**: ${context.threshold}\n`;
      }
      if (context.severity) {
        content += `- **严重级别**: ${context.severity}\n`;
      }
      content += '\n';
    }

    if (userComment) {
      content += `## 用户反馈\n\n${userComment}\n\n`;
    }

    if (resolution) {
      content += `## 解决方案\n\n${resolution}\n`;
    }

    return content.trim();
  }

  // ==================== 效果追踪 ====================

  /**
   * 记录知识条目在告警解决中的应用
   * Requirements: 6.5
   * 
   * @param entryId 知识条目 ID
   * @param success 是否成功解决
   * @param resolutionTimeMs 解决耗时（毫秒）
   */
  async recordEffectiveness(
    entryId: string,
    success: boolean,
    resolutionTimeMs?: number
  ): Promise<void> {
    // 并发锁：等待同一 entryId 的上一次写入完成
    while (this.effectivenessLocks.has(entryId)) {
      await this.effectivenessLocks.get(entryId);
    }

    const lockPromise = (async () => {
      try {
        this.ensureInitialized();

        const entry = this.entries.get(entryId);
        if (!entry) {
          logger.warn(`Cannot record effectiveness for non-existent entry: ${entryId}`);
          return;
        }

        // 初始化效果追踪数据
        if (!entry.metadata.effectiveness) {
          entry.metadata.effectiveness = {
            resolvedAlerts: 0,
            avgResolutionTime: 0,
            successRate: 0,
            totalApplications: 0,
          };
        }

        const effectiveness = entry.metadata.effectiveness;
        effectiveness.totalApplications++;

        if (success) {
          effectiveness.resolvedAlerts++;
          effectiveness.lastEffectiveAt = Date.now();

          // 更新平均解决时间
          if (resolutionTimeMs !== undefined) {
            const totalTime = effectiveness.avgResolutionTime * (effectiveness.resolvedAlerts - 1) + resolutionTimeMs;
            effectiveness.avgResolutionTime = totalTime / effectiveness.resolvedAlerts;
          }
        }

        // 更新成功率
        effectiveness.successRate = effectiveness.resolvedAlerts / effectiveness.totalApplications;

        // 低效条目自动标记：多次应用但成功率极低时，打上 low-effectiveness 标签
        if (
          effectiveness.totalApplications >= KnowledgeBase.LOW_EFFECTIVENESS_MIN_APPLICATIONS &&
          effectiveness.successRate < KnowledgeBase.LOW_EFFECTIVENESS_RATE_THRESHOLD &&
          !entry.metadata.tags.includes('low-effectiveness')
        ) {
          entry.metadata.tags.push('low-effectiveness');
          logger.warn(
            `[Auto-Punishment] Knowledge entry ${entryId} tagged as low-effectiveness ` +
            `(successRate: ${effectiveness.successRate.toFixed(2)}, ` +
            `applications: ${effectiveness.totalApplications})`
          );
        }

        // 恢复机制：如果成功率回升，移除标记
        if (
          effectiveness.successRate >= KnowledgeBase.RECOVERY_RATE_THRESHOLD &&
          entry.metadata.tags.includes('low-effectiveness')
        ) {
          entry.metadata.tags = entry.metadata.tags.filter(t => t !== 'low-effectiveness');
          logger.info(
            `[Auto-Recovery] Knowledge entry ${entryId} recovered from low-effectiveness ` +
            `(successRate: ${effectiveness.successRate.toFixed(2)})`
          );
        }

        entry.updatedAt = Date.now();
        await this.saveEntry(entry);

        logger.debug(`Recorded effectiveness for entry ${entryId}`, {
          success,
          resolutionTimeMs,
          totalApplications: effectiveness.totalApplications,
          successRate: effectiveness.successRate,
        });
      } finally {
        this.effectivenessLocks.delete(entryId);
      }
    })();

    this.effectivenessLocks.set(entryId, lockPromise);
    await lockPromise;
  }

  /**
   * 获取知识条目的效果统计
   * Requirements: 6.5
   */
  async getEffectiveness(entryId: string): Promise<KnowledgeEffectiveness | null> {
    this.ensureInitialized();

    const entry = this.entries.get(entryId);
    if (!entry) {
      return null;
    }

    return entry.metadata.effectiveness || null;
  }

  /**
   * 获取效果最好的知识条目
   * Requirements: 6.5
   * 
   * @param limit 返回数量限制
   * @param minApplications 最小应用次数（用于过滤样本量不足的条目）
   */
  async getTopEffectiveEntries(
    limit: number = 10,
    minApplications: number = 3
  ): Promise<Array<{ entry: KnowledgeEntry; effectiveness: KnowledgeEffectiveness }>> {
    this.ensureInitialized();

    const results: Array<{ entry: KnowledgeEntry; effectiveness: KnowledgeEffectiveness }> = [];

    for (const storedEntry of this.entries.values()) {
      const effectiveness = storedEntry.metadata.effectiveness;
      if (effectiveness && effectiveness.totalApplications >= minApplications) {
        results.push({
          entry: this.toKnowledgeEntry(storedEntry),
          effectiveness,
        });
      }
    }

    // 按成功率和解决告警数量排序
    results.sort((a, b) => {
      // 首先按成功率排序
      if (b.effectiveness.successRate !== a.effectiveness.successRate) {
        return b.effectiveness.successRate - a.effectiveness.successRate;
      }
      // 成功率相同时按解决告警数量排序
      return b.effectiveness.resolvedAlerts - a.effectiveness.resolvedAlerts;
    });

    return results.slice(0, limit);
  }

  /**
   * 获取效果统计摘要
   * Requirements: 6.5
   */
  async getEffectivenessStats(): Promise<{
    totalTracked: number;
    avgSuccessRate: number;
    totalResolved: number;
    avgResolutionTime: number;
  }> {
    this.ensureInitialized();

    let totalTracked = 0;
    let totalSuccessRate = 0;
    let totalResolved = 0;
    let totalResolutionTime = 0;
    let entriesWithTime = 0;

    for (const entry of this.entries.values()) {
      const effectiveness = entry.metadata.effectiveness;
      if (effectiveness && effectiveness.totalApplications > 0) {
        totalTracked++;
        totalSuccessRate += effectiveness.successRate;
        totalResolved += effectiveness.resolvedAlerts;

        if (effectiveness.avgResolutionTime > 0) {
          totalResolutionTime += effectiveness.avgResolutionTime;
          entriesWithTime++;
        }
      }
    }

    return {
      totalTracked,
      avgSuccessRate: totalTracked > 0 ? totalSuccessRate / totalTracked : 0,
      totalResolved,
      avgResolutionTime: entriesWithTime > 0 ? totalResolutionTime / entriesWithTime : 0,
    };
  }

  /**
   * 清理孤立向量
   * 删除向量数据库中不再有对应知识条目的向量
   * 
   * @returns 清理结果统计
   */
  async cleanupOrphanedVectors(): Promise<{ checked: number; deleted: number; failed: number }> {
    this.ensureInitialized();

    logger.info('Starting orphaned vectors cleanup...');

    let checked = 0;
    let deleted = 0;
    let failed = 0;

    // 获取所有有效的 entryId
    const validEntryIds = new Set(this.entries.keys());

    // 遍历所有集合
    const collections = Object.values(COLLECTION_MAP).filter((v, i, a) => a.indexOf(v) === i);

    for (const collection of collections) {
      try {
        const stats = await this.vectorDatabase.getCollectionStats(collection);
        if (stats.documentCount === 0) continue;

        logger.info(`Checking collection ${collection} with ${stats.documentCount} documents`);

        // 获取集合中所有文档的 entryId
        // 由于 LanceDB 不支持直接遍历，我们使用一个技巧：
        // 搜索一个零向量，获取所有文档
        const zeroVector = new Array(2048).fill(0); // 使用当前的向量维度
        const allDocs = await this.vectorDatabase.search(collection, zeroVector, {
          topK: 10000, // 获取尽可能多的文档
          minScore: 0, // 不过滤
          includeVector: false,
        });

        // 收集需要删除的向量 ID
        const toDelete: string[] = [];
        const seenEntryIds = new Set<string>();

        for (const result of allDocs) {
          checked++;
          const entryId = result.document.metadata.entryId as string;

          if (!entryId) {
            // 没有 entryId 的向量是孤立的
            toDelete.push(result.document.id);
            continue;
          }

          if (!validEntryIds.has(entryId)) {
            // entryId 不在有效条目中，是孤立向量
            toDelete.push(result.document.id);
            seenEntryIds.add(entryId);
          }
        }

        // 批量删除孤立向量
        if (toDelete.length > 0) {
          logger.info(`Deleting ${toDelete.length} orphaned vectors from ${collection}`);

          // 分批删除，避免一次删除太多
          const batchSize = 100;
          for (let i = 0; i < toDelete.length; i += batchSize) {
            const batch = toDelete.slice(i, i + batchSize);
            try {
              await this.vectorDatabase.delete(collection, batch);
              deleted += batch.length;
            } catch (error) {
              logger.error(`Failed to delete batch from ${collection}`, { error });
              failed += batch.length;
            }
          }
        }

        logger.info(`Collection ${collection}: checked ${allDocs.length}, deleted ${toDelete.length}`);
      } catch (error) {
        logger.error(`Failed to cleanup collection ${collection}`, { error });
      }
    }

    logger.info(`Orphaned vectors cleanup completed`, { checked, deleted, failed });
    return { checked, deleted, failed };
  }


  // ==================== 向量索引同步 ====================

  /**
   * 同步向量索引
   * 检查每个知识条目是否有对应的向量，如果没有则自动重建
   * 
   * 此方法在初始化时自动调用，确保向量数据库与知识条目保持同步
   */
  private async syncVectorIndex(): Promise<void> {
    if (this.entries.size === 0) {
      logger.info('No entries to sync');
      return;
    }

    logger.info('Starting vector index sync check...', { entriesCount: this.entries.size });

    const entriesToReindex: StoredKnowledgeEntry[] = [];

    // 检查每个条目是否有对应的向量
    for (const [entryId, entry] of this.entries) {
      const collection = COLLECTION_MAP[entry.type];
      const hasVector = await this.checkEntryHasVector(entryId, collection);

      if (!hasVector) {
        entriesToReindex.push(entry);
        logger.debug(`Entry ${entryId} missing vector, will reindex`);
      }
    }

    if (entriesToReindex.length === 0) {
      logger.info('All entries have vectors, no sync needed');
      return;
    }

    logger.info(`Found ${entriesToReindex.length} entries missing vectors, reindexing...`);

    // 重建缺失向量的条目
    let successCount = 0;
    let failCount = 0;

    for (const entry of entriesToReindex) {
      try {
        await this.reindexEntry(entry);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error(`Failed to reindex entry ${entry.id}`, { error });
      }
    }

    logger.info(`Vector index sync completed`, {
      total: entriesToReindex.length,
      success: successCount,
      failed: failCount
    });
  }

  /**
   * 检查条目是否有对应的向量
   * 
   * @param entryId 条目 ID
   * @param collection 集合名称
   * @returns 是否存在向量
   */
  private async checkEntryHasVector(entryId: string, collection: string): Promise<boolean> {
    try {
      // 检查第一个分块是否存在
      const chunkId = `${entryId}_chunk_0`;
      const doc = await this.vectorDatabase.get(collection, chunkId);
      return doc !== null;
    } catch (error) {
      // 如果集合不存在或查询失败，认为没有向量
      return false;
    }
  }

  /**
   * 重建单个条目的向量索引
   * 
   * @param entry 要重建索引的条目
   */
  private async reindexEntry(entry: StoredKnowledgeEntry): Promise<void> {
    const collection = COLLECTION_MAP[entry.type];

    // 处理文档并向量化
    const docSource: DocumentSource = {
      type: entry.type,
      id: entry.id,
      content: `${entry.title}\n\n${entry.content}`,
      metadata: {
        ...entry.metadata,
        entryId: entry.id,
        entryType: entry.type,
      },
    };

    const processedDocs = await this.documentProcessor.process(docSource);

    // 存储到向量数据库
    const vectorDocs: VectorDocument[] = processedDocs.map(doc => ({
      id: doc.id,
      content: doc.content,
      vector: doc.vector,
      metadata: {
        source: entry.type,
        category: entry.metadata.category,
        timestamp: entry.metadata.timestamp,
        tags: entry.metadata.tags,
        entryId: entry.id,
        chunkIndex: doc.chunkIndex,
      },
    }));

    await this.vectorDatabase.insert(collection, vectorDocs);

    // 更新条目的 vectorId
    entry.vectorId = processedDocs[0]?.id || '';
    await this.saveEntry(entry);

    logger.debug(`Reindexed entry ${entry.id} with ${processedDocs.length} chunks`);
  }

  /**
   * 手动触发向量索引同步
   * 可用于在运行时检查和修复索引不一致问题
   * 
   * @returns 同步结果统计
   */
  async forceVectorSync(): Promise<{ checked: number; reindexed: number; failed: number }> {
    this.ensureInitialized();

    logger.info('Force vector sync triggered');

    let checked = 0;
    let reindexed = 0;
    let failed = 0;

    for (const [entryId, entry] of this.entries) {
      checked++;
      const collection = COLLECTION_MAP[entry.type];
      const hasVector = await this.checkEntryHasVector(entryId, collection);

      if (!hasVector) {
        try {
          await this.reindexEntry(entry);
          reindexed++;
          logger.info(`Force reindexed entry ${entryId}`);
        } catch (error) {
          failed++;
          logger.error(`Failed to force reindex entry ${entryId}`, { error });
        }
      }
    }

    logger.info(`Force vector sync completed`, { checked, reindexed, failed });
    return { checked, reindexed, failed };
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 加载索引
   */
  private async loadIndex(): Promise<void> {
    try {
      const indexPath = path.join(this.dataDir, KNOWLEDGE_INDEX_FILE);
      const data = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(data) as { entries: string[] };

      // 加载每个条目
      for (const entryId of index.entries) {
        try {
          const entryPath = path.join(this.dataDir, 'entries', `${entryId}.json`);
          const entryData = await fs.readFile(entryPath, 'utf-8');
          const entry = JSON.parse(entryData) as StoredKnowledgeEntry;
          this.entries.set(entryId, entry);
        } catch (error) {
          logger.warn(`Failed to load entry ${entryId}`, { error });
        }
      }

      logger.info(`Loaded ${this.entries.size} knowledge entries from index`);
    } catch (error) {
      // 索引文件不存在是正常的（首次运行）
      logger.info('No existing knowledge index found, starting fresh');
    }
  }

  /**
   * 保存索引
   */
  private async saveIndex(): Promise<void> {
    const indexPath = path.join(this.dataDir, KNOWLEDGE_INDEX_FILE);
    const index = {
      entries: Array.from(this.entries.keys()),
      lastUpdated: Date.now(),
    };
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * 保存条目
   */
  private async saveEntry(entry: StoredKnowledgeEntry): Promise<void> {
    const entryPath = path.join(this.dataDir, 'entries', `${entry.id}.json`);
    await fs.writeFile(entryPath, JSON.stringify(entry, null, 2));
  }

  /**
   * 删除条目文件
   */
  private async deleteEntryFile(id: string): Promise<void> {
    const entryPath = path.join(this.dataDir, 'entries', `${id}.json`);
    try {
      await fs.unlink(entryPath);
    } catch (error) {
      logger.warn(`Failed to delete entry file ${id}`, { error });
    }
  }

  /**
   * 计算内容哈希
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * 转换为 KnowledgeEntry（移除内部字段）
   */
  private toKnowledgeEntry(stored: StoredKnowledgeEntry): KnowledgeEntry {
    const { vectorId: _, contentHash: __, ...entry } = stored;
    return entry;
  }

  /**
   * 构建告警内容
   */
  private buildAlertContent(alertEvent: AlertEvent, analysis?: RootCauseAnalysis): string {
    let content = `
告警规则: ${alertEvent.ruleName}
告警消息: ${alertEvent.message}
严重级别: ${alertEvent.severity}
指标类型: ${alertEvent.metric}
当前值: ${alertEvent.currentValue}
阈值: ${alertEvent.threshold}
状态: ${alertEvent.status}
触发时间: ${new Date(alertEvent.triggeredAt).toISOString()}
`;

    if (alertEvent.resolvedAt) {
      content += `解决时间: ${new Date(alertEvent.resolvedAt).toISOString()}\n`;
    }

    if (alertEvent.aiAnalysis) {
      content += `\nAI 分析:\n${alertEvent.aiAnalysis}\n`;
    }

    if (alertEvent.autoResponseResult) {
      content += `\n自动响应结果:\n`;
      content += `- 已执行: ${alertEvent.autoResponseResult.executed}\n`;
      content += `- 成功: ${alertEvent.autoResponseResult.success}\n`;
      if (alertEvent.autoResponseResult.output) {
        content += `- 输出: ${alertEvent.autoResponseResult.output}\n`;
      }
      if (alertEvent.autoResponseResult.error) {
        content += `- 错误: ${alertEvent.autoResponseResult.error}\n`;
      }
    }

    if (analysis) {
      content += `\n根因分析:\n`;
      for (const cause of analysis.rootCauses) {
        content += `- ${cause.description} (置信度: ${cause.confidence}%)\n`;
        let evidenceArr = Array.isArray(cause.evidence) ? cause.evidence : (cause.evidence ? [cause.evidence] : []);

        // 防御：当 AI 将单个长字符串误拆解为单字符数组时 (例如 ["防", "火", "墙"]) 进行自动缝合
        if (evidenceArr.length > 3 && evidenceArr.every((e: any) => typeof e === 'string' && e.length <= 3)) {
          evidenceArr = [evidenceArr.join('')];
        }

        for (const evidence of evidenceArr) {
          content += `  证据: ${evidence}\n`;
        }
      }

      if (analysis.impact) {
        content += `\n影响评估:\n`;
        content += `- 范围: ${analysis.impact.scope}\n`;
        content += `- 受影响资源: ${analysis.impact.affectedResources.join(', ')}\n`;
      }
    }

    return content.trim();
  }

  /**
   * 构建修复方案内容
   */
  private buildRemediationContent(plan: RemediationPlan, results: ExecutionResult[]): string {
    let content = `
修复方案 ID: ${plan.id}
关联告警: ${plan.alertId}
根因分析: ${plan.rootCauseId}
整体风险: ${plan.overallRisk}
预计耗时: ${plan.estimatedDuration} 秒
状态: ${plan.status}

修复步骤:
`;

    for (const step of plan.steps) {
      content += `\n${step.order}. ${step.description}\n`;
      content += `   命令: ${step.command}\n`;
      content += `   风险级别: ${step.riskLevel}\n`;
      content += `   可自动执行: ${step.autoExecutable}\n`;

      const result = results.find(r => r.stepOrder === step.order);
      if (result) {
        content += `   执行结果: ${result.success ? '成功' : '失败'}\n`;
        if (result.output) {
          content += `   输出: ${result.output}\n`;
        }
        if (result.error) {
          content += `   错误: ${result.error}\n`;
        }
      }
    }

    if (plan.rollback.length > 0) {
      content += `\n回滚步骤:\n`;
      for (const step of plan.rollback) {
        content += `${step.order}. ${step.description}\n`;
        content += `   命令: ${step.command}\n`;
      }
    }

    return content.trim();
  }

  /**
   * 构建配置内容
   */
  private buildConfigContent(snapshot: ConfigSnapshot, diff?: SnapshotDiff): string {
    let content = `
配置快照 ID: ${snapshot.id}
触发方式: ${snapshot.trigger}
时间: ${new Date(snapshot.timestamp).toISOString()}
大小: ${snapshot.size} bytes
校验和: ${snapshot.checksum}
`;

    if (snapshot.metadata) {
      if (snapshot.metadata.routerVersion) {
        content += `路由器版本: ${snapshot.metadata.routerVersion}\n`;
      }
      if (snapshot.metadata.routerModel) {
        content += `路由器型号: ${snapshot.metadata.routerModel}\n`;
      }
    }

    if (diff) {
      content += `\n配置变更:\n`;

      if (diff.additions.length > 0) {
        content += `\n新增 (${diff.additions.length}):\n`;
        for (const addition of diff.additions.slice(0, 10)) {
          content += `+ ${addition}\n`;
        }
        if (diff.additions.length > 10) {
          content += `... 还有 ${diff.additions.length - 10} 项\n`;
        }
      }

      if (diff.modifications.length > 0) {
        content += `\n修改 (${diff.modifications.length}):\n`;
        for (const mod of diff.modifications.slice(0, 10)) {
          content += `~ ${mod.path}: ${mod.oldValue} -> ${mod.newValue}\n`;
        }
        if (diff.modifications.length > 10) {
          content += `... 还有 ${diff.modifications.length - 10} 项\n`;
        }
      }

      if (diff.deletions.length > 0) {
        content += `\n删除 (${diff.deletions.length}):\n`;
        for (const deletion of diff.deletions.slice(0, 10)) {
          content += `- ${deletion}\n`;
        }
        if (diff.deletions.length > 10) {
          content += `... 还有 ${diff.deletions.length - 10} 项\n`;
        }
      }

      if (diff.aiAnalysis) {
        content += `\nAI 分析:\n`;
        content += `风险级别: ${diff.aiAnalysis.riskLevel}\n`;
        content += `摘要: ${diff.aiAnalysis.summary}\n`;
        if (diff.aiAnalysis.recommendations.length > 0) {
          content += `建议:\n`;
          for (const rec of diff.aiAnalysis.recommendations) {
            content += `- ${rec}\n`;
          }
        }
      }
    }

    return content.trim();
  }

  /**
   * 构建故障模式内容
   */
  private buildPatternContent(pattern: FaultPattern): string {
    let content = `
故障模式: ${pattern.name}
描述: ${pattern.description}
启用状态: ${pattern.enabled ? '已启用' : '已禁用'}
自动修复: ${pattern.autoHeal ? '是' : '否'}
内置模式: ${pattern.builtin ? '是' : '否'}

触发条件:
`;

    for (const condition of pattern.conditions) {
      content += `- ${condition.metric}`;
      if (condition.metricLabel) {
        content += ` (${condition.metricLabel})`;
      }
      content += ` ${condition.operator} ${condition.threshold}\n`;
    }

    content += `\n修复脚本:\n${pattern.remediationScript}\n`;

    if (pattern.verificationScript) {
      content += `\n验证脚本:\n${pattern.verificationScript}\n`;
    }

    return content.trim();
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取所有条目（用于测试）
   */
  getAllEntries(): KnowledgeEntry[] {
    return Array.from(this.entries.values()).map(e => this.toKnowledgeEntry(e));
  }

  // ==================== 混合检索辅助方法 ====================

  /**
   * 异步元数据增强调度
   * Requirements: 1.4, 5.2
   * 
   * 使用 setImmediate 异步执行，不阻塞添加操作
   */
  private scheduleMetadataEnhancement(entry: StoredKnowledgeEntry): void {
    if (!this.metadataEnhancer) return;

    setImmediate(async () => {
      try {
        const enhanced = await this.metadataEnhancer!.enhance(entry);

        // 更新条目元数据
        await this.updateMetadataInternal(entry.id, enhanced);

        // 更新关键词索引
        if (this.keywordIndexManager) {
          this.keywordIndexManager.updateEntry(entry.id, {
            title: entry.title,
            content: entry.content,
            tags: entry.metadata.tags || [],
            autoKeywords: enhanced.autoKeywords,
            questionExamples: enhanced.questionExamples,
          });
        }

        logger.debug('Metadata enhancement completed', { entryId: entry.id });
      } catch (error) {
        logger.warn('Metadata enhancement failed', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });

        // 降级：使用 fallback 增强
        try {
          const fallback = this.metadataEnhancer!.enhanceFallback(entry);
          await this.updateMetadataInternal(entry.id, fallback);
        } catch (fallbackError) {
          logger.error('Fallback enhancement also failed', { entryId: entry.id });
        }
      }
    });
  }

  /**
   * 内部更新元数据方法
   */
  private async updateMetadataInternal(entryId: string, enhanced: EnhancedMetadata): Promise<void> {
    const entry = this.entries.get(entryId);
    if (!entry) return;

    entry.metadata.autoKeywords = enhanced.autoKeywords;
    entry.metadata.questionExamples = enhanced.questionExamples;
    entry.metadata.autoSynonyms = enhanced.autoSynonyms;
    entry.metadata.searchableText = enhanced.searchableText;
    entry.metadata.enhancedAt = enhanced.enhancedAt;
    entry.metadata.enhancementSource = enhanced.enhancementSource;
    entry.updatedAt = Date.now();

    await this.saveEntry(entry);
  }

  /**
   * 设置混合检索配置
   * Requirements: 5.3
   */
  setHybridSearchConfig(config: Partial<{
    enabled: boolean;
    keywordWeight: number;
    vectorWeight: number;
  }>): void {
    this.hybridSearchConfig = { ...this.hybridSearchConfig, ...config };
    logger.info('Hybrid search config updated', { config: this.hybridSearchConfig });
  }

  /**
   * 获取混合检索配置
   */
  getHybridSearchConfig(): {
    enabled: boolean;
    keywordWeight: number;
    vectorWeight: number;
  } {
    return { ...this.hybridSearchConfig };
  }

  /**
   * 设置 AI 适配器（用于元数据增强）
   */
  setAIAdapter(adapter: any, provider: any, model?: string): void {
    if (this.metadataEnhancer) {
      this.metadataEnhancer.setAIAdapter(adapter, provider, model);
      logger.info('MetadataEnhancer AI adapter set');
    }
  }

  /**
   * 获取关键词索引管理器（用于测试和迁移）
   */
  getKeywordIndexManager(): KeywordIndexManager | null {
    return this.keywordIndexManager;
  }

  /**
   * 获取元数据增强器（用于测试和迁移）
   */
  getMetadataEnhancer(): MetadataEnhancer | null {
    return this.metadataEnhancer;
  }

  /**
   * 获取混合检索引擎（用于测试）
   */
  getHybridSearchEngine(): HybridSearchEngine | null {
    return this.hybridSearchEngine;
  }

  // ==================== 经验质量管理 API ====================
  // Requirements: 2.4.1, 2.4.2, 2.4.3, 2.4.4

  /**
   * 获取所有经验条目
   * Requirements: 2.4.1
   * 
   * @param options 查询选项
   * @returns 经验条目列表
   */
  async listExperiences(options?: {
    reviewStatus?: 'pending' | 'approved' | 'rejected';
    limit?: number;
    offset?: number;
  }): Promise<{ entries: KnowledgeEntry[]; total: number }> {
    this.ensureInitialized();

    const allExperiences = Array.from(this.entries.values())
      .filter(e => e.type === 'experience')
      .filter(e => !options?.reviewStatus || e.metadata.reviewStatus === options.reviewStatus)
      .sort((a, b) => b.createdAt - a.createdAt);

    const total = allExperiences.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;

    const entries = allExperiences
      .slice(offset, offset + limit)
      .map(e => this.toKnowledgeEntry(e));

    return { entries, total };
  }

  /**
   * 审核经验条目
   * Requirements: 2.4.2
   * 
   * @param id 经验条目 ID
   * @param review 审核输入
   * @returns 更新后的经验条目
   */
  async reviewExperience(id: string, review: ExperienceReviewInput): Promise<KnowledgeEntry> {
    this.ensureInitialized();

    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Experience entry ${id} not found`);
    }

    if (entry.type !== 'experience') {
      throw new Error(`Entry ${id} is not an experience entry`);
    }

    const now = Date.now();
    const updatedMetadata: KnowledgeMetadata = {
      ...entry.metadata,
      reviewStatus: review.status,
      reviewedAt: now,
      reviewedBy: review.reviewedBy,
      reviewNote: review.note,
      qualityScore: review.qualityScore,
    };

    return this.update(id, { metadata: updatedMetadata });
  }

  /**
   * 获取待审核经验数量
   * Requirements: 2.4.3
   * 
   * @returns 待审核数量
   */
  async getPendingExperienceCount(): Promise<number> {
    this.ensureInitialized();

    return Array.from(this.entries.values())
      .filter(e => e.type === 'experience')
      .filter(e => !e.metadata.reviewStatus || e.metadata.reviewStatus === 'pending')
      .length;
  }

  /**
   * 批量审核经验
   * Requirements: 2.4.2
   * 
   * @param ids 经验条目 ID 列表
   * @param review 审核输入
   * @returns 更新结果
   */
  async batchReviewExperiences(
    ids: string[],
    review: ExperienceReviewInput
  ): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
    this.ensureInitialized();

    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        await this.reviewExperience(id, review);
        success.push(id);
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Batch review completed', {
      total: ids.length,
      success: success.length,
      failed: failed.length,
    });

    return { success, failed };
  }

  /**
   * 获取经验统计
   * Requirements: 2.4.4
   * 
   * @returns 经验统计信息
   */
  async getExperienceStats(): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    avgQualityScore: number;
    recentCount: number;
  }> {
    this.ensureInitialized();

    const experiences = Array.from(this.entries.values())
      .filter(e => e.type === 'experience');

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const pending = experiences.filter(e =>
      !e.metadata.reviewStatus || e.metadata.reviewStatus === 'pending'
    ).length;

    const approved = experiences.filter(e =>
      e.metadata.reviewStatus === 'approved'
    ).length;

    const rejected = experiences.filter(e =>
      e.metadata.reviewStatus === 'rejected'
    ).length;

    const qualityScores = experiences
      .filter(e => e.metadata.qualityScore !== undefined)
      .map(e => e.metadata.qualityScore!);

    const avgQualityScore = qualityScores.length > 0
      ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
      : 0;

    const recentCount = experiences.filter(e => e.createdAt >= oneWeekAgo).length;

    return {
      total: experiences.length,
      pending,
      approved,
      rejected,
      avgQualityScore: Math.round(avgQualityScore * 10) / 10,
      recentCount,
    };
  }

  /**
   * 删除被拒绝的经验
   * Requirements: 2.4.3
   * 
   * @param olderThanDays 删除多少天前被拒绝的经验，默认 30 天
   * @returns 删除的条目数量
   */
  async cleanupRejectedExperiences(olderThanDays: number = 30): Promise<number> {
    this.ensureInitialized();

    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const toDelete = Array.from(this.entries.values())
      .filter(e => e.type === 'experience')
      .filter(e => e.metadata.reviewStatus === 'rejected')
      .filter(e => e.metadata.reviewedAt && e.metadata.reviewedAt < cutoffTime)
      .map(e => e.id);

    for (const id of toDelete) {
      try {
        await this.delete(id);
      } catch (error) {
        logger.warn(`Failed to delete rejected experience ${id}`, { error });
      }
    }

    logger.info('Cleaned up rejected experiences', { deleted: toDelete.length });
    return toDelete.length;
  }
}

// 导出单例实例
export const knowledgeBase = new KnowledgeBase();
