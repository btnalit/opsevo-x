"""
三态状态机 — pending → confirmed → stale → removed

支持分层稳定性阈值（infrastructure vs endpoint）

Requirements: 16.2
"""

from __future__ import annotations

from dataclasses import dataclass

from opsevo.services.topology.types import (
    NodeState, StabilityTier, TopologyDiscoveryConfig,
)


@dataclass
class StateMachineEntity:
    state: NodeState
    confirm_count: int
    miss_count: int
    last_seen_at: float
    stability_tier: StabilityTier = StabilityTier.INFRASTRUCTURE


def get_confirm_threshold(tier: StabilityTier, config: TopologyDiscoveryConfig) -> int:
    return config.infra_confirm_count if tier == StabilityTier.INFRASTRUCTURE else config.endpoint_confirm_count


def get_stale_threshold(tier: StabilityTier, config: TopologyDiscoveryConfig) -> int:
    return config.infra_stale_threshold_count if tier == StabilityTier.INFRASTRUCTURE else config.endpoint_stale_threshold_count


def on_entity_seen(
    entity: StateMachineEntity, tier: StabilityTier,
    config: TopologyDiscoveryConfig, now: float,
) -> StateMachineEntity:
    """处理实体被发现（本轮采集中出现）。"""
    threshold = get_confirm_threshold(tier, config)
    new_count = entity.confirm_count + 1

    if entity.state == NodeState.PENDING:
        new_state = NodeState.CONFIRMED if new_count >= threshold else NodeState.PENDING
        return StateMachineEntity(
            state=new_state, confirm_count=new_count, miss_count=0,
            last_seen_at=now, stability_tier=tier,
        )

    if entity.state == NodeState.STALE:
        if new_count >= threshold:
            new_state = NodeState.CONFIRMED
        else:
            new_state = NodeState.PENDING
        return StateMachineEntity(
            state=new_state, confirm_count=new_count, miss_count=0,
            last_seen_at=now, stability_tier=tier,
        )

    # confirmed: reset miss, update lastSeen
    return StateMachineEntity(
        state=NodeState.CONFIRMED, confirm_count=new_count, miss_count=0,
        last_seen_at=now, stability_tier=tier,
    )


def on_entity_missed(
    entity: StateMachineEntity, tier: StabilityTier,
    config: TopologyDiscoveryConfig, now: float,
) -> StateMachineEntity | None:
    """处理实体未被发现。返回 None 表示应从图中移除。"""
    stale_threshold = get_stale_threshold(tier, config)
    new_miss = entity.miss_count + 1

    if entity.state == NodeState.CONFIRMED:
        new_state = NodeState.STALE if new_miss >= stale_threshold else NodeState.CONFIRMED
        return StateMachineEntity(
            state=new_state, confirm_count=entity.confirm_count,
            miss_count=new_miss, last_seen_at=entity.last_seen_at, stability_tier=tier,
        )

    if entity.state == NodeState.STALE:
        if (now - entity.last_seen_at) * 1000 > config.stale_expiry_ms:
            return None
        return StateMachineEntity(
            state=NodeState.STALE, confirm_count=entity.confirm_count,
            miss_count=new_miss, last_seen_at=entity.last_seen_at, stability_tier=tier,
        )

    # pending
    if (now - entity.last_seen_at) * 1000 > config.stale_expiry_ms:
        return None
    return StateMachineEntity(
        state=NodeState.PENDING, confirm_count=entity.confirm_count,
        miss_count=new_miss, last_seen_at=entity.last_seen_at, stability_tier=tier,
    )
