"""三列 xlsx 摄取与模板（R12）。"""
from __future__ import annotations

from pathlib import Path

import pytest
from openpyxl import Workbook

from app.pipeline.errors import XlsxFormatError
from app.pipeline.xlsx_io import parse_grade, parse_unit, read_words_xlsx, write_template


def test_parse_grade_variants() -> None:
    assert parse_grade("1上") == ("1", "上")
    assert parse_grade("一年级上册") == ("1", "上")
    assert parse_grade(" 2 下 ") == ("2", "下")
    assert parse_grade("六年级上") == ("6", "上")


def test_parse_grade_senior_books() -> None:
    """票 46 高中册次：人教 2019 七本，grade='高中'，term=课本册名。"""
    assert parse_grade("必修一") == ("高中", "必修一")
    assert parse_grade("必修三册") == ("高中", "必修三")
    assert parse_grade("高中选必一") == ("高中", "选必一")
    assert parse_grade(" 选必四 ") == ("高中", "选必四")
    with pytest.raises(XlsxFormatError):
        parse_grade("必修四")  # 人教 2019 无必修四


def test_parse_grade_missing_term_is_error() -> None:
    with pytest.raises(XlsxFormatError):
        parse_grade("三年级")


def test_parse_unit_variants() -> None:
    assert parse_unit("1") == (1, None)
    assert parse_unit("Unit 3 My Family") == (3, "My Family")
    assert parse_unit("第2单元") == (2, None)
    assert parse_unit("1 Hello") == (1, "Hello")


def test_parse_unit_invalid() -> None:
    with pytest.raises(XlsxFormatError):
        parse_unit("hello")


def test_template_roundtrip(tmp_path: Path) -> None:
    target = write_template(tmp_path / "tpl.xlsx")
    rows = read_words_xlsx(target)
    assert [row.word for row in rows] == ["hello", "school"]
    assert all(row.grade == "1" and row.term == "上" and row.unit_no == 1 for row in rows)


def test_read_rejects_bad_header(tmp_path: Path) -> None:
    path = tmp_path / "bad.xlsx"
    workbook = Workbook()
    workbook.active.append(["Grade", "Unit", "Word"])
    workbook.save(path)
    with pytest.raises(XlsxFormatError):
        read_words_xlsx(path)


def test_read_skips_blank_rows_and_reports_row_no(tmp_path: Path) -> None:
    path = tmp_path / "blank.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["年级", "单元", "单词"])
    sheet.append(["1上", "1 Hello", "hello"])
    sheet.append([None, None, None])
    sheet.append(["1上", "1 Hello", "day"])
    workbook.save(path)
    rows = read_words_xlsx(path)
    assert [(row.row_no, row.word) for row in rows] == [(2, "hello"), (4, "day")]


def test_read_rejects_empty_word_with_row_number(tmp_path: Path) -> None:
    path = tmp_path / "empty-word.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["年级", "单元", "单词"])
    sheet.append(["1上", "1 Hello", "  "])
    workbook.save(path)
    with pytest.raises(XlsxFormatError, match="第 2 行"):
        read_words_xlsx(path)
