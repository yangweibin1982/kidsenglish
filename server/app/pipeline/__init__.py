"""词表编制流水线（spec S3：server 侧双入口共用管线）。

本包承载：三列 xlsx 摄取 → ECDICT 自动补全 → 预览（E7 查无标黄待补队列）→
入库 → official/custom 词包版本化发布。本票只通 CLI 入口
（`python -m app.pipeline`）；HTTP API 入口（R12 家长向导）归后续票复用同一 runner。

安全硬约束：数据库查询一律参数绑定（tests/pipeline/test_static_parambind.py 静态断言）；
下载 URL 仅 https 且校验 host（preload.ALLOWED_DOWNLOAD_HOSTS）。
"""
from app.pipeline.errors import PackImmutabilityError, PipelineError, PreloadError, XlsxFormatError

__all__ = ["PipelineError", "PackImmutabilityError", "PreloadError", "XlsxFormatError"]
