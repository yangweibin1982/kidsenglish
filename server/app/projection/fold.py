"""服务端折叠投影（spec S1/S2；票 13）：与客户端 TS 折叠器同构。

唯一事实源＝共享 golden 向量集（client/engine/test/golden/*.json，票 12 落盘）：
本模块 fold_projection(events) 的终态与 TS fold(events) 对全部向量逐字段相等
（tests/test_projection_golden.py 参数化断言）。TS 侧实现＝client/engine/src/fold.ts。

职责边界（S2 铁律：折叠≠调度）：
- 本模块只做「事件 → 物化状态投影」：排序重放、池位转移重演（重放已发生的事实，
  非决策——升/降/毕业在客户端作答时已定，服务端只是按全序重演同一规则）、
  计数聚合（周报数据源）。**不含任何调度入口**：无计划/抽卡/变式选档决策、
  无到期集合计算、无任何 I/O 与调度模块 import。
- 排序键全序化（与 TS compareEvents 同构）：(hlc 物理, hlc 逻辑, device_id,
  event_id) 字典序；墙钟 occurred_at 只是遥测字符串，不参与排序——设备时钟
  偏移不打乱合并序（R16）。
- 幂等：event_id 全局唯一，重复投递折叠一次（全序首见者胜）。
- 「只增不减」：计数类（答题/正确/星星/碎片）单调累加，无任何可减路径。
- 前向兼容：未知事件类型跳过＋计数（unknownEventTypes），不编造语义。

纯度：零 I/O、零时钟（datetime 只做日历算术，不读当前时间）、零随机——
同一事件集无论到达顺序、重复投递多少次，折叠结果恒同（收敛性）。
"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta
from typing import Any

# --------------------------------------------------------------------------- #
# 常量（与 TS 侧同值同义；golden 向量钉死两端一致）                              #
# --------------------------------------------------------------------------- #

#: 已知事件类型（其余类型跳过＋计数；TS KNOWN_EVENT_TYPES 同构）。
KNOWN_EVENT_TYPES = (
    "answer",
    "pool_promoted",
    "pool_demoted",
    "daily_plan_adjusted",
    "daily_completed",
)

ALL_POOLS = ("P0", "P1", "P2", "P3", "P4", "P5", "graduated")

#: 熟练池复习间隔（天）：P1=D+1、P2=D+3、P3=D+7、P4=D+14、P5=D+30（R3）。
POOL_INTERVALS_DAYS = {"P1": 1, "P2": 3, "P3": 7, "P4": 14, "P5": 30}

#: 毕业条件：P5 连续 2 轮快对（R3）。
GRADUATION_REQUIRED_FAST_ROUNDS = 2

#: 答错降档目标（R3：P1 自环地板、P0 留池）。
_DEMOTE_TARGET = {"P2": "P1", "P3": "P2", "P4": "P3", "P5": "P4"}

#: 未登记题型的兜底基线（毫秒）。
DEFAULT_BASELINE_MS = 10_000

#: 题型基线初值表（R3 题型分基线；TS REACTION_BASELINES_MS 同值）。
REACTION_BASELINES_MS = {
    "teach_picture_audio": 8_000,
    "teach_trace": 10_000,
    "teach_audio_pick_picture": 6_000,
    "audio_pick_picture": 5_000,
    "word_pick_meaning": 6_000,
    "near_sound_discrimination": 7_000,
    "word_family_blend": 8_000,
    "spelling_letter_bank": 12_000,
    "spelling_full_keyboard": 18_000,
    "sentence_fill": 15_000,
    "boss_mix": 12_000,
}

#: 变式三档阈值（R5；TS variation.ts 同值）。
HARD_FAST_RATE = 2 / 3
MIN_SAMPLES_FOR_HARD = 2
EASY_FAST_RATE = 1 / 3

_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


# --------------------------------------------------------------------------- #
# 纯日期工具（TS date.ts 同构；只做日历算术，不读系统时钟）                      #
# --------------------------------------------------------------------------- #


def _fail(where: str, message: str) -> None:
    raise ValueError(f"{where}: {message}")


def is_valid_iso_date(value: str) -> bool:
    """ISO 日期校验（YYYY-MM-DD＋日历有效性）。"""
    match = _ISO_DATE_RE.match(value)
    if not match:
        return False
    year, month, day = (int(part) for part in match.groups())
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def add_days(iso_date: str, days: int) -> str:
    match = _ISO_DATE_RE.match(iso_date)
    if not match:
        raise ValueError(f"invalid ISO date: {iso_date!r}")
    year, month, day = (int(part) for part in match.groups())
    return (date(year, month, day) + timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------- #
# 信封校验（TS assertValidEnvelope 同构）                                       #
# --------------------------------------------------------------------------- #


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _req_string(rec: dict, field: str, where: str) -> str:
    value = rec.get(field)
    if not isinstance(value, str) or not value:
        _fail(where, f"{field} must be a non-empty string")
    return value  # type: ignore[return-value]


def _req_bool(rec: dict, field: str, where: str) -> bool:
    value = rec.get(field)
    if not isinstance(value, bool):
        _fail(where, f"{field} must be a boolean")
    return value


def _req_uint(rec: dict, field: str, where: str) -> int:
    """非负整数（TS reqUint 同构；接受整值浮点字面量如 3000.0）。"""
    value = rec.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(where, f"{field} must be a non-negative integer")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer() or value < 0:
            _fail(where, f"{field} must be a non-negative integer")
        return int(value)
    if value < 0:
        _fail(where, f"{field} must be a non-negative integer")
    return value


def _req_non_negative_number(rec: dict, field: str, where: str) -> float:
    """非负有限数（反应时/正确率/指数；TS reqNonNegativeNumber 同构）。"""
    value = rec.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(where, f"{field} must be a finite number >= 0")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        _fail(where, f"{field} must be a finite number >= 0")
    return result


def _opt_uint(rec: dict, field: str, where: str) -> int:
    """可选非负整数：缺省 0（计数面不存在可减路径，负值即违约）。"""
    if field not in rec:
        return 0
    return _req_uint(rec, field, where)


def _req_iso_date(rec: dict, field: str, where: str) -> str:
    value = _req_string(rec, field, where)
    if not is_valid_iso_date(value):
        _fail(where, f"{field} is not a valid ISO date: {value}")
    return value


def _validate_envelope(event: Any, index: int) -> None:
    where = (
        f"learning event #{index} "
        f"({event.get('event_id') if _is_record(event) else '?'})"
    )
    if not _is_record(event):
        _fail(where, "event must be an object")
    _req_string(event, "event_id", where)
    _req_string(event, "child_id", where)
    _req_string(event, "device_id", where)
    _req_uint(event, "device_seq", where)
    _req_string(event, "occurred_at", where)
    _req_string(event, "type", where)
    hlc = event.get("hlc")
    if not _is_record(hlc):
        _fail(where, "hlc must be an object {physicalMs, counter}")
    _req_uint(hlc, "physicalMs", f"{where} hlc")
    _req_uint(hlc, "counter", f"{where} hlc")


# --------------------------------------------------------------------------- #
# 排序键全序化（TS compareHlc/compareEvents/sortEvents 同构）                    #
# --------------------------------------------------------------------------- #


def compare_hlc(a: dict, b: dict) -> int:
    """HLC 比较：物理毫秒 asc → 逻辑计数 asc。a/b＝{physicalMs, counter}。"""
    if a["physicalMs"] != b["physicalMs"]:
        return -1 if a["physicalMs"] < b["physicalMs"] else 1
    if a["counter"] != b["counter"]:
        return -1 if a["counter"] < b["counter"] else 1
    return 0


def compare_events(a: dict, b: dict) -> int:
    """事件全序比较：(hlc 物理, hlc 逻辑, device_id, event_id) 字典序。"""
    order = compare_hlc(a["hlc"], b["hlc"])
    if order != 0:
        return order
    if a["device_id"] != b["device_id"]:
        return -1 if a["device_id"] < b["device_id"] else 1
    if a["event_id"] != b["event_id"]:
        return -1 if a["event_id"] < b["event_id"] else 1
    return 0


def _sort_key(event: dict) -> tuple:
    hlc = event["hlc"]
    return (hlc["physicalMs"], hlc["counter"], event["device_id"], event["event_id"])


def sort_events(events: list[dict]) -> list[dict]:
    """排序＋去重（确定性重放入口）：先校验全部信封（按输入序报错），再按全序
    排序，event_id 去重——全序首见者胜（幂等；同 id 异容为契约违约，取先到者）。"""
    for index, event in enumerate(events):
        _validate_envelope(event, index)
    ordered = sorted(events, key=_sort_key)
    seen: set[str] = set()
    unique: list[dict] = []
    for event in ordered:
        if event["event_id"] in seen:
            continue
        seen.add(event["event_id"])
        unique.append(event)
    return unique


# --------------------------------------------------------------------------- #
# 状态转移重演（TS transition.ts applyAnswer / fold.ts applyPoolChange 同构）     #
# ——重放已发生的事实，非调度决策                                                 #
# --------------------------------------------------------------------------- #


def new_card_state(child_id: str, lexical_entry_id: str, on: str) -> dict:
    """新词建卡：进 P0，到期＝建卡当日（R3 图）。"""
    return {
        "childId": child_id,
        "lexicalEntryId": lexical_entry_id,
        "pool": "P0",
        "fastStreak": 0,
        "errorStreak": 0,
        "dueDate": on,
        "variationTier": "standard",
        "paused": False,
        "graduatedSampledMonth": None,
        "recentOutcomes": [],
    }


def _get_baseline(question_type: str) -> int:
    baseline = REACTION_BASELINES_MS.get(question_type)
    return baseline if isinstance(baseline, int) and baseline > 0 else DEFAULT_BASELINE_MS


def _is_fast_correct(correct: bool, reaction_ms: float, baseline_ms: int) -> bool:
    """快对＝答对且反应时 ≤ 基线（恰好等于也算快对，边界与 TS 一致）。"""
    return correct and reaction_ms >= 0 and reaction_ms <= baseline_ms


def _select_variation_tier(recent: list[dict]) -> str:
    """近 3 次快对率选三档（R5；无样本 → standard）。"""
    recent = recent[-3:]
    if not recent:
        return "standard"
    rate = sum(1 for outcome in recent if outcome["fast"]) / len(recent)
    if rate >= HARD_FAST_RATE and len(recent) >= MIN_SAMPLES_FOR_HARD:
        return "hard"
    if rate < EASY_FAST_RATE:
        return "easy"
    return "standard"


def apply_answer(state: dict, event: dict) -> dict:
    """单步转移重演（升/降/留池/毕业；与 TS applyAnswer 同则，纯函数）。

    event＝已解析的 answer 载荷（lexical_entry_id/question_type/correct/
    reaction_ms/answered_on）。
    """
    baseline = _get_baseline(event["question_type"])
    fast = _is_fast_correct(event["correct"], event["reaction_ms"], baseline)
    from_pool = state["pool"]
    day = event["answered_on"]

    if event["correct"]:
        # 快对连击：留池累计；升档进新池清零；慢对清零
        fast_streak = state["fastStreak"] + 1 if fast else 0
        if from_pool == "graduated":
            to_pool, due = "graduated", None
        elif from_pool == "P5":
            if fast and fast_streak >= GRADUATION_REQUIRED_FAST_ROUNDS:
                to_pool, due = "graduated", None
            else:
                to_pool, due = "P5", add_days(day, POOL_INTERVALS_DAYS["P5"])
        elif fast:
            next_pool = "P1" if from_pool == "P0" else f"P{int(from_pool[1:]) + 1}"
            to_pool = next_pool
            due = add_days(day, POOL_INTERVALS_DAYS[next_pool])
            fast_streak = 0  # 进入新池从 0 轮起算
        else:
            to_pool = from_pool
            due = day if from_pool == "P0" else add_days(day, POOL_INTERVALS_DAYS[from_pool])
    else:
        # 答错：降一档（E1），快对连击清零
        fast_streak = 0
        if from_pool == "P0":
            to_pool, due = "P0", day
        elif from_pool == "graduated":
            to_pool = "P5"
            due = add_days(day, POOL_INTERVALS_DAYS["P5"])
        else:
            to_pool = _DEMOTE_TARGET.get(from_pool, "P1")  # P1 自环地板
            due = add_days(day, POOL_INTERVALS_DAYS[to_pool])

    recent = (state["recentOutcomes"] + [
        {"correct": event["correct"], "fast": fast, "answeredOn": day}
    ])[-3:]
    return {
        **state,
        "pool": to_pool,
        "fastStreak": fast_streak,
        "errorStreak": 0 if event["correct"] else state["errorStreak"] + 1,
        "dueDate": due,
        "variationTier": _select_variation_tier(recent),
        "graduatedSampledMonth": (
            state["graduatedSampledMonth"] if to_pool == "graduated" else None
        ),
        "recentOutcomes": recent,
    }


def apply_pool_change(state: dict, to_pool: str, on: str) -> dict:
    """显式池位设置（pool_promoted/pool_demoted；TS fold.ts applyPoolChange 同则）：
    to_pool 直接生效（引擎外池位事实，不复算）；快对连击清零、错误连击与近 3 次
    缓存保留；到期按新池间隔自 on 起算（P0=当日、graduated=None）。"""
    if to_pool == "graduated":
        due = None
    elif to_pool == "P0":
        due = on
    else:
        due = add_days(on, POOL_INTERVALS_DAYS[to_pool])
    return {
        **state,
        "pool": to_pool,
        "fastStreak": 0,
        "dueDate": due,
        "graduatedSampledMonth": (
            state["graduatedSampledMonth"] if to_pool == "graduated" else None
        ),
    }


# --------------------------------------------------------------------------- #
# 载荷解析（已知类型逐字段校验；未知类型不进这里）                                #
# --------------------------------------------------------------------------- #


def _parse_answer_payload(event_id: str, payload: Any) -> dict:
    where = f"event {event_id} (answer payload)"
    if not _is_record(payload):
        _fail(where, "payload must be an object")
    question_type = _req_string(payload, "question_type", where)
    return {
        "lexical_entry_id": _req_string(payload, "lexical_entry_id", where),
        # 未登记题型不拒收：落兜底基线（前向兼容）
        "question_type": question_type,
        "correct": _req_bool(payload, "correct", where),
        "reaction_ms": _req_non_negative_number(payload, "reaction_ms", where),
        "answered_on": _req_iso_date(payload, "answered_on", where),
        "stars_earned": _opt_uint(payload, "stars_earned", where),
        "shards_earned": _opt_uint(payload, "shards_earned", where),
    }


def _parse_pool_change_payload(event_id: str, payload: Any) -> dict:
    where = f"event {event_id} (pool change payload)"
    if not _is_record(payload):
        _fail(where, "payload must be an object")
    to_pool = _req_string(payload, "to_pool", where)
    if to_pool not in ALL_POOLS:
        _fail(where, f"unknown to_pool {to_pool}")
    return {
        "lexical_entry_id": _req_string(payload, "lexical_entry_id", where),
        "to_pool": to_pool,
        "on": _req_iso_date(payload, "on", where),
    }


def _parse_signal_snapshot(event_id: str, value: Any) -> dict:
    where = f"event {event_id} (signal_snapshot)"
    if not _is_record(value):
        _fail(where, "signal_snapshot must be an object")
    return {
        "date": _req_iso_date(value, "date", where),
        "answered": _req_uint(value, "answered", where),
        "correct": _req_uint(value, "correct", where),
        "accuracy": _req_non_negative_number(value, "accuracy", where),
        "completedOnTime": _req_bool(value, "completedOnTime", where),
        "overtime": _req_bool(value, "overtime", where),
        "timeInBand": _req_bool(value, "timeInBand", where),
        "digestIndex": _req_non_negative_number(value, "digestIndex", where),
    }


def _parse_plan_adjusted_payload(event_id: str, payload: Any) -> dict:
    where = f"event {event_id} (daily_plan_adjusted payload)"
    if not _is_record(payload):
        _fail(where, "payload must be an object")
    reasons = payload.get("reasons")
    if not isinstance(reasons, list) or any(not isinstance(item, str) for item in reasons):
        _fail(where, "reasons must be an array of strings")
    return {
        "date": _req_iso_date(payload, "date", where),
        "from": _req_uint(payload, "from", where),
        "to": _req_uint(payload, "to", where),
        "reasons": reasons,
        "signal_snapshot": _parse_signal_snapshot(
            event_id, payload.get("signal_snapshot")
        ),
    }


def _parse_daily_completed_payload(event_id: str, payload: Any) -> dict:
    where = f"event {event_id} (daily_completed payload)"
    if not _is_record(payload):
        _fail(where, "payload must be an object")
    segment = payload.get("segment_seconds")
    if not _is_record(segment):
        _fail(where, "segment_seconds must be an object {new_words, review}")
    return {
        "date": _req_iso_date(payload, "date", where),
        "completed_on_time": _req_bool(payload, "completed_on_time", where),
        "segment_seconds": {
            "new_words": _req_uint(segment, "new_words", where),
            "review": _req_uint(segment, "review", where),
        },
        "stars_earned": _opt_uint(payload, "stars_earned", where),
        "shards_earned": _opt_uint(payload, "shards_earned", where),
    }


# --------------------------------------------------------------------------- #
# 折叠器主入口                                                                  #
# --------------------------------------------------------------------------- #


def fold_projection(events: list[dict]) -> dict:
    """折叠：事件集 → FoldedState（TS fold 同构；纯函数，同事件集必同终态）。

    输出形状（camelCase，与 TS FoldedState / golden 向量 expected 逐字段一致）：
    {childId, poolStates[], counters, dailySummaries[], planAdjustments[],
     unknownEventTypes}——counters/dailySummaries 即周报摘要的计数聚合面。

    events 为单一 child_id 的事件集（混入多孩即抛错，多孩由调用方分流）。
    """
    ordered = sort_events(events)

    child_id = ""
    for event in ordered:
        if child_id == "":
            child_id = event["child_id"]
        if event["child_id"] != child_id:
            raise ValueError(
                "fold_projection: mixed child_id in event set "
                f"({child_id} vs {event['child_id']}); "
                "fold is per-child — split by child_id before folding"
            )

    states: dict[str, dict] = {}
    counters = {"answered": 0, "correct": 0, "stars": 0, "shards": 0}
    daily: dict[str, dict] = {}
    adjustments: dict[str, dict] = {}
    unknown_event_types: dict[str, int] = {}

    def ensure_daily(day: str) -> dict:
        summary = daily.get(day)
        if summary is None:
            summary = {
                "date": day,
                "answered": 0,
                "correct": 0,
                "completedOnTime": False,
                "segmentSeconds": {"newWords": 0, "review": 0},
                "starsEarned": 0,
                "shardsEarned": 0,
            }
            daily[day] = summary
        return summary

    def ensure_card(lexical_entry_id: str, on: str) -> dict:
        state = states.get(lexical_entry_id)
        if state is None:
            state = new_card_state(child_id, lexical_entry_id, on)
            states[lexical_entry_id] = state
        return state

    for event in ordered:
        event_type = event["type"]
        if event_type == "answer":
            payload = _parse_answer_payload(event["event_id"], event.get("payload"))
            stars = payload["stars_earned"]
            shards = payload["shards_earned"]
            counters["answered"] += 1
            if payload["correct"]:
                counters["correct"] += 1
            counters["stars"] += stars
            counters["shards"] += shards
            summary = ensure_daily(payload["answered_on"])
            summary["answered"] += 1
            if payload["correct"]:
                summary["correct"] += 1
            summary["starsEarned"] += stars
            summary["shardsEarned"] += shards
            states[payload["lexical_entry_id"]] = apply_answer(
                ensure_card(payload["lexical_entry_id"], payload["answered_on"]),
                payload,
            )
        elif event_type in ("pool_promoted", "pool_demoted"):
            payload = _parse_pool_change_payload(event["event_id"], event.get("payload"))
            states[payload["lexical_entry_id"]] = apply_pool_change(
                ensure_card(payload["lexical_entry_id"], payload["on"]),
                payload["to_pool"],
                payload["on"],
            )
        elif event_type == "daily_plan_adjusted":
            payload = _parse_plan_adjusted_payload(event["event_id"], event.get("payload"))
            # 同日 last-wins（全序后到者覆盖；adaptation_log 投影源，S9）
            adjustments[payload["date"]] = {
                "type": "daily_plan_adjusted",
                "childId": child_id,
                "date": payload["date"],
                "from": payload["from"],
                "to": payload["to"],
                "reasons": payload["reasons"],
                "signalSnapshot": payload["signal_snapshot"],
            }
        elif event_type == "daily_completed":
            payload = _parse_daily_completed_payload(event["event_id"], event.get("payload"))
            stars = payload["stars_earned"]
            shards = payload["shards_earned"]
            summary = ensure_daily(payload["date"])
            summary["completedOnTime"] = payload["completed_on_time"]
            summary["segmentSeconds"] = {
                "newWords": payload["segment_seconds"]["new_words"],
                "review": payload["segment_seconds"]["review"],
            }
            summary["starsEarned"] += stars
            summary["shardsEarned"] += shards
            counters["stars"] += stars
            counters["shards"] += shards
        else:
            # 未知类型：跳过＋计数（前向兼容，不编造语义）
            unknown_event_types[event_type] = unknown_event_types.get(event_type, 0) + 1

    return {
        "childId": child_id,
        "poolStates": [states[key] for key in sorted(states)],
        "counters": counters,
        "dailySummaries": [daily[key] for key in sorted(daily)],
        "planAdjustments": [adjustments[key] for key in sorted(adjustments)],
        "unknownEventTypes": unknown_event_types,
    }
