# 票 61：复习演出布局自适应 dock＋吸引力 pass（用户网页实测反馈第二轮）

日期：2026-11-09（用户网页实测票 59 后两诉求：①「复习时奥特曼可能会被挡住，手机上拼写区域会变高」②「画面仍未达我想要的效果，设立目标：优化成更具有吸引力的小游戏」）

## 修复 1：巨人布局自适应（P0 可用性）

- 查因：canvas 全屏（window 尺寸），拼写 dock 是 `position:fixed` 浮层、高度随内容走；手机竖屏字母键换行→dock 变高（probe61 实测 375×744 下 dockH=238），巨人固定 `vh-280`（y=464）被 dock（top=494）盖住下半身＋能量光环。
- 修法（pixiStage 内部，契约零触碰）：`fighterBaseY()` 运行时测量 `.rv-dock` 顶边（`document.querySelector?.` 可选链兼容测试 DOM shim），巨人踩 dock 上方 84px 净空；测量不到回退旧净空；`DOCK_MIN_Y_RATIO=0.42` 兜底 dock 高到离谱不侵入敌人带。`layout()/ambient/凝聚登场` 三处统一走 fighterBaseY；resize 事件驱动重算。
- 实证：probe61 手机竖屏几何 dockTop=494→巨人 y=410，截图目检巨人＋光环完整在 dock 上方（reports/61-assets/61-mobile-dock.png）。

## 修复 2：吸引力 pass（画面升级）

1. **巨人精致化**：外发光 glow 层（BLEND_MODES.ADD 青蓝柔光轮廓，ambient 呼吸）＋红披风（ambient 摆动＋移动侧偏）＋宽肩 V 型躯干英雄比例＋腹肌阴影＋膝甲＋双层发光眼（光晕＋内芯）＋胸灯常驻光环。
2. **背景层次**：远山剪影两层（景深）＋极光带两条（BLEND ADD 弧光，ambient 往复漂移）。
3. **Boss 战氛围**：红色警报渐晕 danger 层（Boss 在场脉冲呼吸，退场/清场/resize 复位链完整）。
4. **击破反馈闭环到主角**：巨人胜利小跳＋胸灯爆闪（Boss 跳更高）；登场落地冲击波环＋震屏。
5. **主角写面独占窗**（heroHold/演出时钟）：蓄力后仰/光波/胜利跳/登场点亮期间 ambient 让位（y/rotation/chest/glow/cape 不写）——消除「后到 tween 覆盖＝演出丢帧」竞争。

## 影响面

- 契约/考核面/testid 零变化；pixiStage.ts 单文件演出内部＋测试桩两处（FakeGraphics 无新方法需求；mock 补 BLEND_MODES 导出）。
- 测试：pixiStage 8/8；app 250 全绿；vue-tsc exit 0（抓出 blendMode 'add' 字面量类型错→BLEND_MODES.ADD 数值枚举修复）；build 绿；门仓根 exit 0。
- probe61 10/10（等首题 poll 加 reload 重试；手机竖屏仿真段 CDP Emulation 375×744）：全流程 7 词全对/1590 分/击破 6 只/零错误＋四截图（61-mobile-dock/61-wave-battle/61-boss-battle/61-done-report）目检全过。

## 探针坑（L47）

- **Edge CDP Emulation mobile 指标切换触发整页 reload**→复习会话重启→battle-start 重发→凝聚 2520ms 重跑——切视口后 1.1s 截图会截到「凝聚中巨人 invisible」伪影（怪兽已按新 vw spawn＝判据）；等 3.4s 再截即真实状态。
- vite 冷启动 dep 优化整页 reload 打断 awaitPromise→evaluate 返回 undefined——等首题 poll 需 try/catch＋重试。

> 注：本件为 2026-11-11 事故重建稿（原文随搬家丢失，内容自会话记录逐字恢复）。
