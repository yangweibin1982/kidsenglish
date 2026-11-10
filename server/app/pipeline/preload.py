"""ECDICT 预载脚本（独立入口、安装期独占执行、幂等可重跑；06 号报告 §7 参数锁定）。

用法（server/ 目录下）：
  python -m app.pipeline.preload                      # 下载 tar.gz → 解出 ecdict.csv → 建库
  python -m app.pipeline.preload --tarball <本地.tgz>  # 离线：用本地压缩包
  python -m app.pipeline.preload --csv <ecdict.csv>    # 离线：直接用本地 csv
  python -m app.pipeline.preload --force               # 忽略幂等标记强制重建

安全硬约束：
- 下载 URL 仅 https 且 host 必须在白名单（codeload.github.com），否则拒绝。
- 下载累计超 DOWNLOAD_DEADLINE_S（600s）即止损报错（票面止损条款的脚本内实现）。

产物：server/data/ecdict/ecdict.db（ecdict 表 + preload_meta 幂等标记表 +
word COLLATE NOCASE 索引）+ ECDICT-LICENSE.txt + SOURCE.txt（来源留痕）。
运行期查询走 app.pipeline.ecdict.EcdictLookup（只读），本模块不参与运行期。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import shutil
import sqlite3
import sys
import tarfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from app.pipeline.errors import PreloadError

DOWNLOAD_URL = "https://codeload.github.com/skywind3000/ECDICT/tar.gz/refs/heads/master"
ALLOWED_DOWNLOAD_HOSTS = frozenset({"codeload.github.com"})
DOWNLOAD_DEADLINE_S = 600  # 累计止损：下载超过 10 分钟即报错（票面止损条款）
BATCH_SIZE = 20_000  # executemany 批大小（06 §7 实测口径）
CSV_MEMBER_SUFFIX = "ecdict.csv"
LICENSE_MEMBER = "LICENSE"

# 保留列（06 §7：弃 detail/audio/pos 三列，瘦身到预算内 ~110MB）
KEEP_COLUMNS = ("word", "sw", "phonetic", "definition", "translation", "collins", "oxford", "tag", "bnc", "frq", "exchange")

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS ecdict ("
    "word TEXT NOT NULL, sw TEXT, phonetic TEXT, definition TEXT, translation TEXT, "
    "collins TEXT, oxford TEXT, tag TEXT, bnc TEXT, frq TEXT, exchange TEXT)"
)
_META_SCHEMA = "CREATE TABLE IF NOT EXISTS preload_meta (key TEXT PRIMARY KEY, value TEXT)"
_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_ecdict_word_nocase ON ecdict(word COLLATE NOCASE)"

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def validate_download_url(url: str) -> None:
    """下载 URL 门：仅 https 且 host 在白名单（安全硬约束，测试直查）。"""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise PreloadError(f"下载 URL 须为 https，收到：{parts.scheme or '(空)'}://{url}")
    host = (parts.hostname or "").lower()
    if host not in ALLOWED_DOWNLOAD_HOSTS:
        raise PreloadError(
            f"下载 host 不在白名单 {sorted(ALLOWED_DOWNLOAD_HOSTS)}：{host}"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_tarball(url: str, dest: Path, *, deadline_s: int = DOWNLOAD_DEADLINE_S) -> Path:
    """流式下载 tar.gz 到 dest；累计超 deadline_s 即止损（PreloadError）。"""
    validate_download_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    deadline = time.monotonic() + deadline_s
    printed_mb = -20
    try:
        # 注解双 ID：在线 p/default 规则全 ID（双后缀）＋快照仓裸 ID（本地快照 check_id 带
        # 机器路径前缀，semgrep 对 nosemgrep 逐值做前缀/全等匹配，裸 ID 是其 ID 尾段）。
        # URL 已由上一行 validate_download_url 强校验（仅 https ＋ host 白名单 codeload.github.com），
        # 来源为常量 DOWNLOAD_URL 或运维显式传入，非终端用户可控；审计规则按已核缓解处置。
        with urllib.request.urlopen(url, timeout=30) as response, tmp.open("wb") as out:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected, dynamic-urllib-use-detected
            total = 0
            while True:
                if time.monotonic() > deadline:
                    raise PreloadError(
                        f"下载累计超 {deadline_s}s 止损（已下 {total / 1048576:.1f} MB）。"
                        "可改用 --tarball/--csv 本地源重跑。"
                    )
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                out.write(chunk)
                if total // 1048576 >= printed_mb + 20:
                    printed_mb = total // 1048576
                    print(f"  已下载 {total / 1048576:.0f} MB…")
    except PreloadError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise PreloadError(f"下载失败：{exc}") from exc
    tmp.replace(dest)
    print(f"下载完成：{dest}（{dest.stat().st_size / 1048576:.0f} MB）")
    return dest


def extract_members(tarball: Path, dest_dir: Path) -> tuple[Path, Path | None]:
    """从 tar.gz 流式解出 ecdict.csv（必须）与 LICENSE（可选）。

    用 extractfile 逐成员拷贝到受控落点（不调 extract/extractall → 无路径穿越面）。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    csv_path = dest_dir / CSV_MEMBER_SUFFIX
    license_path = dest_dir / "ECDICT-LICENSE.txt"
    found_csv = found_license = False
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            for member in archive:
                name = (member.name or "").replace("\\", "/")
                base = name.rsplit("/", 1)[-1]
                if not member.isfile():
                    continue
                if base == CSV_MEMBER_SUFFIX:
                    with archive.extractfile(member) as src, csv_path.open("wb") as out:
                        shutil.copyfileobj(src, out, length=1024 * 1024)
                    found_csv = True
                elif base == LICENSE_MEMBER:
                    with archive.extractfile(member) as src, license_path.open("wb") as out:
                        shutil.copyfileobj(src, out, length=1024 * 1024)
                    found_license = True
                if found_csv and found_license:
                    break
    except PreloadError:
        raise
    except Exception as exc:
        raise PreloadError(f"解压失败（{tarball}）：{exc}") from exc
    if not found_csv:
        raise PreloadError(f"压缩包内未找到 {CSV_MEMBER_SUFFIX}：{tarball}")
    print(f"已解出：{csv_path.name}（{csv_path.stat().st_size / 1048576:.0f} MB）"
          + ("＋ECDICT-LICENSE.txt" if found_license else "（包内无 LICENSE）"))
    return csv_path, (license_path if found_license else None)


def _read_marker(conn: sqlite3.Connection) -> dict[str, str]:
    try:
        return {key: value for key, value in conn.execute("SELECT key, value FROM preload_meta")}
    except sqlite3.OperationalError:
        return {}


def preload_from_csv(
    csv_path: str | Path,
    db_path: str | Path,
    *,
    force: bool = False,
    source_note: str | None = None,
) -> dict:
    """ecdict.csv → SQLite 预载库。幂等：同 csv_sha256 且非 force → 跳过重建。

    导入坑对策（06 §4）：字面量 ``\\n`` 在预载期替换为真实换行；sw 缺列时以
    word.casefold() 兜底；sw/次要列缺失容忍为 None。
    """
    csv_path, db_path = Path(csv_path), Path(db_path)
    if not csv_path.exists():
        raise PreloadError(f"csv 不存在：{csv_path}")
    csv_sha256 = _sha256_file(csv_path)

    if db_path.exists():
        conn = sqlite3.connect(db_path)
        try:
            marker = _read_marker(conn)
        finally:
            conn.close()
        if not force and marker.get("csv_sha256") == csv_sha256:
            rows = int(marker.get("csv_rows", "0"))
            print(f"已预载且源一致（sha256 {csv_sha256[:12]}…，{rows} 行）→ 跳过（幂等）。"
                  "如需强制重建：--force")
            return {"skipped": True, "rows": rows, "csv_sha256": csv_sha256, "db_path": str(db_path)}

    db_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"预载建库：{db_path}（源 csv sha256 {csv_sha256[:12]}…）")
    started = time.monotonic()
    conn = sqlite3.connect(db_path)
    try:
        # 预载期提速 PRAGMA（仅建库期；建完即只读使用，与运行期 PRAGMA 无关）
        conn.executescript(
            "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; "
            "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;"
        )
        conn.execute("DROP TABLE IF EXISTS ecdict")
        conn.execute("DROP TABLE IF EXISTS preload_meta")
        conn.execute(_SCHEMA)
        conn.execute(_META_SCHEMA)

        insert_sql = (
            "INSERT INTO ecdict (word, sw, phonetic, definition, translation, "
            "collins, oxford, tag, bnc, frq, exchange) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        batch: list[tuple] = []
        rows = 0
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            # 只读随包分发的 ECDICT csv 建库，无用户可控写入面，无 CSV 公式注入出口。
            reader = csv.DictReader(handle)  # nosemgrep: python.lang.security.use-defusedcsv
            if reader.fieldnames is None or "word" not in [name.strip() for name in reader.fieldnames]:
                raise PreloadError(f"csv 缺 word 列（表头：{reader.fieldnames}）：{csv_path}")
            for raw in reader:
                row = {
                    (name.strip() if name else name): value
                    for name, value in raw.items()
                }
                word = (row.get("word") or "").strip()
                if not word:
                    continue  # 无词形行不入库
                translation = row.get("translation")
                definition = row.get("definition")
                values = (
                    word,
                    (row.get("sw") or "").strip() or word.casefold(),
                    (row.get("phonetic") or "").strip() or None,
                    definition.replace("\\n", "\n") if definition else None,
                    translation.replace("\\n", "\n") if translation else None,
                    row.get("collins") or None,
                    row.get("oxford") or None,
                    row.get("tag") or None,
                    row.get("bnc") or None,
                    row.get("frq") or None,
                    row.get("exchange") or None,
                )
                batch.append(values)
                rows += 1
                if len(batch) >= BATCH_SIZE:
                    conn.executemany(insert_sql, batch)
                    if rows // BATCH_SIZE % 10 == 0:
                        print(f"  已导入 {rows} 行…")
                    batch = []
        if batch:
            conn.executemany(insert_sql, batch)
        conn.execute(_INDEX_SQL)
        marker_rows = {
            "csv_sha256": csv_sha256,
            "csv_rows": str(rows),
            "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": source_note or str(csv_path),
        }
        conn.executemany(
            "INSERT INTO preload_meta (key, value) VALUES (?, ?)", list(marker_rows.items())
        )
        conn.commit()
    except PreloadError:
        conn.close()
        db_path.unlink(missing_ok=True)  # 半成品不留盘
        raise
    except Exception as exc:
        conn.close()
        db_path.unlink(missing_ok=True)
        raise PreloadError(f"csv 导入失败：{exc}") from exc
    else:
        conn.close()

    elapsed = time.monotonic() - started
    size_mb = db_path.stat().st_size / 1048576
    print(f"预载完成：{rows} 行｜{size_mb:.0f} MB｜耗时 {elapsed:.1f}s（预算 15s+110MB 口径）")
    return {"skipped": False, "rows": rows, "csv_sha256": csv_sha256, "db_path": str(db_path)}


def preload(
    data_dir: Path,
    *,
    csv_path: str | Path | None = None,
    tarball_path: str | Path | None = None,
    url: str = DOWNLOAD_URL,
    force: bool = False,
) -> dict:
    """编排：本地 csv > 本地 tarball > 下载；解 LICENSE/写 SOURCE.txt → 建库。"""
    ecdict_dir = data_dir / "ecdict"
    ecdict_dir.mkdir(parents=True, exist_ok=True)
    source_note: str
    license_path: Path | None = None

    if csv_path is not None:
        csv_file = Path(csv_path)
        source_note = f"local csv: {csv_file}"
        # 直接给 csv 时若旁有 ECDICT-LICENSE.txt 一并落留痕
        sibling = csv_file.parent / "ECDICT-LICENSE.txt"
        if sibling.exists():
            license_path = ecdict_dir / "ECDICT-LICENSE.txt"
            shutil.copyfile(sibling, license_path)
    else:
        if tarball_path is not None:
            tarball = Path(tarball_path)
            if not tarball.exists():
                raise PreloadError(f"tarball 不存在：{tarball}")
            source_note = f"local tarball: {tarball}"
        else:
            tarball = ecdict_dir / "ecdict-master.tar.gz"
            print(f"下载 ECDICT：{url}")
            download_tarball(url, tarball)
            source_note = f"download: {url}"
        csv_file, license_path = extract_members(tarball, ecdict_dir)

    result = preload_from_csv(csv_file, ecdict_dir / "ecdict.db", force=force, source_note=source_note)
    (ecdict_dir / "SOURCE.txt").write_text(
        f"source: {source_note}\nimported_at: {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n"
        f"csv_sha256: {result['csv_sha256']}\nrows: {result['rows']}\n",
        encoding="utf-8",
    )
    if license_path is not None and license_path.exists() and license_path.parent != ecdict_dir:
        shutil.copyfile(license_path, ecdict_dir / "ECDICT-LICENSE.txt")
    elif license_path is not None and license_path.parent == ecdict_dir:
        pass  # extract_members 已直接落位
    return result


def main(argv: list[str] | None = None) -> int:
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        prog="python -m app.pipeline.preload",
        description="ECDICT 预载（安装期独占执行；幂等可重跑；运行期只读）",
    )
    parser.add_argument("--csv", default=None, help="本地 ecdict.csv（跳过下载/解压）")
    parser.add_argument("--tarball", default=None, help="本地 ECDICT tar.gz（跳过下载）")
    parser.add_argument("--url", default=DOWNLOAD_URL, help="下载地址（默认 codeload master）")
    parser.add_argument("--data-dir", default=None, help="覆盖数据目录（默认 server/data）")
    parser.add_argument("--force", action="store_true", help="忽略幂等标记强制重建")
    args = parser.parse_args(argv)

    from app.config import Settings

    settings = Settings(data_dir=Path(args.data_dir)) if args.data_dir else Settings()
    try:
        result = preload(
            settings.data_dir,
            csv_path=args.csv,
            tarball_path=args.tarball,
            url=args.url,
            force=args.force,
        )
    except PreloadError as exc:
        print(f"预载失败：{exc}", file=sys.stderr)
        return 2
    if result.get("skipped"):
        print("状态：跳过（已预载且源一致）")
    else:
        print(f"状态：完成（{result['rows']} 行）")
    print(f"ECDICT 库：{settings.ecdict_db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
