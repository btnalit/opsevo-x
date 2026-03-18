/**
 * 边工具函数 - 边 ID 生成与置信度计算
 *
 * Property 2: 置信度计算正确性与范围不变量
 * Property 3: 边去重与双向合并
 * Requirements: 2.1-2.5, 3.1, 3.4, 3.8
 */

import { DiscoverySource } from './types';

/**
 * 生成边的唯一标识（双向合并）
 * (A→B, if1, if2) 和 (B→A, if2, if1) 生成相同的边 ID
 */
export function generateEdgeId(
  sourceDeviceId: string,
  targetDeviceId: string,
  localInterface: string,
  remoteInterface: string,
): string {
  const [first, second] = sourceDeviceId < targetDeviceId
    ? [sourceDeviceId, targetDeviceId]
    : [targetDeviceId, sourceDeviceId];
  const [if1, if2] = sourceDeviceId < targetDeviceId
    ? [localInterface, remoteInterface]
    : [remoteInterface, localInterface];
  return `edge-${first}-${second}-${if1}-${if2}`;
}

/**
 * 计算边的置信度
 *
 * 多源确认时累加权重，上限 1.0
 * 滑动窗口线性加权：权重序列 [1, 2, ..., N]，归一化后求加权平均
 * 索引 0 为最旧快照，索引 N-1 为最新快照
 *
 * @param sources 当前确认该边的发现来源列表
 * @param weights 各来源的置信度权重配置
 * @param slidingWindowSnapshots 最近 N 个快照中该边是否出现（索引 0 最旧）
 * @returns 0.0 - 1.0 的置信度值
 */
export function calculateEdgeConfidence(
  sources: DiscoverySource[],
  weights: Record<string, number>,
  slidingWindowSnapshots: boolean[],
): number {
  if (sources.length === 0) return 0;

  // 计算基础置信度：累加各来源权重
  const baseConfidence = sources.reduce((sum, src) => sum + (weights[src] || 0), 0);
  const clampedBase = Math.min(1.0, Math.max(0, baseConfidence));

  // 如果没有滑动窗口数据，直接返回基础置信度
  if (slidingWindowSnapshots.length === 0) return clampedBase;

  // 滑动窗口线性加权：[1, 2, ..., N]
  const n = slidingWindowSnapshots.length;
  const totalWeight = (n * (n + 1)) / 2; // 1+2+...+N = N*(N+1)/2

  let weightedPresence = 0;
  for (let i = 0; i < n; i++) {
    if (slidingWindowSnapshots[i]) {
      weightedPresence += (i + 1); // 权重从 1 到 N
    }
  }

  const windowFactor = weightedPresence / totalWeight;
  const result = clampedBase * windowFactor;

  return Math.min(1.0, Math.max(0, Math.round(result * 1000) / 1000));
}
