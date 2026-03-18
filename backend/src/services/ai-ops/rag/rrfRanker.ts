/**
 * RRFRanker - Reciprocal Rank Fusion 融合排序器
 * 
 * 实现 RRF 算法，用于融合多路检索结果。
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 * - 4.1: 实现标准 RRF 公式 score(d) = Σ 1/(k + rank_i(d))
 * - 4.2: 处理只出现在单路检索中的文档
 * - 4.3: 归一化最终分数到 0-1 范围
 * - 4.4: 支持可配置的 k 参数
 * - 4.5: 保留各路检索的原始分数
 */

import { logger } from '../../../utils/logger';
import {
  RRFConfig,
  DEFAULT_RRF_CONFIG,
  RankedItem,
  FusedResult,
} from './types/hybridSearch';

/**
 * RRFRanker 融合排序器类
 */
export class RRFRanker {
  private config: RRFConfig;

  constructor(config?: Partial<RRFConfig>) {
    this.config = { ...DEFAULT_RRF_CONFIG, ...config };
    logger.debug('RRFRanker created', { config: this.config });
  }

  /**
   * 融合多路检索结果
   * Requirements: 4.1, 4.2, 4.3, 4.5
   * 
   * @param resultSets 各路检索结果，key 为检索路径名称
   * @returns 融合后的结果列表
   */
  fuse(resultSets: Record<string, RankedItem[]>): FusedResult[] {
    const k = this.config.k;

    // 收集所有文档 ID 及其在各路检索中的排名和分数
    const docData = new Map<string, {
      ranks: Record<string, number>;
      scores: Record<string, number>;
    }>();

    // 遍历所有检索路径
    for (const [pathName, items] of Object.entries(resultSets)) {
      for (const item of items) {
        let data = docData.get(item.id);
        if (!data) {
          data = { ranks: {}, scores: {} };
          docData.set(item.id, data);
        }

        data.ranks[pathName] = item.rank;
        data.scores[pathName] = item.score;
      }
    }

    // 计算每个文档的 RRF 分数
    const results: FusedResult[] = [];
    const pathNames = Object.keys(resultSets);

    for (const [id, data] of docData) {
      // 计算 RRF 分数
      const rrfScore = this.calculateRRFScore(
        pathNames.map(name => data.ranks[name]),
        k
      );

      results.push({
        id,
        rrfScore,
        normalizedScore: 0, // 稍后归一化
        ranks: data.ranks,
        scores: data.scores,
      });
    }

    // 按 RRF 分数排序
    results.sort((a, b) => b.rrfScore - a.rrfScore);

    // 归一化分数到 0-1 范围
    if (this.config.normalizeScores && results.length > 0) {
      const maxScore = results[0].rrfScore;
      const minScore = results[results.length - 1].rrfScore;
      const range = maxScore - minScore;

      for (const result of results) {
        if (range > 0) {
          result.normalizedScore = (result.rrfScore - minScore) / range;
        } else {
          // 当 range 为 0 时（只有 1 个结果或所有结果分数相同），避免盲目自信给 1.0 (导致直达模式)
          // 给予 0.5 (中等置信度)，这将使 FastPath 降级为 Enhanced 或 Exploration 模式，
          // 从而让 LLM 进行最终决策，这是更安全的策略。
          result.normalizedScore = 0.5;
        }
      }
    }

    logger.debug('RRF fusion completed', {
      inputPaths: pathNames.length,
      totalDocs: results.length,
    });

    return results;
  }

  /**
   * 计算单个文档的 RRF 分数
   * Requirements: 4.1, 4.2
   * 
   * RRF 公式: score(d) = Σ 1/(k + rank_i(d))
   * 
   * @param ranks 各路检索中的排名（undefined 表示未出现）
   * @param k RRF k 参数
   * @returns RRF 分数
   */
  calculateRRFScore(ranks: (number | undefined)[], k: number = this.config.k): number {
    let score = 0;

    for (const rank of ranks) {
      if (rank !== undefined && rank > 0) {
        // RRF 公式: 1 / (k + rank)
        score += 1 / (k + rank);
      }
      // 如果 rank 为 undefined，表示该文档未出现在该路检索中
      // 不贡献分数（相当于排名无穷大）
    }

    return score;
  }

  /**
   * 融合两路检索结果（简化版本）
   * 
   * @param keywordResults 关键词检索结果
   * @param vectorResults 向量检索结果
   * @param keywordWeight 关键词权重
   * @param vectorWeight 向量权重
   * @returns 融合后的结果
   */
  fuseTwoPaths(
    keywordResults: RankedItem[],
    vectorResults: RankedItem[],
    keywordWeight: number = 0.4,
    vectorWeight: number = 0.6
  ): FusedResult[] {
    // 使用加权 RRF
    const k = this.config.k;

    // 收集所有文档
    const docData = new Map<string, {
      keywordRank?: number;
      keywordScore?: number;
      vectorRank?: number;
      vectorScore?: number;
    }>();

    // 处理关键词结果
    for (const item of keywordResults) {
      docData.set(item.id, {
        keywordRank: item.rank,
        keywordScore: item.score,
      });
    }

    // 处理向量结果
    for (const item of vectorResults) {
      const existing = docData.get(item.id) || {};
      docData.set(item.id, {
        ...existing,
        vectorRank: item.rank,
        vectorScore: item.score,
      });
    }

    // 计算加权 RRF 分数
    const results: FusedResult[] = [];

    for (const [id, data] of docData) {
      let rrfScore = 0;

      // 关键词检索贡献
      if (data.keywordRank !== undefined) {
        rrfScore += keywordWeight * (1 / (k + data.keywordRank));
      }

      // 向量检索贡献
      if (data.vectorRank !== undefined) {
        rrfScore += vectorWeight * (1 / (k + data.vectorRank));
      }

      results.push({
        id,
        rrfScore,
        normalizedScore: 0,
        ranks: {
          keyword: data.keywordRank ?? -1,
          vector: data.vectorRank ?? -1,
        },
        scores: {
          keyword: data.keywordScore ?? 0,
          vector: data.vectorScore ?? 0,
        },
      });
    }

    // 排序
    results.sort((a, b) => b.rrfScore - a.rrfScore);

    // 归一化
    if (this.config.normalizeScores && results.length > 0) {
      const maxScore = results[0].rrfScore;
      const minScore = results[results.length - 1].rrfScore;
      const range = maxScore - minScore;

      for (const result of results) {
        if (range > 0) {
          result.normalizedScore = (result.rrfScore - minScore) / range;
        } else {
          // 当 range 为 0 时（只有 1 个结果或所有结果分数相同），避免盲目自信给 1.0 (导致直达模式)
          // 给予 0.5 (中等置信度)，这将使 FastPath 降级为 Enhanced 或 Exploration 模式，
          // 从而让 LLM 进行最终决策，这是更安全的策略。
          result.normalizedScore = 0.5;
        }
      }
    }

    return results;
  }

  /**
   * 获取配置
   */
  getConfig(): RRFConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<RRFConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('RRFRanker config updated', { config: this.config });
  }
}

// 导出单例实例
export const rrfRanker = new RRFRanker();
