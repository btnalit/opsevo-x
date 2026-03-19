"""
MAC 地址归一化器

统一为小写冒号分隔格式 aa:bb:cc:dd:ee:ff
支持输入格式：AA-BB-CC-DD-EE-FF, AABB.CCDD.EEFF, AA:BB:CC:DD:EE:FF 等

Requirements: 16.2
"""

from __future__ import annotations

import re


def normalize_mac(mac: str) -> str:
    """归一化 MAC 地址为 aa:bb:cc:dd:ee:ff 格式。"""
    if not mac or not isinstance(mac, str):
        return mac
    hex_str = re.sub(r"[:\-.\s]", "", mac).lower()
    if not re.fullmatch(r"[0-9a-f]{12}", hex_str):
        return mac.lower()
    return ":".join(hex_str[i:i + 2] for i in range(0, 12, 2))
