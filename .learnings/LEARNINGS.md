# LEARNINGS 台账（2026-11-11 重建版）

> 2026-11-10 搬家误删事故：L1-L41 原文随 `.learnings/` 一并丢失（git 历史同损，除非文件雕刻恢复成功）。
> 本文件为重建基线：L40-L47 自助手记忆/会话记录恢复全文；L1-L39 仅存目录级摘要（原文待恢复或认损）。
> 新条目从 L48 起编。

## 恢复的条目（L40-L47 全文）

- L40 **自然拼读拆分＝pyphen 词典主源（票 54），模式启发式只配当兜底**：自拟 VCCV 启发式只覆盖双写辅音型（hel·lo/mor·ning/sis·ter），全库 1,813 多音节词无拆；pyphen（en_US 连字词典）尖刀 24 词 20 精确命中、665 旧拆 30 抽样全归词典标准（de·cem·ber/dis·ap·pear/reg·is·ter 等——旧 VCCV 反而多处非标准）。守卫三件套保留：词组/符号不拆（isalpha 门）、join==word、客户端 syllablesOf 宁缺勿滥。假词（zorblat）模式拆分无害——E7 不入包。
- L41 **词包版本轮全库重发的波次形状**：enrich 改源→25 册逐册 import（源 xlsx 全在 reports/*-assets）→commit 自动 max+1→verify→词数逐册对账（committed==旧 bundle 词数）→E7=0 门（事实面变化禁盲发）→client assets 换装（新拷入+旧移除，旧版线 1a-v4/2a-v2 不动）→START_POINT_TO_PACK+DEFAULT_PACK_ID+packs.test 断言 bulk bump。series 身份必须与原版一致。进程内直调 runner API（import_xlsx/commit_batch/verify_bundle）优于 subprocess CLI——单次 ECDICT 预载零命令注入形状。
- L42 **探针 Edge 生命周期管理三件套（票 56/57 探针连环崩定责）**：①上一轮 edge.kill() 异步释放文件锁——下一轮开头 rmSync 固定 profile 目录会静默失败→localStorage 残留档案→首启跳过建档页；②顶层抛错绕过 edge.kill()→泄漏全棵 Edge 进程树→僵尸占 CDP 调试端口，下一轮连到旧页面。修法＝唯一 profile 目录（Date.now 后缀）＋process.on(uncaughtException/unhandledRejection) 兜底杀＋每轮开跑前按 CommandLine 匹配清场。
- L43 **文本面修完的读音 bug 会在新模态面重犯（票 52 不变式音频面回归）**：不变式是跨模态的——新路由面/新数据源上线时，必须对既往不变式清单（全字母读音/儿童零外链/圣经 token 零新色值）逐条过一遍，测试钉死。另：CDP evaluate().click() 是非信任点击，audio.play() 必遭 NotAllowedError——探针验证音频路径必须加 --autoplay-policy=no-user-gesture-required。
- L44 **vue-router 参数级导航复用组件实例（票 56 probe57 定责）**：仅变 hash 或同路由不同参数时组件不重挂、onMounted 不重跑——详情页类视图必须 `watch(() => route.params.entryId, load)` 双入口。连带：CSS 插入锚点残留会产出孤儿声明碎片，浏览器静默跳过——css diff 后要目检块边界。
- L45 **例句模板缺槽位＝词条脱钩型缺陷（票 58）**：「例句里有没有这个词」是例句缺陷的机械判据（en 不含 headword 且 origin=template: 全库扫）。三条排查纪律：①全库模拟 diff 必须用 xlsx 原词形（bundle headword 规范化会造大小写伪影）；②扫描先剔旧版线保留包；③curated 键 normalize 精确匹配——连字符/空格变体互不命中，按 bundle 实形逐形补。
- L46 **演出层重做的三条时序纪律（票 59）**：①事件断言全绿≠时序干净——双 spawnWave 竞争只在「这只怪是哪只」粒度断言下暴露；契约有隐含时序前件时后到者让位。②hitStop 别用 performance.now——测试瞬时 tick 下全落窗；用演出时钟（缩放 dt 累计）＋窗长换算。③emoji sprite 是真机独有空白源——probeEmojiSupport＋矢量兜底是根治形状，测试桩测不出（无渲染），真机路径只有用户实走能验。
- L47 **探针双坑：CDP Emulation mobile 切换＝整页 reload（票 61）**：①Edge CDP setDeviceMetricsOverride(mobile:true) 触发整页 reload→SPA 会话重启→凝聚演出重跑——1.1s 截图截到 invisible 伪影（判据＝怪兽 baseX 已按新 vw spawn），3.4s 才是真实态。②vite 冷启动 dep 优化 reload 打断 awaitPromise→evaluate undefined——等首题 poll 必须 try/catch＋歇拍重试。

## L1-L39 目录级摘要（原文认损；主题线索供 gbrain 回查）

词包编制纪律（curated-first/E7 守卫/版本轮）· TTS 坑链（voices 异步/Online Natural 挂死/单字母大写化 L39）· 探针方法论（pollUntil/原子读态点击/遮挡节流三禁/vite reload 坑/profile 生命周期）· vue-tsc 判空窄化 L38 · 圣经 token 零新色值 · 儿童零外链 · 门脚本 CWD 敏感/PATH 前置 3.13 · gitleaks 精确锚定豁免 · sql.js db.run 规避写入门 · localStorage shim 测试惯例 · vitest include 显式清单 · 深色对比度呈报 · XML 注释 `--` 违规范 SVG 空图。细节沉淀大量同步在 gbrain（kidsenglish/* 命名空间）——回查以 gbrain 为准。
- L48 **搬家＝dotfile 事故面（2026-11-10 搬家误删，历史判死实锤）**：项目迁 E:\400-家庭\kidsenglish（旧路径留符号链接＝正确做法），但搬家过程把根目录 dot 项（.git/.learnings/.gitignore/.gitleaks.toml）与 .squad/kids-english-g2 一并删了；回收站 0 命中（绕过删除）＋无卷影＋全盘无副本＋**winfr regular 全盘扫描零命中（MFT 已覆盖/复用）**＝文件雕刻恢复窗口关闭。三条铁律：①**搬家/清理前先 `git status`＋远端存在性检查——无远端的本地仓是单副本裸奔**；②删除工具若可能绕过回收站（shift-del/清理工具），dotfile 与"看着像缓存"的目录是第一牺牲品，搬家一律走「整目录移动」不走过滤复制；③本项目工作树即真相（工作树=票 61 终态全量幸存），基线重建成本仅 15 分钟——**工作树在，损失就有底**。
