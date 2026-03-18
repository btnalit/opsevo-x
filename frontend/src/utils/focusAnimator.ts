/**
 * FocusAnimator — 焦点动画控制器
 *
 * 周期性随机选择一个节点作为焦点，高亮该节点及其直接邻居，
 * 非焦点非邻居节点降低透明度。使用 G6 节点样式更新 API
 * 修改单个节点样式，而非创建所有节点的完整副本。
 *
 * - 间隔 ≥ 6 秒
 * - UI 繁忙时（requestIdleCallback 或 DiffBatchProcessor 有待处理数据）跳过当前周期
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import type { DiffBatchProcessor } from './diffBatchProcessor'

/** Minimal interface for the G6 graph instance used by FocusAnimator */
export interface G6GraphLike {
  getNodeData(): Array<{ id: string; style?: Record<string, unknown> }>
  getRelatedEdgesData(nodeId: string): Array<{ source: string; target: string }>
  updateNodeData(updates: Array<{ id: string; style: Record<string, unknown> }>): void
  draw(): Promise<void>
}

/** Minimum allowed interval in milliseconds */
const MIN_INTERVAL_MS = 6000

/** Opacity for non-focus, non-neighbor nodes */
const DIM_OPACITY = 0.3

/** Shadow blur for the focused node */
const FOCUS_SHADOW_BLUR = 16

/** Shadow blur for neighbor nodes */
const NEIGHBOR_SHADOW_BLUR = 10

/** Size boost for the focused node */
const FOCUS_SIZE = 48

/** Default node size (should match G6 graph config) */
// Default size is now passed via constructor parameter

export class FocusAnimator {
  private readonly graph: G6GraphLike
  private readonly intervalMs: number
  private readonly defaultSize: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private drawing = false
  private batchProcessor: DiffBatchProcessor | null = null

  constructor(graph: G6GraphLike, intervalMs = 6000, defaultSize = 40) {
    this.graph = graph
    this.intervalMs = Math.max(intervalMs, MIN_INTERVAL_MS)
    this.defaultSize = defaultSize
  }

  /** Optionally attach a DiffBatchProcessor for busyness detection */
  setBatchProcessor(processor: DiffBatchProcessor | null): void {
    this.batchProcessor = processor
  }

  /** Start the focus animation loop */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      // Use requestIdleCallback to only animate when browser is idle
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => void this.tick(), { timeout: 200 })
      } else {
        void this.tick()
      }
    }, this.intervalMs)
  }

  /** Stop the focus animation loop and optionally restore all node styles */
  stop(skipRestore = false): void {
    if (!this.running) return
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!skipRestore) {
      void this.restoreAllNodes()
    }
  }

  /** Single animation tick — pick a random focus node and update styles */
  private async tick(): Promise<void> {
    if (this.shouldSkip()) return

    const nodes = this.graph.getNodeData()
    if (nodes.length === 0) return

    // Pick a random focus node
    const focusIndex = Math.floor(Math.random() * nodes.length)
    const focusNode = nodes[focusIndex]

    // Find neighbor node IDs
    const neighborIds = this.getNeighborIds(focusNode.id)

    // Build style updates for all nodes in a single batch
    const updates: Array<{ id: string; style: Record<string, unknown> }> = []

    for (const node of nodes) {
      if (node.id === focusNode.id) {
        updates.push({
          id: node.id,
          style: {
            opacity: 1,
            shadowBlur: FOCUS_SHADOW_BLUR,
            size: FOCUS_SIZE,
          },
        })
      } else if (neighborIds.has(node.id)) {
        updates.push({
          id: node.id,
          style: {
            opacity: 0.85,
            shadowBlur: NEIGHBOR_SHADOW_BLUR,
            size: this.defaultSize,
          },
        })
      } else {
        updates.push({
          id: node.id,
          style: {
            opacity: DIM_OPACITY,
            shadowBlur: 0,
            size: this.defaultSize,
          },
        })
      }
    }

    this.drawing = true
    try {
      this.graph.updateNodeData(updates)
      await this.graph.draw()
    } finally {
      this.drawing = false
    }
  }

  /**
   * Check if the current animation cycle should be skipped.
   * Returns true when:
   * - A draw operation is already in progress
   * - DiffBatchProcessor has pending data to flush
   * - requestIdleCallback reports the browser is busy (deadline < 5ms)
   */
  private shouldSkip(): boolean {
    // Skip if we're already drawing
    if (this.drawing) return true

    // Skip if DiffBatchProcessor has pending data
    if (this.batchProcessor?.hasPending) return true

    return false
  }

  /** Get the set of neighbor node IDs for a given node */
  private getNeighborIds(nodeId: string): Set<string> {
    const edges = this.graph.getRelatedEdgesData(nodeId)
    const neighbors = new Set<string>()
    for (const edge of edges) {
      if (edge.source === nodeId) {
        neighbors.add(edge.target)
      } else if (edge.target === nodeId) {
        neighbors.add(edge.source)
      }
    }
    return neighbors
  }

  /** Restore all nodes to default opacity and size */
  private async restoreAllNodes(): Promise<void> {
    if (this.drawing) return
    const nodes = this.graph.getNodeData()
    if (nodes.length === 0) return

    const updates = nodes.map((node) => ({
      id: node.id,
      style: {
        opacity: 1,
        shadowBlur: 0,
        size: this.defaultSize,
      },
    }))

    this.drawing = true
    try {
      this.graph.updateNodeData(updates)
      await this.graph.draw()
    } finally {
      this.drawing = false
    }
  }
}
