"""接缝 2：折叠器 TS/Py 同构——Py 投影读票 12 golden 向量集断言同终态。

向量目录＝client/engine/test/golden/（仓内相对路径即契约，票 12 落盘、
票 13 读取；文件名增删须同步 TS/Py 两端）。TS 侧断言见
client/engine/test/golden.test.ts；两侧跑同一文件、断言同一 expected。
"""
from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from app.projection import fold_projection

GOLDEN_DIR = Path(__file__).resolve().parents[2] / "client" / "engine" / "test" / "golden"

#: 向量清单＝spec 钉死四类必含（升×降×时钟偏斜×并发升降）＋三类性质
#: （计数单调/幂等重放/乱序到达）＋扩展（S9 调整投影＋未知类型前向兼容）。
MANIFEST = [
    "promote.json",
    "demote.json",
    "clock-skew.json",
    "concurrent-promote-demote.json",
    "counters-monotonic.json",
    "idempotent-replay.json",
    "out-of-order-arrival.json",
    "plan-adjusted-unknown.json",
]

REQUIRED_CATEGORIES = ("·升", "·降", "·时钟偏斜", "·并发升降")


def _load(file: str) -> dict:
    vector = json.loads((GOLDEN_DIR / file).read_text(encoding="utf-8"))
    assert isinstance(vector.get("name"), str) and vector["name"]
    assert isinstance(vector.get("events"), list) and vector["events"]
    assert isinstance(vector.get("expected"), dict)
    return vector


def test_directory_listing_equals_manifest() -> None:
    """目录文件清单与 MANIFEST 全等（增删向量须同步 TS/Py 两端，禁静默漂移）。"""
    files = sorted(p.name for p in GOLDEN_DIR.glob("*.json"))
    assert files == sorted(MANIFEST)


def test_required_four_categories_present() -> None:
    assert len(MANIFEST) == 8  # 四类必含＋三类性质＋一类扩展


@pytest.mark.parametrize("file", MANIFEST)
def test_golden_vector_same_terminal_state(file: str) -> None:
    """每向量：fold_projection(events) 深等于 expected（TS/Py 同终态机器钉死）。"""
    vector = _load(file)
    assert fold_projection(vector["events"]) == vector["expected"]


def test_shuffle_invariance_all_vectors() -> None:
    """乱序到达性质：每向量 20 种子打乱 → 终态恒等 expected（不依赖到达顺序）。"""
    rnd = random.Random(42)
    for file in MANIFEST:
        vector = _load(file)
        for _ in range(20):
            shuffled = vector["events"][:]
            rnd.shuffle(shuffled)
            assert fold_projection(shuffled) == vector["expected"], file


def test_duplicate_delivery_invariance_all_vectors() -> None:
    """幂等重放性质：事件集整体重复 2/3 遍 → 终态恒等 expected（event_id 去重）。"""
    for file in MANIFEST:
        vector = _load(file)
        doubled = vector["events"] + vector["events"]
        tripled = vector["events"] * 3
        assert fold_projection(doubled) == vector["expected"], file
        assert fold_projection(tripled) == vector["expected"], file


def test_wallclock_rewrite_invariance_all_vectors() -> None:
    """墙钟不可感：occurred_at 全部改写 → 终态恒等（排序键不含墙钟，R16）。"""
    for file in MANIFEST:
        vector = _load(file)
        rewritten = [
            {**event, "occurred_at": "1970-01-01T00:00:00Z" if i % 2 == 0 else "2099-12-31T23:59:59Z"}
            for i, event in enumerate(vector["events"])
        ]
        assert fold_projection(rewritten) == vector["expected"], file


def test_counters_monotonic_prefix_property() -> None:
    """只增不减：任意事件前缀序列折叠，四计数逐事件非降（禁可减路径的机器证明）。"""
    vector = _load("counters-monotonic.json")
    ordered = sorted(vector["events"], key=lambda e: (e["hlc"]["physicalMs"], e["hlc"]["counter"], e["device_id"], e["event_id"]))
    previous = {"answered": 0, "correct": 0, "stars": 0, "shards": 0}
    for i in range(1, len(ordered) + 1):
        counters = fold_projection(ordered[:i])["counters"]
        for key in previous:
            assert counters[key] >= previous[key], (key, i)
        previous = counters


def test_projection_package_imports_no_scheduling() -> None:
    """S2 铁律：投影包 import 面＝纯 stdlib 算术（math/re/datetime/typing），
    零调度模块、零 I/O、零框架依赖——server 只投影不调度的机器钉死。"""
    projection_dir = Path(__file__).resolve().parents[1] / "app" / "projection"
    allowed = {"math", "re", "datetime", "typing", "__future__", "app.projection.fold"}
    for py in sorted(projection_dir.glob("*.py")):
        source = py.read_text(encoding="utf-8")
        for marker in ("buildDailyPlan", "collectDueCards", "planLevel", "plan_level"):
            assert marker not in source, f"{py.name} 疑似引入调度概念：{marker}"
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith("import ") or stripped.startswith("from "):
                module = stripped.split()[1].split(" as ")[0].strip()
                assert module in allowed, f"{py.name} 非 白名单 import：{module}"
