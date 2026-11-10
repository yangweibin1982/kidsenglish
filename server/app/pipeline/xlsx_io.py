"""三列 xlsx 摄取与模板产出（R12，spec S3／接缝 4）。

列契约（模板即契约）：年级｜单元｜单词。
- 年级：'1上'/'一年级上'/'一年级上册' → (grade='1', term='上')；缺学期＝错误（防错包）。
- 单元：'1'/'Unit 1'/'Unit 1 Hello'/'第1单元' → (unit_no=1, title=...)。
- 单词：非空；读取时不改写词形（归一只在 normalize.py）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from openpyxl import Workbook, load_workbook

from app.pipeline.errors import XlsxFormatError

COLUMNS = ("年级", "单元", "单词")

_GRADE_RE = re.compile(r"^\s*([0-9一二三四五六])\s*(?:年\s*级)?\s*([上下])\s*(?:册)?\s*$")
_DIGIT_CN = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6"}
# 高中册次（票 46 P-15 全学段）：人教 2019 必修一~三＋选必一~四；grade='高中'，term=课本册名
_SENIOR_RE = re.compile(r"^\s*(?:高中)?\s*(必修[一二三]|选必[一二三四])\s*册?\s*$")
_UNIT_RE = re.compile(r"^\s*(?:unit|u|第)?\s*(\d+)\s*(?:单元)?\s*[\s:：-]*(.*?)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class WordRow:
    """xlsx 一行：年级+学期+单元+原样词形。"""

    row_no: int  # xlsx 实际行号（1 起、含表头）
    grade: str  # '1'
    term: str  # '上'/'下'
    unit_no: int
    unit_title: str | None
    word: str  # 原样词形（未归一）


def parse_grade(raw: str, row_no: int = 0) -> tuple[str, str]:
    """解析年级列 → (grade, term)。缺学期（上/下）直接报错，防错包。

    高中册次（票 46）：「必修一/选必四（高中必修第一册）」→ ('高中', '必修一')——
    term 承载课本册名（人教 2019 七本结构与 6 学期非一一对应）。
    """
    senior = _SENIOR_RE.match(raw)
    if senior is not None:
        return "高中", senior.group(1)
    match = _GRADE_RE.match(raw)
    if match is None:
        raise XlsxFormatError(
            f"第 {row_no} 行「年级」无法解析：{raw!r}"
            "（示例：1上／一年级上册／必修一；小学初中须含上/下学期）"
        )
    digit = match.group(1)
    return _DIGIT_CN.get(digit, digit), match.group(2)


def parse_unit(raw: str, row_no: int = 0) -> tuple[int, str | None]:
    """解析单元列 → (unit_no, title|None)。标题可缺省（'1'）。"""
    match = _UNIT_RE.match(raw)
    if match is None or int(match.group(1)) < 1:
        raise XlsxFormatError(
            f"第 {row_no} 行「单元」无法解析：{raw!r}（示例：1／Unit 1／Unit 1 Hello）"
        )
    title = (match.group(2) or "").strip() or None
    return int(match.group(1)), title


def read_words_xlsx(path: str | Path) -> list[WordRow]:
    """读三列 xlsx → WordRow 列表；形状不合法抛 XlsxFormatError（带行号）。"""
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        rows_iter = sheet.iter_rows(values_only=True)
        header = next(rows_iter, None)
        if header is None:
            raise XlsxFormatError("空表：无表头行")

        index: dict[str, int] = {}
        for position, name in enumerate(header):
            key = "" if name is None else str(name).strip()
            if key in COLUMNS:
                index[key] = position
        missing = [col for col in COLUMNS if col not in index]
        if missing:
            raise XlsxFormatError(
                f"表头须含「年级/单元/单词」三列；缺 {missing}，"
                f"实际表头：{[str(name) for name in header]}（模板：python -m app.pipeline template）"
            )

        def cell(values: tuple, col: str) -> str:
            if index[col] >= len(values) or values[index[col]] is None:
                return ""
            return str(values[index[col]]).strip()

        result: list[WordRow] = []
        for row_no, values in enumerate(rows_iter, start=2):
            grade_raw, unit_raw, word = cell(values, "年级"), cell(values, "单元"), cell(values, "单词")
            if not (grade_raw or unit_raw or word):
                continue  # 整行空白跳过
            if not word:
                raise XlsxFormatError(f"第 {row_no} 行「单词」为空")
            if not grade_raw:
                raise XlsxFormatError(f"第 {row_no} 行「年级」为空")
            if not unit_raw:
                raise XlsxFormatError(f"第 {row_no} 行「单元」为空")
            grade, term = parse_grade(grade_raw, row_no)
            unit_no, unit_title = parse_unit(unit_raw, row_no)
            result.append(
                WordRow(row_no=row_no, grade=grade, term=term, unit_no=unit_no, unit_title=unit_title, word=word)
            )
        return result
    finally:
        workbook.close()


def write_template(
    path: str | Path,
    *,
    grade: str = "1上",
    unit: str = "Unit 1 Hello",
    sample_words: tuple[str, ...] = ("hello", "school"),
) -> Path:
    """产出可复用三列 xlsx 模板（R12：家长下载模板→只填三列）。"""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "词表"
    sheet.append(list(COLUMNS))
    for word in sample_words:
        sheet.append([grade, unit, word])
    for column, width in zip("ABC", (12, 22, 30)):
        sheet.column_dimensions[column].width = width
    sheet.freeze_panes = "A2"
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(target)
    return target
