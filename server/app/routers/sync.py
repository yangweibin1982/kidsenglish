"""POST /api/sync —— 单次双向事件交换（spec S1 冻结语义；票 13）。

上行 {child_id, device_id, cursor, events[]} → 下行 {events[], cursor, server_hlc_upper}。

- 幂等：event_id 主键 ``INSERT ... ON CONFLICT (event_id) DO NOTHING``——重复投递
  零改写、零丢弃（WRONG 条款「丢上行事件/覆盖已有行」的双反例都有测试钉死）。
- 下行＝该 child 全局流「游标之后」的事件（含他设备上行＝合并语义），剔除本次
  上行集合（客户端本地已有，免回声）。**游标＝服务端插入序位（SQLite rowid，
  只追加表上严格单调）而非 HLC**：离线设备晚到上行的事件 HLC 可能远低于当前
  上界，按 HLC 截流会漏事件；rowid 游标只进不退，晚到事件必被拉取。
- server_hlc_upper＝库内该 child 最大 HLC（app/hlc.py 定长编码，字典序＝时序），
  供客户端偏移校正（S1）——与游标职责分离。
- 游标持久化 sync_cursors（device×child 唯一 UPSERT）；查询以客户端上报游标
  为准（设备对自身位次权威），库内行作观测/恢复面。
- 家庭令牌鉴权（S4，02 票复用）＋child 归属校验：child 不存在→404；
  family_id 异于部署家庭（跨家庭 child）→403。
- 全部 SQL 参数绑定（禁拼接）；事件信封形状＝票 12 fold 契约
  （{event_id, child_id, device_id, device_seq, hlc:{physicalMs,counter},
  occurred_at, type, payload}），server 只存储转发＋投影，不做任何调度（S2）。
"""
from __future__ import annotations

import secrets
import uuid as uuid_lib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, literal_column, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.auth import require_family_token, resolve_family
from app.db import get_db
from app.hlc import decode_hlc, encode_hlc
from app.models import Child, LearningEvent, SyncCursor

router = APIRouter(prefix="/api", dependencies=[Depends(require_family_token)])

_HLC_PART_MAX = 10**16 - 1  # app/hlc.py 定长编码上限（越界 422，禁截断）


# --------------------------------------------------------------------------- #
# 请求/响应模型（契约＝票 12 fold 信封；fastapi 响应序列化 by_alias）             #
# --------------------------------------------------------------------------- #


class Hlc(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    physical_ms: int = Field(alias="physicalMs", ge=0, le=_HLC_PART_MAX)
    counter: int = Field(ge=0, le=_HLC_PART_MAX)


class SyncEventIn(BaseModel):
    """上行事件信封（客户端折叠器契约形状；S1）。"""

    model_config = ConfigDict(populate_by_name=True)

    event_id: uuid_lib.UUID  # 客户端生成，全局唯一幂等键（S1）
    child_id: str = Field(min_length=1)
    device_id: str = Field(min_length=1)
    device_seq: int = Field(ge=0)
    hlc: Hlc
    occurred_at: datetime  # 墙钟遥测（不参与排序，S1）
    type: str = Field(min_length=1)
    payload: object = None


class SyncRequest(BaseModel):
    child_id: int = Field(ge=1)
    device_id: str = Field(min_length=1)
    cursor: str | None = None  # 不透明服务端游标；null/缺省＝从头拉取
    events: list[SyncEventIn] = Field(default_factory=list)

    @field_validator("cursor")
    @classmethod
    def _cursor_is_nonnegative_digits(cls, value: str | None) -> str | None:
        if value is None or (value.isdigit() and int(value) >= 0):
            return value
        raise ValueError("cursor must be null or a non-negative integer string")


class SyncEventOut(BaseModel):
    """下行事件信封（与上行同形；客户端 fold 直接可折叠）。"""

    model_config = ConfigDict(populate_by_name=True)

    event_id: str
    child_id: str
    device_id: str
    device_seq: int
    hlc: Hlc
    occurred_at: str
    type: str
    payload: object = None


class SyncResponse(BaseModel):
    events: list[SyncEventOut]
    cursor: str
    server_hlc_upper: Hlc | None = None


# --------------------------------------------------------------------------- #
# child 归属校验（票面：跨家庭 token 摸他人 child → 403）                        #
# --------------------------------------------------------------------------- #


def ensure_child_access(db: Session, child_id: int, family: str) -> Child:
    """child 解析＋家庭归属：不存在→404；归属他家庭→403。

    children.family_id＝sha256(令牌) 前 16 位（NULL＝单家庭部署隐式归属，
    S4 全部存量行/新行默认）。非空且异于部署家庭＝跨家庭 child，403。
    """
    child = db.get(Child, child_id)
    if child is None:
        raise HTTPException(status_code=404, detail="child not found")
    owner = child.family_id
    if owner is not None and not secrets.compare_digest(owner, family):
        raise HTTPException(status_code=403, detail="child belongs to another family")
    return child


# --------------------------------------------------------------------------- #
# 路由                                                                         #
# --------------------------------------------------------------------------- #


def _iso_z(value: datetime | None) -> str:
    """下行墙钟序列化：统一 Z 记法（SQLite DATETIME 存取丢 tzinfo，naive 视作 UTC；
    遥测字段，客户端折叠契约只要求非空 ISO 字符串）。"""
    if value is None:
        return ""
    if value.tzinfo is None:
        return value.isoformat() + "Z"
    return value.isoformat().replace("+00:00", "Z")


def _to_out(row: LearningEvent) -> SyncEventOut:
    physical_ms, counter = decode_hlc(row.hlc) or (0, 0)
    return SyncEventOut(
        event_id=str(row.event_id),
        child_id=str(row.child_id),
        device_id=row.device_id,
        device_seq=row.device_seq,
        hlc=Hlc(physical_ms=physical_ms, counter=counter),
        occurred_at=_iso_z(row.occurred_at),
        type=row.event_type,
        payload=row.payload,
    )


def _persist_cursor(db: Session, device_id: str, child_id: int, cursor: str) -> None:
    """sync_cursors（device×child 唯一）UPSERT：游标只前进（覆盖为新位次）。"""
    now = datetime.now(timezone.utc)
    statement = sqlite_insert(SyncCursor).values(
        device_id=device_id, child_id=child_id, cursor=cursor, last_synced_at=now
    )
    statement = statement.on_conflict_do_update(
        index_elements=["device_id", "child_id"],
        set_={"cursor": statement.excluded.cursor, "last_synced_at": statement.excluded.last_synced_at},
    )
    db.execute(statement)


@router.post("/sync", response_model=SyncResponse)
def sync_events(
    payload: SyncRequest, request: Request, db: Session = Depends(get_db)
) -> SyncResponse:
    child = ensure_child_access(db, payload.child_id, resolve_family(request))
    cursor_value = int(payload.cursor) if payload.cursor is not None else 0

    # 信封 child_id 一致性：上行事件必须属于本请求声明的 child（防跨孩串写）
    for event in payload.events:
        if event.child_id != str(payload.child_id):
            raise HTTPException(
                status_code=422,
                detail=f"event {event.event_id} child_id {event.child_id} != request child_id {payload.child_id}",
            )

    # 请求内 event_id 去重（首见者胜＝fold 语义）后整批幂等落库
    uplink: dict[str, SyncEventIn] = {}
    for event in payload.events:
        uplink.setdefault(str(event.event_id), event)
    if uplink:
        rows = [
            {
                "event_id": event.event_id,
                "child_id": child.id,
                "device_id": event.device_id,
                "device_seq": event.device_seq,
                "hlc": encode_hlc(event.hlc.physical_ms, event.hlc.counter),
                "occurred_at": event.occurred_at,
                "event_type": event.type,
                "payload": event.payload,
            }
            for event in uplink.values()
        ]
        db.execute(
            sqlite_insert(LearningEvent)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["event_id"])
        )

    # 下行：全局流中「客户端游标之后」的他源事件（rowid 单调；剔除本次上行集合）
    rowid = literal_column("rowid")
    new_rows = db.execute(
        select(LearningEvent)
        .where(LearningEvent.child_id == child.id, rowid > cursor_value)
        .order_by(rowid.asc())
    ).scalars().all()
    down_events = [_to_out(row) for row in new_rows if str(row.event_id) not in uplink]

    # 新游标＝该 child 全局流当前末位（含本次上行；空流保持 0 位）
    max_rowid = (
        db.execute(
            select(func.max(rowid))
            .select_from(LearningEvent)
            .where(LearningEvent.child_id == child.id)
        ).scalar()
        or 0
    )

    # HLC 上界（定长编码下 MAX 字符串＝最大 HLC）；无事件→null
    max_hlc = db.execute(
        select(func.max(LearningEvent.hlc)).where(LearningEvent.child_id == child.id)
    ).scalar()

    _persist_cursor(db, payload.device_id, child.id, str(max_rowid))
    db.commit()

    upper = None
    if max_hlc is not None:
        physical_ms, counter = decode_hlc(max_hlc) or (0, 0)
        upper = Hlc(physical_ms=physical_ms, counter=counter)

    return SyncResponse(events=down_events, cursor=str(max_rowid), server_hlc_upper=upper)
