"""流水线测试夹具：mini ECDICT csv（13 词，覆盖三个导入坑）＋三列 sample xlsx（7 行）。

mini ECDICT 覆盖面：
- hello   带字面量 \\n 的释义（预载期替换）＋西里尔 ә 音标（规范化）
- school  名词（票 17 起释义行换成真库垃圾尾形「鱼群…」，验 curated 整表替换）
- morning 音标 ɒ: 映射＋[医] 领域行裁剪
- give/a  票 17 校对锚词（give ECDICT 名词义误排首；a 含字面量 \\r 残留＋[计] 域行）
- lick    exchange 0:lemma 基词
- licked  屈折词（释义=「lick的过去式」，走 lemma 救回）
- zorblat 不存在（→ ecdict_miss）
- onlydomain 纯领域释义（→ domain_only）
- mum/old/white/sorry/don't/has 票 19 校对锚词（2 上；释义行抄自真实 ECDICT 2026-11-01
  实勘：mum「菊花」垃圾首义、old「荒野」名词义误排首、white「眼白」垃圾尾、
  don't「禁忌」尾义、has 屈折串「have的第三人称单数现在式」（非全串屈折形，lemma 救回不触发）
"""
from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

import pytest
from openpyxl import Workbook
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.db import create_single_writer_engine
from app.models import Base
from app.pipeline.preload import preload_from_csv

MINI_ECDICT_HEADER = [
    "word", "phonetic", "definition", "translation", "pos",
    "collins", "oxford", "tag", "bnc", "frq", "exchange",
]

# 注意：translation 中的 \\n 是「两个字符」（字面量反斜杠+n），模拟 ECDICT 原始 csv。
# give/a/school 的释义行抄自真实 ECDICT（2026-11-01 实勘），含垃圾尾与 \\r 残留，
# 供票 17 curated 覆盖断言（give 首义「给」、a 无 \r、school 无「鱼群」）有据可打。
MINI_ECDICT_ROWS = [
    ["hello", "hә'lәʊ", "", "int. 你好\\n喂", "int:97", "", "", "", "", "", ""],
    ["school", "skuːl", "", "n. 学校, 鱼群, 门派, 学派\\nvt. 教育, 训练, 培养", "n:3", "", "", "", "", "", ""],
    ["morning", "mɒ:nɪŋ", "", "n. 早晨\\n上午\\n[医]晨间护理", "n:3", "", "", "", "", "", ""],
    ["give", "giv", "", "n. 弹性, 适应性\\nvt. 给, 授予, 供给", "n:2/v:5", "", "", "", "", "", ""],
    ["a", "ə", "", "n. 第一个字母 A; 一个; 第一的\\r\\nart. [计] 累加器, 加法器, 地址", "", "", "", "", "", "", ""],
    ["lick", "lɪk", "", "vt. 舔", "v:5", "", "", "", "", "", "0:lick/s:licks/d:licked/i:licking/3:licks"],
    ["licked", "", "", "lick的过去式", "", "", "", "", "", "", "0:lick"],
    ["onlydomain", "", "", "[计]域处理机", "", "", "", "", "", "", ""],
    ["apple", "'æpl", "", "n. 苹果", "n:3", "", "", "", "", "", ""],
    ["mum", "mʌm", "", "n. 菊花, 沉默\\na. 沉默的\\nvi. 演哑剧\\ninterj. 别说话", "n:1", "", "", "", "", "", ""],
    ["old", "әuld", "", "n. 以前, 往昔\\na. 老的, 旧的, 古老的, 年长的, 老练的", "n:1/a:5", "", "", "", "", "", ""],
    ["white", "hwait", "", "n. 白色, 洁白, 眼白, 白种人, 蛋白\\na. 白色的, 纯洁的, 白种的, 苍白的, 空白的, 幸运的", "n:3/a:4", "", "", "", "", "", ""],
    ["sorry", "'sɒri", "", "a. 难过的, 悲哀的, 遗憾的", "a:5", "", "", "", "", "", ""],
    ["don't", "dәunt", "", "(= do not)不要\\nn. 禁忌", "", "", "", "", "", "", ""],
    ["has", "hæz", "", "have的第三人称单数现在式", "", "", "", "", "", "", "0:have/p:has/d:had/i:having/3:has"],
    ["can't", "kɑ:nt", "", "vi. 不能", "v:1", "", "", "", "", "", ""],
]


def write_mini_ecdict_csv(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        # 测试夹具写自有常量行，无用户数据进 csv，无公式注入出口。
        writer = csv.writer(handle)  # nosemgrep: python.lang.security.use-defusedcsv
        writer.writerow(MINI_ECDICT_HEADER)
        writer.writerows(MINI_ECDICT_ROWS)
    return path


@pytest.fixture
def pipe_settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")


@pytest.fixture
def pipe_engine(pipe_settings: Settings):
    pipe_settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_single_writer_engine(pipe_settings)
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def pipe_session(pipe_engine):
    factory = sessionmaker(bind=pipe_engine, expire_on_commit=False)
    session = factory()
    yield session
    session.close()


@pytest.fixture
def ecdict_csv(tmp_path: Path) -> Path:
    return write_mini_ecdict_csv(tmp_path / "mini-ecdict.csv")


@pytest.fixture
def ecdict_db(pipe_settings: Settings, ecdict_csv: Path) -> Path:
    """把 mini ECDICT 预载到 settings 的标准落点（走真实 preload_from_csv 代码路径）。"""
    result = preload_from_csv(ecdict_csv, pipe_settings.ecdict_db_path)
    assert result["skipped"] is False
    return pipe_settings.ecdict_db_path


@pytest.fixture
def sample_xlsx(tmp_path: Path) -> Path:
    """三列词表 7 行：hello/school/licked/zorblat/onlydomain/hello(批内重复)/' HELLO '(归一重复)。"""
    path = tmp_path / "sample-u1.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["年级", "单元", "单词"])
    for word in ("hello", "school", "licked", "zorblat", "onlydomain", "hello", " HELLO "):
        sheet.append(["1上", "1 Hello", word])
    workbook.save(path)
    return path


def count_rows(db_path: Path, sql: str) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute(sql).scalar())
    finally:
        conn.close()
