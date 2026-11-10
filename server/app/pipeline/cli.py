"""编制 CLI（spec S3 双入口之一；HTTP API 入口归后续票，复用同一 runner）。

用法（server/ 目录下，Python 3.11）：
  python -m app.pipeline template --out <模板.xlsx>
  python -m app.pipeline import <词表.xlsx> [--source official] [--series "沪教牛津（深圳专版）"]
  python -m app.pipeline commit <batch_id> [--version N]
  python -m app.pipeline verify-pack <bundle 目录>
  python -m app.pipeline ecdict-status

ECDICT 预载为独立入口：python -m app.pipeline.preload --help（幂等可重跑）。
退出码：0 成功；2 流水线错误（含同版本重发被拒）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import Settings
from app.db import create_single_writer_engine
from app.models import Base
from app.pipeline.errors import PipelineError

DEFAULT_SERIES = "沪教牛津（深圳专版）"


def _open_session(data_dir: str | None) -> tuple[Settings, Session, object]:
    """CLI 会话：单写引擎＋create_all 兜底（已迁移库为 no-op，避免「装后先跑 CLI」踩无表）。"""
    settings = Settings(data_dir=Path(data_dir)) if data_dir else Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_single_writer_engine(settings)
    Base.metadata.create_all(engine)
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=engine, expire_on_commit=False)
    return settings, factory(), engine


def _close(engine) -> None:
    engine.dispose()


def _cmd_template(args: argparse.Namespace) -> int:
    from app.pipeline.xlsx_io import write_template

    target = write_template(args.out, grade=args.grade, unit=args.unit)
    print(f"模板已生成：{target}")
    print("列契约：年级（如 1上／一年级上册）｜单元（如 1／Unit 1 Hello）｜单词")
    return 0


def _cmd_import(args: argparse.Namespace) -> int:
    from app.pipeline import runner

    settings, session, engine = _open_session(args.data_dir)
    try:
        payload = runner.import_xlsx(
            session, settings, args.xlsx, source=args.source, series=args.series
        )
    finally:
        _close(engine)

    stats = payload["stats"]
    print(f"== 预览（批次 {payload['batch_id']}）==")
    print(f"文件：{args.xlsx}")
    print(
        f"总计 {stats['total']} 行｜ECDICT 命中 {stats['ecdict_hit']}"
        f"｜查无 {stats['missing']}｜批内重复 {stats['dup_in_batch']}｜库内已有 {stats['dup_in_db']}"
    )
    print("逐行：")
    for row in payload["rows"]:
        status_label = {
            "ok": "OK（ECDICT 命中）",
            "dup_in_db": "DUP-DB（库内已有词条，复用）",
            "dup_in_batch": f"DUP-BATCH（批内重复，首现行 {row.get('duplicate_of_row')}）",
            "missing": f"查无-标黄（{row.get('reason')}）→ 待补队列 E7",
        }[row["status"]]
        lemma = f"  [lemma←{row['used_lemma']}]" if row.get("used_lemma") else ""
        print(f"  行{row['row_no']:<3} U{row['unit_no']:<3} {row['word']:<16} {status_label}{lemma}")
    if payload["pending_queue"]:
        print(f"待补队列（E7，标黄）{len(payload['pending_queue'])} 项：")
        for item in payload["pending_queue"]:
            print(f"  行{item['row_no']:<3} {item['word']:<16} reason={item['reason']}")
    print(f"预览快照：{runner._preview_path(settings, payload['batch_id'])}")
    print(f"提交入库：python -m app.pipeline commit {payload['batch_id']}")
    return 0


def _cmd_commit(args: argparse.Namespace) -> int:
    from app.pipeline import runner

    settings, session, engine = _open_session(args.data_dir)
    try:
        result = runner.commit_batch(session, settings, args.batch_id, version=args.version)
    finally:
        _close(engine)

    print("== 入库＋发版 ==")
    print(
        f"lexical_entries：新增 {result['entries_new']}｜复用 {result['entries_reused']}"
        f"；word_versions：{result['committed_words']} 行（source_batch_id={result['batch_id']}）"
    )
    print(
        f"词包 {result['source']}/{result['textbook_series']}"
        f"/{result['grade']}{result['term']} v{result['version']}"
        f"（pack_id={result['pack_id']}）"
    )
    print(f"bundle：{result['bundle_dir']}")
    print(f"manifest：{result['manifest_files']} 个单元文件，逐文件 SHA-256")
    print("bundle 自校验：通过（逐文件 SHA-256 比对一致）")
    return 0


def _cmd_verify_pack(args: argparse.Namespace) -> int:
    from app.pipeline.pack import verify_bundle

    result = verify_bundle(Path(args.bundle_dir))
    manifest = result["manifest"]
    print(f"bundle 校验通过：{result['files']} 个文件 SHA-256 全部一致")
    print(f"包身份：{manifest['pack']}")
    for entry in manifest["files"]:
        print(f"  {entry['path']:<28} {entry['bytes']:>8} B  sha256={entry['sha256']}")
    return 0


def _cmd_ecdict_status(args: argparse.Namespace) -> int:
    import sqlite3

    settings = Settings(data_dir=Path(args.data_dir)) if args.data_dir else Settings()
    db_path = settings.ecdict_db_path
    print(f"ECDICT 库：{db_path}")
    if not db_path.exists():
        print("状态：未预载。执行：python -m app.pipeline.preload（或 --csv/--tarball 指定本地源）")
        return 0
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT COUNT(*) FROM ecdict").fetchone()[0]
        marker = dict(conn.execute("SELECT key, value FROM preload_meta").fetchall())
    finally:
        conn.close()
    license_path = settings.ecdict_dir / "ECDICT-LICENSE.txt"
    print(f"状态：已预载｜词条 {rows}｜csv_sha256={marker.get('csv_sha256', '?')[:16]}…")
    print(f"导入时间：{marker.get('imported_at', '?')}｜License 文件：{'有' if license_path.exists() else '缺'}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.pipeline",
        description="词表编制流水线（三列 xlsx → ECDICT 补全 → 预览 → 入库 → 词包发布）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_template = sub.add_parser("template", help="产出可复用三列 xlsx 模板")
    p_template.add_argument("--out", required=True, help="模板输出路径")
    p_template.add_argument("--grade", default="1上", help="示例年级（默认 1上）")
    p_template.add_argument("--unit", default="Unit 1 Hello", help="示例单元")
    p_template.set_defaults(handler=_cmd_template)

    p_import = sub.add_parser("import", help="导入 xlsx：补全＋预览（不入库）")
    p_import.add_argument("xlsx", help="三列 xlsx 路径")
    p_import.add_argument("--source", choices=("official", "parent"), default="official")
    p_import.add_argument("--series", default=DEFAULT_SERIES, help="教材版本（包 identity 之一）")
    p_import.add_argument("--data-dir", default=None, help="覆盖数据目录（默认 server/data）")
    p_import.set_defaults(handler=_cmd_import)

    p_commit = sub.add_parser("commit", help="批次入库＋词包版本化发布")
    p_commit.add_argument("batch_id", type=int)
    p_commit.add_argument("--version", type=int, default=None, help="显式版本号（默认取下一版本）")
    p_commit.add_argument("--data-dir", default=None)
    p_commit.set_defaults(handler=_cmd_commit)

    p_verify = sub.add_parser("verify-pack", help="校验 bundle：manifest 逐文件 SHA-256")
    p_verify.add_argument("bundle_dir", help="bundle 目录（如 data/packs/official/<系列>/1上/v1）")
    p_verify.set_defaults(handler=_cmd_verify_pack)

    p_status = sub.add_parser("ecdict-status", help="查看 ECDICT 预载状态")
    p_status.add_argument("--data-dir", default=None)
    p_status.set_defaults(handler=_cmd_ecdict_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except PipelineError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
