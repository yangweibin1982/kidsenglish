/**
 * PixiJS 演出域适配器 v5（spec v1.6 S9 游戏吸引力重制，Ticket 32；P-13）。
 *
 * 相对 v4 的变化＝「从画形状到上资产」：
 *   - 角色全量 emoji sprite（Segoe UI Emoji/Noto Color Emoji 全平台内置，
 *     零版权职业美术，P-13 决策 1）：🚀 战机（-45° 扶正朝上）＋8 种怪兽池
 *     （👾👽😈👹🤡🦇🐙🦖 逐波轮换＝收集感）＋👑 Boss 王冠＋⭐ 子弹（自旋）
 *     ＋☄️ 弹幕雨＋💥✨ 爆炸＋⚡ 火力升级＋🎉 高连击；
 *   - juice：spawn 弹跳入场（easeOutBack overshoot）＋受击抖动＋击破星星
 *     （⭐ 从击破点飞入 HUD 计分区＋✨ 落袋——星星收集元循环，P-13 决策 2）
 *     ＋目标怪 ▼ 指示箭头（孩子看清打谁）；
 *   - 芯片音乐（P-13 决策 3）：battle-start 即尝试启动，首个用户手势
 *     （pointerdown/字母点击）重试接通，clear/unmount 停止；
 *   - 天空世界/布局/波次/Boss 调度/儿童红线语义承袭 v3/v4。
 *
 * 演出事件时序逐 ms 保持票 29/30 契约：letter-fire 零回报零扣血；每词恰一次
 * fire（串尾 870ms 落点伤害）；击破 FALL_MS 垫场后 spawnWave＋defeat 回报
 * （单测钉死）。挂载形态/S5 铁律/boot 队列/节流/可见性全部承袭。
 */

import { Application, BLEND_MODES, Container, Graphics, Text } from 'pixi.js';
import {
  REVIEW_WORDS_PER_BOSS,
  type StageBus,
  type StageCommand,
  type StageDriverHandle,
} from './stageContract';
import { sfxBeam, sfxBossWarn, sfxBoom, sfxCharge, sfxHit, sfxPowerUp, sfxShoot, startMusic, stopMusic } from './sfx';

/* 案 C 蜡笔绘本主色（P-05 定案，与 main.css --ke-* token 同值） */
const COLOR_SKY = 0x5b9bb5;
const COLOR_CORAL = 0xe8764f;
const COLOR_SUN = 0xf0c05a;
const COLOR_INK = 0x3a3f4a;

/** 天空渐变带两端（顶深→底浅） */
const SKY_TOP = 0x44789a;
const SKY_BOTTOM = 0xd9edf5;

/** 怪兽 emoji 池（8 种逐波轮换＝收集感；年龄适宜的呆萌怪兽向） */
const MONSTER_EMOJI: readonly string[] = ['👾', '👽', '😈', '👹', '🤡', '🦇', '🐙', '🦖'];
const BOSS_EMOJI = '🐲';
const CROWN_EMOJI = '👑';

const EMOJI_FONT = '"Segoe UI Emoji", "Noto Color Emoji", sans-serif';

const ENEMY_Y_MIN = 0.16; // 敌机巡场带上缘（vh 比例）
const ENEMY_Y_SPAN = 0.18;
const BOSS_Y_RATIO = 0.24;

/* 票 61 布局自适应：拼写 dock（.rv-dock，fixed 浮层）在手机竖屏随字母键
 * 换行而变高——巨人固定 vh-280 会被盖住。改为运行时测量 dock 顶边，
 * 巨人踩在 dock 上方 SAFE_GAP 处；测量不到回退旧净空（测试桩/极端 DOM）。 */
const DOCK_SELECTOR = '.rv-dock';
const DOCK_SAFE_GAP = 84; // 巨人脚底到 dock 顶边的净空（含能量光环）
const DOCK_FALLBACK_CLEAR = 280; // 回退净空（≈旧 FIGHTER_Y_RATIO 语义）
const DOCK_MIN_Y_RATIO = 0.42; // dock 高到离谱时巨人最低不越过敌人带

const ENEMY_FONT = 62; // 小怪字号
const COMPANION_FONT = 50; // 伴飞怪
const BOSS_FONT = 168; // Boss

const ENTRANCE_MS = 550;
const LETTER_BULLET_MS = 240;
const BULLET_TRAVEL_MS = 420;
const BULLET_GAP_MS = 90;
const BULLETS_PER_WORD = 6;
const EXPLOSION_MS = 500;
const FALL_MS = 700;
const BOSS_HP_MAX = 6;
const RAIN_INTERVAL_MS = 900;
const RAIN_FALL_MS = 1500;
const SHAKE_MS = 300;
const FLASH_MS = 240;
const POPUP_MS = 900;
const PARTICLE_MAX = 110;
const STAR_COUNT = 22;
const CLOUD_COUNT = 7;
const SKY_BANDS = 24;
const STAR_FLY_MS = 750; // 击破星星飞入计分区
const SCORE_CHIP_X_OFFSET = 150; // HUD 计分 chip 近似位（画布侧落袋点）

/* 票 59 光之巨人重制：登场凝聚/光矢/光波/打击感常量 */
const HERO_GATHER_MS = 2100; // 首战光点从四周凝聚成形的登场时长
const HERO_GATHER_COUNT = 56; // 凝聚光点数（四周散射）
const BEAM_CHARGE_MS = 380; // 光波蓄力（胸灯亮起）
const BEAM_FIRE_MS = 260; // 光波展开
const BEAM_FADE_MS = 340; // 光波收束
const HITSTOP_HIT_MS = 70; // 命中顿帧（时间变慢系数见 onTick）
const HITSTOP_DEFEAT_MS = 130; // 击破顿帧
const HITSTOP_SLOW = 0.06; // 顿帧期时间流速（0=全停太僵，慢 6% 有"砸中"感）
const SHAKE_POWER_HIT = 5; // 命中小震（px）
const SHAKE_POWER_DEFEAT = 11; // 击破大震（px）

/** 空闲停渲染延迟（capacitor#3899 缓解）。 */
const IDLE_STOP_DELAY_MS = 500;
/** 单帧步长上限。 */
const MAX_FRAME_MS = 100;

interface Tween {
  update(dtMs: number): boolean;
  finish(): void;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
/** easeOutBack（spawn 弹跳 overshoot）。 */
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

type BubbleHost = Container & { __bubble?: { bg: Graphics; text: Text } };

/** emoji 角色制作（anchor 居中）。 */
function makeEmoji(glyph: string, fontSize: number): Text {
  const t = new Text(glyph, {
    fontFamily: EMOJI_FONT,
    fontSize,
    fill: 0xffffff,
  });
  t.anchor.set(0.5);
  return t;
}

/**
 * emoji Canvas 渲染能力探测（票 59：真机「看不到飞机」定责——部分 Android
 * WebView 缺彩色 emoji 字体，Canvas Text 画 emoji 出空白；Windows 桌面一直
 * 正常所以从未暴露）。offscreen canvas 画 🚀 读 alpha 像素：全透明＝渲染失败。
 * 每次挂载探测一次；失败时角色/特效走矢量兜底（光之巨人本就矢量，不受影响）。
 */
function probeEmojiSupport(): boolean {
  try {
    const cv = document.createElement('canvas');
    cv.width = 32;
    cv.height = 32;
    const ctx = cv.getContext('2d');
    if (!ctx) return false;
    ctx.font = `24px ${EMOJI_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('🚀', 4, 16);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! > 8) return true; // 有非透明像素＝emoji 可渲染
    }
    return false;
  } catch {
    return false;
  }
}

/** 场上敌机（目标怪/伴飞怪/Boss 统一形状；词形永不进演出层）。 */
interface Enemy {
  c: Container;
  sprite: Container;
  hpBar: Graphics | null;
  crown: Container | null;
  hp: number;
  maxHp: number;
  isBoss: boolean;
  baseX: number;
  baseY: number;
  phase: number;
  age: number;
  removed: boolean;
}

/** 矢量兜底怪色池（emoji 不可渲染时按波次轮换，与 emoji 池同 8 变奏）。 */
const MONSTER_COLORS: readonly number[] = [0xa16bd4, 0x64b5a2, 0xd96a5a, 0xc75d7e, 0x5f8fd0, 0x8a76c9, 0x4aa5c4, 0x7fae4f];

interface Cloud {
  c: Container;
  speed: number;
}

export type StageUnmount = () => void;

/**
 * 挂载雷霆战机演出舞台（每个复习会话至多一个）。容器缺省取
 * #stage-canvas-root；容器缺失或 Pixi 初始化失败时经契约上报 stage-error
 * 并返回 no-op 卸载（考核层兜底推进，儿童不被卡死）。
 */
export async function mountShootingStage(bus: StageBus, container?: HTMLElement): Promise<StageUnmount> {
  const bootQueue: StageCommand[] = [];
  let booted = false;

  function emitError(message: string): void {
    handle.emit({ kind: 'stage-error', message });
  }

  function runCommand(cmd: StageCommand): void {
    try {
      handleCommand(cmd);
    } catch (err) {
      emitError(err instanceof Error ? err.message : String(err));
    }
  }

  const handle: StageDriverHandle = bus.attachDriver((cmd) => {
    if (!booted) {
      bootQueue.push(cmd);
      return;
    }
    runCommand(cmd);
  });

  const mountRoot: HTMLElement | null = container ?? document.getElementById('stage-canvas-root');
  if (!mountRoot) {
    emitError('stage-canvas-root 挂载点不存在（App.vue S5 兄弟节点缺失）');
    handle.detach();
    return () => undefined;
  }

  let app: Application;
  try {
    app = new Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: SKY_BOTTOM,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
  } catch (err) {
    emitError(`PixiJS 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
    handle.detach();
    return () => undefined;
  }

  const canvas = app.view as HTMLCanvasElement;
  canvas.style.pointerEvents = 'none';
  mountRoot.appendChild(canvas);

  /* ---------------- emoji 能力探测＋矢量兜底工厂（票 59） ---------------- */

  const emojiOk = probeEmojiSupport();

  /** 特效小星（emojiOk→✨/⭐；兜底→发光小圆点）。 */
  function makeSparkle(size: number): Container {
    if (emojiOk) return makeEmoji('✨', size);
    const g = new Graphics();
    g.beginFill(COLOR_SUN, 0.95).drawCircle(0, 0, size * 0.32).endFill();
    g.beginFill(0xffffff, 0.9).drawCircle(0, 0, size * 0.16).endFill();
    return g;
  }

  /** 击破星星（emojiOk→⭐；兜底→金菱形）。 */
  function makeStar(size: number): Container {
    if (emojiOk) return makeEmoji('⭐', size);
    const g = new Graphics();
    const r = size * 0.42;
    g.beginFill(COLOR_SUN)
      .drawPolygon([-r * 0.32, -r, r * 0.32, -r, r * 0.32, r, -r * 0.32, r])
      .endFill();
    g.beginFill(COLOR_SUN)
      .drawPolygon([-r, -r * 0.32, r, -r * 0.32, r, r * 0.32, -r, r * 0.32])
      .endFill();
    g.beginFill(0xfff3c4).drawCircle(0, 0, r * 0.34).endFill();
    return g;
  }

  /** 爆炸贴图（emojiOk→💥；兜底→矢量爆星：橙圆＋白芯＋碎刺）。 */
  function makeBoom(size: number): Container {
    if (emojiOk) return makeEmoji('💥', size);
    const g = new Graphics();
    const r = size * 0.5;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginFill(COLOR_CORAL, 0.9)
        .drawPolygon([
          Math.cos(a) * r * 0.55,
          Math.sin(a) * r * 0.55,
          Math.cos(a + 0.35) * r * 1.05,
          Math.sin(a + 0.35) * r * 1.05,
          Math.cos(a + 0.7) * r * 0.55,
          Math.sin(a + 0.7) * r * 0.55,
        ])
        .endFill();
    }
    g.beginFill(COLOR_SUN).drawCircle(0, 0, r * 0.62).endFill();
    g.beginFill(0xffffff).drawCircle(0, 0, r * 0.3).endFill();
    return g;
  }

  /** 王冠（emojiOk→👑；兜底→矢量三尖金冠）。 */
  function makeCrown(): Container {
    if (emojiOk) return makeEmoji(CROWN_EMOJI, 54);
    const g = new Graphics();
    g.beginFill(COLOR_SUN)
      .drawPolygon([-26, 14, -26, -10, -13, 2, 0, -16, 13, 2, 26, -10, 26, 14])
      .endFill();
    g.lineStyle({ width: 2, color: 0xb98a2a });
    g.drawPolygon([-26, 14, -26, -10, -13, 2, 0, -16, 13, 2, 26, -10, 26, 14]);
    g.lineStyle({ width: 0 });
    return g;
  }

  /**
   * 怪兽 sprite 工厂：emojiOk→池 emoji（现状）；兜底→矢量 Q 版小怪（圆体＋
   * 大眼＋角/触手，色池按 variant 轮换）——真机缺 emoji 字体时演出不空场。
   */
  function makeMonsterSprite(size: number, variant: number, boss: boolean): Container {
    if (emojiOk) return makeEmoji(boss ? BOSS_EMOJI : (MONSTER_EMOJI[variant % MONSTER_EMOJI.length] as string), size);
    const g = new Graphics();
    const r = size * (boss ? 0.34 : 0.4);
    const body = MONSTER_COLORS[variant % MONSTER_COLORS.length] as number;
    if (boss) {
      // Boss：大体型＋双角＋双翼＋腹甲弧纹
      g.beginFill(0x3f6f52, 0.9)
        .drawPolygon([-r * 1.35, -r * 0.2, -r * 0.7, -r * 0.5, -r * 0.62, r * 0.15])
        .endFill();
      g.beginFill(0x3f6f52, 0.9)
        .drawPolygon([r * 1.35, -r * 0.2, r * 0.7, -r * 0.5, r * 0.62, r * 0.15])
        .endFill();
    }
    g.beginFill(body).drawCircle(0, 0, r).endFill();
    g.lineStyle({ width: Math.max(3, r * 0.09), color: 0x3a3f4a, alpha: 0.55 });
    g.drawCircle(0, 0, r);
    g.lineStyle({ width: 0 });
    // 双角
    g.beginFill(0xf5efe2)
      .drawPolygon([-r * 0.52, -r * 0.7, -r * 0.28, -r * 1.18, -r * 0.14, -r * 0.66])
      .endFill()
      .drawPolygon([r * 0.52, -r * 0.7, r * 0.28, -r * 1.18, r * 0.14, -r * 0.66])
      .endFill();
    // 肚皮
    g.beginFill(0xffffff, 0.28).drawEllipse(0, r * 0.42, r * 0.55, r * 0.4).endFill();
    // 大眼（发光感＝白底＋深瞳＋高光）
    const eyeY = -r * 0.18;
    const eyeDx = r * 0.34;
    for (const sx of [-1, 1]) {
      g.beginFill(0xffffff).drawCircle(sx * eyeDx, eyeY, r * 0.22).endFill();
      g.beginFill(0x2b2f38).drawCircle(sx * eyeDx + sx * r * 0.05, eyeY, r * 0.11).endFill();
      g.beginFill(0xffffff).drawCircle(sx * eyeDx - r * 0.06, eyeY - r * 0.07, r * 0.05).endFill();
    }
    // 嘴（小弧＋两颗牙）
    g.beginFill(0x2b2f38).drawRoundedRect(-r * 0.3, r * 0.14, r * 0.6, r * 0.16, r * 0.08).endFill();
    g.beginFill(0xffffff)
      .drawPolygon([-r * 0.18, r * 0.14, -r * 0.1, r * 0.28, -r * 0.02, r * 0.14])
      .endFill()
      .drawPolygon([r * 0.02, r * 0.14, r * 0.1, r * 0.28, r * 0.18, r * 0.14])
      .endFill();
    return g;
  }

  /* ---------------- 渲染循环节流 ---------------- */

  let destroyed = false;
  let tickerRunning = false;
  let animCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const tweens: Tween[] = [];
  /** 演出时钟（缩放后 dt 累计；顿帧窗用它计时——测试/挂起恢复都自洽）。 */
  let stageClockMs = 0;
  /** 顿帧窗结束点（演出时钟意义）。 */
  let hitStopEndsAtMs = -1;
  /** 主角写面独占窗（演出时钟意义；票 61）：蓄力后仰/胜利跳/登场点亮期间
   * ambient 让位（y/rotation/chest/glow/cape 不写），后到覆盖＝演出丢帧。 */
  let heroHoldUntilMs = -1;
  function heroHold(ms: number): void {
    heroHoldUntilMs = Math.max(heroHoldUntilMs, stageClockMs + ms);
  }

  /** 打击感·顿帧：真实时间 ms 内全局减速（窗长按慢放系数换算成演出时间——
   * 慢速 6% 下真实 70ms 只对应 4.2ms 演出时间；仅演出层，考核计时不受影响）。
   */
  function hitStop(ms: number): void {
    hitStopEndsAtMs = Math.max(hitStopEndsAtMs, stageClockMs + ms * HITSTOP_SLOW);
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function ensureTicker(): void {
    if (destroyed) return;
    clearIdleTimer();
    if (!tickerRunning && !document.hidden) {
      app.ticker.start();
      tickerRunning = true;
    }
  }

  function scheduleIdleStop(): void {
    if (destroyed) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!destroyed && animCount <= 0 && tickerRunning && !document.hidden) {
        app.ticker.stop();
        tickerRunning = false;
      }
    }, IDLE_STOP_DELAY_MS);
  }

  function beginAnim(): void {
    animCount++;
    ensureTicker();
  }

  function endAnim(): void {
    animCount = Math.max(0, animCount - 1);
    if (animCount === 0) scheduleIdleStop();
  }

  function renderOnce(): void {
    if (!destroyed && !tickerRunning) app.render();
  }

  function addAnim(step: (dtMs: number) => boolean): void {
    beginAnim();
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        endAnim();
      }
    };
    tweens.push({
      update(dtMs: number): boolean {
        if (!finished && !step(dtMs)) finish();
        return finished;
      },
      finish,
    });
  }

  const onTick = (): void => {
    const rawDt = Math.min(app.ticker.deltaMS, MAX_FRAME_MS);
    // 打击感·顿帧（hit-stop）：命中/击破后短窗内时间变慢（慢 6% 流速），砸中感
    const dt = stageClockMs < hitStopEndsAtMs ? rawDt * HITSTOP_SLOW : rawDt;
    stageClockMs += dt;
    for (let i = tweens.length - 1; i >= 0; i--) {
      if (tweens[i].update(dt)) tweens.splice(i, 1);
    }
  };
  app.ticker.add(onTick);
  app.ticker.stop();
  tickerRunning = false;

  /* ---------------- 分层场景根 ---------------- */

  const root = new Container();
  app.stage.addChild(root);

  const bgLayer = new Container();
  const cloudLayer = new Container();
  root.addChild(bgLayer, cloudLayer);

  let vw = window.innerWidth;
  let vh = window.innerHeight;

  /* ---------------- 天空世界 ---------------- */

  let skyBuilt = false;
  /** 极光带/Boss 警报渐晕（buildSky 产出；onResize 重建后引用刷新）。 */
  let aurora: Graphics | null = null;
  let danger: Graphics | null = null;

  function lerpColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xff;
    const ag = (a >> 8) & 0xff;
    const ab = a & 0xff;
    const br = (b >> 16) & 0xff;
    const bg = (b >> 8) & 0xff;
    const bb = b & 0xff;
    return (Math.round(lerp(ar, br, t)) << 16) | (Math.round(lerp(ag, bg, t)) << 8) | Math.round(lerp(ab, bb, t));
  }

  function buildSky(): void {
    if (skyBuilt) return;
    skyBuilt = true;
    for (let i = 0; i < SKY_BANDS; i++) {
      const t = i / (SKY_BANDS - 1);
      const band = new Graphics();
      band.beginFill(lerpColor(SKY_TOP, SKY_BOTTOM, t));
      band.drawRect(0, (vh * i) / SKY_BANDS - 1, vw, vh / SKY_BANDS + 2);
      band.endFill();
      bgLayer.addChild(band);
    }
    const sun = new Graphics();
    const sx = vw - 120;
    const sy = 110;
    sun.beginFill(COLOR_SUN, 0.1).drawCircle(sx, sy, 96).endFill();
    sun.beginFill(COLOR_SUN, 0.16).drawCircle(sx, sy, 64).endFill();
    sun.beginFill(COLOR_SUN, 0.5).drawCircle(sx, sy, 36).endFill();
    sun.beginFill(0xffe9b8).drawCircle(sx, sy, 26).endFill();
    bgLayer.addChild(sun);
    // 极光带（票 61：两条大弧柔光带，ambient 缓慢平移＝天空活着）
    aurora = new Graphics();
    aurora.blendMode = BLEND_MODES.ADD;
    aurora.beginFill(0x8fe8c8, 0.14).drawEllipse(vw * 0.32, vh * 0.16, vw * 0.46, 34).endFill();
    aurora.beginFill(0x9fc0f0, 0.11).drawEllipse(vw * 0.62, vh * 0.24, vw * 0.4, 26).endFill();
    bgLayer.addChild(aurora);
    // 远山剪影两层（票 61：地平线层次；深浅拉开景深）
    const hillsFar = new Graphics();
    hillsFar.beginFill(0x6f9db4, 0.5)
      .drawPolygon([
        -40, vh, -40, vh * 0.78, vw * 0.14, vh * 0.66, vw * 0.3, vh * 0.76, vw * 0.46, vh * 0.62,
        vw * 0.62, vh * 0.75, vw * 0.8, vh * 0.65, vw + 40, vh * 0.74, vw + 40, vh,
      ])
      .endFill();
    bgLayer.addChild(hillsFar);
    const hillsNear = new Graphics();
    hillsNear.beginFill(0x54809a, 0.62)
      .drawPolygon([
        -40, vh, -40, vh * 0.88, vw * 0.18, vh * 0.8, vw * 0.4, vh * 0.9, vw * 0.58, vh * 0.79,
        vw * 0.78, vh * 0.88, vw + 40, vh * 0.81, vw + 40, vh,
      ])
      .endFill();
    bgLayer.addChild(hillsNear);
    for (let i = 0; i < STAR_COUNT; i++) {
      const g = new Graphics();
      const r = 1.2 + Math.random() * 1.8;
      g.beginFill(0xffffff, 0.28 + Math.random() * 0.3);
      g.drawCircle(0, 0, r);
      g.endFill();
      g.x = Math.random() * vw;
      g.y = Math.random() * vh * 0.45;
      bgLayer.addChild(g);
    }
    // Boss 战红色警报渐晕（票 61：Boss 在场时脉冲，root 内 dangerLayer 承载）
    danger = new Graphics();
    danger.visible = false;
    danger.beginFill(0xe04545, 0.1).drawRect(0, 0, vw, vh * 0.16).endFill();
    danger.beginFill(0xe04545, 0.06).drawRect(0, vh * 0.16, vw, vh * 0.14).endFill();
    danger.beginFill(0xe04545, 0.08).drawRect(0, vh * 0.62, vw, vh * 0.38).endFill();
    cloudLayer.addChild(danger);
  }

  const clouds: Cloud[] = [];

  function ensureClouds(): void {
    if (clouds.length > 0) return;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const c = new Container();
      const g = new Graphics();
      const big = i % 3 === 0;
      const s = big ? 1.25 : 0.85 + Math.random() * 0.3;
      g.beginFill(0xffffff, 0.82);
      g.drawCircle(-34 * s, 6 * s, 20 * s);
      g.drawCircle(0, -8 * s, 26 * s);
      g.drawCircle(32 * s, 6 * s, 19 * s);
      g.drawCircle(0, 10 * s, 22 * s);
      g.endFill();
      c.addChild(g);
      c.x = Math.random() * vw;
      c.y = Math.random() * vh;
      cloudLayer.addChild(c);
      clouds.push({ c, speed: big ? 46 : 18 + Math.random() * 20 });
    }
  }

  /* ---------------- 光之巨人（票 59 矢量绘制；票 61 精致化） ----------------
   * 造型＝通用「光之巨人」：银色身躯＋红纹＋胸灯＋发光眼＋披风（奥特曼类型
   * 核心特征，不复刻特定角色纹样——版权面留痕票 59）。全矢量＝零 emoji 字体
   * 依赖，根治部分 Android WebView 缺彩色 emoji 字体的「看不到飞机」。
   * 票 61 吸引力 pass：外发光轮廓＋披风（ambient 摆动）＋宽肩 V 躯干＋
   * 双层发光眼＋胸灯光环。 */

  const HERO_SILVER = 0xccd6e0;
  const HERO_SILVER_DARK = 0x8b9bb0;
  const HERO_RED = 0xd94848;
  const HERO_RED_DARK = 0xa83232;
  const HERO_CHEST = 0x7fe3ff;
  const HERO_EYE = 0xffe066;
  /** 手部炮口相对高度（光矢发射点）。 */
  const HERO_MUZZLE_DY = -22;
  /** 胸灯相对高度（光波发射点）。 */
  const HERO_CHEST_DY = -6;

  type FighterParts = { flame: Graphics; shield: Graphics; chest: Graphics; body: Graphics; glow: Graphics; cape: Graphics };
  const fighterParts: FighterParts = {
    flame: new Graphics(),
    shield: new Graphics(),
    chest: new Graphics(),
    body: new Graphics(),
    glow: new Graphics(),
    cape: new Graphics(),
  };

  function createFighter(): Container {
    const c = new Container();
    const { flame, shield, chest, body, glow, cape } = fighterParts;
    // 脚下能量光环（ambient 闪烁重绘）
    flame.alpha = 0.85;
    // 护盾光罩（弹幕雨命中闪烁；半径盖住巨人）
    shield.lineStyle({ width: 5, color: 0x9fd4ea, alpha: 0.95 });
    shield.drawCircle(0, -14, 56);
    shield.lineStyle({ width: 0 });
    shield.visible = false;
    // 外发光（票 61）：多层青蓝柔光轮廓（ambient 低频呼吸重绘）
    glow.blendMode = BLEND_MODES.ADD;
    // 披风（票 61）：身后红披风，ambient 摆动（rotation 写面独占）
    cape.beginFill(HERO_RED_DARK, 0.92)
      .drawPolygon([-26, -20, 0, -26, 26, -20, 34, 18, 20, 44, 0, 38, -20, 44, -34, 18])
      .endFill();
    cape.beginFill(HERO_RED, 0.55).drawPolygon([-20, -14, 0, -20, 20, -14, 26, 16, 0, 34, -26, 16]).endFill();
    cape.zIndex = -1;
    // 腿（两条短银柱＋膝甲）
    body.beginFill(HERO_SILVER_DARK)
      .drawRoundedRect(-16, 26, 12, 20, 6)
      .drawRoundedRect(4, 26, 12, 20, 6)
      .endFill();
    body.beginFill(HERO_SILVER).drawRoundedRect(-17, 24, 14, 8, 4).drawRoundedRect(3, 24, 14, 8, 4).endFill();
    // 躯干（票 61 宽肩 V 型银甲——英雄比例）
    body.beginFill(HERO_SILVER).drawPolygon([-30, -20, 30, -20, 20, 4, 12, 34, -12, 34, -20, 4]).endFill();
    body.lineStyle({ width: 2.5, color: HERO_SILVER_DARK, alpha: 0.7 });
    body.drawPolygon([-30, -20, 30, -20, 20, 4, 12, 34, -12, 34, -20, 4]);
    body.lineStyle({ width: 0 });
    // 腹肌阴影（立体感）
    body.beginFill(HERO_SILVER_DARK, 0.35).drawRoundedRect(-9, 8, 18, 20, 6).endFill();
    // 红纹（肩带双斜纹＋胸口 V 带——通用光之巨人纹路面）
    body.beginFill(HERO_RED)
      .drawPolygon([-30, -16, -12, -22, -12, -8, -30, 0])
      .endFill()
      .drawPolygon([30, -16, 12, -22, 12, -8, 30, 0])
      .endFill();
    // 手臂（左右斜置＋拳；宽肩下外扩）
    body.beginFill(HERO_SILVER)
      .drawRoundedRect(-38, -16, 13, 36, 6)
      .drawRoundedRect(25, -16, 13, 36, 6)
      .endFill();
    body.beginFill(HERO_RED).drawCircle(-31, 23, 8).drawCircle(31, 23, 8).endFill();
    // 头（银色椭圆＋锐头冠脊）
    body.beginFill(HERO_SILVER).drawEllipse(0, -34, 15, 17).endFill();
    body.beginFill(HERO_SILVER_DARK).drawPolygon([-3.5, -52, 3.5, -52, 2.5, -40, -2.5, -40]).endFill();
    // 发光眼（票 61 双层：外圈光晕＋内芯，横长椭圆——奥特曼类型核心特征）
    body.beginFill(HERO_EYE, 0.4).drawEllipse(-7, -36, 8.5, 4.5).drawEllipse(7, -36, 8.5, 4.5).endFill();
    body.beginFill(HERO_EYE).drawEllipse(-7, -36, 6, 2.6).drawEllipse(7, -36, 6, 2.6).endFill();
    body.beginFill(0xfff8d8).drawEllipse(-7, -36.6, 3.4, 1.3).drawEllipse(7, -36.6, 3.4, 1.3).endFill();
    // 胸灯（光波蓄力/发射的可视能量核；亮度由 chest 层叠加）
    body.beginFill(0xffffff).drawCircle(0, HERO_CHEST_DY, 6.5).endFill();
    chest.beginFill(HERO_CHEST, 0.95).drawCircle(0, HERO_CHEST_DY, 5).endFill();
    chest.beginFill(0xffffff, 0.9).drawCircle(0, HERO_CHEST_DY, 2.4).endFill();
    // 胸灯光环（票 61：常驻微光环，蓄力时随 chest 层同亮）
    chest.lineStyle({ width: 2.5, color: HERO_CHEST, alpha: 0.5 });
    chest.drawCircle(0, HERO_CHEST_DY, 11);
    chest.lineStyle({ width: 0 });
    c.addChild(cape, glow, flame, body, chest, shield);
    return c;
  }

  const fighter = createFighter();
  root.addChild(fighter); // v4 教训：场景图重写必检上屏
  const fighterX = { target: vw / 2 };

  /** 巨人基准位（票 61）：测量拼写 dock 顶边动态避让——手机竖屏 dock 变高时
   * 巨人自动上移；桌面 dock 矮≈旧 vh-280 语义。可选链兼容测试 DOM shim。 */
  function fighterBaseY(): number {
    let clear = DOCK_FALLBACK_CLEAR;
    const dock = document.querySelector?.(DOCK_SELECTOR) as HTMLElement | null | undefined;
    if (dock) {
      const top = dock.getBoundingClientRect().top;
      if (top > 0) clear = vh - top + DOCK_SAFE_GAP;
    }
    return Math.min(vh - DOCK_FALLBACK_CLEAR * 0.5, Math.max(vh * DOCK_MIN_Y_RATIO, vh - clear));
  }

  function layout(): void {
    fighter.y = fighterBaseY();
    fighterX.target = Math.min(Math.max(fighterX.target, 50), vw - 50);
  }

  /** 首个用户手势接通音乐（自动播放策略：battle-start 的首次尝试常挂起）。 */
  function ensureMusic(): void {
    if (battleActive) startMusic();
  }

  function onPointer(e: PointerEvent): void {
    if (!battleActive) return;
    fighterX.target = Math.min(Math.max(e.clientX, 50), vw - 50);
    ensureMusic();
  }
  window.addEventListener('pointerdown', onPointer);
  window.addEventListener('pointermove', onPointer);

  /* ---------------- 敌机（emoji sprite＋分段血条＋Boss 王冠） ---------------- */

  let battleActive = false;
  let totalWords = 0;
  let firesDone = 0;
  let waveIndex = 0;
  /** 光之巨人已登场（每场战斗首波凝聚成形后置位；clearScene 新战局复位）。 */
  let heroBorn = false;
  let target: Enemy | null = null;
  const companions: Enemy[] = [];
  let currentTargetId: string | null = null;
  const bullets: Container[] = [];
  const blasts: Container[] = [];
  const particles: Container[] = [];
  let bossRainAge = 0;
  let exhaustAcc = 0;

  /** 目标怪指示箭头（▼ 弹跳；load-word 时移到当前目标头顶；基准值驱动防漂移）。 */
  const targetMarker = new Graphics();
  targetMarker.beginFill(COLOR_SUN).drawPolygon([-14, 0, 14, 0, 0, 16]).endFill();
  targetMarker.visible = false;
  root.addChild(targetMarker);
  let markerBaseY = -60;

  function makeBubble(c: BubbleHost): void {
    const bubbleBg = new Graphics();
    bubbleBg.visible = false;
    const bubbleText = new Text('', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 24,
      fontWeight: '800',
      fill: COLOR_INK,
      wordWrap: true,
      wordWrapWidth: 210,
      breakWords: true,
    });
    bubbleText.anchor.set(0.5);
    bubbleText.visible = false;
    c.addChild(bubbleBg, bubbleText);
    c.__bubble = { bg: bubbleBg, text: bubbleText };
  }

  /** 分段血条（局部坐标：sprite 头顶；受击重绘递减）。 */
  function drawHpBar(g: Graphics, hp: number, maxHp: number, isBoss: boolean, topY: number): void {
    g.clear();
    const segW = isBoss ? 34 : 26;
    const totalW = segW * maxHp + (maxHp - 1) * 6;
    for (let i = 0; i < maxHp; i++) {
      g.beginFill(i < hp ? COLOR_CORAL : 0xe8e2d6);
      g.drawRoundedRect(-totalW / 2 + i * (segW + 6), topY, segW, isBoss ? 14 : 10, 4);
      g.endFill();
    }
  }

  function removeEnemy(e: Enemy | null, fromCompanions: boolean): void {
    if (!e || e.removed) return;
    e.removed = true;
    if (e.isBoss && danger) danger.visible = false; // Boss 警报渐晕随 Boss 退场（票 61）
    if (target === e) {
      target = null;
      targetMarker.visible = false;
    }
    // targetMarker 是跨波共享节点，setMeaning 时会挂进敌机容器；
    // 不摘除会被 destroy({children:true}) 连坐销毁，下一波复用即每帧抛错断演出链。
    if (targetMarker.parent === e.c) e.c.removeChild(targetMarker);
    root.removeChild(e.c);
    e.c.destroy({ children: true });
    if (fromCompanions) {
      const i = companions.indexOf(e);
      if (i >= 0) companions.splice(i, 1);
    }
  }

  /** 入场（下落＋easeOutBack 弹跳）＋双频游荡＋生动摆动。 */
  function animateEnemy(e: Enemy, entranceDelayMs: number): void {
    e.c.alpha = 0;
    let age = -entranceDelayMs;
    addAnim((dt) => {
      if (e.removed) return false;
      age += dt;
      e.age = Math.max(0, age);
      if (age < 0) return true;
      const t = Math.min(1, age / ENTRANCE_MS);
      e.c.alpha = Math.min(1, t * 2);
      e.c.y = lerp(-80, e.baseY, easeOutCubic(t));
      if (t < 1) {
        const s = Math.max(0.05, easeOutBack(t)); // 弹跳 overshoot（入场期独占 scale 写面）
        e.c.scale.set(s, s);
        return true;
      }
      e.phase += (dt / (e.isBoss ? 5200 : 3400)) * Math.PI * 2;
      const ampX = e.isBoss ? 90 : target === e ? 46 : 72;
      e.c.x = e.baseX + Math.sin(e.phase) * ampX + Math.sin(e.phase * 0.37) * ampX * 0.3;
      e.c.y = e.baseY + Math.cos(e.phase * 0.8) * ampX * 0.22;
      e.c.rotation = Math.sin(e.age * 0.004) * 0.06;
      return true;
    });
  }

  /** 出一波敌机：每第 BOSS_PERIOD 词出 Boss（👑🐲），否则池中小怪＋2 伴飞。 */
  function spawnWave(): void {
    removeEnemy(target, false);
    for (const c of companions.splice(0, companions.length)) removeEnemy(c, false);
    target = null;
    targetMarker.visible = false;
    currentTargetId = null;
    if (!battleActive) return;

    const nextWordIndex = firesDone + 1;
    const isBossWave = nextWordIndex % REVIEW_WORDS_PER_BOSS === 0;
    waveIndex += 1;

    if (isBossWave) {
      const hp = Math.max(1, Math.min(BOSS_HP_MAX, totalWords - firesDone));
      const hpBar = new Graphics();
      const crown = makeCrown();
      drawHpBar(hpBar, hp, hp, true, -BOSS_FONT * 0.62);
      crown.x = BOSS_FONT * 0.12; // 冠戴角侧
      crown.y = -BOSS_FONT * 0.66;
      const e: Enemy = {
        c: new Container() as BubbleHost,
        sprite: makeMonsterSprite(BOSS_FONT, waveIndex, true),
        hpBar,
        crown,
        hp,
        maxHp: hp,
        isBoss: true,
        baseX: vw / 2,
        baseY: vh * BOSS_Y_RATIO,
        phase: Math.random() * Math.PI * 2,
        age: 0,
        removed: false,
      };
      makeBubble(e.c as BubbleHost);
      e.c.addChild(e.sprite, hpBar, crown);
      if (danger) danger.visible = true; // Boss 警报渐晕起（票 61）
      target = e;
      root.addChild(e.c);
      animateEnemy(e, 0);
      bossWarnBanner();
      sfxBossWarn();
      startBossRain(e);
    } else {
      const hpBar = new Graphics();
      drawHpBar(hpBar, 1, 1, false, -ENEMY_FONT * 0.68);
      const e: Enemy = {
        c: new Container() as BubbleHost,
        sprite: makeMonsterSprite(ENEMY_FONT, waveIndex - 1, false),
        hpBar,
        crown: null,
        hp: 1,
        maxHp: 1,
        isBoss: false,
        baseX: vw * (0.32 + Math.random() * 0.36),
        baseY: vh * (ENEMY_Y_MIN + Math.random() * ENEMY_Y_SPAN),
        phase: Math.random() * Math.PI * 2,
        age: 0,
        removed: false,
      };
      makeBubble(e.c as BubbleHost);
      e.c.addChild(e.sprite, hpBar);
      target = e;
      root.addChild(e.c);
      animateEnemy(e, 0);
      for (let i = 0; i < 2; i++) {
        const cp: Enemy = {
          c: new Container(),
          sprite: makeMonsterSprite(COMPANION_FONT, waveIndex + i + 2, false),
          hpBar: null,
          crown: null,
          hp: 0,
          maxHp: 0,
          isBoss: false,
          baseX: vw * (i === 0 ? 0.15 : 0.85),
          baseY: vh * (ENEMY_Y_MIN + ENEMY_Y_SPAN * (i === 0 ? 0.4 : 0.8)),
          phase: Math.random() * Math.PI * 2,
          age: 0,
          removed: false,
        };
        cp.c.addChild(cp.sprite);
        cp.c.alpha = 0.95;
        companions.push(cp);
        root.addChild(cp.c);
        animateEnemy(cp, 140 + i * 160);
      }
    }
    renderOnce();
  }

  function setMeaning(meaning: string): void {
    const e = target;
    if (!e || e.removed) return;
    const c = e.c as BubbleHost;
    if (!c.__bubble) return;
    // 目标指示箭头钉到当前目标头顶（弹跳由 ambient 驱动）
    markerBaseY = (e.isBoss ? -BOSS_FONT * 0.86 : -ENEMY_FONT * 0.86 - 14) - 10;
    targetMarker.visible = true;
    targetMarker.x = 0;
    targetMarker.y = markerBaseY;
    e.c.addChild(targetMarker);
    const { bg, text } = c.__bubble;
    text.text = meaning;
    bg.clear();
    if (meaning.length === 0) {
      bg.visible = false;
      text.visible = false;
      return;
    }
    bg.visible = true;
    text.visible = true;
    const w = Math.max(76, Math.min(240, text.width + 30));
    const h = Math.max(40, text.height + 20);
    const bubbleY = e.isBoss ? BOSS_FONT * 0.5 : ENEMY_FONT * 0.52;
    bg.lineStyle({ width: 4, color: COLOR_SKY });
    bg.beginFill(0xffffff);
    bg.drawRoundedRect(-w / 2, bubbleY, w, h, 14);
    bg.endFill();
    bg.lineStyle({ width: 0 });
    bg.beginFill(0xffffff).drawPolygon([-8, bubbleY + 1, 8, bubbleY + 1, 0, bubbleY - 12]).endFill();
    text.position.set(0, bubbleY + h / 2 + 1);
  }

  /** Boss 来袭横幅（抖动三拍）。 */
  function bossWarnBanner(): void {
    const t = new Text('⚠ BOSS 来袭', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 40,
      fontWeight: '900',
      fill: 0xffffff,
      stroke: COLOR_CORAL,
      strokeThickness: 8,
    });
    t.anchor.set(0.5);
    t.position.set(vw / 2, vh * 0.42);
    root.addChild(t);
    let age = 0;
    addAnim((dt) => {
      age += dt;
      const p = age / 1300;
      t.y = vh * 0.42 + Math.sin(p * Math.PI * 3) * 10;
      t.alpha = p < 0.12 ? p / 0.12 : 1 - Math.max(0, (p - 0.7) / 0.3);
      if (p >= 1) {
        root.removeChild(t);
        t.destroy();
        return false;
      }
      return true;
    });
  }

  /** Boss 弹幕雨（☄️；命中战机＝护盾闪烁，无惩罚——儿童红线）。 */
  function startBossRain(boss: Enemy): void {
    bossRainAge = 0;
    addAnim((dt) => {
      if (!battleActive || boss.removed) return false;
      bossRainAge += dt;
      if (bossRainAge >= RAIN_INTERVAL_MS) {
        bossRainAge = 0;
        for (let i = 0; i < 3; i++) {
          spawnRainDrop(boss.c.x + (i - 1) * 48, boss.c.y + 44);
        }
      }
      return true;
    });
  }

  function spawnRainDrop(x: number, y: number): void {
    // 弹幕雨滴：emojiOk→☄️；兜底→紫色矢量流星（小三角尾）
    let b: Container;
    if (emojiOk) {
      b = makeEmoji('☄️', 26);
    } else {
      const g = new Graphics();
      g.beginFill(0x9a6ad8).drawCircle(0, 0, 8).endFill();
      g.beginFill(0xc39ae8, 0.8).drawPolygon([2, -4, 20, -18, 8, 2]).endFill();
      b = g;
    }
    b.rotation = Math.PI / 6;
    b.x = x;
    b.y = y;
    root.addChild(b);
    bullets.push(b);
    let age = 0;
    addAnim((dt) => {
      if (destroyed) return false;
      age += dt;
      b.y = y + (fighter.y - y) * (age / RAIN_FALL_MS);
      if (Math.abs(b.x - fighter.x) < 48 && Math.abs(b.y - fighter.y) < 34) {
        shieldFlash();
        removeBullet(b);
        return false;
      }
      if (age >= RAIN_FALL_MS) {
        removeBullet(b);
        return false;
      }
      return true;
    });
  }

  let shieldBusy = false;
  function shieldFlash(): void {
    if (shieldBusy) return;
    const { shield } = fighterParts;
    shieldBusy = true;
    shield.visible = true;
    let age = 0;
    addAnim((dt) => {
      age += dt;
      shield.alpha = Math.max(0, 0.95 * (1 - age / 320));
      if (age >= 320) {
        shield.visible = false;
        shield.alpha = 0.95;
        shieldBusy = false;
        return false;
      }
      return true;
    });
  }

  /* ---------------- 子弹 / 爆炸 / 粒子 / 浮字 / 震屏 ---------------- */

  function removeBullet(b: Container): void {
    const i = bullets.indexOf(b);
    if (i >= 0) bullets.splice(i, 1);
    root.removeChild(b);
    b.destroy();
  }

  function removeBlast(b: Container): void {
    const i = blasts.indexOf(b);
    if (i >= 0) blasts.splice(i, 1);
    root.removeChild(b);
    b.destroy();
  }

  function removeParticle(p: Container): void {
    const i = particles.indexOf(p);
    if (i >= 0) particles.splice(i, 1);
    root.removeChild(p);
    p.destroy();
  }

  /** 击破冲击波：扩散环（保留图形环承担体积感）。 */
  function explode(x: number, y: number, scale = 1): void {
    const g = new Graphics();
    g.position.set(x, y);
    root.addChild(g);
    blasts.push(g);
    let elapsed = 0;
    addAnim((dt) => {
      elapsed += dt;
      const t = Math.min(1, elapsed / EXPLOSION_MS);
      g.clear();
      g.lineStyle({ width: 8 * scale * (1 - t) + 1, color: COLOR_SUN, alpha: 1 - t });
      g.drawCircle(0, 0, (10 + 64 * t) * scale);
      g.beginFill(0xffffff, (1 - t) * 0.9).drawCircle(0, 0, (6 + 22 * t) * scale).endFill();
      if (t >= 1) {
        removeBlast(g);
        return false;
      }
      return true;
    });
  }

  /** 💥 爆炸贴图（scale pop）。 */
  function boomSticker(x: number, y: number, scale: number): void {
    const b = makeBoom(60);
    b.x = x;
    b.y = y;
    root.addChild(b);
    blasts.push(b);
    let age = 0;
    addAnim((dt) => {
      age += dt;
      const t = Math.min(1, age / 360);
      const s = scale * (0.4 + 0.8 * easeOutCubic(t));
      b.scale.set(s, s);
      b.alpha = 1 - t;
      b.rotation = (Math.random() - 0.5) * 0.2;
      if (t >= 1) {
        removeBlast(b);
        return false;
      }
      return true;
    });
  }

  /** 碎片粒子＋✨ 星尘＋烟雾（池上限护栏）。 */
  function spawnParticles(x: number, y: number, count: number): void {
    for (let i = 0; i < count && particles.length < PARTICLE_MAX; i++) {
      const sparkle = i % 4 === 3;
      const p: Container = sparkle
        ? makeSparkle(18 + Math.random() * 10)
        : (() => {
            const g = new Graphics();
            if (i % 3 === 2) {
              g.beginFill(0x9aa5ad, 0.55).drawCircle(0, 0, 7 + Math.random() * 6).endFill();
            } else {
              const r = 3 + Math.random() * 4;
              g.beginFill(i % 2 === 0 ? COLOR_SUN : COLOR_CORAL).drawCircle(0, 0, r).endFill();
              g.beginFill(0xffffff, 0.4).drawCircle(-r * 0.3, -r * 0.3, r * 0.3).endFill();
            }
            return g;
          })();
      p.x = x;
      p.y = y;
      root.addChild(p);
      particles.push(p);
      const ang = Math.random() * Math.PI * 2;
      const speed = sparkle ? 90 + Math.random() * 120 : 60 + Math.random() * 240;
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed - (sparkle ? 60 : 90);
      const life = sparkle ? 800 : 560 + Math.random() * 340;
      let age = 0;
      addAnim((dt) => {
        age += dt;
        const t = age / life;
        p.x += (vx * dt) / 1000;
        p.y += ((vy + 420 * (age / 1000)) * dt) / 1000;
        p.alpha = Math.max(0, 1 - t);
        if (t >= 1) {
          removeParticle(p);
          return false;
        }
        return true;
      });
    }
  }

  /** 击破星星：⭐ 从击破点飞入 HUD 计分区（收集元循环视觉）。 */
  function flyStarToScore(fromX: number, fromY: number): void {
    const star = makeStar(34);
    star.x = fromX;
    star.y = fromY;
    root.addChild(star);
    const tx = vw - SCORE_CHIP_X_OFFSET;
    const ty = 44;
    let age = 0;
    addAnim((dt) => {
      age += dt;
      const t = Math.min(1, age / STAR_FLY_MS);
      const k = t * t; // ease-in 抓取感
      star.x = lerp(fromX, tx, k);
      star.y = lerp(fromY, ty, k) - Math.sin(t * Math.PI) * 60; // 上抛弧线
      const s = lerp(1, 0.4, t);
      star.scale.set(s, s);
      if (t >= 1) {
        root.removeChild(star);
        star.destroy();
        // 落袋 sparkle
        const puff = makeSparkle(22);
        puff.x = tx;
        puff.y = ty;
        root.addChild(puff);
        let puffAge = 0;
        addAnim((pdt) => {
          puffAge += pdt;
          puff.alpha = Math.max(0, 1 - puffAge / 260);
          puff.y = ty - puffAge * 0.05;
          if (puffAge >= 260) {
            root.removeChild(puff);
            puff.destroy();
            return false;
          }
          return true;
        });
        return false;
      }
      return true;
    });
  }

  /** 浮字（连击/得分；scale 弹跳起手）。 */
  function popup(x: number, y: number, text: string, color: number, fontSize: number): void {
    const c = new Text(text, {
      fontFamily: 'system-ui, sans-serif',
      fontSize,
      fontWeight: '900',
      fill: color,
      stroke: 0xffffff,
      strokeThickness: 5,
    });
    c.anchor.set(0.5);
    c.position.set(x, y);
    root.addChild(c);
    let age = 0;
    addAnim((dt) => {
      age += dt;
      const t = age / POPUP_MS;
      const pop = t < 0.18 ? 1 + 0.4 * Math.sin((t / 0.18) * Math.PI) : 1;
      c.scale.set(pop, pop);
      c.y = y - 52 * easeOutCubic(Math.min(1, t));
      c.alpha = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
      if (t >= 1) {
        root.removeChild(c);
        c.destroy();
        return false;
      }
      return true;
    });
  }

  function screenFlash(): void {
    const g = new Graphics();
    g.beginFill(0xffffff, 0.5);
    g.drawRect(0, 0, vw, vh);
    g.endFill();
    root.addChild(g);
    let age = 0;
    addAnim((dt) => {
      age += dt;
      g.alpha = Math.max(0, 1 - age / FLASH_MS);
      if (age >= FLASH_MS) {
        root.removeChild(g);
        g.destroy();
        return false;
      }
      return true;
    });
  }

  /** 震屏（幅度分级：命中小震/击破大震；衰减正弦）。 */
  function shake(power = SHAKE_POWER_HIT): void {
    let age = 0;
    addAnim((dt) => {
      age += dt;
      const t = age / SHAKE_MS;
      root.x = Math.sin(age * 0.09) * power * (1 - t);
      root.y = Math.cos(age * 0.11) * power * 0.75 * (1 - t);
      if (t >= 1) {
        root.x = 0;
        root.y = 0;
        return false;
      }
      return true;
    });
  }

  /* ---------------- 开火链路 ---------------- */

  function muzzleFlash(): void {
    const g = new Graphics();
    g.beginFill(HERO_CHEST, 0.85).drawCircle(0, 0, 12).endFill();
    g.beginFill(COLOR_SUN, 0.9).drawCircle(0, 0, 9).endFill();
    g.beginFill(0xffffff, 0.95).drawCircle(0, 0, 5).endFill();
    g.x = fighter.x;
    g.y = fighter.y + HERO_MUZZLE_DY;
    root.addChild(g);
    let age = 0;
    addAnim((dt) => {
      age += dt;
      g.alpha = Math.max(0, 1 - age / 70);
      if (age >= 70) {
        root.removeChild(g);
        g.destroy();
        return false;
      }
      return true;
    });
  }

  /** 光矢弹（票 59 矢量化：金白菱形弹体＋尾光；core=蓄能加大弹）。 */
  function makeBullet(core: boolean): Container {
    const g = new Graphics();
    const L = core ? 30 : 22;
    const W = core ? 9 : 6.5;
    g.beginFill(0xffd977, 0.55).drawPolygon([-W, 0, 0, -W * 0.9, W, 0, 0, L]).endFill();
    g.beginFill(COLOR_SUN).drawPolygon([-W * 0.7, 0, 0, -L, W * 0.7, 0, 0, L * 0.9]).endFill();
    g.beginFill(0xffffff).drawPolygon([-W * 0.32, 0, 0, -L * 0.8, W * 0.32, 0, 0, L * 0.6]).endFill();
    return g;
  }

  /** 字母级弹幕：每拼对一个字母一发（不扣血、零回报——纯反馈密度）。 */
  function letterFire(targetId: string): void {
    const e = target;
    if (!e || e.removed || currentTargetId !== targetId) return;
    ensureMusic(); // 首字母点击＝首个可靠手势：接通音乐
    const b = makeBullet(false);
    b.visible = false;
    b.x = fighter.x;
    b.y = fighter.y + HERO_MUZZLE_DY;
    root.addChild(b);
    bullets.push(b);
    muzzleFlash();
    sfxShoot();
    let elapsed = 0;
    let launched = false;
    let tx = 0;
    let ty = 0;
    addAnim((dt) => {
      if (e.removed) {
        removeBullet(b);
        return false;
      }
      elapsed += dt;
      // 尾光摆动（定向光矢不做自旋）
      b.rotation = Math.sin(elapsed * 0.04) * 0.12;
      if (!launched) {
        launched = true;
        b.visible = true;
        tx = e.c.x;
        ty = e.c.y + 6;
      }
      const t = Math.min(1, elapsed / LETTER_BULLET_MS);
      const k = t * t;
      b.x = lerp(fighter.x, tx, k);
      b.y = lerp(fighter.y + HERO_MUZZLE_DY, ty, k);
      if (t >= 1) {
        removeBullet(b);
        explode(tx, ty, 0.5);
        spawnParticles(tx, ty, 3);
        shake(SHAKE_POWER_HIT);
        return false;
      }
      return true;
    });
  }

  /** 每词恰一次 fire：武器列形 Lv1 单列/Lv2 双列/Lv3 三列＋主炮 🔥。 */
  function fireBurst(cmd: Extract<StageCommand, { kind: 'fire' }>): void {
    const e = target;
    if (!e || e.removed || currentTargetId !== cmd.targetId) {
      handle.emit({ kind: 'performance-complete', targetId: cmd.targetId, outcome: 'hit' });
      return;
    }
    const streams = cmd.weaponLevel >= 3 ? [-30, 0, 30] : cmd.weaponLevel === 2 ? [-17, 17] : [0];
    muzzleFlash();
    for (let i = 0; i < BULLETS_PER_WORD; i++) {
      const isLast = i === BULLETS_PER_WORD - 1;
      const core = cmd.weaponLevel >= 3 && i % 3 === 1;
      const bullet = makeBullet(core);
      bullet.visible = false;
      bullet.x = fighter.x;
      bullet.y = fighter.y + HERO_MUZZLE_DY;
      root.addChild(bullet);
      bullets.push(bullet);
      const delayMs = i * BULLET_GAP_MS;
      const offsetX = streams[i % streams.length]!;
      let elapsed = 0;
      let launched = false;
      let tx = 0;
      let ty = 0;
      addAnim((dt) => {
        if (e.removed) {
          removeBullet(bullet);
          return false;
        }
        elapsed += dt;
        bullet.rotation = Math.sin(elapsed * 0.04) * 0.1;
        if (elapsed < delayMs) return true;
        if (!launched) {
          launched = true;
          bullet.visible = true;
          tx = e.c.x + offsetX;
          ty = e.c.y + 6;
        }
        const t = Math.min(1, (elapsed - delayMs) / BULLET_TRAVEL_MS);
        const k = t * t;
        bullet.x = lerp(fighter.x + offsetX * 0.4, tx, k);
        bullet.y = lerp(fighter.y + HERO_MUZZLE_DY, ty, k);
        if (t >= 1) {
          removeBullet(bullet);
          explode(tx, ty, core ? 0.8 : 0.55);
          spawnParticles(tx, ty, core ? 5 : 3);
          if (isLast) {
            damageTarget(cmd);
          } else {
            shake(SHAKE_POWER_HIT);
          }
          return false;
        }
        return true;
      });
    }
  }

  /** 光波击破前置演出：胸灯蓄力（BEAM_CHARGE_MS）→ 双手收拢 → 金色宽幅光波
   * 贯穿怪兽 → 爆碎交给 defeatSequence。用户指定演出链（票 59）：打击感＝
   * 顿帧＋大震＋白闪＋光波贯穿。 */
  function beamThenDefeat(e: Enemy, cmd: Extract<StageCommand, { kind: 'fire' }>): void {
    const { chest } = fighterParts;
    heroHold(BEAM_CHARGE_MS + BEAM_FIRE_MS + BEAM_FADE_MS + 620); // 蓄力→光波→胜利跳全程 ambient 让位（票 61）
    sfxCharge();
    // 蓄力：胸灯增亮脉冲＋巨人微微后仰蓄势
    let chargeAge = 0;
    addAnim((dt) => {
      chargeAge += dt;
      const t = Math.min(1, chargeAge / BEAM_CHARGE_MS);
      chest.scale.set(1 + 1.3 * t, 1 + 1.3 * t);
      chest.alpha = 0.7 + 0.3 * t;
      fighter.rotation = -0.06 * t;
      return t < 1;
    });
    setTimeoutStageSafe(() => {
      if (destroyed) return;
      const cx = e.c.x;
      const cy = e.c.y;
      const sx = fighter.x;
      const sy = fighter.y + HERO_CHEST_DY;
      chest.scale.set(2.4, 2.4); // 发射瞬间胸灯最亮
      // 光波束：从胸口到怪兽点的宽幅金白光带（展开→持续→收束）
      const beam = new Graphics();
      const len = Math.hypot(cx - sx, cy - sy);
      beam.position.set(sx, sy);
      beam.rotation = Math.atan2(cy - sy, cx - sx);
      root.addChild(beam);
      blasts.push(beam);
      let beamAge = 0;
      addAnim((dt) => {
        beamAge += dt;
        const grow = Math.min(1, beamAge / BEAM_FIRE_MS);
        const fade = beamAge < BEAM_FIRE_MS + BEAM_FADE_MS ? 1 : 1 - (beamAge - BEAM_FIRE_MS - BEAM_FADE_MS) / BEAM_FADE_MS;
        const w = 26 * easeOutCubic(grow);
        beam.clear();
        beam.beginFill(COLOR_SUN, 0.55 * Math.max(0, fade)).drawRect(0, -w * 0.85, len, w * 1.7).endFill();
        beam.beginFill(0xffe28a, 0.9 * Math.max(0, fade)).drawRect(0, -w * 0.5, len, w).endFill();
        beam.beginFill(0xffffff, Math.max(0, fade)).drawRect(0, -w * 0.2, len, w * 0.4).endFill();
        // 光波末端脉动粒子
        if (Math.random() < 0.5 && particles.length < PARTICLE_MAX) spawnParticles(cx, cy, 1);
        if (beamAge >= BEAM_FIRE_MS + BEAM_FADE_MS) {
          removeBlast(beam);
          return false;
        }
        return true;
      });
      // 打击感：击破顿帧＋大震＋白闪（光波命中瞬间）
      hitStop(HITSTOP_DEFEAT_MS);
      shake(SHAKE_POWER_DEFEAT);
      screenFlash();
      sfxBeam();
      // 怪兽被光波钉住抖动一拍，随后爆碎
      let pinAge = 0;
      addAnim((dt) => {
        if (e.removed) return false;
        pinAge += dt;
        e.c.x = cx + (Math.random() - 0.5) * 10;
        e.c.y = cy + (Math.random() - 0.5) * 10;
        return pinAge < 120;
      });
      setTimeoutStageSafe(() => {
        chest.scale.set(1, 1);
        chest.alpha = 1;
        defeatSequence(e, cmd);
      }, 150);
    }, BEAM_CHARGE_MS);
  }

  /** 串尾落点：扣 1 格血＋受击抖动；未空 → hit，扣完 → 击破 → defeat。 */
  function damageTarget(cmd: Extract<StageCommand, { kind: 'fire' }>): void {
    const e = target;
    if (!e || e.removed || currentTargetId !== cmd.targetId) {
      handle.emit({ kind: 'performance-complete', targetId: cmd.targetId, outcome: 'hit' });
      return;
    }
    firesDone += 1;
    e.hp = Math.max(0, e.hp - 1);
    if (e.hpBar) drawHpBar(e.hpBar, e.hp, e.maxHp, e.isBoss, e.isBoss ? -BOSS_FONT * 0.62 : -ENEMY_FONT * 0.68);
    sfxHit();
    // 受击 scale 脉冲（入场动画已让出 scale 写面）
    let pulseAge = 0;
    addAnim((dt) => {
      if (e.removed) return false;
      pulseAge += dt;
      const t = Math.min(1, pulseAge / 180);
      const s = 1 + 0.22 * Math.sin(t * Math.PI);
      e.c.scale.set(s, s);
      return t < 1;
    });
    if (e.hp <= 0) {
      beamThenDefeat(e, cmd);
    } else {
      hitStop(HITSTOP_HIT_MS);
      handle.emit({ kind: 'performance-complete', targetId: cmd.targetId, outcome: 'hit' });
    }
  }

  /** 击破：光波贯穿后爆碎（💥＋冲击波＋碎片＋星星入袋＋屏闪＋大震＋浮字 → 垫场 → 下一波＋defeat）。 */
  function defeatSequence(e: Enemy, cmd: Extract<StageCommand, { kind: 'fire' }>): void {
    const cx = e.c.x;
    const cy = e.c.y;
    const scale = e.isBoss ? 1.7 : 1;
    sfxBoom();
    boomSticker(cx, cy, scale);
    explode(cx, cy, scale);
    spawnParticles(cx, cy, e.isBoss ? 22 : 14);
    flyStarToScore(cx, cy);
    // 巨人胜利小跳＋胸灯爆闪（票 61：击破反馈落在主角身上，手感闭环）
    {
      const { chest } = fighterParts;
      heroHold(360);
      const baseY = fighter.y;
      let hopAge = 0;
      addAnim((dt) => {
        hopAge += dt;
        const t = Math.min(1, hopAge / 320);
        fighter.y = baseY - Math.sin(t * Math.PI) * (e.isBoss ? 26 : 14);
        chest.scale.set(1 + 1.6 * Math.sin(Math.min(1, t * 1.4) * Math.PI), 1 + 1.6 * Math.sin(Math.min(1, t * 1.4) * Math.PI));
        if (t >= 1) {
          fighter.y = baseY;
          chest.scale.set(1, 1);
          return false;
        }
        return true;
      });
    }
    if (e.isBoss) {
      setTimeoutStageSafe(() => boomSticker(cx - 60, cy + 24, 1.0), 180);
      setTimeoutStageSafe(() => boomSticker(cx + 64, cy - 14, 1.2), 340);
      setTimeoutStageSafe(() => spawnParticles(cx, cy, 12), 300);
    }
    screenFlash();
    shake(SHAKE_POWER_DEFEAT);
    if (cmd.combo >= 5) popup(cx, cy - 96, '🎉', COLOR_SUN, 48);
    if (cmd.combo >= 2) popup(cx, cy - 84, `x${cmd.combo} 连击！`, COLOR_CORAL, 34);
    if (cmd.score > 0) popup(cx, cy - 38, `+${cmd.score}`, COLOR_SUN, 28);
    if (cmd.weaponLevel >= 2) sfxPowerUp();
    if (cmd.weaponLevel < 3 && cmd.combo > 0 && cmd.combo % 3 === 0) popup(cx, cy - 128, '⚡ 火力升级！', COLOR_SKY, 26);
    // removeEnemy 内部完成 removed 置位/target 清空/marker 摘除/容器销毁；
    // 禁止外部预置 removed（会触发其 early-return 留下僵尸容器）。
    removeEnemy(e, false);
    let elapsed = 0;
    addAnim((dt) => {
      elapsed += dt;
      if (elapsed < FALL_MS) return true;
      spawnWave();
      handle.emit({ kind: 'performance-complete', targetId: cmd.targetId, outcome: 'defeat' });
      return false;
    });
  }

  /** 舞台内安全延时。 */
  function setTimeoutStageSafe(fn: () => void, delayMs: number): void {
    let age = 0;
    addAnim((dt) => {
      age += dt;
      if (age >= delayMs) {
        if (!destroyed) fn();
        return false;
      }
      return true;
    });
  }

  function clearScene(): void {
    battleActive = false;
    stopMusic();
    removeEnemy(target, false);
    target = null;
    targetMarker.visible = false;
    if (danger) danger.visible = false; // Boss 警报渐晕复位（票 61）
    for (const c of companions.splice(0, companions.length)) removeEnemy(c, false);
    currentTargetId = null;
    for (const b of bullets.splice(0, bullets.length)) {
      root.removeChild(b);
      b.destroy();
    }
    for (const b of blasts.splice(0, blasts.length)) {
      root.removeChild(b);
      b.destroy();
    }
    for (const p of particles.splice(0, particles.length)) {
      root.removeChild(p);
      p.destroy();
    }
    root.x = 0;
    root.y = 0;
    for (const t of tweens.splice(0, tweens.length)) t.finish();
    renderOnce();
  }

  /* ---------------- 常驻环境动画 ---------------- */

  /** 视差云＋战机跟随/侧倾/喷焰/尾迹粒子＋目标箭头弹跳。 */
  function startAmbient(): void {
    buildSky();
    ensureClouds();
    addAnim((dt) => {
      if (!battleActive) return false;
      for (const cl of clouds) {
        cl.c.y += (cl.speed * dt) / 1000;
        cl.c.x += Math.sin((cl.c.y + cl.speed) * 0.004) * 0.2;
        if (cl.c.y > vh + 60) {
          cl.c.y = -70;
          cl.c.x = Math.random() * vw;
        }
      }
      const prevX = fighter.x;
      const heroFree = stageClockMs >= heroHoldUntilMs; // 票 61：主角写面独占窗让位
      const { flame } = fighterParts; // 光环常驻写面（不进独占窗）
      if (heroFree) fighter.x = lerp(fighter.x, fighterX.target, Math.min(1, dt * 0.010));
      const vx = fighter.x - prevX;
      if (heroFree) {
        fighter.rotation = Math.max(-0.05, Math.min(0.05, vx * 0.006)); // 巨人站位轻微侧倾
        fighter.y = fighterBaseY() + Math.sin(performance.now() / 520) * 3; // idle 呼吸浮动
        // 披风摆动（票 61：低频摆＋移动侧偏，独立 rotation 写面）
        const { glow, cape, chest } = fighterParts;
        cape.rotation = Math.sin(performance.now() / 700) * 0.07 + vx * 0.004;
        // 外发光呼吸（票 61：低频明暗；blend add 叠亮轮廓）
        const glowK = 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 900));
        glow.clear();
        glow.beginFill(HERO_CHEST, 0.1 * glowK).drawEllipse(0, -8, 52, 66).endFill();
        glow.beginFill(HERO_CHEST, 0.08 * glowK).drawEllipse(0, -34, 30, 30).endFill();
        // 胸灯待机呼吸（票 61：低频脉动，蓄力期 chest 被 beamThenDefeat 独占写面）
        const chestK = 0.75 + 0.25 * Math.sin(performance.now() / 460);
        chest.alpha = chestK;
      }
      // 脚下能量光环脉冲（三层青蓝光晕；重绘驱动闪烁）
      const flick = 0.7 + 0.3 * Math.abs(Math.sin(performance.now() / 110));
      flame.clear();
      flame.beginFill(HERO_CHEST, 0.16 * flick).drawEllipse(0, 48, 46, 12).endFill();
      flame.beginFill(HERO_CHEST, 0.28 * flick).drawEllipse(0, 48, 30, 8).endFill();
      flame.beginFill(0xffffff, 0.5 * flick).drawEllipse(0, 48, 14, 4).endFill();
      // 极光带缓慢漂移（票 61：往复平移＝远景活）
      if (aurora) {
        aurora.x = Math.sin(performance.now() / 5200) * 26;
        aurora.alpha = 0.8 + 0.2 * Math.sin(performance.now() / 3100);
      }
      // Boss 警报渐晕脉冲（票 61：Boss 在场时红色边缘呼吸）
      if (danger && danger.visible) {
        danger.alpha = 0.75 + 0.25 * Math.sin(performance.now() / 380);
      }
      // 脚下光尘上飘（低频；防粒子池爆量）
      exhaustAcc += dt;
      if (exhaustAcc > 170 && particles.length < PARTICLE_MAX - 8) {
        exhaustAcc = 0;
        const p = makeSparkle(12);
        p.x = fighter.x + (Math.random() - 0.5) * 44;
        p.y = fighter.y + 44;
        root.addChild(p);
        particles.push(p);
        let age = 0;
        addAnim((pdt) => {
          age += pdt;
          p.y += (pdt * 90) / 1000;
          p.alpha = Math.max(0, 1 - age / 420);
          if (age >= 420) {
            removeParticle(p);
            return false;
          }
          return true;
        });
      }
      // 目标箭头弹跳（基准值＋sin，不累积漂移）
      if (targetMarker.visible) {
        targetMarker.y = markerBaseY + Math.sin(performance.now() / 180) * 6;
      }
      return true;
    });
  }

  /** 登场凝聚（票 59 用户指定演出链）：四周散射光点 → 螺旋汇聚 → 白闪 →
   * 光之巨人 easeOutBack 登场＋胸灯点亮。每场战斗仅首波播完整序列；后续
   * 波次巨人已在场（换怪由 spawnWave 自行入场）。 */
  function heroGatherThenWave(): void {
    if (heroBorn) return; // 首波出怪由 load-word 承担（同上：避免双 spawnWave 竞争）
    heroBorn = true;
    fighter.visible = false;
    const destX = vw / 2;
    const destY = fighterBaseY();
    const gatherPts: Container[] = [];
    for (let i = 0; i < HERO_GATHER_COUNT; i++) {
      const p = makeSparkle(10 + Math.random() * 12);
      // 起点＝屏幕四周边缘随机散射位
      const edge = i % 4;
      const t = Math.random();
      p.x = edge === 0 ? t * vw : edge === 1 ? vw + 20 : edge === 2 ? t * vw : -20;
      p.y = edge === 0 ? -20 : edge === 1 ? t * vh : edge === 2 ? vh + 20 : t * vh;
      p.alpha = 0.95;
      root.addChild(p);
      gatherPts.push(p);
    }
    let gatherAge = 0;
    addAnim((dt) => {
      gatherAge += dt;
      const t = Math.min(1, gatherAge / HERO_GATHER_MS);
      const k = t * t * (3 - 2 * t); // smoothstep：缓起缓收
      for (let i = 0; i < gatherPts.length; i++) {
        const p = gatherPts[i] as Container;
        // 各点带相位差的螺旋汇聚（半径随 t 收拢＋绕目标旋转）
        const phase = (i / gatherPts.length) * Math.PI * 2;
        const radius = (1 - k) * (240 + (i % 5) * 60);
        const px = destX + Math.cos(phase + k * Math.PI * 2.2) * radius;
        const py = destY + Math.sin(phase + k * Math.PI * 2.2) * radius * 0.72;
        p.x = lerp(p.x, px, 0.55);
        p.y = lerp(p.y, py, 0.55);
        p.alpha = 0.4 + 0.6 * k;
        p.scale.set(0.6 + k * 0.9);
      }
      if (t >= 1) {
        for (const p of gatherPts) {
          root.removeChild(p);
          p.destroy();
        }
        // 凝聚白闪＋巨人登场
        screenFlash();
        hitStop(HITSTOP_HIT_MS);
        sfxBeam();
        heroHold(460); // 登场点亮期 ambient 让位（chest 渐亮/落地跳不被呼吸覆盖，票 61）
        fighter.visible = true;
        fighter.position.set(destX, destY);
        let bornAge = 0;
        addAnim((dt) => {
          bornAge += dt;
          const bt = Math.min(1, bornAge / 420);
          const s = 0.25 + 0.75 * easeOutBack(bt);
          fighter.scale.set(s, s);
          const { chest } = fighterParts;
          chest.alpha = bt < 1 ? 0.4 + 0.6 * bt : 1;
          if (bt >= 1) {
            fighter.scale.set(1, 1);
            // 落地冲击环＋光尘（票 61：登场落点有「砸地」重量）
            explode(destX, destY + 30, 0.9);
            shake(SHAKE_POWER_DEFEAT);
            spawnParticles(destX, destY + 20, 10);
            // 首波出怪由 load-word 触发（契约：battle-start 后必跟 load-word）——
            // 此处若再 spawnWave 会把 load-word 已出的怪/正在打的 fire 链换掉
            // （票 59 探针定责：双 spawnWave 竞争＝defeat 错位）。凝聚先行完成即静默让位。
            return false;
          }
          return true;
        });
        return false;
      }
      return true;
    });
  }

  function handleCommand(cmd: StageCommand): void {
    switch (cmd.kind) {
      case 'battle-start':
        clearScene();
        battleActive = true;
        totalWords = cmd.total;
        firesDone = 0;
        waveIndex = 0;
        heroBorn = false; // 新战斗重播登场凝聚
        startAmbient();
        heroGatherThenWave();
        startMusic(); // 尝试启动（挂起则由首手势 ensureMusic 接通）
        break;
      case 'load-word':
        if (!target || target.removed) spawnWave();
        currentTargetId = cmd.targetId;
        setMeaning(cmd.meaning);
        break;
      case 'letter-fire':
        letterFire(cmd.targetId);
        break;
      case 'fire':
        fireBurst(cmd);
        break;
      case 'clear':
        clearScene();
        break;
    }
  }

  /* ---------------- 视口与可见性 ---------------- */

  function onResize(): void {
    if (destroyed) return;
    vw = window.innerWidth;
    vh = window.innerHeight;
    app.renderer.resize(vw, vh);
    layout();
    for (const child of [...bgLayer.children]) {
      bgLayer.removeChild(child);
      child.destroy({ children: true });
    }
    skyBuilt = false;
    buildSky();
    // buildSky 重建了 danger（默认隐藏）：Boss 战进行中则恢复警报面（票 61）
    if (danger && battleActive && target?.isBoss && !target.removed) danger.visible = true;
    renderOnce();
  }

  function onVisibilityChange(): void {
    if (destroyed) return;
    if (document.hidden) {
      clearIdleTimer();
      if (tickerRunning) {
        app.ticker.stop();
        tickerRunning = false;
      }
    } else if (animCount > 0) {
      ensureTicker();
    }
  }

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  buildSky();
  layout();
  renderOnce();

  booted = true;
  for (const cmd of bootQueue.splice(0, bootQueue.length)) runCommand(cmd);

  return function unmountStage(): void {
    if (destroyed) return;
    destroyed = true;
    stopMusic();
    handle.detach();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerdown', onPointer);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    clearIdleTimer();
    for (const t of tweens.splice(0, tweens.length)) t.finish();
    app.destroy(true, { children: true });
  };
}
