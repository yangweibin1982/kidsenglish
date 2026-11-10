# NOTICE（第三方数据与资产声明）

本项目代码以 GPL-3.0 分发（见 LICENSE）。以下第三方数据与资产按其自身许可独立声明，
本 NOTICE 不改变其效力；引用本项目时请一并遵守对应条款。

## 1. ECDICT 词典数据（服务端管线依赖）

- 来源：<https://github.com/skywind3000/ECDICT>
- 许可：**MIT**（保留原版权与许可声明即可自由使用/分发/商用）
- 落点：`server/data/ecdict/`（运行态，不入仓；重建方式＝按上游 README 下载）
- 用途：词性/释义/词频的词典主源（curated 显式覆盖优先）

## 2. word-atlas 词光数据（词卡详情页拓展区）

- 来源：<https://github.com/designfuchen/word-atlas>（数据集）
- 许可：**CC BY 4.0**（署名即可自由使用/分发/商用；AI 生成、未经人工审校）
- 落点：`client/app/src/assets/atlas-extra.json`（构建期从数据集提取的交集子集）
- 署名面：词卡详情页页脚已内置 CC BY 4.0 署名行（代码内保留，勿删）

## 3. 词表事实源

- 小学/初中：沪教牛津（深圳专版/广州深圳版）教材词表——单词与单元归属为事实性目录，
  释义/例句均为本项目自写或 ECDICT/curated 派生，不含教材原文内容
- 高中：人教版（2019 年版）教材词表，同上
- 源页：教习网词表页（yyld.51jiaoxi.com，仅词形与单元归属）

## 4. 音频

- 仓库**不含**任何音频文件（`client/app/public/audio/` gitignored）
- `reports/57-assets/fetch-audio.py` 为词级英音音频的抓取脚本，音频接口无公开许可，
  **仅供个人自用重新生成**；随本项目分发的代码不含且不链接任何音频资产

## 5. 美术与形象

- 全部 SVG/矢量演出形象（怪兽、光之巨人、场景、贴纸）为本项目原创（案 C 蜡笔绘本）
- 头像池 emoji 值渲染依赖系统字体，bitmap 位图头像（`assets/avatars/`）为原创形象
- 项目不含任何第三方角色形象（含历史遗留面已清理——见票 62）
