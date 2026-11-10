# 票 30 交付报告：复习段「雷霆战机」仿真度重制（v2 → v3）

日期：2026-11-02 ｜ 状态：**已交付**（单测＋构建＋探针实走全过）

## 一、交付了什么

针对用户实测反馈「太简单了，完全没有吸引力」，按雷霆战机调研（腾讯官网 Boss 解析／TapTap 集结测评／space-game 波次结构／知乎 Boss 死亡特效模板）把复习段演出重制为 >90% 相似度的雷霆战机形态，**考核语义零变化**：

- **星空卷轴**：双层视差滚动（雷霆战机纵版背景）。
- **拖动战机**：window 级指针横移（lerp 跟随，不拦截 DOM 考核卡交互）＋尾焰闪烁＋护盾环。
- **字母级弹幕**：每拼对 1 个字母立即一发子弹（反馈密度 ×6）＋合成射击音；词完 burst（6 发）扣血。
- **波次编队**：目标怪（义气泡＋血条）＋2 只伴飞怪错峰入场游荡。
- **Boss 战**：每 6 词一次——红色警告横幅＋金冠大体型＋宽分段血条＋装饰弹幕雨（命中战机仅护盾闪烁，**无任何惩罚**——儿童红线）；血量=min(6, 剩余词)，末 Boss 必可击破。
- **火力升级**：连击驱动武器 Lv1-3（单列→双列→三列散射＋主炮加粗），错误归 Lv1。
- **击破特效**：粒子爆炸＋白屏闪光＋震屏＋连击/得分浮字；Boss 多段爆炸。
- **得分/连击**：score=词长×10×combo，头部 chip（得分／xN·火力 Lv）＋canvas 浮字＋战报；**纯游戏内，不进学习事件流**（P-11 决策 3）。
- **合成音效**：WebAudio 振荡器（射击/命中/爆炸/升级琶音/Boss 警告），零音频资产，全 try/catch no-op 兜底。

## 二、改动点与影响面清单

| 文件 | 改动 | 影响面 |
| --- | --- | --- |
| `stageContract.ts` | v3：`letter-fire` 指令＋`fire` 载荷 {combo,weaponLevel,score}＋`REVIEW_WORDS_PER_BOSS=6`；缓冲 32→64 | ReviewView/pixiStage/两套测试 |
| `sfx.ts`（新） | WebAudio 合成音效 5 函数 | 仅 pixiStage 消费 |
| `stateMachine.ts` | RvState/RvResult 增 combo/score；拼完记账 combo（连续首试全对，错误归零）与得分；`REVIEW_WORDS_PER_MONSTER` 退役 | 视图/测试；review_fill 口径零变化 |
| `pixiStage.ts` | v3 全量重写（星空/拖动/波次/Boss/粒子/震屏/浮字/音效/武器形态/巡场收位） | 契约消费方；S5 铁律保持（只 import pixi＋契约＋sfx） |
| `ReviewView.vue` | letter-fire 接线；**新卡 question 步补发 load-word（真 bug 修复，见 §四）**；defeats 改数 defeat 事件；得分/连击 chip；战报增得分 | mock 夹具不涉 |
| `main.css` | .rv-head-side/.rv-score-chip/.rv-combo-chip | ArtPreviewView 不涉 |
| 三套测试 | v3 对齐＋4 新例（combo/score、Boss 调度、letter-fire 零回报、弱 Boss 血量） | — |
| 文书 | spec v1.4＋P-11 台账＋票 30 任务书 | — |

零触碰面：engine（183 基线绿）、server、美术圣经锁参色值、review_fill 跨端载荷。

## 三、验证闭环

| 检查 | 结果 |
| --- | --- |
| `cd client/app && npm test` | **148/148 绿**（144→148） |
| `npm run build` | 零错误 |
| `cd client && npm test`（engine 基线） | **183/183 绿** |
| 探针（Edge+CDP 原子读态点击，`?mock=1`） | **7/7 断言全过**：7 词全对、击破 **6 只**（5 小怪＋1 Boss）、得分 **1590** 精确匹配词长×10×combo 口径、40 点击零错误；截图 3 张存 `reports/30-assets/`（波次战三怪编队／金冠 Boss＋弹幕雨＋火力 Lv3／战报＋x7 连击浮字＋爆炸余韵） |

## 四、探针抓出的真 bug（v2 遗留，本次修复）

**新卡进 question 步时视图从不发 `load-word`**——第二只怪开始 `currentTargetId=null`，后续 fire 全走 fail-open 立即回报 `hit`：血条不扣、击破链断裂、怪兽 2+ 义气泡永不显示。首轮探针实锤：击破仅 1 只（应 6）。修复＝dispatch 新卡分支补发 load-word（ReviewView.vue）。**v2 为何没暴露**：v2 战报击破数用公式 `floor(卡数/3)` 计算、不消费 defeat 事件，缺陷被掩盖；本次 defeats 改数真实 defeat 事件后缺陷显形。修复后探针 7/7，演出链（血条→击破→下一波）真实运转。

## 五、布局与已知面

1. **巡场收位**：怪兽/Boss 巡场高度迁至考核卡下方自由带（vh×0.72/0.78），DOM 头部/卡片零遮挡；Boss 纵摆幅收窄防血条触卡。残面：Boss 头顶血条/王冠在巡游极位仍轻微探入「再听一遍」按钮下缘（canvas 在 DOM 后层，纯装饰性搭接，交互零影响）——P2 待用户拍板。
2. **Mimosa 误报 3 条**（弱随机）：pixiStage 游荡相位/坠落向＋sfx 白噪声 buffer＝演出随机非加密用途，按噪声归类。
3. **P-11 决策 1-4** 按调研推荐推进未逐项问询（票 26/29 先例），台账 `pending-confirmations.md` P-11 留痕待追认。
4. **相似度映射表**（>90% 判定）与放弃项（掉落道具→连击武器升级替代；生命/坠机→儿童红线故意不做）见票 30 任务书。

## 六、两分钟下一步

```powershell
Start-Process "http://localhost:5199/?mock=1#/learning/review"
```

拖动战机左右移动→逐字母拼写（每字母一发子弹）→连击 3 词升火力 Lv2→第 6 词看 Boss 警告与弹幕雨→击破看粒子/震屏/浮字→战报核对得分。
