"""运行时设置：全部数据面落在 server/data/（已被 .gitignore 覆盖，不入仓）。"""
from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent

#: CORS origin 白名单（G4 Standards #1 移交；票 13 开工硬门）：
#: Capacitor Android/iOS 原生壳 origin（https://localhost）＋ Vite dev server。
#: 禁 `*`、禁反射任意请求 origin——白名单可经 Settings 注入覆盖，默认值钉死。
DEFAULT_CORS_ORIGINS: tuple[str, ...] = ("https://localhost", "http://localhost:5173")


class Settings:
    """路径型配置；data_dir 可注入（测试用 tmp 目录）。"""

    def __init__(
        self,
        data_dir: Path | None = None,
        cors_origins: Sequence[str] | None = None,
    ) -> None:
        self.data_dir = Path(data_dir) if data_dir is not None else SERVER_ROOT / "data"
        self.cors_origins = (
            tuple(cors_origins) if cors_origins is not None else DEFAULT_CORS_ORIGINS
        )

    @property
    def db_path(self) -> Path:
        return self.data_dir / "kidsenglish.db"

    @property
    def token_file(self) -> Path:
        return self.data_dir / "family_token"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"

    @property
    def imports_dir(self) -> Path:
        """导入批次预览快照（batch_{id}_preview.json）。"""
        return self.data_dir / "imports"

    @property
    def packs_dir(self) -> Path:
        """词包 bundle 根（四级组织目录：源/系列/年级学期/vN）。"""
        return self.data_dir / "packs"

    @property
    def ecdict_dir(self) -> Path:
        """ECDICT 本地库目录（ecdict.db＋license/source 留痕）。"""
        return self.data_dir / "ecdict"

    @property
    def ecdict_db_path(self) -> Path:
        return self.ecdict_dir / "ecdict.db"
