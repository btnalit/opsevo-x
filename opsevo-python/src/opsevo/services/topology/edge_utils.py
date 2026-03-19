"""
边工具函数 — 边 ID 生成（双向合并）与置信度计算（滑动窗口线性加权）

Requirements: 16.2
"""

from __future__ import annotations


def generate_edge_id(
    source_device_id: str, target_device_id: str,
    local_interface: str, remote_interface: str,
) -> str:
    """生成边的唯一标识（双向合并）。(A→B) 和 (B→A) 生成相同 ID。"""
    if source_device_id < target_device_id:
        first, second = source_device_id, target_device_id
        if1, if2 = local_interface, remote_interface
    else:
        first, second = target_device_id, source_device_id
        if1, if2 = remote_interface, local_interface
    return f"edge-{first}-{second}-{if1}-{if2}"


def calculate_edge_confidence(
    sources: list[str],
    weights: dict[str, float],
    sliding_window_snapshots: list[bool],
) -> float:
    """计算边置信度。多源累加权重，滑动窗口线性加权，结果 0.0-1.0。"""
    if not sources:
        return 0.0
    base = sum(weights.get(s, 0.0) for s in sources)
    base = max(0.0, min(1.0, base))
    if not sliding_window_snapshots:
        return base
    n = len(sliding_window_snapshots)
    total_weight = n * (n + 1) / 2
    weighted = sum((i + 1) for i, present in enumerate(sliding_window_snapshots) if present)
    window_factor = weighted / total_weight
    result = base * window_factor
    return max(0.0, min(1.0, round(result, 3)))
