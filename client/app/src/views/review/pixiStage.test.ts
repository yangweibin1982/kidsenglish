/**
 * 演出层挂载时序回归 v3（Ticket 30；boot 队列语义承自票 11）：
 * 挂载前经契约总线缓冲的指令（battle-start/load-word）必须在场景就绪后回放——
 * 曾因 attachDriver 同步回放缓冲踩半初始化场景（TDZ）而挂载失败，
 * 本测试钉死该时序。另钉 v3 战场语义：letter-fire 零回报、小怪 1 血首发
 * 击破、每 6 词出 Boss（血量=min(6, 剩余词)）、fail-open、clear 零回报。
 * PixiJS 以桩替换（无 WebGL 环境）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type AnyObj = Record<string, unknown>;

/* pixijs 桩：只覆盖 pixiStage 用到的面；__apps 泄漏实例供测试驱动 ticker */
vi.mock('pixi.js', () => {
  class FakeContainer {
    children: FakeContainer[] = [];
    position = { set: vi.fn(), x: 0, y: 0 };
    anchor = { set: vi.fn() };
    scale = { set: vi.fn() }; // 票 32 juice（spawn 弹跳/爆炸 pop/星星飞入）需要
    alpha = 1;
    rotation = 0;
    x = 0;
    y = 0;
    destroyed = false;
    addChild(...cs: FakeContainer[]): this {
      this.children.push(...cs);
      return this;
    }
    removeChild(c: FakeContainer): this {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return this;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  class FakeGraphics extends FakeContainer {
    beginFill(): this {
      return this;
    }
    endFill(): this {
      return this;
    }
    drawRect(): this {
      return this;
    }
    drawCircle(): this {
      return this;
    }
    drawRoundedRect(): this {
      return this;
    }
    drawEllipse(): this {
      return this;
    }
    drawPolygon(): this {
      return this;
    }
    lineStyle(): this {
      return this;
    }
    moveTo(): this {
      return this;
    }
    lineTo(): this {
      return this;
    }
    clear(): this {
      return this;
    }
  }
  class FakeTicker {
    cbs: Array<() => void> = [];
    deltaMS = 16;
    add(cb: () => void): void {
      this.cbs.push(cb);
    }
    start(): void {}
    stop(): void {}
  }
  const apps: FakeApplication[] = [];
  class FakeApplication {
    view = { style: {} as Record<string, string> };
    stage = new FakeContainer();
    ticker = new FakeTicker();
    renderer = { resize: vi.fn() };
    render = vi.fn();
    destroy = vi.fn();
    constructor() {
      apps.push(this);
    }
  }
  return { Application: FakeApplication, Container: FakeContainer, Graphics: FakeGraphics, Text: FakeGraphics, BLEND_MODES: { ADD: 'add' }, __apps: apps };
});

import { mountShootingStage } from './pixiStage';
import { createStageBus, type StageEvent } from './stageContract';

/* node 环境手搭最小 DOM 面（不引 jsdom：演出桩不需要真布局） */
let rootEl: { appendChild: ReturnType<typeof vi.fn>; style: Record<string, string> };

function installDomShim(hasRoot = true): void {
  rootEl = { appendChild: vi.fn(), style: {} };
  (globalThis as AnyObj).document = {
    hidden: false,
    getElementById: vi.fn(() => (hasRoot ? rootEl : null)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (globalThis as AnyObj).window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function makeContainer(): HTMLElement {
  return { appendChild: vi.fn(), style: {} } as unknown as HTMLElement;
}

async function driveTicks(ms: number): Promise<void> {
  // vi.mock 仅运行时生效：类型侧仍是真 pixi 声明，经 unknown 双跳转取桩面
  const pixi = (await import('pixi.js')) as unknown as { __apps: Array<{ ticker: { cbs: Array<() => void> } }> };
  const app = pixi.__apps.at(-1);
  expect(app).toBeDefined();
  const steps = Math.ceil(ms / 16);
  for (let i = 0; i < steps; i++) {
    for (const cb of app!.ticker.cbs) cb();
    await Promise.resolve();
  }
}

afterEach(() => {
  delete (globalThis as AnyObj).document;
  delete (globalThis as AnyObj).window;
  vi.restoreAllMocks();
});

describe('演出层挂载时序（boot 队列回归）', () => {
  it('挂载前缓冲的 battle-start/load-word 在场景就绪后回放：不报 stage-error，随后 fire 完成回报', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    // 场景尚未挂载即下发作战指令（出题时序）→ 应入 boot 队列而非立即执行
    bus.sendCommand({ kind: 'battle-start', total: 3 });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_panda', meaning: '熊猫' });

    const unmount = await mountShootingStage(bus, makeContainer());

    // 回放完成：无 stage-error（挂载时序曾在此踩 TDZ）
    expect(events.filter((e) => e.kind === 'stage-error')).toEqual([]);

    // 拼完开火 → 驱动桩 ticker 推进子弹串（串尾 870ms 落点扣血）→ 小怪 1 血首发击破
    bus.sendCommand({ kind: 'fire', shotId: 's1', targetId: 'w_panda', combo: 1, weaponLevel: 1, score: 30 });
    await driveTicks(2600);
    expect(events).toContainEqual({ kind: 'performance-complete', targetId: 'w_panda', outcome: 'defeat' });

    unmount();
  });

  it('挂载点缺失：经契约上报 stage-error，卸载为 no-op（考核层兜底推进）', async () => {
    installDomShim(false);
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    const unmount = await mountShootingStage(bus); // 无容器参数 → 找 #stage-canvas-root

    const errs = events.filter((e) => e.kind === 'stage-error');
    expect(errs).toHaveLength(1);
    expect((errs[0] as { message: string }).message).toContain('stage-canvas-root');
    expect(() => unmount()).not.toThrow();
  });

  it('clear 指令在挂载前缓冲：场景就绪后回放不抛错', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    bus.sendCommand({ kind: 'clear' });
    const unmount = await mountShootingStage(bus, makeContainer());
    expect(events.filter((e) => e.kind === 'stage-error')).toEqual([]);
    unmount();
  });
});

describe('战场语义 v3（波次/Boss/字母弹幕；每 fire 恰一次回报）', () => {
  it('letter-fire 零回报零扣血；小怪血量 1：第 1 次 fire 即击破 → defeat', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    const unmount = await mountShootingStage(bus, makeContainer());
    bus.sendCommand({ kind: 'battle-start', total: 9 });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_cat', meaning: '猫' });

    bus.sendCommand({ kind: 'letter-fire', targetId: 'w_cat' });
    bus.sendCommand({ kind: 'letter-fire', targetId: 'w_cat' });
    bus.sendCommand({ kind: 'letter-fire', targetId: 'w_other' }); // 无匹配：静默
    await driveTicks(500);
    expect(events.filter((e) => e.kind === 'performance-complete')).toEqual([]); // 字母弹不回报

    bus.sendCommand({ kind: 'fire', shotId: 'f1', targetId: 'w_cat', combo: 1, weaponLevel: 1, score: 30 });
    await driveTicks(2600); // 子弹串 870ms ＋ 光波蓄力/贯穿 530ms ＋ 击破垫场 700ms（票 59）
    expect(events).toEqual([{ kind: 'performance-complete', targetId: 'w_cat', outcome: 'defeat' }]);

    unmount();
  });

  it('每 6 词出 Boss（血量=min(6, 剩余词)）：total=12 → 小怪×5 各 1 发击破，第 6 词 Boss 血 6，第 11 发击破', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    const unmount = await mountShootingStage(bus, makeContainer());
    bus.sendCommand({ kind: 'battle-start', total: 12 });

    const outcomes: string[] = [];
    for (let i = 1; i <= 11; i++) {
      bus.sendCommand({ kind: 'load-word', targetId: `w${i}`, meaning: `义${i}` });
      bus.sendCommand({
        kind: 'fire',
        shotId: `f${i}`,
        targetId: `w${i}`,
        combo: 0,
        weaponLevel: 1,
        score: 0,
      });
      await driveTicks(2600);
      const last = events.filter((e) => e.kind === 'performance-complete').at(-1);
      outcomes.push((last as { outcome: string } | undefined)?.outcome ?? 'none');
    }
    // 小怪 1 血：fires 1-5 全 defeat；fires 6-10 打 Boss 血 6→1 全 hit；fire 11 击破 Boss
    expect(outcomes).toEqual(['defeat', 'defeat', 'defeat', 'defeat', 'defeat', 'hit', 'hit', 'hit', 'hit', 'hit', 'defeat']);

    unmount();
  });

  it('末段 Boss 弱血量：total=7 → 第 6 词 Boss 血 2（min(6, 7-5)），第 7 发击破', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    const unmount = await mountShootingStage(bus, makeContainer());
    bus.sendCommand({ kind: 'battle-start', total: 7 });

    const outcomes: string[] = [];
    for (let i = 1; i <= 7; i++) {
      bus.sendCommand({ kind: 'load-word', targetId: `w${i}`, meaning: `义${i}` });
      bus.sendCommand({ kind: 'fire', shotId: `f${i}`, targetId: `w${i}`, combo: 0, weaponLevel: 1, score: 0 });
      await driveTicks(2600);
      const last = events.filter((e) => e.kind === 'performance-complete').at(-1);
      outcomes.push((last as { outcome: string } | undefined)?.outcome ?? 'none');
    }
    expect(outcomes).toEqual(['defeat', 'defeat', 'defeat', 'defeat', 'defeat', 'hit', 'defeat']);

    unmount();
  });

  it('fire 目标不匹配（无怪兽/异词）：fail-open 立即回报 hit（考核层不被卡）', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    const unmount = await mountShootingStage(bus, makeContainer());
    bus.sendCommand({ kind: 'battle-start', total: 3 });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_cat', meaning: '猫' });

    bus.sendCommand({ kind: 'fire', shotId: 'fx', targetId: 'w_other', combo: 0, weaponLevel: 1, score: 0 });
    await Promise.resolve();
    expect(events).toEqual([{ kind: 'performance-complete', targetId: 'w_other', outcome: 'hit' }]);

    unmount();
  });

  it('clear 后不再回报（终态演出被清场，回报随 tween 终结消失）', async () => {
    installDomShim();
    const bus = createStageBus();
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));

    const unmount = await mountShootingStage(bus, makeContainer());
    bus.sendCommand({ kind: 'battle-start', total: 3 });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_cat', meaning: '猫' });
    bus.sendCommand({ kind: 'fire', shotId: 'f1', targetId: 'w_cat', combo: 0, weaponLevel: 1, score: 0 });
    bus.sendCommand({ kind: 'clear' }); // 时间盒到点/收尾清场
    await driveTicks(2600);

    expect(events.filter((e) => e.kind === 'performance-complete')).toEqual([]);
    unmount();
  });
});
