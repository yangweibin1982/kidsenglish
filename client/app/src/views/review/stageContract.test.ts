/**
 * S5 三向事件契约单测 v3（Ticket 30 VALIDATE；v3 指令形状：letter-fire＋
 * fire 载荷 combo/weaponLevel/score）。
 * 覆盖：①指令（Vue→Pixi）往返、②完成回报（Pixi→Vue）往返、
 * ③错误上报往返各 ≥1 例；缓冲补投/clear 弃单/退订/换驱动等契约边角。
 */
import { describe, expect, it, vi } from 'vitest';
import { REVIEW_WORDS_PER_BOSS, createStageBus, type StageCommand, type StageEvent } from './stageContract';

describe('① Vue→Pixi 指令向', () => {
  it('驱动已挂载：sendCommand 即时送达（battle-start/load-word/letter-fire/fire/clear 全形）', () => {
    const bus = createStageBus();
    const received: StageCommand[] = [];
    bus.attachDriver((cmd) => received.push(cmd));

    bus.sendCommand({ kind: 'battle-start', total: 7 });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_monkey', meaning: '猴子' });
    bus.sendCommand({ kind: 'letter-fire', targetId: 'w_monkey' });
    bus.sendCommand({ kind: 'fire', shotId: 'w_monkey-1', targetId: 'w_monkey', combo: 2, weaponLevel: 1, score: 60 });
    bus.sendCommand({ kind: 'clear' });

    expect(received).toEqual([
      { kind: 'battle-start', total: 7 },
      { kind: 'load-word', targetId: 'w_monkey', meaning: '猴子' },
      { kind: 'letter-fire', targetId: 'w_monkey' },
      { kind: 'fire', shotId: 'w_monkey-1', targetId: 'w_monkey', combo: 2, weaponLevel: 1, score: 60 },
      { kind: 'clear' },
    ]);
  });

  it('Boss 出词周期常量＝6（票 30 舞台调度唯一事实源）', () => {
    expect(REVIEW_WORDS_PER_BOSS).toBe(6);
  });

  it('驱动未挂载：指令缓冲，挂载后按发出顺序补投（懒挂载竞态）', () => {
    const bus = createStageBus();
    // 先发后挂：模拟「load-word 先于 Pixi 初始化完成」的真实时序
    bus.sendCommand({ kind: 'battle-start', total: 3 });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_panda', meaning: '熊猫' });
    bus.sendCommand({ kind: 'fire', shotId: 's1', targetId: 'w_panda', combo: 0, weaponLevel: 1, score: 0 });

    const received: StageCommand[] = [];
    bus.attachDriver((cmd) => received.push(cmd));

    expect(received).toEqual([
      { kind: 'battle-start', total: 3 },
      { kind: 'load-word', targetId: 'w_panda', meaning: '熊猫' },
      { kind: 'fire', shotId: 's1', targetId: 'w_panda', combo: 0, weaponLevel: 1, score: 0 },
    ]);
  });

  it('clear 兼弃单：末次 clear 之前的未投递旧卡指令丢弃，clear 本身与其后指令照投', () => {
    const bus = createStageBus();
    bus.sendCommand({ kind: 'load-word', targetId: 'w_old', meaning: '旧' });
    bus.sendCommand({ kind: 'clear' });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_new', meaning: '新' });

    const received: StageCommand[] = [];
    bus.attachDriver((cmd) => received.push(cmd));
    // w_old 被弃；clear 照投（驱动自清场）；w_new 保留
    expect(received).toEqual([
      { kind: 'clear' },
      { kind: 'load-word', targetId: 'w_new', meaning: '新' },
    ]);
  });
});

describe('②③ Pixi→Vue 回报向（完成＋错误）', () => {
  it('完成回报往返：指令发出→驱动处理→performance-complete 到达 Vue 订阅者', () => {
    const bus2 = createStageBus();
    const got2: StageEvent[] = [];
    bus2.onEvent((evt) => got2.push(evt));
    bus2.sendCommand({ kind: 'fire', shotId: 's1', targetId: 'w_hamburger', combo: 1, weaponLevel: 1, score: 100 });
    // 模拟演出驱动：消费缓冲的 fire 后，演出完成 → 经句柄 emit 回报
    const driver = bus2.attachDriver(() => undefined);
    driver.emit({ kind: 'performance-complete', targetId: 'w_hamburger', outcome: 'hit' });
    expect(got2).toEqual([{ kind: 'performance-complete', targetId: 'w_hamburger', outcome: 'hit' }]);
  });

  it('defeat 回报往返：血条扣完的击破结局原样到达（考核层据此弹出本卡）', () => {
    const bus = createStageBus();
    const got: StageEvent[] = [];
    bus.onEvent((evt) => got.push(evt));
    const driver = bus.attachDriver(() => undefined);
    driver.emit({ kind: 'performance-complete', targetId: 'w_panda', outcome: 'defeat' });
    expect(got).toEqual([{ kind: 'performance-complete', targetId: 'w_panda', outcome: 'defeat' }]);
  });

  it('错误上报往返：stage-error 到达全部 Vue 订阅者（多订阅广播）', () => {
    const bus = createStageBus();
    const gotA: StageEvent[] = [];
    const gotB: StageEvent[] = [];
    bus.onEvent((evt) => gotA.push(evt));
    bus.onEvent((evt) => gotB.push(evt));

    const driver = bus.attachDriver(() => undefined);
    driver.emit({ kind: 'stage-error', message: 'WebGL 上下文创建失败' });

    expect(gotA).toEqual([{ kind: 'stage-error', message: 'WebGL 上下文创建失败' }]);
    expect(gotB).toEqual(gotA);
  });

  it('全链路往返：fire 指令下发→驱动模拟开火→完成回报→Vue 消费（同一总线两端）', () => {
    const bus = createStageBus();
    const commands: StageCommand[] = [];
    const events: StageEvent[] = [];
    bus.onEvent((evt) => events.push(evt));
    const driver = bus.attachDriver((cmd) => {
      commands.push(cmd);
      if (cmd.kind === 'fire') {
        driver.emit({ kind: 'performance-complete', targetId: cmd.targetId, outcome: 'hit' });
      }
    });

    bus.sendCommand({ kind: 'fire', shotId: 's2', targetId: 'w_yellow', combo: 3, weaponLevel: 2, score: 180 });
    expect(commands).toEqual([{ kind: 'fire', shotId: 's2', targetId: 'w_yellow', combo: 3, weaponLevel: 2, score: 180 }]);
    expect(events).toEqual([{ kind: 'performance-complete', targetId: 'w_yellow', outcome: 'hit' }]);
  });
});

describe('契约边角', () => {
  it('onEvent 退订后不再收到事件', () => {
    const bus = createStageBus();
    const got: StageEvent[] = [];
    const unsub = bus.onEvent((evt) => got.push(evt));
    const driver = bus.attachDriver(() => undefined);
    driver.emit({ kind: 'stage-error', message: 'a' });
    unsub();
    driver.emit({ kind: 'stage-error', message: 'b' });
    expect(got).toEqual([{ kind: 'stage-error', message: 'a' }]);
  });

  it('驱动 detach：emit 失效、后续 sendCommand 重新进入缓冲（可再挂载）', () => {
    const bus = createStageBus();
    const got: StageEvent[] = [];
    bus.onEvent((evt) => got.push(evt));
    const received: StageCommand[] = [];
    const driver = bus.attachDriver((cmd) => received.push(cmd));

    driver.detach();
    driver.emit({ kind: 'stage-error', message: '不应送达' });
    bus.sendCommand({ kind: 'load-word', targetId: 'w_x', meaning: 'x' });
    expect(got).toEqual([]);
    expect(received).toEqual([]); // 缓冲中

    bus.attachDriver((cmd) => received.push(cmd));
    expect(received).toEqual([{ kind: 'load-word', targetId: 'w_x', meaning: 'x' }]);
  });

  it('新驱动顶替旧驱动：指令只投递给当前驱动', () => {
    const bus = createStageBus();
    const oldGot: StageCommand[] = [];
    const newGot: StageCommand[] = [];
    const oldDriver = bus.attachDriver((cmd) => oldGot.push(cmd));
    bus.attachDriver((cmd) => newGot.push(cmd));
    oldDriver.detach();

    bus.sendCommand({ kind: 'clear' });
    expect(oldGot).toEqual([]);
    expect(newGot).toEqual([{ kind: 'clear' }]);
  });

  it('缓冲上限防泄漏：超量后丢最旧指令（正常流远达不到该量）', () => {
    const bus = createStageBus();
    for (let i = 0; i < 70; i++) {
      bus.sendCommand({ kind: 'load-word', targetId: `w${i}`, meaning: `义${i}` });
    }
    const received: StageCommand[] = [];
    bus.attachDriver((cmd) => received.push(cmd));
    expect(received.length).toBeLessThanOrEqual(64);
    expect(received[received.length - 1]?.kind).toBe('load-word');
  });

  it('句柄 emit 是驱动的唯一回报通道（vi.fn 断言订阅回调按事件次数触发）', () => {
    const bus = createStageBus();
    const spy = vi.fn();
    bus.onEvent(spy);
    const driver = bus.attachDriver(() => undefined);
    driver.emit({ kind: 'performance-complete', targetId: 't', outcome: 'hit' });
    driver.emit({ kind: 'performance-complete', targetId: 't', outcome: 'defeat' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
