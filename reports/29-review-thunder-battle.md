# 票 29 交付报告：复习段「雷霆战机」拼写战斗

日期：2026-11-01 ｜ 状态：**已交付**（单测＋构建＋探针实走全过）

## 一、交付了什么

复习段从「看词选义选择题」重写为「拼写驱动雷霆战机」：

- 孩子在 DOM 考核层按「正确字母＋干扰字母」逐槽拼写（听写式：词形不显示，进卡自动读词＋可点「再听一遍」；怪兽头顶挂中文义气泡）。
- 每拼对一个词，常驻战机向当前怪兽发射 6 发子弹串（90ms 间隔）；怪兽 3 格分段血条，串尾扣 1 格，扣完击破坠落、下一只自动出场。
- 怪兽数 = ceil(卡数/3)；战报「拼出 N 词（全对 M），击破 K 只怪兽，用时 X 秒」。
- 口径：correct＝首试全对严格口径（`review_fill` 事件回写引擎）；非首试全对重排队尾一次。
- 时间盒 300s／硬顶 10 张／顺延／E4 全保持；question_type=`review_fill`，引擎零触碰。

## 二、改动点与影响面清单（全链路留痕）

| 文件 | 改动 | 影响面 |
| --- | --- | --- |
| `client/app/src/views/review/stageContract.ts` | 契约 v2 重写：指令 battle-start/load-word/fire/clear；事件 hit/defeat/stage-error（reveal/answer/escape 退役） | ReviewView、pixiStage、契约测试；总线机制（缓冲/回放/退订）逐行保留 |
| `client/app/src/views/review/stateMachine.ts` | 状态机 v2 重写：步骤 question→performance→done/timeup；拼写判定／重排／时间盒；导出 REVIEW_WORDS_PER_MONSTER=3 | ReviewView、状态机测试；引擎 DailyReviewCard 只读消费 |
| `client/app/src/views/review/pixiStage.ts` | 演出 v2 重写：常驻战机＋怪兽上半区 sin 游荡＋3 格血条＋6 发子弹串＋击破坠落＋义气泡；boot 队列/节流/可见性承袭 v1 | 契约三向总线消费方；ArtPreviewView 怪兽打样不受影响 |
| `client/app/src/views/review/ReviewView.vue` | 视图 v2 重写：enrichCard／onPickLetter／syncStage fire／recordReviewFill 回写；testid 全换（rv-fill-slot-*、rv-fill-option-* 等） | mock 夹具沿用；buildQuestion 保留导出但视图不再用 |
| `client/app/src/store/learningData.ts` | 新增 `buildReviewFillPayload` 纯函数＋`recordReviewFill` 方法；删除 recordReviewAnswer（word_pick_meaning） | 载荷形状跨端契约已钉测试；无其他调用方 |
| `client/app/src/styles/main.css` | rv 样式换装：退役 .rv-badge/.rv-option 系列；新增 .rv-meaning/.rv-grid--fill/.rv-fill-slot(-–done)/.rv-fill-option(--hint)/.rv-btn--ghost | **ArtPreviewView.vue 同步更新**（美术圣经预览页旧快过卡样例→新拼写组件样例，唯一外部引用面） |
| `client/app/src/views/review/stateMachine.test.ts` | v2 重写 ~15 例 | — |
| `client/app/src/views/review/stageContract.test.ts` | v2 重写 | — |
| `client/app/src/views/review/pixiStage.test.ts` | v2 重写＋战场语义（3 fire 击破时序） | — |
| `docs/spec.md` / `.squad/.../29-...md` / `pending-confirmations.md` | spec v1.3 S9 条款 2、票 29 任务书、P-10 台账 | — |

零触碰面：`client/engine`（183 例基线绿）、server（venv 135）、美术圣经锁参、词表版权线。

## 三、验证闭环（命令＋结果）

| 检查 | 结果 |
| --- | --- |
| `cd client/app && npm test` | **144/144 绿**（基线 141 → 净增 3；1 例测试期望修正：fail-open 语义不跳过重排，双卡会话重写） |
| `cd client/app && npm run build` | 零错误（vue-tsc/noUnusedLocals 过） |
| `cd client && npm test`（engine 零触碰基线） | **183/183 绿** |
| 探针实走（Edge＋CDP，`?mock=1#/learning/review`） | **47/47 断言全过**：7 词首试全对、40 次拼写点击、演出链（拼完→fire→血条→击破→下一只）、done 战报；截图 2 张存 `reports/29-assets/`（mid-battle：怪兽＋血条＋子弹串＋战机＋义气泡；done：战报页） |

探针过程记录：曾出现 6 例「末槽填充」断言失败，经聚焦探针＋页面时钟定位为**探针自身读态-点击竞态**（CDP 队列挂起期间页面世代推进，点击落到已切走卡面的同字母键），产品代码零缺陷证据＝聚焦探针末槽 t=1ms 字母＋--done 同帧、935ms 演出锁定、切卡正常。修复方式＝探针改原子读态点击（meaning/slot 世代校验与 click 同一 evaluate）。

## 四、须披露的决策与已知面

1. **P-10 决策 1（AskUserQuestion 未答，按推荐推进待追认）**：P0-P2 表单快过取消、全部进战斗（票 26/P-09 先例）。旧「快过卡/射击卡」分流退役。
2. **P-06 决策 3 部分取代**：复习段不再复用新词段「先词块后听写」形态，改听写式检索拼写（词只听不显）。
3. **GPU 节流偏差（票面已接受）**：怪兽在场期间 ticker 持续运行（常驻环境动画），document.hidden 即停、清场后回空闲。
4. **P2 视觉观察（不阻塞）**：mid-battle 截图示怪兽/义气泡与 DOM 卡顶轻微层叠（canvas 全屏演出与 DOM 卡固有交叠，prompt 装饰句被气泡部分遮挡）；如需微调属 ENEMY_Y/气泡锚点参数面，待用户拍板。
5. **Mimosa 误报 2 条**：pixiStage.ts `Math.random`×2（游荡相位/坠落旋向）＝演出随机，非加密用途，按噪声归类。
6. **测试基线变化**：app 141→144；engine 183 不变；server venv 135 不变。

## 五、两分钟下一步

打开 PowerShell 跑（dev server 已在 5199 端口运行中）：

```powershell
Start-Process "http://localhost:5199/?mock=1#/learning/review"
```

实走一遍：听发音→逐字母点选→看战机开火、血条掉格、击破坠落到 done 战报。
