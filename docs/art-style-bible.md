# 美术风格圣经 · 案 C 蜡笔绘本（Art Style Bible）

> **唯一事实源**：本文件是战机英语全部视觉产出的参数基线。第三方（画师/AI 管线/工程师）拿本文件应能画出与既有样张一致的风格。
> 定案依据：P-05 美术案 C 拍板（蜡笔绘本风）；候选评估见 `.squad/kids-english-g2/reports/08-美术风格候选/案C-蜡笔绘本/风格卡.md`。
> 前端 token 落点：`client/app/src/styles/main.css`（--ke-* 全套）——**两处同值，改任一侧必须同步另一侧，禁魔法数漂移**。
> 样张：`client/app/src/assets/art/`（U2 情景图×1＋怪兽×3），开发预览页 `/art-preview`（dev-only）。

---

## 1. 风格一句话与适用范围

**蜡笔绘本质感**：暖纸底、暖棕手绘线稿、蜡笔涂色不满（飞白露纸）、歪萌简笔形体。定位「孩子书架上一本会动的绘本」。

| 面 | 处理方式 | 理由 |
|---|---|---|
| 插画资产（情景图/怪兽/演出序列帧） | SVG 滤镜程序化手绘感，或画师手绘（同参数） | 滤镜可参数化复现（§4） |
| 主路径 DOM UI（按钮/卡片/徽章） | **不挂实时 SVG 滤镜**——用暖棕描边＋蜡笔硬阴影＋蜡笔色块静态近似 | 性能红线：低端安卓 WebView 实时滤镜掉帧（风格卡 PixiJS 注记同源结论）；绘本感靠形与色，不靠逐帧滤镜 |
| PixiJS 演出层 | 运行时纯色 Graphics＋暖棕描边；蜡笔颗粒烘进贴图（离线预烘，不在运行时做） | capacitor#3899 节流现状下禁加重渲染负担 |

## 2. 色板 token（全套，对照表）

对比度为本机实算值（WCAG 2.1 相对亮度公式；「大字」=≥18.66px bold 或 ≥24px regular，AA 大字 3:1，正文 4.5:1，非文本边界 3:1）。

### 2.1 三主色（P-05 拍板定案值，不可改）

| token | HEX | 角色 | 使用边界 |
|---|---|---|---|
| `--ke-sky` | `#5B9BB5` | 蜡笔蓝：主操作底/战机涂装/充能条 | 白字 on 它 3.09（仅大字档 ≥18.75px bold）；不做小字底 |
| `--ke-coral` | `#E8764F` | 蜡笔橘红：强调/怪主业色 | 白字 on 它 2.94 **不达标**——文字承载面一律降档用 `--ke-coral-deep` |
| `--ke-sun` | `#F0C05A` | 蜡笔黄：星星/奖励/高亮 | 禁做描边色（对比 1.5 级）；文字用 `--ke-ink`（5.01） |
| `--ke-grass` | `#8FBE6E` | 蜡笔绿：插画植被/角球装饰（案 C 定义色） | 仅插画装饰；禁做描边与文字（on 米纸约 2.1 级） |

### 2.2 主色深档与晕染（token 化的对错修正面）

| token | HEX | 用途 | 实测对比 |
|---|---|---|---|
| `--ke-sky-deep` | `#356E88` | 蓝系文字/链接/时间盒数字/交互描边 | on 米纸 5.08；on 奶油卡 5.36 |
| `--ke-coral-deep` | `#D96843` | 红系文字承载底（音节块2）/紧迫态/boss 描边 | 白字 3.49 大字档；描边 on 奶油卡 3.33 |
| `--ke-sky-wash` | `#E3F0F2` | 蓝淡晕底（徽章/装饰） | — |
| `--ke-coral-wash` | `#FBE3D6` | 红淡晕底（徽章/步骤激活） | — |
| `--ke-sun-wash` | `#FCF4DE` | 黄淡晕底（词片） | — |
| `--ke-on-crayon` | `#FFFFFF` | 蜡笔色块上文字＝**纯白** | on sky 3.09（大字档）；奶油白 #FFF9EC 2.94 禁用 |

### 2.3 纸感与线稿

| token | HEX | 用途 | 实测对比 |
|---|---|---|---|
| `--ke-paper` | `#FBF3DF` | 米纸全局底（旧值 #FDF8EF → 案 C 定案色） | — |
| `--ke-paper-night` | `#26221C` | 夜纸底（仅壳层随暗色；深棕灰非纯黑） | — |
| `--ke-card` | `#FFF9EC` | 奶油纸卡面（儿童卡固定亮底，不随暗色反转） | — |
| `--ke-line` | `#7A5A3D` | 暖棕线稿（全部插画描边＋UI 交互描边） | 做文字 on 米纸 5.66；交互边界达标 |
| `--ke-line-soft` | `#E7DBC2` | 纸边淡棕（仅弱分隔装饰；**禁做交互边界/描边**，对比 1.2 级） | — |

### 2.4 文字墨色

| token | HEX | 用途 | 实测对比 |
|---|---|---|---|
| `--ke-ink` | `#5A4A38` | 暖棕深墨正文（旧 #3A3F4A 冷灰 → 暖棕化） | on 奶油卡 8.10；on 蛋黄 5.01 |
| `--ke-ink-soft` | `#75654F` | 暖灰棕次级（旧 #7A7F8A） | on 米纸 5.09 |
| 壳层 `--text` | `#4A3A2A`（旧 #1C2330） | 壳层正文（最深，怪兽眼珠同源） | on 米纸 9.84 |
| 壳层 `--muted` | `#75654F`（旧 #5C6675） | 壳层次级文字 | 5.09 |
| 壳层 `--brand` | `#356E88`（旧 #1E6FD9 默认蓝） | 壳层标题/链接 | 5.08 |

### 2.5 语义色三件套（对/错/警示）

| 语义 | bg | fg | border | fg 实测 |
|---|---|---|---|---|
| 对 ok | `--ke-ok-bg #F1F8E9` | `--ke-ok-fg #3E7A4E` | `--ke-ok-border #5C9968` | on bg 4.72 ✓ |
| 错 no | `--ke-no-bg #FDEFE6` | `--ke-no-fg #B04A28` | `--ke-no-border #D96843` | on bg 4.84 ✓ |
| 警示 warn | `--ke-warn-bg #FCF4DE` | `--ke-warn-fg #8A6A1F` | `--ke-warn-border #E8B84A`（装饰档） | on bg 4.60 ✓ |

语义映射（组件层）：答对反馈＝`ok-border` 涂改圈＋`ok-fg` 勾（原蛋黄圈对比 1.6 不达标，改蜡笔绿——蛋黄保留给星星/奖励）；答错提示＝`no-fg`；时间盒紧迫＝`coral-deep`（大字档 3.16）；boss 标题＝`no-fg`（4.92）。

### 2.6 深浅两态规则

- **儿童段（新词/复习）固定亮纸底**，不随 `prefers-color-scheme` 反转（色彩识别稳定，Ticket 10 既有裁定）。
- **壳层（五域导航/家长域）随暗色**：暗色映射＝夜纸 `#26221C`＋夜卡 `#332E26`＋暖米白 `#EFE6D6`＋暖灰米 `#B8AB94`＋蓝提亮 `#7FB6CE`（on 夜纸 7.14）。暗色下层级靠纸面色差（非纯黑、阴影退场）。

### 2.7 硬阴影 token

`--ke-shadow: 0 4px 0 rgba(122,90,61,.22)`（线稿棕族）/ `--ke-shadow-coral: 0 4px 0 rgba(217,104,67,.25)`（boss）。蜡笔「涂厚了一层」的纸面厚度感；只用于卡片级浮面，按钮不用阴影（按压用 scale 0.94-0.97＋opacity）。

## 3. 造型语言（插画与 UI 共用）

1. **线稿**：暖棕 `#7A5A3D`，禁纯黑（避免「作业本批改」联想）。插画线宽 3-3.5px（900×560 画布基准），UI 描边统一 2px；一律圆头 `stroke-linecap="round"`＋圆角连接。
2. **蜡笔涂色不满**：色块 opacity 0.8-0.9 露纸底（约 8-12% 飞白）；颗粒滤镜见 §4。
3. **手绘抖动**：轮廓经 wobble 滤镜（§4），允许轻微不对称——眼睛一高一低、云三笔团成、太阳光芒长短不一。
4. **形体**：圆润歪萌，「孩子画得出来的形状」；表情简笔＋小腮红斜线两笔（不涂色块）。
5. **文字层**：**永不参与抖动滤镜**（可读性铁律，示意 HTML 同规则）。
6. **禁**：锐利尖角武器/伤痕/血腥元素（R8）；性别指向元素；纯黑描边；冷灰中性色（全部暖棕化）。

## 4. SVG 滤镜参数锁定（禁漂移）

三个滤镜的参数**写死于文档与本节代码块**；任何资产不得私自调参。`seed` 按图注册（§4.4）。

### 4.1 手绘线稿滤镜 `ke-wobble`（轮廓抖动）

```xml
<filter id="ke-wobble" x="-10%" y="-10%" width="120%" height="120%">
  <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="7" result="w"/>
  <feDisplacementMap in="SourceGraphic" in2="w" scale="5"/>
</filter>
```

| 参数 | 锁定值 | 说明 |
|---|---|---|
| type | `fractalNoise` | 多倍频噪声，抖动自然 |
| baseFrequency | `0.035` | 抖动空间频率（900×560 画布基准；画布尺寸变化时**等比缩放此值**，如 450×280 用 0.07） |
| numOctaves | `3` | 倍频数 |
| seed | `7`（基准注册，见 §4.4） | 噪声种子 |
| scale | `5` | 位移幅度 px——**大于 6 线条破碎、小于 4 手绘感消失** |

### 4.2 蜡笔涂色滤镜 `ke-crayon`（颗粒飞白）

```xml
<filter id="ke-crayon" x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2" seed="8" result="n"/>
  <feColorMatrix in="n" type="matrix"
    values="0 0 0 0 0.45  0 0 0 0 0.35  0 0 0 0 0.22  0 0 0 0.45 0" result="g"/>
  <feComposite in="g" in2="SourceAlpha" operator="in" result="grain"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="grain"/></feMerge>
</filter>
```

| 参数 | 锁定值 | 说明 |
|---|---|---|
| baseFrequency | `0.5` | 颗粒密度 |
| numOctaves | `2` | — |
| 颗粒色（matrix 末列） | `0.45 / 0.35 / 0.22` | 暖棕颗粒 RGB（≈#735938） |
| 颗粒 alpha | `0.45` | 飞白强度——调高显脏、调低失蜡笔感 |
| 合成 | `feComposite in SourceAlpha` ＋ `feMerge` 叠加 | 颗粒只落在色块内（不溢出轮廓） |

### 4.3 纸面颗粒滤镜 `ke-papergrain`（全局纸纹，仅插画/演出画面用）

```xml
<filter id="ke-papergrain" x="0" y="0" width="100%" height="100%">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11"/>
  <feColorMatrix type="matrix"
    values="0 0 0 0 0.5  0 0 0 0 0.42  0 0 0 0 0.28  0 0 0 0.06 0"/>
</filter>
```

颗粒色 `0.5/0.42/0.28`、alpha 锁 `0.06`（极淡罩层）；DOM 主路径**禁用**本滤镜（性能红线，§1）。

### 4.4 seed 注册规则

基准 seed：wobble=`7`、crayon=`8`、papergrain=`11`（样张与首批资产即此值）。批量量产时**每张图可换 seed 但必须登记**进该学期包 manifest（同图三滤镜 seed 固定不变；同批不同图换 seed 防噪声纹理雷同）。换 seed 不视为改风格。

## 5. 字体策略（儿童可读性）

- **零外链字体**（儿童红线 R18）：全站系统字体栈 `system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif`；PixiJS Text 同栈（`'system-ui, sans-serif'`）。禁 CDN/Google Fonts/内嵌字体文件。
- 大字号基线：正文 clamp(15px,1.6vw,18px)；儿童可读词 ≥2em bold（音节块/词牌）；主按钮 ≥1.25em bold（≥18.75px，保白字大字档 3:1）。
- 行高：中文正文 ≥1.7（`.view` 已设）；标题 1.2-1.3。
- 数字（倒计时/计数）一律 `font-variant-numeric: tabular-nums`。
- 音标永不上孩子界面（R7）。

## 6. 组件形态规范（五件套）

统一语言：奶油纸卡面 `--ke-card`＋2px 暖棕线稿描边＋蜡笔硬阴影＋18px 大圆角；按压＝scale 0.94-0.97（150ms `--ke-ease`）；焦点环 3px `--ke-sky-deep`（box-shadow 通道）；触控目标一律 ≥44px（`--ke-hit`）。

| 件 | 圆角 | 描边 | 底/字 | 按压态 |
|---|---|---|---|---|
| 卡片（nw-card/rv-card） | `--ke-radius 18px` | 2px `--ke-line`（boss 用 `--ke-no-border`，结束卡 dashed 无阴影） | `--ke-card` 底 | 无位移（非按钮） |
| 主按钮（nw-btn/rv-btn） | `999px` 胶囊 | 无描边 | `--ke-sky` 底＋`--ke-on-crayon` 字 1.25em bold | scale 0.94-0.97；ghost 变体＝透明底＋2px `--ke-sky-deep` 描边＋同色字 |
| 徽章（rv-badge） | `999px` | 2px（plain `--ke-sky-deep` / shooting `--ke-no-border`） | 淡晕底（`--ke-sky-wash`/`--ke-coral-wash`）＋`--ke-ink` 字（贴纸形态，小字 4.5 达标） | 无 |
| 时间盒（nw/rv-timer） | `12px` | 2px `--ke-sky-deep`（紧迫切 `--ke-coral-deep`） | `--ke-card` 底＋数字同描边色（1.3em bold tabular-nums） | 无 |
| 选项按钮（rv-option） | `14px` | 2px `--ke-line` | `--ke-card` 底＋`--ke-ink` 字 1.15em bold | scale 0.97；答对＝`--ke-ok-border` 描边＋3px 外圈＋`ok-fg` 勾；锁定 opacity .65 |

状态矩阵（选项按钮）：default / active(scale) / focus-visible(3px 蓝环) / disabled(cursor default＋locked .65) / correct(ok 圈勾)。触屏产品不做 hover 态（避免粘滞高亮）。

## 7. 怪兽 → Pixi Graphics 参数映射（票 11 演出层换装依据）

三只打样 SVG（`src/assets/art/monsters/`）全部由 Graphics 基元构成，参数一一对应。运行时规范：**纯色 `beginFill`＋`lineStyle({ width: 3, color: 0x7a5a3d, cap: 'round', joint: 'round' })` 暖棕描边；蜡笔颗粒不在运行时做**（烘贴图或离线序列帧，§1）。

| 部位 | SVG（打样） | pixi Graphics 等价 |
|---|---|---|
| 圆胖体 blob（monster-blob.svg，蜡笔蓝） | `<ellipse cx="0" cy="0" rx="46" ry="42">` | `g.beginFill(0x5b9bb5).drawEllipse(0, 0, 46, 42).endFill()` |
| 高瘦体 tall（monster-tall.svg，蜡笔红深档） | `<rect x="-30" y="-64" width="60" height="128" rx="30">` | `g.beginFill(0xd96843).drawRoundedRect(-30, -64, 60, 128, 30).endFill()` |
| 团圆体 trio（monster-trio.svg，蛋黄＋深墨五官） | `<circle r="44">` | `g.beginFill(0xf0c05a).drawCircle(0, 0, 44).endFill()` |
| 眼白/瞳孔 | `<circle r="11">` / `<circle r="4.5">` | `beginFill(0xffffff).drawCircle(±16, -6, 11)`；瞳 `0x4a3a2a` `drawCircle(±14, -4, 4.5)`（歪瞳＝歪萌） |
| 触角/手脚 | `<path>` 圆头线 | `g.lineStyle({width:3, color:0x7a5a3d, cap:'round'}).moveTo(x,y).lineTo(x,y)` |
| 腮红斜线 | 两笔短线 `#E8764F` | `lineStyle({width:2, color:0xe8764f, cap:'round'})` 两段短线 |
| 嘴 | `<path d="M.. Q..">` | `g.moveTo().quadraticCurveTo(cx, cy, x, y)` |

关键锁定值：描边宽 `3`、描边色 `0x7a5a3d`、圆头 `cap/joint: 'round'`、瞳色 `0x4a3a2a`、词牌底 `0xffffff` 圆角矩形（radius 12）＋`0x5a4a38` 文字。
**迁移注记**：现 `pixiStage.ts` 占位怪为遗留值（体 `drawCircle(0,0,46)` 蓝底＋`lineStyle width 5` 同色描边＋瞳/词牌文字 `0x3a3f4a`）——本票禁改该文件；票 11 换装时按本表替换为三怪参数组，`COLOR_INK 0x3a3f4a` 一并换 `0x5a4a38`（暖棕化收口）。

### 7.1 U2 情景图人物映射（票 18 几何 v2 定案）

样张 `src/assets/art/scenes/u2-my-classmates.svg`（900×560）四角色，头身比 ≈1:1.5；线稿/描边规范同 §7 表头（3px `0x7a5a3d` round cap/joint）。运行时 Graphics 等价（演出层引用依据）：

| 部位 | teacher（站姿·讲台侧） | boy / girl / me（坐姿·课桌后） |
|---|---|---|
| 头 | `drawCircle(292,296,34)` fill `0xf2d6b4` | `drawCircle(cx,369~370,r)`：boy r29 / girl·me r28；fill boy `0xf2d6b4` · girl `0xeed3b3` · me `0xf5dcc0` |
| 发型与成年感 | 短发帽色块 `0x4a3a2a`＋白 V 领线＋圆框眼镜 r7.5（成年感三件） | boy 短发帽＋顶翘双刺；girl 帽＋双侧马尾椭圆 rx11 ry13＋蛋黄发绳 r3.5；me 圆帽＋单翘（发色暖棕 `0x4a3a2a`，旧冷灰 `#3A3F4A` 已废） |
| 躯干 | `drawRoundedRect(258,326,68,78,24)` fill `0x5b9bb5` | `drawRoundedRect(cx-26~28,393,52~56,64~65,20~22)` fill boy `0x8fbe6e` · girl `0xe8764f` · me `0xf0c05a` |
| 手臂（连肩弧线，无圈手） | 棕描边底 width16＋衣色覆面 width11 同路径 Q 曲线：指黑板臂 `M270,336 Q246,332 230,308`；垂臂持书 `M314,338 Q330,366 326,400` | 同技法 width15/10：boy 举手臂 `M442,384 Q466,378 472,348`，余臂垂放扶桌（端点没入桌面线后） |
| 腿与鞋 | 裤腿 rounded rect 16×38 fill `0x4a3a2a`＋鞋 26×13 rx6.5 fill `0x356e88` | 腿 14×62 rx7 fill `0x6e4a2e`＋鞋 24×13 rx6 fill `0x7a5a3d`（桌下可见段） |
| 落地软阴影 | `drawEllipse(292,447,44,8)` fill `0x7a5a3d` α0.15 | 每桌一单元影 `drawEllipse(cx,549,100,8.5)` α0.13（罩桌腿＋鞋，角色随桌落地） |
| 家具 | 讲台独立左后：slab 120×20 rx10＋双腿 18×66（不再横穿人物） | 课桌一横排 ×3：slab 180×16 rx8＋双腿 15×80 rx7 垂直落地（脚线 y≈546） |

构图定案：黑板居中上方（x 255-585）、窗右上保留、四角色全落地（teacher 脚线 y≈443、课桌排脚线 y≈546）、地面轻细节限两件（散页纸＋蜡笔黄铅笔）。

**涂改圈柔化定案（票 18 两案择优）**：取 **A 案头肩小圈**——圆心 `(cx, 头cy+15)`、半径 ≈头r+18（teacher r52，其余 r46-47），`stroke-dasharray 10 8` 与 3.5px 暖棕描边**不变**，opacity 0.75→0.2；弃 B 案脚下舞台光圈（自检结论：坐姿脚下圈与桌组单元影同位重叠，读作第二层阴影且丢失「点名角色」热点语义）。名签 chip 压在圈上层属既定层序。量产热点坐标接词包配置。

## 8. 量产施工规则（一致性对冲，P-05「一致性最弱」的补偿）

1. 本圣经参数**锁死**：色板/滤镜/线宽/圆角不得按图微调；换 seed 除外（§4.4）。
2. 每张成稿对照色板校验（吸管比对 §2 表）；抽检率 ≥50%（风格卡同口径）。
3. 角色转面表：每怪三视图＋表情表先行，量产图引用转面表。
4. 资产体积预算：颗粒纹理压缩率差，全量 25-40 MB（风格卡估）——低端安卓实测归管线试点票。
5. AI 管线只做构图草稿，成稿手绘或滤镜渲染（AI 直出蜡笔颗粒稳定性最差，风格卡结论）。

## 9. 儿童红线自检（每批资产过一遍）

- [ ] 零外链：无网络字体/图库/CDN 引用；SVG 内无 `<image href="http…">`。
- [ ] 无血腥锐利元素（R8）；击中＝涂改圈擦除＋星星撒纸。
- [ ] 低饱和暖色系；无纯黑描边；无冷灰。
- [ ] 对比度：正文 4.5 / 大字 3 / 交互边界 3（§2 实测值即验收值）。
- [ ] 样张不进儿童主路径（预览页 dev-only：`/art-preview` 路由或 `?art=1` 参数，生产构建默认不可达）。
