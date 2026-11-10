"""接缝 5（API 契约）：POST /api/sync 单次双向交换（spec S1；票 13）。

覆盖：401 令牌门/404/403 归属/422 契约、上行幂等（重复投递零改写、
同 id 异容不覆盖）、游标推进不回退、HLC 上界、双设备交错同步合并收敛、
下行形状＝票 12 fold 信封（可直接折叠）。
"""
from __future__ import annotations

import uuid
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.auth import family_id_from_token
from app.models import Base, Child, LearningEvent, SyncCursor
from app.projection import fold_projection

FOREIGN_FAMILY = "feedfacefeedface"  # 任意异于部署家庭摘要的归属标记


def _event(
    event_id: str,
    child_id: int,
    device: str,
    seq: int,
    physical_ms: int,
    counter: int = 0,
    *,
    occurred: str = "2026-10-26T09:00:00Z",
    type_: str = "answer",
    payload: dict | None = None,
) -> dict:
    if payload is None:
        payload = {
            "lexical_entry_id": "w-apple",
            "question_type": "teach_picture_audio",
            "correct": True,
            "reaction_ms": 3000,
            "answered_on": "2026-10-26",
        }
    return {
        "event_id": event_id,
        "child_id": str(child_id),
        "device_id": device,
        "device_seq": seq,
        "hlc": {"physicalMs": physical_ms, "counter": counter},
        "occurred_at": occurred,
        "type": type_,
        "payload": payload,
    }


@pytest.fixture()
def env(client: TestClient) -> SimpleNamespace:
    """建表＋两孩：own（部署家庭）/foreign（他家庭）。"""
    Base.metadata.create_all(client.app.state.engine)
    token = client.app.state.family_token
    family = family_id_from_token(token)
    with client.app.state.SessionLocal() as session:
        own = Child(display_name="Alice", family_id=family)
        legacy = Child(display_name="Legacy")  # family_id NULL＝单家庭隐式归属
        foreign = Child(display_name="Bob", family_id=FOREIGN_FAMILY)
        session.add_all([own, legacy, foreign])
        session.commit()
        ids = (own.id, legacy.id, foreign.id)
    return SimpleNamespace(
        client=client,
        token=token,
        headers={"X-Family-Token": token},
        child_id=ids[0],
        legacy_child_id=ids[1],
        foreign_child_id=ids[2],
    )


def _post_sync(env: SimpleNamespace, body: dict):
    return env.client.post("/api/sync", json=body, headers=env.headers)


def _db_events(env: SimpleNamespace) -> list[LearningEvent]:
    with env.client.app.state.SessionLocal() as session:
        return list(session.query(LearningEvent).order_by(LearningEvent.event_id).all())


def _snapshot(rows: list[LearningEvent]) -> list[tuple]:
    return sorted(
        (
            str(row.event_id),
            row.child_id,
            row.device_id,
            row.device_seq,
            row.hlc,
            row.occurred_at,
            row.event_type,
            repr(row.payload),
        )
        for row in rows
    )


# --------------------------------------------------------------------------- #
# 鉴权与归属                                                                   #
# --------------------------------------------------------------------------- #


def test_sync_gated_by_family_token(env) -> None:
    assert env.client.post("/api/sync", json={"child_id": 1, "device_id": "d"}).status_code == 401
    wrong = {"X-Family-Token": "wrong"}
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": []}
    assert env.client.post("/api/sync", json=body, headers=wrong).status_code == 401


def test_sync_unknown_child_404(env) -> None:
    body = {"child_id": 9999, "device_id": "dev-a", "events": []}
    assert _post_sync(env, body).status_code == 404


def test_sync_cross_family_child_403(env) -> None:
    """跨家庭 child：令牌有效但 child 归属他家庭 → 403（不落任何上行事件）。"""
    event = _event(str(uuid.uuid4()), env.foreign_child_id, "dev-a", 1, 1000)
    body = {"child_id": env.foreign_child_id, "device_id": "dev-a", "events": [event]}
    response = _post_sync(env, body)
    assert response.status_code == 403
    assert _db_events(env) == []


def test_sync_null_family_child_allowed(env) -> None:
    """family_id NULL（单家庭隐式归属，存量行形态）→ 正常同步。"""
    body = {"child_id": env.legacy_child_id, "device_id": "dev-a", "events": []}
    assert _post_sync(env, body).status_code == 200


# --------------------------------------------------------------------------- #
# 请求契约（422 面）                                                            #
# --------------------------------------------------------------------------- #


def test_sync_rejects_envelope_child_mismatch(env) -> None:
    event = _event(str(uuid.uuid4()), env.child_id + 1, "dev-a", 1, 1000)  # 信封串孩
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [event]}
    assert _post_sync(env, body).status_code == 422
    assert _db_events(env) == []


def test_sync_rejects_bad_cursor(env) -> None:
    body = {"child_id": env.child_id, "device_id": "dev-a", "cursor": "abc", "events": []}
    assert _post_sync(env, body).status_code == 422


def test_sync_rejects_non_uuid_event_id(env) -> None:
    event = _event("e-001", env.child_id, "dev-a", 1, 1000)  # 非 UUID（golden 形态禁入 DB）
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [event]}
    assert _post_sync(env, body).status_code == 422


def test_sync_rejects_negative_hlc_part(env) -> None:
    event = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, -1)
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [event]}
    assert _post_sync(env, body).status_code == 422


# --------------------------------------------------------------------------- #
# 单设备往返（空流基线）                                                         #
# --------------------------------------------------------------------------- #


def test_sync_empty_stream_returns_empty_events_and_zero_cursor(env) -> None:
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": []}
    response = _post_sync(env, body)
    assert response.status_code == 200
    data = response.json()
    assert data == {"events": [], "cursor": "0", "server_hlc_upper": None}


def test_sync_uplink_stored_and_not_echoed_back(env) -> None:
    """首同步上行：落库成功；下行不回声自有事件（客户端已有）。"""
    event = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 1000)
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [event]}
    data = _post_sync(env, body).json()
    assert data["events"] == []
    assert data["cursor"] == "1"
    assert data["server_hlc_upper"] == {"physicalMs": 1000, "counter": 0}
    rows = _db_events(env)
    assert len(rows) == 1 and str(rows[0].event_id) == event["event_id"]


# --------------------------------------------------------------------------- #
# 幂等（UPSERT 语义＝只插不改）                                                 #
# --------------------------------------------------------------------------- #


def test_sync_duplicate_delivery_is_noop(env) -> None:
    """重复投递（重试路径）：行数不变、行内容逐字节同态（无 UPDATE 路径）。"""
    event = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 1000)
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [event]}
    _post_sync(env, body)
    before = _snapshot(_db_events(env))
    data = _post_sync(env, body).json()  # 原样重放
    assert _snapshot(_db_events(env)) == before
    assert len(_db_events(env)) == 1
    assert data["cursor"] == "1"  # 游标不回退
    assert data["events"] == []


def test_sync_same_id_conflicting_payload_first_write_wins(env) -> None:
    """同 event_id 异容投递＝契约违约尝试：ON CONFLICT DO NOTHING 保首写，
    既有行零覆盖（WRONG「UPSERT 语义错成覆盖」的机器反例）。"""
    event_id = str(uuid.uuid4())
    first = _event(event_id, env.child_id, "dev-a", 1, 1000)
    _post_sync(env, {"child_id": env.child_id, "device_id": "dev-a", "events": [first]})

    tampered = _event(event_id, env.child_id, "dev-b", 9, 999999, counter=9)
    tampered["payload"] = {
        "lexical_entry_id": "w-evil",
        "question_type": "spelling_full_keyboard",
        "correct": False,
        "reaction_ms": 1,
        "answered_on": "2020-01-01",
    }
    _post_sync(env, {"child_id": env.child_id, "device_id": "dev-b", "events": [tampered]})

    rows = _db_events(env)
    assert len(rows) == 1
    assert rows[0].device_id == "dev-a" and rows[0].device_seq == 1
    assert rows[0].hlc == f"{1000:016d}:{0:016d}"  # 首写定长编码未被改写
    assert rows[0].payload == first["payload"]


def test_sync_duplicate_ids_within_one_request_deduped(env) -> None:
    """单请求内重复 event_id：去重后只落一行（fold 首见者胜同则）。"""
    event = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 1000)
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [event, dict(event)]}
    _post_sync(env, body)
    assert len(_db_events(env)) == 1


# --------------------------------------------------------------------------- #
# 游标推进与 HLC 上界                                                            #
# --------------------------------------------------------------------------- #


def test_sync_cursor_advances_and_no_repush(env) -> None:
    """游标单调推进：已确认事件不重推（第二次拉取 events 为空）。"""
    ids = [str(uuid.uuid4()) for _ in range(3)]
    events = [_event(ids[i], env.child_id, "dev-a", i + 1, 1000 + i) for i in range(3)]
    first = _post_sync(
        env, {"child_id": env.child_id, "device_id": "dev-a", "events": events}
    ).json()
    assert first["cursor"] == "3"

    second = _post_sync(
        env,
        {"child_id": env.child_id, "device_id": "dev-a", "cursor": first["cursor"], "events": []},
    ).json()
    assert second["events"] == []  # 无重复推送
    assert second["cursor"] == first["cursor"]  # 不回退


def test_sync_cursor_persisted_per_device_child(env) -> None:
    """sync_cursors（device×child 唯一）：两设备各自一行、各自位次。"""
    a1 = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 1000)
    b1 = _event(str(uuid.uuid4()), env.child_id, "dev-b", 1, 2000)
    _post_sync(env, {"child_id": env.child_id, "device_id": "dev-a", "events": [a1]})
    _post_sync(env, {"child_id": env.child_id, "device_id": "dev-b", "events": [b1]})

    with env.client.app.state.SessionLocal() as session:
        cursors = session.query(SyncCursor).all()
        by_device = {c.device_id: c for c in cursors}
    assert set(by_device) == {"dev-a", "dev-b"}
    assert by_device["dev-a"].cursor == "1"
    assert by_device["dev-b"].cursor == "2"
    assert all(c.last_synced_at is not None for c in by_device.values())


def test_sync_hlc_upper_is_max_by_lexicographic_encoding(env) -> None:
    """HLC 上界＝(物理, 逻辑) 全序最大；物理大者胜、物理同比计数器。"""
    e1 = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 5000, counter=7)
    e2 = _event(str(uuid.uuid4()), env.child_id, "dev-b", 1, 6000, counter=0)
    e3 = _event(str(uuid.uuid4()), env.child_id, "dev-a", 2, 5000, counter=9)
    body = {"child_id": env.child_id, "device_id": "dev-a", "events": [e1, e2, e3]}
    data = _post_sync(env, body).json()
    assert data["server_hlc_upper"] == {"physicalMs": 6000, "counter": 0}

    e4 = _event(str(uuid.uuid4()), env.child_id, "dev-a", 3, 6000, counter=3)
    data2 = _post_sync(
        env, {"child_id": env.child_id, "device_id": "dev-a", "cursor": data["cursor"], "events": [e4]}
    ).json()
    assert data2["server_hlc_upper"] == {"physicalMs": 6000, "counter": 3}


def test_sync_downlink_events_are_fold_envelope_shaped(env) -> None:
    """下行事件＝票 12 fold 信封形状（hlc 对象/驼峰键），可直接进折叠器。"""
    from app.projection import fold_projection

    up = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 1000)
    _post_sync(env, {"child_id": env.child_id, "device_id": "dev-a", "events": [up]})
    pulled = _post_sync(
        env, {"child_id": env.child_id, "device_id": "dev-b", "events": []}
    ).json()
    assert len(pulled["events"]) == 1
    envelope = pulled["events"][0]
    assert set(envelope) == {
        "event_id", "child_id", "device_id", "device_seq",
        "hlc", "occurred_at", "type", "payload",
    }
    assert envelope["hlc"] == {"physicalMs": 1000, "counter": 0}
    assert envelope["occurred_at"].endswith("Z")
    folded = fold_projection(pulled["events"])  # 下行集直接可折叠（客户端零转换）
    assert folded["counters"] == {"answered": 1, "correct": 1, "stars": 0, "shards": 0}


# --------------------------------------------------------------------------- #
# 双设备交错同步（合并收敛；验收标准 #1）                                        #
# --------------------------------------------------------------------------- #


def test_two_devices_interleaved_sync_converge(env) -> None:
    """两 client 各自上行→各自拉取→事件集一致且折叠终态一致（离线晚到含低 HLC）。"""
    a1 = _event(str(uuid.uuid4()), env.child_id, "dev-a", 1, 1000)
    a2 = _event(str(uuid.uuid4()), env.child_id, "dev-a", 2, 2000)
    # dev-b 离线生成：HLC 落后于 dev-a 已上行的上界（晚到低 HLC 事件不得被游标漏掉）
    b1 = _event(str(uuid.uuid4()), env.child_id, "dev-b", 1, 500)

    # 第一轮：dev-a 上行两事件；dev-b 随后上行一件并拉到 dev-a 的两件
    r_a1 = _post_sync(env, {"child_id": env.child_id, "device_id": "dev-a", "events": [a1, a2]}).json()
    r_b1 = _post_sync(env, {"child_id": env.child_id, "device_id": "dev-b", "events": [b1]}).json()
    dev_b_view = [b1] + r_b1["events"]
    assert {e["event_id"] for e in r_b1["events"]} == {a1["event_id"], a2["event_id"]}

    # 第二轮：dev-a 带游标拉取 → 收到 dev-b 的晚到事件；再无新事件
    r_a2 = _post_sync(
        env,
        {"child_id": env.child_id, "device_id": "dev-a", "cursor": r_a1["cursor"], "events": []},
    ).json()
    assert {e["event_id"] for e in r_a2["events"]} == {b1["event_id"]}
    dev_a_view = [a1, a2] + r_a2["events"]

    # 事件集一致
    assert {e["event_id"] for e in dev_a_view} == {e["event_id"] for e in dev_b_view}
    # 折叠终态一致（收敛性；含晚到低 HLC 事件）
    assert fold_projection(dev_a_view) == fold_projection(dev_b_view)

    # 第三轮：双方游标推进后再拉 → 空集（无重复推送）
    r_a3 = _post_sync(
        env,
        {"child_id": env.child_id, "device_id": "dev-a", "cursor": r_a2["cursor"], "events": []},
    ).json()
    r_b2 = _post_sync(
        env,
        {"child_id": env.child_id, "device_id": "dev-b", "cursor": r_b1["cursor"], "events": []},
    ).json()
    assert r_a3["events"] == [] and r_b2["events"] == []


# --------------------------------------------------------------------------- #
# 库内状态形状（信封化存储）                                                    #
# --------------------------------------------------------------------------- #


def test_stored_event_row_shape(env) -> None:
    event = _event(
        str(uuid.uuid4()),
        env.child_id,
        "dev-a",
        7,
        1234567890123,
        counter=42,
        type_="pool_demoted",
        payload={"lexical_entry_id": "w-cat", "to_pool": "P1", "on": "2026-10-26"},
    )
    _post_sync(env, {"child_id": env.child_id, "device_id": "dev-a", "events": [event]})

    (row,) = _db_events(env)
    assert row.event_type == "pool_demoted"
    assert row.payload == event["payload"]
    assert row.lexical_entry_id is None  # 信封形态不预投影词锚点
    assert row.hlc == f"{1234567890123:016d}:{42:016d}"  # 定长编码
    assert row.occurred_at is not None
    assert row.occurred_at.replace(tzinfo=None) == datetime(2026, 10, 26, 9, 0)
