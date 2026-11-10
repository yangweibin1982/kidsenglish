"""词包 bundle 写盘与校验（spec S1/S7，R1 四级组织）。

- 目录四级组织：packs/{source}/{教材版本}/{年级}{学期}/v{版本}/（Windows 路径安全化 slug）。
- manifest.json 清单含逐文件 SHA-256＋字节数（S1 客户端完整性校验契约）；
  verify_bundle 即同款校验（客户端下载校验逻辑的 server 侧同构）。
- 版本化不可变：bundle 目录已存在＝拒绝（PackImmutabilityError，不覆盖不静默改名）。
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

from app.pipeline.errors import PackImmutabilityError, PipelineError

MANIFEST_NAME = "manifest.json"
MANIFEST_VERSION = 1
_UNSAFE_PATH_CHARS = re.compile(r'[\\/:*?"<>|\s]+')


def slugify(text: str) -> str:
    """路径安全化：Windows 非法字符与空白 → 下划线；保留 CJK 与字母数字。"""
    cleaned = _UNSAFE_PATH_CHARS.sub("_", text.strip()).strip("._")
    if not cleaned:
        raise PipelineError(f"路径片段为空：{text!r}")
    return cleaned


def bundle_dir(settings, *, source: str, series: str, grade: str, term: str, version: int) -> Path:
    """四级组织落点：packs/{source}/{教材版本}/{年级}{学期}/v{版本}。"""
    return (
        settings.packs_dir
        / slugify(source)
        / slugify(series)
        / f"{slugify(grade)}{slugify(term)}"
        / f"v{version}"
    )


def _dump_json_bytes(payload: dict) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_bundle(
    target: Path, *, pack_identity: dict, units: list[dict], generated_at: str
) -> list[dict]:
    """写包 bundle：units/unit-XX.json 逐单元一文件＋manifest.json（最后写）。

    返回逐文件清单（path/sha256/bytes）；目录已存在即拒绝；半途失败清理半成品
    （防占住版本号导致后续发布被目录存在性误拒）。
    """
    if target.exists():
        raise PackImmutabilityError(
            f"包目录已存在，拒绝覆盖：{target}（版本化不可变，spec S1；修词请发新版本）"
        )
    files: list[dict] = []
    try:
        target.mkdir(parents=True)
        (target / "units").mkdir()
        for unit in units:
            relative = f"units/unit-{unit['unit_no']:02d}.json"
            data = _dump_json_bytes(unit)
            (target / relative).write_bytes(data)
            files.append({"path": relative, "sha256": _sha256_bytes(data), "bytes": len(data)})
        manifest = {
            "manifest_version": MANIFEST_VERSION,
            "pack": pack_identity,
            "generated_at": generated_at,
            "files": files,
        }
        (target / MANIFEST_NAME).write_bytes(_dump_json_bytes(manifest))
        return files
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def verify_bundle(target: Path) -> dict:
    """校验 bundle：重算逐文件 SHA-256 比对 manifest（VALIDATE 4／客户端同款逻辑）。"""
    manifest_path = target / MANIFEST_NAME
    if not manifest_path.exists():
        raise PipelineError(f"manifest 缺失：{manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    problems: list[str] = []
    for entry in manifest.get("files", []):
        file_path = target / entry["path"]
        if not file_path.exists():
            problems.append(f"缺文件：{entry['path']}")
            continue
        data = file_path.read_bytes()
        if _sha256_bytes(data) != entry["sha256"]:
            problems.append(f"SHA-256 不匹配：{entry['path']}")
        elif len(data) != entry.get("bytes", len(data)):
            problems.append(f"字节数不匹配：{entry['path']}")
    if problems:
        raise PipelineError("bundle 校验失败：" + "；".join(problems))
    return {"files": len(manifest.get("files", [])), "manifest": manifest}
