"""HLC 定长编码（票 13）：learning_events.hlc（String(64)）的可排序表示。

编码＝f"{physical_ms:016d}:{counter:016d}"（物理毫秒与逻辑计数各 16 位零填充，
冒号分隔，共 33 字符）：定长十进制零填充下**字符串字典序＝数值序＝时序**，
故库内 MAX(hlc) 即该 child 的 HLC 上界（S1：下行携带供客户端偏移校正）。

上限 10^16-1（毫秒≈3170 万年）；越界即 422（编码定长被破坏，拒绝而非截断）。
线上（API/折叠器）形状保持对象 {physicalMs, counter}；本模块只负责
信封对象 ↔ 库列字符串 的转换。
"""
from __future__ import annotations

_HLC_PART_MAX = 10**16 - 1
_HLC_WIDTH = 16


def encode_hlc(physical_ms: int, counter: int) -> str:
    """{physicalMs, counter} → 定长可排序列字符串。"""
    if not (0 <= physical_ms <= _HLC_PART_MAX) or not (0 <= counter <= _HLC_PART_MAX):
        raise ValueError(
            f"hlc out of encodable range: physical_ms={physical_ms}, counter={counter}"
        )
    return f"{physical_ms:0{_HLC_WIDTH}d}:{counter:0{_HLC_WIDTH}d}"


def decode_hlc(encoded: str | None) -> tuple[int, int] | None:
    """列字符串 → (physical_ms, counter)；空值（无事件）→ None。"""
    if encoded is None:
        return None
    physical_ms, counter = encoded.split(":")
    return int(physical_ms), int(counter)
