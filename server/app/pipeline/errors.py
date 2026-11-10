"""流水线异常族：CLI 以退出码 2 呈现；HTTP 入口（后续票）映射 4xx/5xx。"""
from __future__ import annotations


class PipelineError(RuntimeError):
    """流水线可预期失败（输入形状／状态机／前置条件不满足）。"""


class XlsxFormatError(PipelineError):
    """三列 xlsx 形状或取值不合法（spec 接缝 4：怪异格式由夹具逐步扩）。"""


class PackImmutabilityError(PipelineError):
    """词包版本化不可变被触碰：同 identity+version 重复发布（spec S1 红线）。"""


class PreloadError(PipelineError):
    """ECDICT 预载失败（下载止损／来源不合法／导入失败）。"""
