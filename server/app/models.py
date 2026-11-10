"""数据模型——spec S7：核心 8 概念表＋辅助 3 概念表。

锚点铁律：
- 进度锚点 = lexical_entries 稳定词 id（card_pool_states / learning_events 钉此，
  跨包版本连续；钉到 word_versions 即错）。
- 包-词关联锚定 word_versions 内容行 id。
- word_packs 按 S7 行内「含单元/包-词关联」拆为 word_packs / word_pack_units /
  word_pack_entries 三物理表。
- learning_events 只追加（event_id UUID 主键）；card_pool_states 客户端权威物化。
全部查询参数绑定（安全约束）；本模块只声明结构，不做任何原生 SQL。
"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Child(Base):
    """孩子档案（R10/R11/R4/R9）。"""

    __tablename__ = "children"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    # 归属家庭（sha256(家庭令牌) 前 16 位；NULL＝单家庭部署隐式归属，票 13）。
    # S4 单家庭令牌下恒为部署家庭所有；非空且异于部署家庭 → sync 403（归属校验）。
    family_id: Mapped[str | None] = mapped_column(String(64))
    avatar: Mapped[str | None] = mapped_column(String(255))
    grade_band: Mapped[str | None] = mapped_column(String(16))
    start_point: Mapped[str | None] = mapped_column(String(16))  # 0起步/1上/…/6下（R11）
    daily_new_words: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    practice_hard_cap: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    remind_time: Mapped[str | None] = mapped_column(String(5))  # HH:MM（R9）
    remind_window_minutes: Mapped[int | None] = mapped_column(Integer)
    parent_level_override: Mapped[str | None] = mapped_column(String(16))  # 家长手动调级
    selected_pack_ids: Mapped[list | None] = mapped_column(JSON)  # 已选词包（含 custom）

    __table_args__ = (
        CheckConstraint(
            "daily_new_words >= 3 AND daily_new_words <= 10",
            name="ck_children_daily_new_words_range",
        ),
    )


class LexicalEntry(Base):
    """词身份——稳定词 id，进度锚点（S7 v2 拆分）。"""

    __tablename__ = "lexical_entries"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # 稳定词 id
    headword: Mapped[str] = mapped_column(String(255), nullable=False)  # 词形
    difficulty_band: Mapped[str | None] = mapped_column(String(16))  # 难度带


class WordVersion(Base):
    """词内容行，不可变——修词即新行（S7 v2；S1 版本化不可变）。"""

    __tablename__ = "word_versions"
    __table_args__ = (
        {"info": {"immutable_content": True}, "comment": "内容行不可变：修词=新行"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lexical_entry_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("lexical_entries.id"), nullable=False, index=True
    )
    phonetic_uk: Mapped[str | None] = mapped_column(String(128))
    phonetic_us: Mapped[str | None] = mapped_column(String(128))
    senses: Mapped[list | None] = mapped_column(JSON)  # 释义/emoji/语境选图
    examples: Mapped[list | None] = mapped_column(JSON)  # 例句/译文
    phonics_split: Mapped[str | None] = mapped_column(String(255))  # 拼读拆分
    source_batch_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"))


class WordPack(Base):
    """词包版本行——版本化不可变（S1），official/custom 同构（US-11）。"""

    __tablename__ = "word_packs"
    __table_args__ = (
        UniqueConstraint(
            "textbook_series",
            "grade",
            "term",
            "version",
            name="uq_word_packs_identity_version",
        ),
        {"info": {"immutable_versions": True}, "comment": "版本化不可变：改=新版本号"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="official")
    textbook_series: Mapped[str] = mapped_column(String(64), nullable=False)  # 教材版本
    grade: Mapped[str] = mapped_column(String(16), nullable=False)
    term: Mapped[str] = mapped_column(String(16), nullable=False)


class WordPackUnit(Base):
    """包内单元：单元号/标题/情景图引用（R7）。"""

    __tablename__ = "word_pack_units"
    __table_args__ = (
        UniqueConstraint("pack_id", "unit_no", name="uq_word_pack_units_no"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pack_id: Mapped[int] = mapped_column(
        ForeignKey("word_packs.id"), nullable=False, index=True
    )
    unit_no: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str | None] = mapped_column(String(255))
    scene_image_ref: Mapped[str | None] = mapped_column(String(255))


class WordPackEntry(Base):
    """包-词关联：词版本行 id＋单元语境义项＋序。"""

    __tablename__ = "word_pack_entries"
    __table_args__ = (
        UniqueConstraint(
            "pack_id", "unit_id", "word_version_id", name="uq_word_pack_entries"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pack_id: Mapped[int] = mapped_column(
        ForeignKey("word_packs.id"), nullable=False, index=True
    )
    unit_id: Mapped[int] = mapped_column(
        ForeignKey("word_pack_units.id"), nullable=False, index=True
    )
    word_version_id: Mapped[int] = mapped_column(
        ForeignKey("word_versions.id"), nullable=False, index=True
    )
    sense_context: Mapped[dict | None] = mapped_column(JSON)  # 单元语境义项
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class CardPoolState(Base):
    """卡池状态——客户端权威物化，可由事件全量重建；server 周报只读投影不写回。"""

    __tablename__ = "card_pool_states"
    __table_args__ = (
        UniqueConstraint("child_id", "lexical_entry_id", name="uq_card_pool_child_word"),
        {
            "info": {"client_authoritative": True},
            "comment": "客户端权威物化（S7）；调度在客户端，server 不写回",
        },
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    child_id: Mapped[int] = mapped_column(ForeignKey("children.id"), nullable=False)
    lexical_entry_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("lexical_entries.id"), nullable=False
    )
    pool: Mapped[str] = mapped_column(String(8), nullable=False, default="P0")  # P0-P5/graduated
    quick_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    due_at: Mapped[datetime | None] = mapped_column(DateTime)  # 到期时间
    variant_tier: Mapped[str | None] = mapped_column(String(8))  # 变式档 easy/standard/hard
    suspended: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # 暂停标记
    graduation_review_at: Mapped[datetime | None] = mapped_column(DateTime)  # 毕业池抽查标记


class LearningEvent(Base):
    """学习事件——只追加；同步主载体＋埋点/周报数据源（S1/R5/R17）。

    票 13 起事件以 S1 信封形状存储：event_id（幂等键）＋hlc（主序）＋type＋payload
    （完整载荷 JSON，与客户端折叠器契约同构）；word 级字段（lexical_entry_id 等
    答题切片列）在信封形态下不预投影——payload 即唯一事实源，周报走折叠投影读取。
    """

    __tablename__ = "learning_events"
    __table_args__ = (
        {"info": {"append_only": True}, "comment": "只追加，永不改写；幂等键=event_id"},
    )

    event_id: Mapped[object] = mapped_column(Uuid(), primary_key=True)  # 客户端生成 UUID
    child_id: Mapped[int] = mapped_column(ForeignKey("children.id"), nullable=False)
    # 信封化后可空（daily_plan_adjusted/未知类型事件无词锚点；答题事件也不预投影）
    lexical_entry_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("lexical_entries.id"), index=True
    )
    # 事件类型（票 12 fold 契约：answer/pool_promoted/pool_demoted/
    # daily_plan_adjusted/daily_completed＋前向兼容任意字符串）
    event_type: Mapped[str] = mapped_column(
        "type", String(32), nullable=False, server_default="answer", default="answer"
    )
    payload: Mapped[dict | None] = mapped_column(JSON)  # 事件载荷（信封完整切片）
    session_id: Mapped[str | None] = mapped_column(String(64))
    question_type: Mapped[str | None] = mapped_column(String(32))
    variant: Mapped[str | None] = mapped_column(String(32))
    is_correct: Mapped[bool | None] = mapped_column(Boolean)
    response_ms: Mapped[int | None] = mapped_column(Integer)
    error_cause: Mapped[str | None] = mapped_column(String(64))  # 错因埋点（R5）
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    device_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    hlc: Mapped[str] = mapped_column(String(64), nullable=False)  # 混合逻辑时钟主序（S1）
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime)  # 遥测，不参与排序


class GameAsset(Base):
    """战机与奖励资产——child 唯一；消耗/解锁走事件可重放（R8/E5）。"""

    __tablename__ = "game_assets"
    __table_args__ = (
        UniqueConstraint("child_id", name="uq_game_assets_child"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    child_id: Mapped[int] = mapped_column(ForeignKey("children.id"), nullable=False)
    stars: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shards: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    combo_week_state: Mapped[dict | None] = mapped_column(JSON)  # 连击周状态
    makeup_cards: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 补签卡
    unlocked_items: Mapped[dict | None] = mapped_column(JSON)  # 已解锁战机/涂装
    equipped: Mapped[dict | None] = mapped_column(JSON)  # 当前装备
    badges: Mapped[dict | None] = mapped_column(JSON)
    pending_chests: Mapped[dict | None] = mapped_column(JSON)  # 待发宝箱（E5）


class ImportBatch(Base):
    """词库导入批次——官方编制与家长导入共用（S3/E7）。"""

    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # official/parent
    file_ref: Mapped[str | None] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="uploaded")
    # 状态机：uploaded→enriched→preview→committed / failed
    stats: Mapped[dict | None] = mapped_column(JSON)  # 总数/ECDICT命中/查无/重复
    pending_queue: Mapped[list | None] = mapped_column(JSON)  # 待补队列（E7）
    product_pack_id: Mapped[int | None] = mapped_column(ForeignKey("word_packs.id"))


class SessionCheckpoint(Base):
    """断点续学（R4）：child＋日期、当日计划快照、进度位置。"""

    __tablename__ = "session_checkpoints"
    __table_args__ = (
        UniqueConstraint("child_id", "day", name="uq_session_checkpoints_child_day"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    child_id: Mapped[int] = mapped_column(ForeignKey("children.id"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    plan_snapshot: Mapped[dict | None] = mapped_column(JSON)
    position: Mapped[dict | None] = mapped_column(JSON)


class DailyCompletion(Base):
    """每日达成（R4 硬顶、E5 判定）：child＋日期、完成关数、窗口加成。"""

    __tablename__ = "daily_completions"
    __table_args__ = (
        UniqueConstraint("child_id", "day", name="uq_daily_completions_child_day"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    child_id: Mapped[int] = mapped_column(ForeignKey("children.id"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    completed_levels: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    window_bonus: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class SyncCursor(Base):
    """同步游标（S1）：设备×child、游标位、末次同步时。"""

    __tablename__ = "sync_cursors"
    __table_args__ = (
        UniqueConstraint("device_id", "child_id", name="uq_sync_cursors_device_child"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    child_id: Mapped[int] = mapped_column(ForeignKey("children.id"), nullable=False)
    cursor: Mapped[str | None] = mapped_column(String(128))  # 游标位（如服务器 HLC 上界）
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime)
