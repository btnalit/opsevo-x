/**
 * 三态状态机
 *
 * pending → confirmed → stale → removed
 * 支持分层稳定性阈值（infrastructure vs endpoint）
 *
 * Property 5: 三态状态机转换正确性
 * Property 6: Stale 过期移除
 * Requirements: 3.5, 3.6, 3.7, 5.5
 */

import { NodeState, StabilityTier, TopologyDiscoveryConfig } from './types';

export interface StateMachineEntity {
  state: NodeState;
  confirmCount: number;
  missCount: number;
  lastSeenAt: number;
  stabilityTier?: StabilityTier;
}

/**
 * 获取确认阈值
 */
export function getConfirmThreshold(tier: StabilityTier, config: TopologyDiscoveryConfig): number {
  return tier === 'infrastructure' ? config.infraConfirmCount : config.endpointConfirmCount;
}

/**
 * 获取失效阈值
 */
export function getStaleThreshold(tier: StabilityTier, config: TopologyDiscoveryConfig): number {
  return tier === 'infrastructure' ? config.infraStaleThresholdCount : config.endpointStaleThresholdCount;
}

/**
 * 处理实体被发现（本轮采集中出现）
 * 返回更新后的状态
 */
export function onEntitySeen(entity: StateMachineEntity, tier: StabilityTier, config: TopologyDiscoveryConfig, now: number): StateMachineEntity {
  const confirmThreshold = getConfirmThreshold(tier, config);
  const newConfirmCount = entity.confirmCount + 1;

  if (entity.state === 'pending') {
    if (newConfirmCount >= confirmThreshold) {
      return { ...entity, state: 'confirmed', confirmCount: newConfirmCount, missCount: 0, lastSeenAt: now };
    }
    return { ...entity, confirmCount: newConfirmCount, missCount: 0, lastSeenAt: now };
  }

  if (entity.state === 'stale') {
    // stale → confirmed（重新被发现）
    if (newConfirmCount >= confirmThreshold) {
      return { ...entity, state: 'confirmed', confirmCount: newConfirmCount, missCount: 0, lastSeenAt: now };
    }
    return { ...entity, state: 'pending', confirmCount: newConfirmCount, missCount: 0, lastSeenAt: now };
  }

  // confirmed 状态：重置 missCount，更新 lastSeen
  return { ...entity, confirmCount: newConfirmCount, missCount: 0, lastSeenAt: now };
}

/**
 * 处理实体未被发现（本轮采集中缺失）
 * 返回更新后的状态，或 null 表示应从图中移除
 */
export function onEntityMissed(entity: StateMachineEntity, tier: StabilityTier, config: TopologyDiscoveryConfig, now: number): StateMachineEntity | null {
  const staleThreshold = getStaleThreshold(tier, config);
  const newMissCount = entity.missCount + 1;

  if (entity.state === 'confirmed') {
    if (newMissCount >= staleThreshold) {
      return { ...entity, state: 'stale', missCount: newMissCount };
    }
    return { ...entity, missCount: newMissCount };
  }

  if (entity.state === 'stale') {
    // 检查是否超过过期时间
    if (now - entity.lastSeenAt > config.staleExpiryMs) {
      return null; // 从图中移除
    }
    return { ...entity, missCount: newMissCount };
  }

  // pending 状态：超过过期时间则移除
  if (now - entity.lastSeenAt > config.staleExpiryMs) {
    return null;
  }
  return { ...entity, missCount: newMissCount };
}
