# 票 59：复习演出重做——光点凝聚光之巨人＋光波击破＋打击感（根治真机看不到飞机）

日期：2026-11-08（用户报障「手机上复习时看不到飞机」＋改版需求：四周光点凝聚成卡通光之巨人、发射光波击破怪兽、增加打击感）

## 症状与查因

- 真机 Android WebView 复习战场空白（看不到飞机）：角色全 emoji sprite（🚀 字体链 `"Segoe UI Emoji", "Noto Color Emoji"`）——Android WebView 缺彩色 emoji 字体时 Canvas 画不出像素＝空白。模拟器有字体所以 probe 全绿、真机独有。
- 根治方向：演出层去 emoji 依赖（矢量绘制为主），真机不再受字体面影响。

## 修法（pixiStage.ts 演出内部重做；契约与考核面零触碰）

1. **emoji 探测＋矢量兜底**：`probeEmojiSupport()` offscreen canvas 画 🚀 读 alpha 像素判定；`emojiOk=false` 时角色工厂全走矢量（sparkle/star/boom/crown/monster 兜底造型），真机字体缺失不再空白。
2. **光之巨人（替代飞机）**：全矢量造型——银色身躯＋红纹＋胸灯（chest 层）＋发光眼＋脚下能量光环 flame；通用光之巨人造型，不复刻迪迦专属紫黑纹样（版权面）。
3. **battle-start 凝聚登场**：56 颗光点四周边缘 smoothstep 螺旋汇聚（HERO_GATHER_MS=2100）→闪白＋巨人 easeOutBack 420ms 登场。**凝聚完成不再 spawnWave**（修复双 spawnWave 竞争：曾会换掉 load-word 已出的怪→defeat 错位一位；首波出怪全权由 load-word 承担，契约「battle-start 后必跟 load-word」）。
4. **光矢（替代字母火箭串）**：矢量金白菱形光矢，自旋改尾光摆动；起点 HERO_MUZZLE（手部）；命中加粒子＋震屏。
5. **光波击破（替代爆炸消失）**：`beamThenDefeat()`——胸灯 scale 蓄力（BEAM_CHARGE_MS=380，sfxCharge）→金白三层光束 atan2 对准目标→怪钉住抖动→击破粒子雨＋Boss 额外垫场。
6. **打击感**：hitStop 顿帧（命中 70ms／击破 130ms，窗长×HITSTOP_SLOW=0.06 换算进 stageClockMs 演出时钟——`performance.now` 方案在测试瞬时 tick 下全部落窗，作废）＋震屏（命中 5／击破 11）＋闪白＋粒子（14/22 颗，Boss 22）。
7. **音效**：sfxCharge（锯齿 160→980Hz 扫升）＋sfxBeam（低频轰 110→38Hz＋噪声脉冲）；音量 ≤0.12 不抢 TTS 主声道（既有纪律）。
8. 弹幕雨 ☄️、沙尘等氛围件同步配矢量兜底。

## 影响面（改动前全链路调查留痕）

- 调用面：pixiStage 仅 ReviewView 经 stageContract 消费；契约指令/事件签名未动，考核面（拼写 dock/HUD/testid）未动。
- 测试面：pixiStage.test.ts FakeGraphics 补 drawEllipse 桩；driveTicks 1800→2600（光波蓄力/贯穿＋击破垫场链路总时长 +530ms）；8/8 全绿。
- 回归不变式核对（票 52 式）：letter-fire 零回报、每 6 词 Boss、fail-open、clear 清零回报逐条过（测试钉死）。

## 验收

- vitest pixiStage 8/8＋app 250 绿；build 绿（TS6133 HERO_FLASH_MS 已删）；门仓根 exit 0。
- probe60 全链：建档→进复习→40 字母点击→战报「7 词全对、击破 6 只（5 小怪＋1 Boss）、得分 1590」；2 处断言 FAIL 定责＝探针 poll 窗时序误报（dev server 新实例首屏慢），无真实 stage-error。
- 三截图目检（reports/59-assets/）：30-wave-battle（巨人＋金菱光矢＋义气泡）、30-boss-battle（Boss＋王冠＋弹幕雨＋连击 chip）、30-done-report（战报卡＋巨人站立）。
- 版权裁定留痕（待追认）：巨人＝通用光之巨人造型（不涉及迪迦专属纹样）；家庭自用，商用分发前需复核造型原创性。
- 待真机复验：矢量兜底根治「看不到飞机」，需用户 Android 真机确认（emojiOk=false 路径真机实测）。

> 注：本件为 2026-11-11 事故重建稿（原文随搬家丢失，内容自会话记录逐字恢复）。
