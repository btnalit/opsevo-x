/**
 * DiffBatchProcessor — 防抖批处理器
 *
 * 在 300ms 防抖窗口内累积多次 SSE diff 事件，合并为单次图更新。
 * 冲突消解规则：
 * - 同一节点先 add 后 remove → 抵消为无操作
 * - 同一节点先 remove 后 add → 视为 update
 * - 同一节点多次 update → 合并为最终状态
 * - 边的处理逻辑同上
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import type { TopologyDiff, TopologyNode, TopologyEdge } from '@/composables/useTopologySSE'

export interface MergedDiff {
  nodesAdded: Map<string, TopologyNode>
  nodesRemoved: Set<string>
  nodesUpdated: Map<string, Record<string, unknown>>
  edgesAdded: Map<string, TopologyEdge>
  edgesRemoved: Set<string>
  edgesUpdated: Map<string, Record<string, unknown>>
}

function createEmptyMergedDiff(): MergedDiff {
  return {
    nodesAdded: new Map(),
    nodesRemoved: new Set(),
    nodesUpdated: new Map(),
    edgesAdded: new Map(),
    edgesRemoved: new Set(),
    edgesUpdated: new Map(),
  }
}

export class DiffBatchProcessor {
  private buffer: MergedDiff = createEmptyMergedDiff()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly onFlush: (merged: MergedDiff) => void
  private readonly debounceMs: number
  private destroyed = false

  constructor(onFlush: (merged: MergedDiff) => void, debounceMs = 300) {
    this.onFlush = onFlush
    this.debounceMs = debounceMs
  }

  /** 累积一个 diff 到缓冲区 */
  push(diff: TopologyDiff): void {
    if (this.destroyed) return

    this.mergeNodes(diff)
    this.mergeEdges(diff)
    this.scheduleFlush()
  }

  /** 立即刷新缓冲区 */
  flush(): void {
    if (this.destroyed) return
    this.cancelTimer()

    if (this.isBufferEmpty()) return

    const merged = this.buffer
    this.buffer = createEmptyMergedDiff()
    this.onFlush(merged)
  }

  /** Whether the buffer has pending data waiting to be flushed */
  get hasPending(): boolean {
    return !this.isBufferEmpty()
  }

  /** 销毁处理器，清理定时器和缓冲区 */
  destroy(): void {
    this.destroyed = true
    this.cancelTimer()
    this.buffer = createEmptyMergedDiff()
  }

  // ==================== 节点合并 ====================

  private mergeNodes(diff: TopologyDiff): void {
    // 处理 nodesAdded
    for (const node of diff.nodesAdded) {
      if (this.buffer.nodesRemoved.has(node.id)) {
        // remove 后 add → 视为 update（从 removed 中移除，放入 updated）
        this.buffer.nodesRemoved.delete(node.id)
        this.buffer.nodesUpdated.set(node.id, this.nodeToRecord(node))
      } else {
        this.buffer.nodesAdded.set(node.id, node)
        // 如果之前有 update，清除（add 已包含完整数据）
        this.buffer.nodesUpdated.delete(node.id)
      }
    }

    // 处理 nodesRemoved
    for (const node of diff.nodesRemoved) {
      if (this.buffer.nodesAdded.has(node.id)) {
        // add 后 remove → 抵消为无操作
        this.buffer.nodesAdded.delete(node.id)
        this.buffer.nodesUpdated.delete(node.id)
      } else {
        this.buffer.nodesRemoved.add(node.id)
        // 清除该节点的 update（已被删除）
        this.buffer.nodesUpdated.delete(node.id)
      }
    }

    // 处理 nodesUpdated
    for (const update of diff.nodesUpdated) {
      const { nodeId, changes } = update

      // 如果节点在 added 中，直接更新 added 中的数据
      if (this.buffer.nodesAdded.has(nodeId)) {
        const existing = this.buffer.nodesAdded.get(nodeId)!
        this.applyChangesToNode(existing, changes)
        continue
      }

      // 如果节点在 removed 中，忽略更新
      if (this.buffer.nodesRemoved.has(nodeId)) continue

      // 合并到 updated（多次 update 合并为最终状态）
      const existing = this.buffer.nodesUpdated.get(nodeId) || {}
      for (const [key, value] of Object.entries(changes)) {
        existing[key] = (value as { old: unknown; new: unknown }).new
      }
      this.buffer.nodesUpdated.set(nodeId, existing)
    }
  }

  // ==================== 边合并 ====================

  private mergeEdges(diff: TopologyDiff): void {
    // 处理 edgesAdded
    for (const edge of diff.edgesAdded) {
      if (this.buffer.edgesRemoved.has(edge.id)) {
        // remove 后 add → 视为 update
        this.buffer.edgesRemoved.delete(edge.id)
        this.buffer.edgesUpdated.set(edge.id, this.edgeToRecord(edge))
      } else {
        this.buffer.edgesAdded.set(edge.id, edge)
        this.buffer.edgesUpdated.delete(edge.id)
      }
    }

    // 处理 edgesRemoved
    for (const edge of diff.edgesRemoved) {
      if (this.buffer.edgesAdded.has(edge.id)) {
        // add 后 remove → 抵消
        this.buffer.edgesAdded.delete(edge.id)
        this.buffer.edgesUpdated.delete(edge.id)
      } else {
        this.buffer.edgesRemoved.add(edge.id)
        this.buffer.edgesUpdated.delete(edge.id)
      }
    }

    // 处理 edgesUpdated
    for (const update of diff.edgesUpdated) {
      const { edgeId, changes } = update

      if (this.buffer.edgesAdded.has(edgeId)) {
        const existing = this.buffer.edgesAdded.get(edgeId)!
        this.applyChangesToEdge(existing, changes)
        continue
      }

      if (this.buffer.edgesRemoved.has(edgeId)) continue

      const existing = this.buffer.edgesUpdated.get(edgeId) || {}
      for (const [key, value] of Object.entries(changes)) {
        existing[key] = (value as { old: unknown; new: unknown }).new
      }
      this.buffer.edgesUpdated.set(edgeId, existing)
    }
  }

  // ==================== 辅助方法 ====================

  private scheduleFlush(): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private isBufferEmpty(): boolean {
    return (
      this.buffer.nodesAdded.size === 0 &&
      this.buffer.nodesRemoved.size === 0 &&
      this.buffer.nodesUpdated.size === 0 &&
      this.buffer.edgesAdded.size === 0 &&
      this.buffer.edgesRemoved.size === 0 &&
      this.buffer.edgesUpdated.size === 0
    )
  }

  /** 将 TopologyNode 的关键字段转为 Record（用于 remove→add 转 update 场景） */
  private nodeToRecord(node: TopologyNode): Record<string, unknown> {
    return {
      hostname: node.hostname,
      ipAddresses: node.ipAddresses,
      macAddress: node.macAddress,
      deviceType: node.deviceType,
      state: node.state,
      stabilityTier: node.stabilityTier,
      ...(node.confidence !== undefined && { confidence: node.confidence }),
      ...(node.endpointInfo && { endpointInfo: node.endpointInfo }),
    }
  }

  /** 将 TopologyEdge 的关键字段转为 Record */
  private edgeToRecord(edge: TopologyEdge): Record<string, unknown> {
    return {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      localInterface: edge.localInterface,
      remoteInterface: edge.remoteInterface,
      confidence: edge.confidence,
      sources: edge.sources,
      state: edge.state,
    }
  }

  /** 将 changes 应用到已有的 TopologyNode 对象上 */
  private applyChangesToNode(
    node: TopologyNode,
    changes: Record<string, { old: unknown; new: unknown }>,
  ): void {
    for (const [key, value] of Object.entries(changes)) {
      ;(node as unknown as Record<string, unknown>)[key] = value.new
    }
  }

  /** 将 changes 应用到已有的 TopologyEdge 对象上 */
  private applyChangesToEdge(
    edge: TopologyEdge,
    changes: Record<string, { old: unknown; new: unknown }>,
  ): void {
    for (const [key, value] of Object.entries(changes)) {
      ;(edge as unknown as Record<string, unknown>)[key] = value.new
    }
  }
}
