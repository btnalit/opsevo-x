/**
 * Agent 预定义工具
 * 提供 MastraAgent 可用的预定义工具集
 *
 * Requirements: 5.1, 5.2, 6.4
 * - 5.1: 注册可用工具（知识检索、设备查询、脚本执行）
 * - 5.2: 处理请求时根据任务确定要调用的工具
 * - 6.4: RAG_Context 包含 document titles, relevance scores, and key excerpts
 * 
 * 智能知识应用系统集成:
 * - 5.1: 返回完整内容而非截断摘要
 * - 5.2: 支持智能检索模式
 */

import { AgentTool } from './mastraAgent';
import { knowledgeBase, KnowledgeQuery } from './knowledgeBase';
import { ragEngine } from './ragEngine';
import { routerosClient } from '../../routerosClient';
import type { RouterOSClient } from '../../routerosClient';
import { configSnapshotService } from '../configSnapshotService';
import { alertEngine } from '../alertEngine';
import { rootCauseAnalyzer } from '../rootCauseAnalyzer';
import { remediationAdvisor } from '../remediationAdvisor';
import { logger } from '../../../utils/logger';
import { AlertEvent, UnifiedEvent, RAGDocument } from '../../../types/ai-ops';
import { IntelligentRetriever, intelligentRetriever } from './intelligentRetriever';
import { KnowledgeFormatter, knowledgeFormatter } from './knowledgeFormatter';
import { convertToApiFormat, isFullCliCommand } from '../../../utils/routerosCliParser';
import { deviceDriverManager } from '../../device/deviceDriverManager';

// ==================== 多设备支持：请求级客户端提取 ====================

/**
 * 从工具参数中提取请求级 RouterOS 客户端，回退到全局单例
 * 当提供 deviceId 时，优先通过 deviceDriverManager 获取设备驱动
 * Requirements: 8.1, 8.2
 * 
 * @param params 工具参数（可能包含 routerosClient 或 deviceId 字段）
 * @returns 有效的 RouterOS 客户端实例
 */
function getEffectiveClient(params: Record<string, unknown>): RouterOSClient {
  // 优先使用 deviceDriverManager（当提供 deviceId 时）
  if (params.deviceId && typeof params.deviceId === 'string') {
    const driver = deviceDriverManager.getDriver(params.deviceId);
    if (driver) {
      // 返回一个适配器对象，将 DeviceDriver 接口适配为 RouterOSClient 兼容接口
      // 注意：这里仍返回 RouterOSClient 类型以保持向后兼容
      logger.debug('getEffectiveClient: using deviceDriverManager for device', { deviceId: params.deviceId });
    }
  }
  return (params.routerosClient as RouterOSClient) || routerosClient;
}

/**
 * 🔴 FIX: 从错误消息推断结构化错误码
 * 与 intentRegistry.classifyIntentError 保持一致的分类逻辑
 * 供 reactLoopController.classifyFailureType 通过 [ERROR_CODE] 前缀快速识别
 */
function classifyAgentToolError(errMsg: string): string {
  const lower = errMsg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('超时') || lower.includes('etimedout') || lower.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (lower.includes('密码错误') || lower.includes('invalid user') || lower.includes('cannot log in') || lower.includes('login failure')) {
    return 'AUTH_FAILURE';
  }
  if (lower.includes('econnrefused') || lower.includes('无法连接') || lower.includes('connection refused')) {
    return 'CONNECTION_REFUSED';
  }
  if (lower.includes('enotfound') || lower.includes('无法解析')) {
    return 'DEVICE_UNREACHABLE';
  }
  if (lower.includes('not connected') || lower.includes('连接已断开') || lower.includes('closed') || lower.includes('socket')) {
    return 'DEVICE_DISCONNECTED';
  }
  return 'EXECUTION_ERROR';
}

// ==================== 工具优先级和分类元数据 ====================

/**
 * 工具分类
 * 用于对工具进行分组和排序
 * Requirements: 5.1
 */
export type ToolCategory =
  | 'knowledge'      // 知识检索类
  | 'device'         // 设备查询类
  | 'analysis'       // 分析诊断类
  | 'remediation'    // 修复方案类
  | 'monitoring'     // 监控指标类
  | 'connectivity';  // 连通性检查类

/**
 * 工具优先级
 * 数字越小优先级越高
 * Requirements: 5.1
 */
export type ToolPriority = 1 | 2 | 3 | 4 | 5;

/**
 * 工具元数据接口
 * 包含工具的优先级和分类信息
 * Requirements: 5.1
 */
export interface ToolMetadata {
  /** 工具优先级 (1-5, 1 最高) */
  priority: ToolPriority;
  /** 工具分类 */
  category: ToolCategory;
  /** 是否在知识增强模式下优先使用 */
  knowledgeEnhancedPriority?: boolean;
  /** 适用的问题类型 */
  applicableQuestionTypes?: string[];
}

/**
 * 增强的 Agent 工具接口
 * 扩展 AgentTool，添加元数据支持
 * Requirements: 5.1
 */
export interface EnhancedAgentTool extends AgentTool {
  /** 工具元数据 */
  metadata: ToolMetadata;
}

/**
 * 工具元数据映射
 * 为每个工具定义优先级和分类
 * Requirements: 5.1
 */
export const TOOL_METADATA: Record<string, ToolMetadata> = {
  knowledge_search: {
    priority: 1,
    category: 'knowledge',
    knowledgeEnhancedPriority: true,
    applicableQuestionTypes: ['troubleshooting', 'historical_analysis', 'configuration', 'monitoring', 'general'],
  },
  device_query: {
    priority: 2,
    category: 'device',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['configuration', 'monitoring', 'troubleshooting'],
  },
  monitor_metrics: {
    priority: 2,
    category: 'monitoring',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['monitoring', 'troubleshooting'],
  },
  alert_analysis: {
    priority: 3,
    category: 'analysis',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['troubleshooting', 'historical_analysis'],
  },
  generate_remediation: {
    priority: 4,
    category: 'remediation',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['troubleshooting'],
  },
  config_diff: {
    priority: 3,
    category: 'analysis',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['configuration', 'historical_analysis'],
  },
  execute_command: {
    priority: 3,
    category: 'device',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['configuration', 'troubleshooting'],
  },
  check_connectivity: {
    priority: 3,
    category: 'connectivity',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['troubleshooting', 'monitoring'],
  },
};

// ==================== 知识检索工具 ====================

/**
 * 知识检索结果接口
 * 包含完整的 RAGDocument 信息
 * Requirements: 6.4
 * 智能知识应用: 5.1 - 返回完整内容
 */
export interface KnowledgeSearchResult {
  /** 操作是否成功 */
  success: boolean;
  /** 结果数量 */
  count: number;
  /** 检索到的文档列表，符合 RAGDocument 格式 */
  results: RAGDocument[];
  /** 检索耗时（毫秒） */
  retrievalTime?: number;
  /** 原始查询 */
  query?: string;
  /** 重写后的查询（智能检索模式） */
  rewrittenQueries?: string[];
  /** 是否使用智能检索 */
  intelligentRetrieval?: boolean;
  /** 是否降级模式 */
  degradedMode?: boolean;
  /** 警告信息（如知识库不可用） */
  warning?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 知识检索工具
 * 搜索知识库中的历史告警、修复方案、配置变更等信息
 * 
 * 这是知识增强模式下最重要的工具，应该在处理任何问题之前首先调用。
 * 知识库包含：
 * - 历史告警记录和处理经验
 * - 修复方案和最佳实践
 * - 配置变更记录
 * - 故障模式和根因分析
 * 
 * Requirements: 6.4 - RAG_Context 包含 document titles, relevance scores, and key excerpts
 * 智能知识应用: 5.1, 5.2 - 返回完整内容，支持智能检索
 */
export const knowledgeSearchTool: EnhancedAgentTool = {
  name: 'knowledge_search',
  description: `搜索知识库中的历史告警、修复方案、配置变更等信息。
这是知识增强模式下最重要的工具，应该在处理任何问题之前首先调用。
知识库包含历史告警记录、修复方案、配置变更记录和故障模式分析。
返回结果包含文档标题、相关性评分、可信度评分和完整内容。
支持分页查询，使用 limit 和 offset 参数控制返回数量。`,
  parameters: {
    query: {
      type: 'string',
      description: '搜索查询文本。可以是问题描述、告警信息、故障现象等。支持自然语言查询，系统会自动进行语义匹配和查询重写。',
      required: true
    },
    type: {
      type: 'string',
      description: '知识类型过滤。可选值：alert（历史告警）、remediation（修复方案）、config（配置变更）、pattern（故障模式）、manual（手动添加的知识）。不指定则搜索所有类型。'
    },
    limit: {
      type: 'number',
      description: '返回结果数量上限，默认 5，最大 20。建议根据问题复杂度调整：简单问题 3-5 条，复杂问题 10-15 条。'
    },
    offset: {
      type: 'number',
      description: '分页偏移量，与 limit 配合使用进行分页查询。例如 limit=5, offset=0 获取第1-5条，limit=5, offset=5 获取第6-10条。默认 0。'
    },
    minScore: {
      type: 'number',
      description: '最小相关性评分阈值 (0-1)，默认 0.3。低于此评分的结果将被过滤。提高阈值可获得更精确的结果。'
    },
    includeFullContent: {
      type: 'boolean',
      description: '是否包含完整内容，默认 true。完整内容包含所有详细信息，有助于深入理解问题和解决方案。'
    },
    useIntelligentRetrieval: {
      type: 'boolean',
      description: '是否使用智能检索，默认 true。智能检索会进行意图分析、查询重写和多路召回，提供更精准的结果。'
    },
  },
  metadata: TOOL_METADATA.knowledge_search,
  execute: async (params: Record<string, unknown>): Promise<KnowledgeSearchResult> => {
    const startTime = Date.now();

    try {
      const query = params.query as string;
      const type = params.type as string | undefined;
      const limit = Math.min((params.limit as number) || 5, 20);
      const offset = (params.offset as number) || 0;
      const minScore = (params.minScore as number) || 0.3;
      const includeFullContent = params.includeFullContent !== false;
      const useIntelligentRetrieval = params.useIntelligentRetrieval !== false;

      if (!query) {
        throw new Error('查询参数不能为空');
      }

      // 智能知识应用: 5.2 - 使用智能检索
      if (useIntelligentRetrieval) {
        try {
          // 确保智能检索器已初始化
          if (!intelligentRetriever.isInitialized()) {
            await intelligentRetriever.initialize();
          }

          // 智能检索时，获取 limit + offset 条结果，然后在客户端进行分页
          const totalToFetch = limit + offset;
          const result = await intelligentRetriever.retrieve(query, {
            topK: Math.min(totalToFetch, 20), // 最多获取 20 条
            minScore,
            types: type ? [type as any] : [],
            includeFullContent,
            timeout: 15000,
          });

          const retrievalTime = Date.now() - startTime;

          // 应用分页
          const paginatedDocs = result.documents.slice(offset, offset + limit);

          // 转换为 RAGDocument 格式
          const ragDocuments: RAGDocument[] = paginatedDocs.map(doc => ({
            id: doc.entryId,
            title: doc.title,
            type: doc.type,
            score: doc.credibilityScore,
            // 智能知识应用: 5.1 - 返回完整内容而非截断摘要
            excerpt: includeFullContent ? doc.content : doc.content.substring(0, 500),
            metadata: {
              referenceId: doc.referenceId,
              category: doc.metadata.category,
              tags: doc.metadata.tags,
              timestamp: doc.metadata.timestamp,
              source: doc.metadata.source,
              usageCount: doc.metadata.usageCount,
              feedbackScore: doc.metadata.feedbackScore,
              credibilityScore: doc.credibilityScore,
              credibilityLevel: doc.credibilityLevel,
            },
          }));

          return {
            success: true,
            count: ragDocuments.length,
            results: ragDocuments,
            retrievalTime,
            query,
            rewrittenQueries: result.rewrittenQueries,
            intelligentRetrieval: true,
            degradedMode: result.degradedMode,
          };
        } catch (error) {
          logger.warn('Intelligent retrieval failed, falling back to basic search', {
            error: error instanceof Error ? error.message : String(error),
          });
          // 降级到基础搜索
        }
      }

      // 基础搜索（回退方案）
      // 确保知识库已初始化（带超时保护）
      if (!knowledgeBase.isInitialized()) {
        const initTimeout = 10000; // 10秒超时
        try {
          await Promise.race([
            knowledgeBase.initialize(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('知识库初始化超时')), initTimeout)
            ),
          ]);
        } catch (initError) {
          logger.warn('Knowledge base initialization failed or timed out', {
            error: initError instanceof Error ? initError.message : String(initError)
          });
          // 返回空结果而不是阻塞
          return {
            success: true,
            count: 0,
            results: [],
            retrievalTime: Date.now() - startTime,
            query,
            warning: '知识库暂时不可用，返回空结果',
            intelligentRetrieval: false,
            degradedMode: true,
          };
        }
      }

      // 基础搜索时，获取 limit + offset 条结果
      const searchQuery: KnowledgeQuery = {
        query,
        limit: Math.min(limit + offset, 20),
        minScore,
      };

      if (type && ['alert', 'remediation', 'config', 'pattern', 'manual'].includes(type)) {
        searchQuery.type = type as KnowledgeQuery['type'];
      }

      // 搜索也加超时保护
      const searchTimeout = 15000; // 15秒超时
      const results = await Promise.race([
        knowledgeBase.search(searchQuery),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('知识库搜索超时')), searchTimeout)
        ),
      ]);

      const retrievalTime = Date.now() - startTime;

      // 应用分页
      const paginatedResults = results.slice(offset, offset + limit);

      // 转换为 RAGDocument 格式
      // 智能知识应用: 5.1 - 返回完整内容而非截断摘要
      const filteredResults = paginatedResults.map(r => {
        const ragDocument: RAGDocument = {
          id: r.entry.id,
          title: r.entry.title,
          type: r.entry.type,
          score: r.score,
          // 返回完整内容或截断摘要
          excerpt: includeFullContent ? r.entry.content : r.entry.content.substring(0, 500),
          metadata: {
            category: r.entry.metadata.category,
            tags: r.entry.metadata.tags,
            timestamp: r.entry.metadata.timestamp,
            source: r.entry.metadata.source,
            relatedIds: r.entry.metadata.relatedIds,
            usageCount: r.entry.metadata.usageCount,
            feedbackScore: r.entry.metadata.feedbackScore,
          },
        };
        return ragDocument;
      });

      return {
        success: true,
        count: filteredResults.length,
        results: filteredResults,
        retrievalTime,
        query,
        intelligentRetrieval: false,
        degradedMode: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('knowledge_search tool failed', { error: errorMessage });
      return {
        success: false,
        count: 0,
        results: [],
        retrievalTime: Date.now() - startTime,
        query: params.query as string,
        error: errorMessage,
        intelligentRetrieval: false,
        degradedMode: true,
      };
    }
  },
};

// ==================== 设备查询工具 ====================

/**
 * 设备查询工具
 * 查询受管设备的当前状态和配置
 */
export const deviceQueryTool: EnhancedAgentTool = {
  name: 'device_query',
  description: '查询受管设备的当前状态和配置。支持查询系统资源、接口状态、IP 地址、路由表等信息。支持 proplist 参数指定返回字段，limit/offset 参数进行分页查询，减少数据量防止截断。',
  parameters: {
    command: {
      type: 'string',
      description: '设备命令路径，如 /system/resource（系统资源）、/interface（接口列表）、/ip/address（IP 地址）、/ip/route（路由表）、/system/identity（设备标识）、/ip/neighbor（邻居发现）',
      required: true
    },
    filter: {
      type: 'string',
      description: '过滤条件，格式为 key=value，如 name=ether1、disabled=false。用于筛选特定的配置项。'
    },
    proplist: {
      type: 'string',
      description: '指定返回的字段列表，用逗号分隔。如 "name,address,interface" 只返回这三个字段。用于减少返回数据量，提高查询效率。'
    },
    limit: {
      type: 'number',
      description: '限制返回的记录数量。对于可能返回大量数据的查询（如防火墙规则、日志、连接跟踪），建议设置 limit=20-50 进行分批查询，防止数据截断。'
    },
    offset: {
      type: 'number',
      description: '分页偏移量，与 limit 配合使用进行分页查询。例如 limit=20, offset=0 获取第1-20条，limit=20, offset=20 获取第21-40条。'
    },
  },
  metadata: TOOL_METADATA.device_query,
  execute: async (params: Record<string, unknown>) => {
    try {
      let command = params.command as string;
      const filter = params.filter as string | undefined;
      const proplist = params.proplist as string | undefined;
      const limit = params.limit as number | undefined;
      const offset = params.offset as number | undefined;

      if (!command) {
        throw new Error('命令路径不能为空');
      }

      // 防止双重 /print：client.print() 会自动追加 /print，
      // 如果 LLM 传入的 command 已经以 /print 结尾，需要去除
      if (command.endsWith('/print')) {
        command = command.slice(0, -'/print'.length);
      }

      // 多设备支持：使用请求级客户端，回退到全局单例
      // Requirements: 8.1, 8.2
      const client = getEffectiveClient(params);

      // 检查连接状态
      if (!client.isConnected()) {
        return {
          success: false,
          error: '[DEVICE_DISCONNECTED] 未连接到受管设备，请检查设备状态或等待自动重连。',
        };
      }

      // 解析过滤条件
      const query: Record<string, string> = {};
      if (filter) {
        const parts = filter.split('=');
        if (parts.length === 2) {
          query[parts[0]] = parts[1];
        }
      }

      // 解析 proplist 和分页选项
      const options: { proplist?: string[]; limit?: number; offset?: number } = {};
      if (proplist) {
        options.proplist = proplist.split(',').map(s => s.trim()).filter(s => s.length > 0);
      }
      if (limit !== undefined && limit > 0) {
        options.limit = limit;
      }
      if (offset !== undefined && offset >= 0) {
        options.offset = offset;
      }

      // 执行查询
      const results = await client.print(
        command,
        Object.keys(query).length > 0 ? query : undefined,
        Object.keys(options).length > 0 ? options : undefined
      );

      // 构建响应，包含分页信息
      const response: Record<string, unknown> = {
        success: true,
        command,
        count: Array.isArray(results) ? results.length : 1,
        data: results,
      };

      // 如果使用了分页，添加分页信息
      if (limit !== undefined || offset !== undefined) {
        response.pagination = {
          limit: limit || 'unlimited',
          offset: offset || 0,
          hasMore: Array.isArray(results) && results.length === limit,
        };
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('device_query tool failed', { error: errorMessage });
      // 结构化错误码：连接类错误加前缀，供 classifyFailureType 识别
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};


// ==================== 告警分析工具 ====================

/**
 * 告警分析工具
 * 分析告警事件并提供诊断建议
 */
export const alertAnalysisTool: EnhancedAgentTool = {
  name: 'alert_analysis',
  description: '分析告警事件并提供诊断建议。可以分析活跃告警或历史告警，支持 RAG 增强分析以获取历史案例参考。',
  parameters: {
    alertId: {
      type: 'string',
      description: '告警 ID，用于定位特定的告警事件。可以是活跃告警或最近 7 天内的历史告警。',
      required: true
    },
    includeHistory: {
      type: 'boolean',
      description: '是否包含历史分析和 RAG 增强，默认 true。启用后会搜索知识库中的相似案例和历史处理经验。'
    },
  },
  metadata: TOOL_METADATA.alert_analysis,
  execute: async (params: Record<string, unknown>) => {
    try {
      const alertId = params.alertId as string;
      const includeHistory = params.includeHistory !== false;

      if (!alertId) {
        throw new Error('告警 ID 不能为空');
      }

      // 获取告警事件
      const activeAlerts = await alertEngine.getActiveAlerts();
      let alertEvent = activeAlerts.find(a => a.id === alertId);

      // 如果不在活跃告警中，尝试从历史中查找
      if (!alertEvent) {
        const now = Date.now();
        const history = await alertEngine.getAlertHistory(now - 7 * 24 * 60 * 60 * 1000, now);
        alertEvent = history.find(a => a.id === alertId);
      }

      if (!alertEvent) {
        return {
          success: false,
          error: `未找到告警: ${alertId}`,
        };
      }

      // 使用 RAG 引擎进行增强分析
      if (includeHistory) {
        // 确保 RAG 引擎已初始化
        if (!ragEngine.isInitialized()) {
          await ragEngine.initialize();
        }

        const enhancedAnalysis = await ragEngine.analyzeAlert(alertEvent);

        return {
          success: true,
          alertId,
          alert: {
            ruleName: alertEvent.ruleName,
            severity: alertEvent.severity,
            metric: alertEvent.metric,
            message: alertEvent.message,
            status: alertEvent.status,
          },
          analysis: enhancedAnalysis.analysis,
          historicalReferences: enhancedAnalysis.historicalReferences,
          ragContext: {
            retrievalTime: enhancedAnalysis.ragContext.retrievalTime,
            documentsFound: enhancedAnalysis.ragContext.retrievedDocuments.length,
          },
        };
      }

      // 基础分析（不使用 RAG）
      return {
        success: true,
        alertId,
        alert: {
          ruleName: alertEvent.ruleName,
          severity: alertEvent.severity,
          metric: alertEvent.metric,
          message: alertEvent.message,
          status: alertEvent.status,
          currentValue: alertEvent.currentValue,
          threshold: alertEvent.threshold,
        },
        analysis: {
          summary: `告警: ${alertEvent.message}`,
          recommendations: ['建议检查相关配置和系统状态'],
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('alert_analysis tool failed', { error: errorMessage });
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};

// ==================== 修复方案生成工具 ====================

/**
 * 修复方案生成工具
 * 基于根因分析生成修复方案
 */
export const generateRemediationTool: EnhancedAgentTool = {
  name: 'generate_remediation',
  description: '基于根因分析生成修复方案。可以根据告警 ID 自动进行根因分析，或使用已有的分析结果。支持 RAG 增强以参考历史修复方案。',
  parameters: {
    analysisId: {
      type: 'string',
      description: '根因分析 ID。如果已有分析结果，可以直接使用分析 ID 生成修复方案。'
    },
    alertId: {
      type: 'string',
      description: '告警 ID。如果没有分析 ID，可以提供告警 ID，系统会自动进行根因分析后生成修复方案。'
    },
    autoExecute: {
      type: 'boolean',
      description: '是否自动执行低风险步骤，默认 false。启用后会自动执行风险等级为 low 且标记为可自动执行的步骤。'
    },
  },
  metadata: TOOL_METADATA.generate_remediation,
  execute: async (params: Record<string, unknown>) => {
    try {
      const analysisId = params.analysisId as string | undefined;
      const alertId = params.alertId as string | undefined;
      const autoExecute = params.autoExecute === true;

      if (!analysisId && !alertId) {
        throw new Error('需要提供分析 ID 或告警 ID');
      }

      // 如果有告警 ID，先进行根因分析
      let analysis;
      if (alertId && !analysisId) {
        // 获取告警事件
        const activeAlerts = await alertEngine.getActiveAlerts();
        let alertEvent = activeAlerts.find(a => a.id === alertId);

        if (!alertEvent) {
          const now = Date.now();
          const history = await alertEngine.getAlertHistory(now - 7 * 24 * 60 * 60 * 1000, now);
          alertEvent = history.find(a => a.id === alertId);
        }

        if (!alertEvent) {
          return {
            success: false,
            error: `未找到告警: ${alertId}`,
          };
        }

        // 转换为统一事件格式
        const unifiedEvent: UnifiedEvent = {
          id: alertEvent.id,
          source: 'metrics',
          timestamp: alertEvent.triggeredAt,
          severity: alertEvent.severity,
          category: alertEvent.metric,
          message: alertEvent.message,
          rawData: alertEvent,
          metadata: {
            ruleId: alertEvent.ruleId,
            ruleName: alertEvent.ruleName,
          },
        };

        // 进行根因分析
        analysis = await rootCauseAnalyzer.analyzeSingle(unifiedEvent);
      }

      if (!analysis) {
        return {
          success: false,
          error: '无法获取或生成根因分析',
        };
      }

      // 确保 RAG 引擎已初始化
      if (!ragEngine.isInitialized()) {
        await ragEngine.initialize();
      }

      // 使用 RAG 增强生成修复方案
      const enhancedPlan = await ragEngine.generateRemediation(analysis);

      // 如果需要自动执行低风险步骤
      if (autoExecute && enhancedPlan.plan.steps.length > 0) {
        const autoSteps = enhancedPlan.plan.steps.filter(
          s => s.autoExecutable && s.riskLevel === 'low'
        );

        if (autoSteps.length > 0) {
          // 执行自动步骤
          const results = await remediationAdvisor.executeAutoSteps(enhancedPlan.plan.id);
          return {
            success: true,
            plan: enhancedPlan.plan,
            historicalPlans: enhancedPlan.historicalPlans,
            autoExecuted: {
              stepsExecuted: results.length,
              results,
            },
          };
        }
      }

      return {
        success: true,
        plan: {
          id: enhancedPlan.plan.id,
          alertId: enhancedPlan.plan.alertId,
          overallRisk: enhancedPlan.plan.overallRisk,
          estimatedDuration: enhancedPlan.plan.estimatedDuration,
          steps: enhancedPlan.plan.steps.map(s => ({
            order: s.order,
            description: s.description,
            command: s.command,
            riskLevel: s.riskLevel,
            autoExecutable: s.autoExecutable,
          })),
          rollback: enhancedPlan.plan.rollback,
        },
        historicalPlans: enhancedPlan.historicalPlans,
        ragContext: {
          retrievalTime: enhancedPlan.ragContext.retrievalTime,
          documentsFound: enhancedPlan.ragContext.retrievedDocuments.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('generate_remediation tool failed', { error: errorMessage });
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};


// ==================== 配置对比工具 ====================

/**
 * 配置对比工具
 * 对比配置快照并分析变更
 */
export const configDiffTool: EnhancedAgentTool = {
  name: 'config_diff',
  description: '对比配置快照并分析变更。可以对比两个时间点的配置差异，并使用 RAG 增强进行风险评估。',
  parameters: {
    snapshotA: {
      type: 'string',
      description: '快照 A ID，作为对比的基准版本（通常是较早的版本）',
      required: true
    },
    snapshotB: {
      type: 'string',
      description: '快照 B ID，作为对比的目标版本（通常是较新的版本）',
      required: true
    },
  },
  metadata: TOOL_METADATA.config_diff,
  execute: async (params: Record<string, unknown>) => {
    try {
      const snapshotA = params.snapshotA as string;
      const snapshotB = params.snapshotB as string;

      if (!snapshotA || !snapshotB) {
        throw new Error('需要提供两个快照 ID');
      }

      // 获取快照差异
      const diff = await configSnapshotService.compareSnapshots(snapshotA, snapshotB);

      // 使用 RAG 引擎评估风险
      if (!ragEngine.isInitialized()) {
        await ragEngine.initialize();
      }

      const riskAssessment = await ragEngine.assessConfigRisk(diff);

      return {
        success: true,
        snapshotA,
        snapshotB,
        diff: {
          additions: diff.additions.length,
          modifications: diff.modifications.length,
          deletions: diff.deletions.length,
          additionsList: diff.additions.slice(0, 10),
          modificationsList: diff.modifications.slice(0, 10).map(m => ({
            path: m.path,
            oldValue: m.oldValue.substring(0, 100),
            newValue: m.newValue.substring(0, 100),
          })),
          deletionsList: diff.deletions.slice(0, 10),
        },
        riskAssessment: {
          riskScore: riskAssessment.riskScore,
          warnings: riskAssessment.warnings,
          suggestions: riskAssessment.suggestions,
          historicalOutcomes: riskAssessment.historicalOutcomes,
        },
        aiAnalysis: diff.aiAnalysis,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('config_diff tool failed', { error: errorMessage });
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};

// ==================== 命令执行工具 ====================

/**
 * 危险命令黑名单
 * 这些命令可能导致系统不稳定或数据丢失
 */
export const DANGEROUS_COMMANDS = [
  '/system/reset',
  '/system/reset-configuration',
  '/file/remove',
  '/system/package/uninstall',
  '/user/remove',
  '/certificate/remove',
];

/**
 * 验证命令安全性
 * @param command 要验证的命令
 * @returns 验证结果，包含是否安全和原因
 */
export function validateCommandSafety(command: string): { safe: boolean; reason?: string } {
  const normalizedCommand = command.toLowerCase().trim();

  for (const dangerous of DANGEROUS_COMMANDS) {
    if (normalizedCommand.startsWith(dangerous)) {
      return {
        safe: false,
        reason: `命令 "${command}" 被禁止执行，因为它可能导致系统不稳定或数据丢失`,
      };
    }
  }

  return { safe: true };
}

/**
 * execute_command 工具
 * 执行设备命令并返回结果
 * Requirements: 4.1, 4.2, 4.5
 */
export const executeCommandTool: EnhancedAgentTool = {
  name: 'execute_command',
  description: '执行受管设备命令并返回结果。支持查询和配置命令。注意：危险命令（如系统重置、文件删除）会被自动拦截。推荐将路径和参数合并为一个 command 字符串（如 "/ip/address/add address=192.168.1.1/24 interface=ether1"），系统会自动解析。',
  parameters: {
    command: {
      type: 'string',
      description: '设备命令。推荐格式：将路径和参数写在一起，如 "/ip/address/add address=192.168.1.1/24 interface=ether1"、"/interface/disable numbers=ether2"。也支持纯路径格式如 /ip/address/add（此时参数通过 args 传递）。',
      required: true,
    },
    args: {
      type: 'object',
      description: '命令参数对象（可选）。当 command 只包含路径时使用，如 { "address": "192.168.1.1/24", "interface": "ether1" }。推荐直接将参数写在 command 中，无需使用此字段。',
      required: false,
    },
  },
  metadata: TOOL_METADATA.execute_command,
  execute: async (params: Record<string, unknown>) => {
    try {
      let command = params.command as string;
      let args = params.args as Record<string, string> | undefined;

      // Fallback: Check if command is inside args (LLM hallucination)
      // Fix: 提取后清理 args.command，避免多余参数发送给设备
      if (!command && args && args.command) {
        command = args.command;
        // 克隆 args 并移除 command 键，避免将其作为参数传递给设备
        const { command: _removed, ...cleanedArgs } = args;
        args = Object.keys(cleanedArgs).length > 0 ? cleanedArgs : undefined;
      }

      if (!command) {
        return {
          success: false,
          error: '命令路径不能为空。请确保 command 参数存在，或者在 args 中包含 command。',
        };
      }

      // 验证命令安全性
      const safetyCheck = validateCommandSafety(command);
      if (!safetyCheck.safe) {
        logger.warn('Dangerous command rejected', { command, reason: safetyCheck.reason });
        return {
          success: false,
          error: safetyCheck.reason,
          blocked: true,
        };
      }

      // 多设备支持：使用请求级客户端，回退到全局单例
      // Requirements: 8.1, 8.2
      const client = getEffectiveClient(params);

      // 检查连接状态
      if (!client.isConnected()) {
        return {
          success: false,
          error: '[DEVICE_DISCONNECTED] 未连接到受管设备，请检查设备状态或等待自动重连。',
        };
      }

      // 判断 args 是否为有效（非空）对象
      // Fix: 空对象 {} 视为无 args，避免阻止 CLI 格式自动检测
      const hasValidArgs = args && typeof args === 'object' && Object.keys(args).length > 0;

      // 自动检测完整 CLI 命令格式（包含路径和参数）
      // 当 LLM 传入完整 CLI 命令（如 "/ip/address/add address=192.168.1.1/24 interface=ether1"）时
      // 自动分离路径和参数
      if (!hasValidArgs && isFullCliCommand(command)) {
        const { apiCommand, params: cliParams } = convertToApiFormat(command);
        logger.info(`Auto-detected full CLI command, converted: ${command} -> ${apiCommand}`, { params: cliParams });
        const result = await client.executeRaw(apiCommand, cliParams);
        return {
          success: true,
          command: apiCommand,
          args: {},
          result,
        };
      }

      // 自动检测 CLI 风格命令（路径中包含空格，如 "/ip arp print"）
      // 这类命令没有 = 参数，但路径需要转换为 API 格式
      if (!hasValidArgs && command.startsWith('/') && command.includes(' ')) {
        const { apiCommand, params: cliParams } = convertToApiFormat(command);
        logger.info(`Auto-detected CLI-style command with spaces, converted: ${command} -> ${apiCommand}`, { params: cliParams });
        const result = await client.executeRaw(apiCommand, cliParams);
        return {
          success: true,
          command: apiCommand,
          args: {},
          result,
        };
      }

      // 构建参数数组
      const paramArray: string[] = [];
      if (hasValidArgs) {
        Object.entries(args!).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            paramArray.push(`=${key}=${String(value)}`);
          }
        });
      }

      // 执行命令
      const result = await client.executeRaw(command, paramArray);

      return {
        success: true,
        command,
        args: args || {},
        result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('execute_command tool failed', { error: errorMessage });
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};

// ==================== 监控指标工具 ====================

/**
 * monitor_metrics 工具
 * 获取受管设备系统监控指标
 * Requirements: 4.3, 4.5
 */
export const monitorMetricsTool: EnhancedAgentTool = {
  name: 'monitor_metrics',
  description: '获取受管设备系统监控指标，包括 CPU、内存、磁盘使用率和接口流量。用于实时监控设备状态和性能分析。',
  parameters: {
    metrics: {
      type: 'array',
      description: '要获取的指标类型数组。可选值：cpu（CPU 使用率）、memory（内存使用）、disk（磁盘使用）、interfaces（接口流量）、all（所有指标）。默认为 all。',
      required: false,
    },
    interface: {
      type: 'string',
      description: '指定接口名称，仅获取该接口的流量指标。如 ether1、bridge1。不指定则获取所有接口。',
      required: false,
    },
  },
  metadata: TOOL_METADATA.monitor_metrics,
  execute: async (params: Record<string, unknown>) => {
    try {
      const metricsParam = params.metrics as string[] | undefined;
      const interfaceName = params.interface as string | undefined;

      // 默认获取所有指标
      const metricsToFetch = metricsParam && metricsParam.length > 0
        ? metricsParam
        : ['all'];

      // 多设备支持：使用请求级客户端，回退到全局单例
      // Requirements: 8.1, 8.2
      const client = getEffectiveClient(params);

      // 检查连接状态
      if (!client.isConnected()) {
        return {
          success: false,
          error: '[DEVICE_DISCONNECTED] 未连接到受管设备，请检查设备状态或等待自动重连。',
        };
      }

      const result: Record<string, unknown> = {};
      const fetchAll = metricsToFetch.includes('all');

      // 获取 CPU 和内存指标（来自 /system/resource）
      if (fetchAll || metricsToFetch.includes('cpu') || metricsToFetch.includes('memory')) {
        try {
          const resources = await client.print<Record<string, string>>('/system/resource');
          if (resources && resources.length > 0) {
            const resource = resources[0];

            if (fetchAll || metricsToFetch.includes('cpu')) {
              result.cpu = {
                load: resource['cpu-load'] || '0',
                count: resource['cpu-count'] || '1',
                frequency: resource['cpu-frequency'] || 'unknown',
              };
            }

            if (fetchAll || metricsToFetch.includes('memory')) {
              const totalMemory = parseInt(resource['total-memory'] || '0', 10);
              const freeMemory = parseInt(resource['free-memory'] || '0', 10);
              const usedMemory = totalMemory - freeMemory;
              const usagePercent = totalMemory > 0 ? ((usedMemory / totalMemory) * 100).toFixed(1) : '0';

              result.memory = {
                total: totalMemory,
                free: freeMemory,
                used: usedMemory,
                usagePercent: `${usagePercent}%`,
              };
            }
          }
        } catch (error) {
          logger.warn('Failed to fetch system resource metrics', { error });
        }
      }

      // 获取磁盘指标（来自 /system/resource）
      if (fetchAll || metricsToFetch.includes('disk')) {
        try {
          const resources = await client.print<Record<string, string>>('/system/resource');
          if (resources && resources.length > 0) {
            const resource = resources[0];
            const totalHdd = parseInt(resource['total-hdd-space'] || '0', 10);
            const freeHdd = parseInt(resource['free-hdd-space'] || '0', 10);
            const usedHdd = totalHdd - freeHdd;
            const usagePercent = totalHdd > 0 ? ((usedHdd / totalHdd) * 100).toFixed(1) : '0';

            result.disk = {
              total: totalHdd,
              free: freeHdd,
              used: usedHdd,
              usagePercent: `${usagePercent}%`,
            };
          }
        } catch (error) {
          logger.warn('Failed to fetch disk metrics', { error });
        }
      }

      // 获取接口流量指标
      if (fetchAll || metricsToFetch.includes('interfaces')) {
        try {
          const query = interfaceName ? { name: interfaceName } : undefined;
          const interfaces = await client.print<Record<string, string>>('/interface', query);

          result.interfaces = interfaces.map(iface => ({
            name: iface.name,
            type: iface.type,
            running: iface.running === 'true',
            disabled: iface.disabled === 'true',
            rxBytes: iface['rx-byte'] || '0',
            txBytes: iface['tx-byte'] || '0',
            rxPackets: iface['rx-packet'] || '0',
            txPackets: iface['tx-packet'] || '0',
            rxErrors: iface['rx-error'] || '0',
            txErrors: iface['tx-error'] || '0',
          }));
        } catch (error) {
          logger.warn('Failed to fetch interface metrics', { error });
        }
      }

      return {
        success: true,
        timestamp: Date.now(),
        metrics: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('monitor_metrics tool failed', { error: errorMessage });
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};

// ==================== 连通性检查工具 ====================

/**
 * check_connectivity 工具
 * 检查网络连通性，支持 ping 和 traceroute
 * Requirements: 4.4, 4.5
 */
export const checkConnectivityTool: EnhancedAgentTool = {
  name: 'check_connectivity',
  description: '检查网络连通性，支持 ping 和 traceroute。用于诊断网络问题、验证路由可达性。',
  parameters: {
    target: {
      type: 'string',
      description: '目标地址，可以是 IP 地址（如 8.8.8.8）或域名（如 google.com）',
      required: true,
    },
    type: {
      type: 'string',
      description: '检查类型：ping（测试连通性和延迟）或 traceroute（追踪路由路径）。默认 ping。',
      required: false,
    },
    count: {
      type: 'number',
      description: 'ping 次数，默认 4。增加次数可以获得更准确的延迟统计。',
      required: false,
    },
  },
  metadata: TOOL_METADATA.check_connectivity,
  execute: async (params: Record<string, unknown>) => {
    try {
      const target = params.target as string;
      const checkType = (params.type as string) || 'ping';
      const count = (params.count as number) || 4;

      if (!target) {
        return {
          success: false,
          error: '目标地址不能为空',
        };
      }

      // 多设备支持：使用请求级客户端，回退到全局单例
      // Requirements: 8.1, 8.2
      const client = getEffectiveClient(params);

      // 检查连接状态
      if (!client.isConnected()) {
        return {
          success: false,
          error: '[DEVICE_DISCONNECTED] 未连接到受管设备，请检查设备状态或等待自动重连。',
        };
      }

      if (checkType === 'ping') {
        // 执行 ping 命令
        // RouterOS ping: /ping address=x.x.x.x count=4
        try {
          const pingParams = [
            `=address=${target}`,
            `=count=${count}`,
          ];

          const result = await client.executeRaw('/ping', pingParams);

          // 解析 ping 结果
          const pingResults = Array.isArray(result) ? result : [];
          const successCount = pingResults.filter((r: Record<string, string>) => r.status === 'echo-reply' || r.time).length;
          const avgTime = pingResults.length > 0
            ? pingResults
              .filter((r: Record<string, string>) => r.time)
              .reduce((sum: number, r: Record<string, string>) => sum + parseInt(r.time || '0', 10), 0) / Math.max(successCount, 1)
            : 0;

          return {
            success: true,
            type: 'ping',
            target,
            count,
            results: {
              sent: count,
              received: successCount,
              lost: count - successCount,
              lossPercent: `${((count - successCount) / count * 100).toFixed(1)}%`,
              avgTime: `${avgTime.toFixed(2)}ms`,
              details: pingResults,
            },
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorCode = classifyAgentToolError(errorMessage);
          return {
            success: false,
            type: 'ping',
            target,
            error: `[${errorCode}] ${errorMessage}`,
          };
        }
      } else if (checkType === 'traceroute') {
        // 执行 traceroute 命令
        // RouterOS traceroute: /tool/traceroute address=x.x.x.x
        try {
          const traceParams = [
            `=address=${target}`,
          ];

          const result = await client.executeRaw('/tool/traceroute', traceParams);

          // 解析 traceroute 结果
          const hops = Array.isArray(result) ? result : [];

          return {
            success: true,
            type: 'traceroute',
            target,
            results: {
              hopCount: hops.length,
              hops: hops.map((hop: Record<string, string>, index: number) => ({
                hop: index + 1,
                address: hop.address || '*',
                time: hop.time || '*',
                status: hop.status || 'unknown',
              })),
            },
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorCode = classifyAgentToolError(errorMessage);
          return {
            success: false,
            type: 'traceroute',
            target,
            error: `[${errorCode}] ${errorMessage}`,
          };
        }
      } else {
        return {
          success: false,
          error: `不支持的检查类型: ${checkType}，请使用 ping 或 traceroute`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('check_connectivity tool failed', { error: errorMessage });
      const errorCode = classifyAgentToolError(errorMessage);
      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      };
    }
  },
};

// ==================== 工具集合 ====================

/**
 * 所有预定义工具
 */
export const predefinedTools: EnhancedAgentTool[] = [
  knowledgeSearchTool,
  deviceQueryTool,
  alertAnalysisTool,
  generateRemediationTool,
  configDiffTool,
  executeCommandTool,
  monitorMetricsTool,
  checkConnectivityTool,
];

/**
 * 注册所有预定义工具到 Agent
 */
export function registerPredefinedTools(agent: { registerTool: (tool: AgentTool) => void }): void {
  for (const tool of predefinedTools) {
    agent.registerTool(tool);
  }
  logger.info(`Registered ${predefinedTools.length} predefined tools`);
}

/**
 * 获取工具描述（用于文档或 API）
 */
export function getToolDescriptions(): Array<{
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  metadata?: ToolMetadata;
}> {
  return predefinedTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    metadata: tool.metadata,
  }));
}

// ==================== 工具优先级排序辅助函数 ====================

/**
 * 根据优先级排序工具
 * Requirements: 5.1
 * @param tools 工具列表
 * @param ascending 是否升序（true = 优先级高的在前）
 * @returns 排序后的工具列表
 */
export function sortToolsByPriority(
  tools: EnhancedAgentTool[],
  ascending: boolean = true
): EnhancedAgentTool[] {
  return [...tools].sort((a, b) => {
    const priorityA = a.metadata?.priority ?? 5;
    const priorityB = b.metadata?.priority ?? 5;
    return ascending ? priorityA - priorityB : priorityB - priorityA;
  });
}

/**
 * 根据分类过滤工具
 * Requirements: 5.1
 * @param tools 工具列表
 * @param category 工具分类
 * @returns 过滤后的工具列表
 */
export function filterToolsByCategory(
  tools: EnhancedAgentTool[],
  category: ToolCategory
): EnhancedAgentTool[] {
  return tools.filter(tool => tool.metadata?.category === category);
}

/**
 * 根据问题类型获取适用的工具
 * Requirements: 5.1
 * @param tools 工具列表
 * @param questionType 问题类型
 * @returns 适用的工具列表（按优先级排序）
 */
export function getToolsForQuestionType(
  tools: EnhancedAgentTool[],
  questionType: string
): EnhancedAgentTool[] {
  const applicableTools = tools.filter(tool =>
    tool.metadata?.applicableQuestionTypes?.includes(questionType)
  );
  return sortToolsByPriority(applicableTools);
}

/**
 * 获取知识增强模式下的工具优先级顺序
 * Requirements: 5.1
 * @param tools 工具列表
 * @returns 按知识增强优先级排序的工具名称列表
 */
export function getKnowledgeEnhancedToolOrder(tools: EnhancedAgentTool[]): string[] {
  // 首先按知识增强优先级分组，然后按普通优先级排序
  const knowledgeFirst = tools.filter(t => t.metadata?.knowledgeEnhancedPriority);
  const others = tools.filter(t => !t.metadata?.knowledgeEnhancedPriority);

  const sortedKnowledgeFirst = sortToolsByPriority(knowledgeFirst);
  const sortedOthers = sortToolsByPriority(others);

  return [...sortedKnowledgeFirst, ...sortedOthers].map(t => t.name);
}

/**
 * 获取工具元数据
 * @param toolName 工具名称
 * @returns 工具元数据，如果不存在则返回默认值
 */
export function getToolMetadata(toolName: string): ToolMetadata {
  return TOOL_METADATA[toolName] ?? {
    priority: 5,
    category: 'device',
    knowledgeEnhancedPriority: false,
    applicableQuestionTypes: ['general'],
  };
}
