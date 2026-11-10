# 票 58：her 例句错误全库纠正（pron 空模板＋31 词 curated＋13 册重发）

日期：2026-11-08（用户报障「her 的例句是错的，排查全库查因纠正」）

## 症状与查因

- her（4上 U1）例句＝"I am seven. I am a pupil."（origin: template:t-pron-i）——例句里没有 her，与词条完全脱钩。
- 根因：`EXAMPLE_TEMPLATES["pron"]` 是模板库**唯一缺 `{word}` 槽位的模板**（固定句），任何代词套它都得到同一句；编制笔记既定纪律「模板填充不通顺的代词/功能词一律进 CURATED_EXAMPLES」——pron 模板是违规残留。
- 全库扫描（en 不含词形且 origin=template:）：**29 词中招**（28 词 t-pron-i＋词组类 3 处其中 1 处合法）。

## 修法（三件套）

1. 机制：`EXAMPLE_TEMPLATES["pron"] = ()` 空模板——pron 无 curated＝例句留空（视图层空行不渲染＝宁缺勿滥，同音标空值语义）。
2. 内容：CURATED_EXAMPLES 补 **31 条**（29 代词/功能词含模拟 diff 抓出的 us 漏编＋make up＋switch-off 词组）。
3. 词组误伤纠正：make up（bx3 n. 模板填出 "This is my make-up."）与 switch-off（7b）补 curated 接住。

## 排查定责（模拟 diff 伪影甄别）

- 全库模拟 diff（xlsx 真实词形→新 enrich→对现行 bundle）：变更面＝31 词＋2 词组改善，零预期外缺陷。
- 4 处伪影甄别：pencil case（在旧版线 2a-v2，现行 2a-v6 不涉及）；china/march/Miss（模拟输入用 bundle headword 小写、真实 import 用 xlsx 原词形——重发词形不变）。

## 重发（13 册版本轮）

3a/3b/4a/4b/5a/5b/6a/6b/7b/9b v2→v3；bx1/xb1 v3→v4；bx3 v2→v3。批次 119-131；词数逐册对账一致＋E7=0 门（104/109/137/149/162/161/134/137/297/188/363/447/370）。client assets 换装（旧现行移除；旧版线 1a-v4/2a-v2 不动）＋START_POINT_TO_PACK bump＋packs.test bulk bump。

## 验收

- server 136 绿（enrich 改后全量）；app 250 绿（packs.test bump 后 14/14）；build 绿；门仓根 exit 0。
- probe59 4/4：4上建档→详情页 w_her→词头 her＋例句 "This is her book. / 这是她的书."＋释义含「她的」；截图 reports/58-assets/（59-her-example.png）。

> 注：本件为 2026-11-11 事故重建稿（原文随搬家丢失，内容自会话记录逐字恢复）。
