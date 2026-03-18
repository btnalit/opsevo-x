/**
 * 抑制定时器与滑动窗口
 *
 * Property 10: 抑制定时器批量合并
 * Property 11: 滑动窗口加权置信度
 * Requirements: 3.8, 3.9
 */

import { TopologyDiff } from './types';
import { isDiffEmpty } from './diffEngine';

/**
 * 滑动窗口 - 维护最近 N 个快照的边出现记录
 */
export class SlidingWindow {
  private readonly maxSize: number;
  /** edgeId → boolean[] (索引 0 最旧) */
  private snapshots: Map<string, boolean[]> = new Map();

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * 记录一个新快照
   * @param presentEdgeIds 本轮发现中出现的边 ID 集合
   */
  recordSnapshot(presentEdgeIds: Set<string>): void {
    // 收集所有已知的边 ID
    const allEdgeIds = new Set([...this.snapshots.keys(), ...presentEdgeIds]);

    for (const edgeId of allEdgeIds) {
      const history = this.snapshots.get(edgeId) || [];
      history.push(presentEdgeIds.has(edgeId));

      // 保持窗口大小
      while (history.length > this.maxSize) {
        history.shift();
      }

      this.snapshots.set(edgeId, history);
    }
  }

  /**
   * 获取边的滑动窗口快照
   */
  getSnapshots(edgeId: string): boolean[] {
    return this.snapshots.get(edgeId) || [];
  }

  /**
   * 移除边的记录
   */
  removeEdge(edgeId: string): void {
    this.snapshots.delete(edgeId);
  }

  /**
   * 清理不再存在于图中的边记录（防止内存泄漏）
   */
  pruneAbsentEdges(currentEdges: Map<string, unknown>): void {
    for (const edgeId of this.snapshots.keys()) {
      if (!currentEdges.has(edgeId)) {
        this.snapshots.delete(edgeId);
      }
    }
  }

  /** 清空所有记录 */
  clear(): void {
    this.snapshots.clear();
  }
}

/**
 * 抑制定时器 - 批量合并快速连续的变更
 */
export class DampeningTimer {
  private timer: NodeJS.Timeout | null = null;
  private pendingDiffs: TopologyDiff[] = [];
  private readonly delayMs: number;
  private readonly onFlush: (mergedDiff: TopologyDiff) => void;

  constructor(delayMs: number, onFlush: (mergedDiff: TopologyDiff) => void) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  /**
   * 添加一个待合并的 diff
   */
  addDiff(diff: TopologyDiff): void {
    if (isDiffEmpty(diff)) return;

    this.pendingDiffs.push(diff);

    // 如果定时器未启动，启动它
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  /**
   * 立即刷新所有待合并的 diff
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pendingDiffs.length === 0) return;

    const merged = this.mergeDiffs(this.pendingDiffs);
    this.pendingDiffs = [];

    if (!isDiffEmpty(merged)) {
      this.onFlush(merged);
    }
  }

  /** 停止定时器 */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 获取待处理的 diff 数量 */
  get pendingCount(): number {
    return this.pendingDiffs.length;
  }

  /**
   * 合并多个 diff 为一个
   */
  private mergeDiffs(diffs: TopologyDiff[]): TopologyDiff {
    const now = Date.now();
    const nodesAddedMap = new Map<string, import('./types').TopologyNode>();
    const nodesRemovedMap = new Map<string, import('./types').TopologyNode>();
    const edgesAddedMap = new Map<string, import('./types').TopologyEdge>();
    const edgesRemovedMap = new Map<string, import('./types').TopologyEdge>();
    const edgesUpdatedMap = new Map<string, { edgeId: string; changes: Record<string, { old: unknown; new: unknown }> }>();
    const nodesUpdatedMap = new Map<string, { nodeId: string; changes: Record<string, { old: unknown; new: unknown }> }>();

    for (const diff of diffs) {
      for (const n of diff.nodesAdded) {
        nodesRemovedMap.delete(n.id);
        nodesAddedMap.set(n.id, n);
      }
      for (const n of diff.nodesRemoved) {
        if (nodesAddedMap.has(n.id)) {
          nodesAddedMap.delete(n.id); // 添加后又移除 = 无变化
        } else {
          nodesRemovedMap.set(n.id, n);
        }
      }
      for (const e of diff.edgesAdded) {
        edgesRemovedMap.delete(e.id);
        edgesAddedMap.set(e.id, e);
      }
      for (const e of diff.edgesRemoved) {
        if (edgesAddedMap.has(e.id)) {
          edgesAddedMap.delete(e.id);
        } else {
          edgesRemovedMap.set(e.id, e);
        }
        edgesUpdatedMap.delete(e.id);
      }
      for (const u of diff.edgesUpdated) {
        const existing = edgesUpdatedMap.get(u.edgeId);
        if (existing) {
          // 合并变更：保留最早的 old 和最新的 new
          for (const [key, change] of Object.entries(u.changes)) {
            if (existing.changes[key]) {
              existing.changes[key].new = change.new;
            } else {
              existing.changes[key] = change;
            }
          }
        } else {
          edgesUpdatedMap.set(u.edgeId, { ...u, changes: { ...u.changes } });
        }
      }
      for (const u of diff.nodesUpdated || []) {
        const existing = nodesUpdatedMap.get(u.nodeId);
        if (existing) {
          // 合并变更：保留最早的 old 和最新的 new
          for (const [key, change] of Object.entries(u.changes)) {
            if (existing.changes[key]) {
              existing.changes[key].new = change.new;
            } else {
              existing.changes[key] = change;
            }
          }
        } else {
          nodesUpdatedMap.set(u.nodeId, { ...u, changes: { ...u.changes } });
        }
      }
    }

    return {
      id: `diff-merged-${now}`,
      timestamp: now,
      nodesAdded: Array.from(nodesAddedMap.values()),
      nodesRemoved: Array.from(nodesRemovedMap.values()),
      edgesAdded: Array.from(edgesAddedMap.values()),
      edgesRemoved: Array.from(edgesRemovedMap.values()),
      edgesUpdated: Array.from(edgesUpdatedMap.values()),
      nodesUpdated: Array.from(nodesUpdatedMap.values()),
    };
  }
}
