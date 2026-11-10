/**
 * 存储层单测（票 14）：事件只追加／离线队列／游标持久／fold 重建／冷启动／
 * 冒烟门首启拦截——全部跑 sql.js 面（driver 抽象换插件 two-way）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fold, type Hlc, type LearningEvent } from '@kidsenglish/engine';
import { createSqlJsDriver, type StorageDriver } from './driver';
import { LearningStore } from './learningStore';
import { runSqliteSmokeVectors } from './smoke';

/** 可注入时钟（毫秒递推，HLC 计数器语义覆盖：同毫秒多事件走 counter+1）。 */
function mkClock(start = 1_730_000_000_000): { restore: (hlc: Hlc | null) => void; tick: (nowMs?: number) => Hlc; recv: (remote: Hlc, nowMs?: number) => Hlc; snapshot: () => Hlc } {
  let physical = start;
  let counter = 0;
  return {
    restore(hlc) {
      if (!hlc) return;
      if (hlc.physicalMs > physical) {
        physical = hlc.physicalMs;
        counter = hlc.counter;
      } else if (hlc.physicalMs === physical) {
        counter = Math.max(counter, hlc.counter);
      }
    },
    tick(nowMs) {
      const t = nowMs ?? physical;
      if (t > physical) {
        physical = t;
        counter = 0;
      } else {
        counter += 1;
      }
      return { physicalMs: physical, counter };
    },
    recv(remote, nowMs) {
      const t = nowMs ?? physical;
      const p = Math.max(t, physical, remote.physicalMs);
      if (p === physical && p === remote.physicalMs) counter = Math.max(counter, remote.counter) + 1;
      else if (p === physical) counter += 1;
      else if (p === remote.physicalMs) counter = remote.counter + 1;
      else counter = 0;
      physical = p;
      return { physicalMs: physical, counter };
    },
    snapshot: () => ({ physicalMs: physical, counter }),
  };
}

async function openStore(): Promise<{ driver: StorageDriver; store: LearningStore; clock: ReturnType<typeof mkClock> }> {
  const driver = await createSqlJsDriver();
  const clock = mkClock();
  const deviceId = 'dev-test-1';
  await LearningStore.open(driver, clock, deviceId);
  const opened = await LearningStore.open(driver, clock, deviceId); // 二次 open：schema/冒烟幂等
  return { driver, store: opened.store, clock };
}

const ANSWER_PAYLOAD = {
  lexical_entry_id: 'w_pencil',
  question_type: 'word_pick_meaning',
  correct: true,
  reaction_ms: 9000,
  answered_on: '2026-10-25',
};

describe('LearningStore：事件只追加＋离线队列＋游标＋fold 重建', () => {
  let driver: StorageDriver;
  let store: LearningStore;

  beforeEach(async () => {
    ({ driver, store } = await openStore());
  });

  it('appendLocal：事件落库＋离线队列入队＋device_seq 递增', async () => {
    const e1 = await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, 1_730_000_000_000);
    // 同毫秒第二事件：HLC 物理不动 → 计数器 +1（tick 语义）
    const e2 = await store.appendLocal('1', 'daily_completed', { date: '2026-10-25', completed_on_time: true, segment_seconds: { new_words: 60, review: 0 } }, 1_730_000_000_000);
    expect(e2.device_seq).toBe(e1.device_seq + 1);
    expect(e2.hlc.counter).toBeGreaterThan(0); // 同毫秒多事件走 HLC counter
    expect(await store.pendingCount()).toBe(2);
    const pending = await store.pendingEvents();
    expect(pending.map((e) => e.event_id)).toEqual([e1.event_id, e2.event_id]); // device_seq 序
  });

  it('appendLocal 后行不可改写：重放同 id 零重复、原行保真（append-only 契约）', async () => {
    const e = await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, 1_730_000_000_000);
    const rowsBefore = await driver.select<Record<string, unknown>>('SELECT * FROM learning_events');
    // 同 id 再投（模拟同步重放路径的下行回声）＝幂等零重复
    await store.appendRemote([e], 1_730_000_000_900);
    const rowsAfter = await driver.select<Record<string, unknown>>('SELECT * FROM learning_events');
    expect(rowsAfter.length).toBe(rowsBefore.length);
    expect(rowsAfter[0].payload).toBe(rowsBefore[0].payload);
    // 存储层 API 面：不存在事件改写/删除方法（WRONG 条款「事件可 UPDATE/DELETE」封死）
    const storeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(storeMethods.filter((m) => /update|delete|remove/i.test(m) && !m.includes('Pending') && m !== 'clearPending')).toEqual([]);
  });

  it('outbox 出队只删队列行，事件本体在位（可再折叠）', async () => {
    const e = await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, 1_730_000_000_000);
    expect(await store.pendingCount()).toBe(1);
    await store.clearPending([e.event_id]);
    expect(await store.pendingCount()).toBe(0);
    const events = await store.allEvents('1');
    expect(events.length).toBe(1);
    expect(events[0].event_id).toBe(e.event_id);
  });

  it('fold 重建：answer 事件 → 池位状态（票 12 契约直喂）', async () => {
    await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, 1_730_000_000_000);
    const state = await store.foldedState('1');
    expect(state.childId).toBe('1');
    expect(state.counters.answered).toBe(1);
    expect(state.counters.correct).toBe(1);
    expect(state.poolStates.length).toBe(1);
    expect(state.poolStates[0].lexicalEntryId).toBe('w_pencil');
    // word_pick_meaning 基线 6s，9000ms 慢对 → 留 P0（次日复习段重学）
    expect(state.poolStates[0].pool).toBe('P0');
    expect(state.poolStates[0].recentOutcomes.length).toBe(1);
  });

  it('appendRemote：他源事件入库且不进离线队列；乱序输入折叠终态不变', async () => {
    const later: LearningEvent = {
      event_id: 'ev-2',
      child_id: '1',
      device_id: 'dev-other',
      device_seq: 0,
      hlc: { physicalMs: 1_730_000_001_000, counter: 0 },
      occurred_at: '2026-10-25T10:00:01Z',
      type: 'answer',
      payload: { ...ANSWER_PAYLOAD, lexical_entry_id: 'w_give', correct: false },
    };
    const earlier: LearningEvent = {
      ...later,
      event_id: 'ev-1',
      hlc: { physicalMs: 1_730_000_000_500, counter: 0 },
      occurred_at: '2026-10-25T10:00:00Z',
      payload: { ...ANSWER_PAYLOAD },
    };
    // 乱序到达（先晚后早）
    const n = await store.appendRemote([later, earlier], 1_730_000_002_000);
    expect(n).toBe(2);
    expect(await store.pendingCount()).toBe(0); // 下行不进离线队列
    const state = await store.foldedState('1');
    expect(state.counters.answered).toBe(2);
    // 全序后到者生效：晚 HLC 的答错（w_give）保错误史
    const give = state.poolStates.find((s) => s.lexicalEntryId === 'w_give');
    expect(give?.errorStreak).toBe(1);
  });

  it('游标持久：setCursor/getCursor 往返＋HLC 上界快照', async () => {
    const c0 = await store.getCursor();
    expect(c0.cursor).toBe('0');
    expect(c0.serverHlcUpper).toBeNull();
    await store.setCursor('5', { physicalMs: 1_730_000_000_000, counter: 3 }, '2026-10-25T10:00:00Z');
    const c1 = await store.getCursor();
    expect(c1.cursor).toBe('5');
    expect(c1.serverHlcUpper).toEqual({ physicalMs: 1_730_000_000_000, counter: 3 });
    expect(c1.lastSyncedAt).toBe('2026-10-25T10:00:00Z');
  });

  it('时钟跨重启恢复：open 后 tick 晚于既有事件 max（HLC 不回退）', async () => {
    await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, 1_730_000_000_000);
    const maxHlc = (await store.allEvents('1'))[0].hlc;
    // 新 open（同一驱动＝重启恢复面；新时钟从同一基线上涨）
    const clock2 = mkClock(0); // 墙钟归零（模拟设备时钟落后）
    await LearningStore.open(driver, clock2, 'dev-test-1');
    const next = clock2.tick(1); // 仅 1ms 墙钟——必须仍晚于既有 max
    // HLC 全序比较（字典序，禁乘大数——1.73e18 超出 double 安全整数精度）
    const laterThanMax =
      next.physicalMs > maxHlc.physicalMs ||
      (next.physicalMs === maxHlc.physicalMs && next.counter > maxHlc.counter);
    expect(laterThanMax).toBe(true);
  });

  it('冷启动零事件：foldedState＝空物化状态（禁编造进度）', async () => {
    const state = await store.foldedState('1');
    expect(state.poolStates).toEqual([]);
    expect(state.counters).toEqual({ answered: 0, correct: 0, stars: 0, shards: 0 });
    expect(state.dailySummaries).toEqual([]);
    expect(fold([]).counters.answered).toBe(0);
  });

  it('首启冒烟门不过关即拒开（禁带病落库）', async () => {
    const badDriver = await createSqlJsDriver();
    // 注入一台 UPSERT 坏掉的驱动：DO NOTHING 不保首行（模拟 04 票担忧的解析 bug）
    const broken: StorageDriver = {
      name: 'broken-sim',
      exec: (sql) => badDriver.exec(sql),
      run: (sql, params) => {
        if (sql.includes('ON CONFLICT') && sql.includes('DO NOTHING')) {
          return badDriver.run(sql.replace(/ON CONFLICT \(.*?\) DO NOTHING/i, ''), params); // 退化为 REPLACE 语义（首行被改写）
        }
        return badDriver.run(sql, params);
      },
      select: (sql, params) => badDriver.select(sql, params),
    };
    await expect(LearningStore.open(broken, mkClock(), 'dev-bad')).rejects.toThrow(/冒烟门未通过/);
    // 正常驱动上冒烟向量确实能抓住该缺陷（门有效性自证）
    await expect(runSqliteSmokeVectors(broken)).resolves.toMatchObject({ pass: false });
  });
});
