/**
 * Ticket 12：折叠器 fold＋排序键全序化单测（golden 向量断言在 golden.test.ts）。
 *
 * 覆盖面：
 * 1. 排序键四级决胜（hlc 物理 → hlc 逻辑 → device_id → event_id）与完备性
 *    （不同 event_id 恒可比出非 0）＋信封校验；
 * 2. fold 状态机：作答链复用 applyAnswer（无第二套转移语义）、显式池位事件、
 *    未见词自动建卡、单孩子作用域、载荷校验（负/非整数奖励即违约）；
 * 3. 前向兼容：未知类型跳过＋计数、未登记题型落兜底基线；
 * 4. 每日摘要/调整投影：同日 last-wins（与到达序无关）；
 * 5. 性质：混合流乱序同终态、幂等重复投递、计数逐前缀非降（只增不减）、
 *    池位合法与输出确定性排序、occurred_at 完全不参与折叠；
 * 6. 票 09 契约：FoldedState 直接喂 buildDailyPlan（真调用，零形状转换）。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASELINE_MS,
  applyAnswer,
  applyPoolChange,
  buildDailyPlan,
  compareEvents,
  compareHlc,
  createNewCardState,
  fold,
  sortEvents,
} from '../src/index.js';
import type { DailyPlan, FoldCounters, LearningEvent, QuestionType } from '../src/index.js';
import { mulberry32 } from './helpers.js';

/* ------------------------------------------------------------------ */
/* 造数帮手                                                             */
/* ------------------------------------------------------------------ */

function ev(overrides: Partial<LearningEvent> = {}): LearningEvent {
  return {
    event_id: 'e-1',
    child_id: 'c1',
    device_id: 'dev-a',
    device_seq: 1,
    hlc: { physicalMs: 1000, counter: 0 },
    occurred_at: '2026-10-26T09:00:00Z',
    type: 'answer',
    payload: {},
    ...overrides,
  };
}

function answerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lexical_entry_id: 'w-1',
    question_type: 'word_pick_meaning',
    correct: true,
    reaction_ms: 1000,
    answered_on: '2026-10-26',
    ...overrides,
  };
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/* ------------------------------------------------------------------ */
/* 排序键全序化                                                          */
/* ------------------------------------------------------------------ */

describe('排序键全序化（hlc 物理 → hlc 逻辑 → device_id → event_id）', () => {
  it('compareHlc：物理毫秒优先，物理并列比逻辑计数', () => {
    expect(compareHlc({ physicalMs: 1, counter: 9 }, { physicalMs: 2, counter: 0 })).toBe(-1);
    expect(compareHlc({ physicalMs: 1, counter: 2 }, { physicalMs: 1, counter: 3 })).toBe(-1);
    expect(compareHlc({ physicalMs: 1, counter: 1 }, { physicalMs: 1, counter: 1 })).toBe(0);
  });

  it('compareEvents：四级决胜逐级生效（物理/逻辑/device_id/event_id）', () => {
    const base = ev({ event_id: 'e-a', device_id: 'dev-a', hlc: { physicalMs: 100, counter: 0 } });
    expect(compareEvents(base, ev({ event_id: 'e-z', device_id: 'dev-z', hlc: { physicalMs: 200, counter: 0 } }))).toBe(-1);
    expect(compareEvents(base, ev({ event_id: 'e-z', device_id: 'dev-a', hlc: { physicalMs: 100, counter: 1 } }))).toBe(-1);
    expect(compareEvents(base, ev({ event_id: 'e-z', device_id: 'dev-b', hlc: { physicalMs: 100, counter: 0 } }))).toBe(-1);
    expect(compareEvents(base, ev({ event_id: 'e-b', device_id: 'dev-a', hlc: { physicalMs: 100, counter: 0 } }))).toBe(-1);
    expect(compareEvents(base, base)).toBe(0);
  });

  it('排序键完备：event_id 不同的两事件永不比较相等（决胜键无缺失）', () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const shared = { child_id: 'c1', device_seq: 1, occurred_at: 'x', type: 'answer', payload: {} };
      const physicalMs = Math.floor(rnd() * 5);
      const counter = Math.floor(rnd() * 3);
      const deviceId = rnd() < 0.5 ? 'dev-a' : 'dev-b';
      const a: LearningEvent = { ...shared, event_id: `a-${i}`, device_id: deviceId, hlc: { physicalMs, counter } };
      const b: LearningEvent = { ...shared, event_id: `b-${i}`, device_id: deviceId, hlc: { physicalMs, counter } };
      expect(compareEvents(a, b)).not.toBe(0);
      expect(compareEvents(a, b)).toBe(-compareEvents(b, a));
    }
  });

  it('sortEvents：乱序输入 → 全序输出（相邻恒 ≤0），与到达顺序无关', () => {
    const events = [5000, 1000, 3000, 2000, 4000].map((p, i) =>
      ev({ event_id: `s-${i}`, hlc: { physicalMs: p, counter: 0 }, payload: answerPayload() }),
    );
    const sorted = sortEvents([events[2]!, events[0]!, events[4]!, events[1]!, events[3]!]);
    expect(sorted.map((e) => e.event_id)).toEqual(['s-1', 's-3', 's-2', 's-4', 's-0']);
    for (let i = 1; i < sorted.length; i++) {
      expect(compareEvents(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
    }
  });

  it('event_id 去重取全序首见（同 id 异容为契约违约，确定性取先到者）', () => {
    const early = ev({ event_id: 'dup-1', hlc: { physicalMs: 1000, counter: 0 }, payload: answerPayload({ correct: true }) });
    const lateSameId = ev({ event_id: 'dup-1', hlc: { physicalMs: 5000, counter: 0 }, payload: answerPayload({ correct: false }) });
    const folded = fold([lateSameId, early]); // 到达序与全序相反
    expect(folded.counters).toEqual({ answered: 1, correct: 1, stars: 0, shards: 0 });
  });

  it('信封校验：缺 id／坏 hlc（负数/非整数）／负 device_seq／空 occurred_at → throw', () => {
    expect(() => sortEvents([ev({ event_id: '' })])).toThrow();
    expect(() => sortEvents([ev({ hlc: { physicalMs: -1, counter: 0 } })])).toThrow();
    expect(() => sortEvents([ev({ hlc: { physicalMs: 1.5, counter: 0 } })])).toThrow();
    expect(() => sortEvents([ev({ hlc: { physicalMs: 1, counter: -2 } })])).toThrow();
    expect(() => sortEvents([ev({ device_seq: -1 })])).toThrow();
    expect(() => sortEvents([ev({ occurred_at: '' })])).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* fold 状态机                                                           */
/* ------------------------------------------------------------------ */

describe('fold：单词状态机', () => {
  it('作答折叠 ≡ applyAnswer 逐步重放（折叠复用调度转移，无第二套语义）', () => {
    const chain = [
      { lexical_entry_id: 'w-1', question_type: 'teach_picture_audio', correct: true, reaction_ms: 3000, answered_on: '2026-10-26' },
      { lexical_entry_id: 'w-1', question_type: 'audio_pick_picture', correct: true, reaction_ms: 2000, answered_on: '2026-10-27' },
      { lexical_entry_id: 'w-1', question_type: 'word_pick_meaning', correct: false, reaction_ms: 9000, answered_on: '2026-10-30' },
    ];
    const folded = fold(chain.map((p, i) => ev({ event_id: `r-${i}`, hlc: { physicalMs: 1000 * (i + 1), counter: 0 }, payload: { ...p } })));
    let manual = createNewCardState('c1', 'w-1', '2026-10-26');
    for (const p of chain) {
      manual = applyAnswer(manual, {
        lexicalEntryId: p.lexical_entry_id,
        questionType: p.question_type as QuestionType,
        correct: p.correct,
        reactionTimeMs: p.reaction_ms,
        answeredOn: p.answered_on,
      }).state;
    }
    expect(folded.poolStates).toEqual([manual]);
  });

  it('applyPoolChange：池位生效、到期按新池间隔、快对连击清零、错误连击/近3次保留、graduated 无到期', () => {
    const base = createNewCardState('c1', 'w-1', '2026-10-26');
    const withHistory = {
      ...base,
      fastStreak: 1,
      errorStreak: 2,
      recentOutcomes: [{ correct: false, fast: false, answeredOn: '2026-10-26' }],
    };
    const toP3 = applyPoolChange(withHistory, 'P3', '2026-10-26');
    expect(toP3.pool).toBe('P3');
    expect(toP3.dueDate).toBe('2026-11-02'); // +7
    expect(toP3.fastStreak).toBe(0);
    expect(toP3.errorStreak).toBe(2);
    expect(toP3.recentOutcomes).toHaveLength(1);
    expect(applyPoolChange(toP3, 'graduated', '2026-11-02').dueDate).toBeNull();
    expect(applyPoolChange(toP3, 'P0', '2026-11-02').dueDate).toBe('2026-11-02'); // P0 当日重学
    expect(applyPoolChange(toP3, 'P5', '2026-11-02').dueDate).toBe('2026-12-02'); // +30
  });

  it('未见词收到手动调级：自动建卡（P0）后设目标池，计数面不动', () => {
    const folded = fold([
      ev({ event_id: 'm-1', type: 'pool_promoted', payload: { lexical_entry_id: 'w-new', to_pool: 'P2', on: '2026-10-26', reason: 'parent_manual_adjust' } }),
    ]);
    expect(folded.poolStates).toHaveLength(1);
    expect(folded.poolStates[0]!.pool).toBe('P2');
    expect(folded.poolStates[0]!.dueDate).toBe('2026-10-29');
    expect(folded.counters).toEqual({ answered: 0, correct: 0, stars: 0, shards: 0 });
    expect(folded.dailySummaries).toHaveLength(0);
  });

  it('混入多个 child_id → throw（fold 为单孩子作用域，多孩由调用方分流）', () => {
    const events = [
      ev({ event_id: 'm-1', payload: answerPayload() }),
      ev({ event_id: 'm-2', child_id: 'c2', hlc: { physicalMs: 2000, counter: 0 }, payload: answerPayload() }),
    ];
    expect(() => fold(events)).toThrow(/mixed child_id/);
  });

  it('载荷校验：负数/非整数奖励、负反应时、坏日期 → throw（计数面无可减路径）', () => {
    expect(() => fold([ev({ payload: answerPayload({ stars_earned: -1 }) })])).toThrow();
    expect(() => fold([ev({ payload: answerPayload({ stars_earned: 1.5 }) })])).toThrow();
    expect(() => fold([ev({ payload: answerPayload({ shards_earned: -3 }) })])).toThrow();
    expect(() => fold([ev({ payload: answerPayload({ reaction_ms: -1 }) })])).toThrow();
    expect(() => fold([ev({ payload: answerPayload({ answered_on: '2026-13-99' }) })])).toThrow();
    expect(() => fold([ev({ type: 'pool_promoted', payload: { lexical_entry_id: 'w-1', to_pool: 'P9', on: '2026-10-26' } })])).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 前向兼容                                                              */
/* ------------------------------------------------------------------ */

describe('fold：前向兼容', () => {
  it('未知事件类型：跳过＋计数，不进任何状态面、不炸', () => {
    const folded = fold([
      ev({ event_id: 'u-1', type: 'future_telemetry', payload: { x: 1 } }),
      ev({ event_id: 'u-2', type: 'future_telemetry', payload: { x: 2 } }),
      ev({ event_id: 'u-3', type: 'another_future', payload: null }),
      ev({ event_id: 'u-4', payload: answerPayload() }),
    ]);
    expect(folded.unknownEventTypes).toEqual({ future_telemetry: 2, another_future: 1 });
    expect(folded.poolStates).toHaveLength(1); // 只有 u-4 的词
    expect(folded.counters.answered).toBe(1);
  });

  it('未登记题型作答：落兜底基线（DEFAULT_BASELINE_MS）不炸，照常升档', () => {
    const folded = fold([
      ev({ event_id: 'q-1', payload: answerPayload({ question_type: 'future_quiz_kind', reaction_ms: DEFAULT_BASELINE_MS - 1 }) }),
    ]);
    expect(folded.poolStates[0]!.pool).toBe('P1'); // 兜底基线内 → 快对升档
    expect(folded.counters.answered).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 每日摘要与调整投影                                                     */
/* ------------------------------------------------------------------ */

describe('fold：每日摘要与 daily_plan_adjusted 投影', () => {
  it('同日多份 daily_completed：全序后到者覆盖完成标记/用时（与到达序无关）', () => {
    const later = ev({
      event_id: 'dc-2',
      device_id: 'dev-b',
      hlc: { physicalMs: 9000, counter: 0 },
      type: 'daily_completed',
      payload: { date: '2026-10-26', completed_on_time: false, segment_seconds: { new_words: 100, review: 50 } },
    });
    const earlier = ev({
      event_id: 'dc-1',
      hlc: { physicalMs: 1000, counter: 0 },
      type: 'daily_completed',
      payload: { date: '2026-10-26', completed_on_time: true, segment_seconds: { new_words: 480, review: 260 } },
    });
    const folded = fold([later, earlier]); // 到达序相反
    expect(folded.dailySummaries).toHaveLength(1);
    expect(folded.dailySummaries[0]!.completedOnTime).toBe(false);
    expect(folded.dailySummaries[0]!.segmentSeconds).toEqual({ newWords: 100, review: 50 });
  });

  it('纯完成日（无作答）也产摘要行；作答聚合按日分桶', () => {
    const folded = fold([
      ev({ event_id: 'd-1', hlc: { physicalMs: 1000, counter: 0 }, type: 'daily_completed', payload: { date: '2026-10-26', completed_on_time: true, segment_seconds: { new_words: 600, review: 300 } } }),
      ev({ event_id: 'd-2', hlc: { physicalMs: 2000, counter: 0 }, payload: answerPayload({ answered_on: '2026-10-27' }) }),
    ]);
    expect(folded.dailySummaries.map((s) => s.date)).toEqual(['2026-10-26', '2026-10-27']);
    expect(folded.dailySummaries[0]).toEqual({
      date: '2026-10-26',
      answered: 0,
      correct: 0,
      completedOnTime: true,
      segmentSeconds: { newWords: 600, review: 300 },
      starsEarned: 0,
      shardsEarned: 0,
    });
  });

  it('daily_plan_adjusted：同日 last-wins、跨设备全序决胜，快照原样携带', () => {
    const mk = (id: string, device: string, p: number, to: number) =>
      ev({
        event_id: id,
        device_id: device,
        hlc: { physicalMs: p, counter: 0 },
        type: 'daily_plan_adjusted',
        payload: {
          date: '2026-10-27',
          from: 5,
          to,
          reasons: ['three_day_streak'],
          signal_snapshot: {
            date: '2026-10-26',
            answered: 10,
            correct: 9,
            accuracy: 0.9,
            completedOnTime: true,
            overtime: false,
            timeInBand: true,
            digestIndex: 0.95,
          },
        },
      });
    const folded = fold([mk('adj-2', 'dev-b', 9000, 4), mk('adj-1', 'dev-a', 1000, 6)]);
    expect(folded.planAdjustments).toHaveLength(1);
    expect(folded.planAdjustments[0]!.to).toBe(4); // 全序后到者（dev-b）胜，与到达序相反
    expect(folded.planAdjustments[0]!.type).toBe('daily_plan_adjusted');
    expect(folded.planAdjustments[0]!.childId).toBe('c1');
    expect(folded.planAdjustments[0]!.signalSnapshot.digestIndex).toBe(0.95);
  });
});

/* ------------------------------------------------------------------ */
/* 票 09 契约：FoldedState 直接喂 buildDailyPlan                          */
/* ------------------------------------------------------------------ */

describe('FoldedState → buildDailyPlan（票 09 契约，零形状转换）', () => {
  it('真调用：poolStates 与 dailySummaries 原样入参，产出合法 DailyPlan', () => {
    const folded = fold([
      ev({ event_id: 'b-1', hlc: { physicalMs: 1000, counter: 0 }, payload: answerPayload({ lexical_entry_id: 'w-hen', question_type: 'teach_picture_audio', correct: true, reaction_ms: 2000, answered_on: '2026-10-26' }) }),
      ev({ event_id: 'b-2', hlc: { physicalMs: 2000, counter: 0 }, payload: answerPayload({ lexical_entry_id: 'w-hen', question_type: 'audio_pick_picture', correct: false, reaction_ms: 9000, answered_on: '2026-10-26' }) }),
      ev({ event_id: 'b-3', hlc: { physicalMs: 3000, counter: 0 }, type: 'daily_completed', payload: { date: '2026-10-26', completed_on_time: true, segment_seconds: { new_words: 480, review: 260 } } }),
    ]);
    expect(folded.childId).toBe('c1');
    // 类型证明：DailySummary[] 直接作 readonly DayDigest[] 入参（编译通过＝形状零转换）
    const plan: DailyPlan = buildDailyPlan(
      { childId: 'c1', date: '2026-10-27', dailyNewWords: 5 },
      folded.poolStates,
      folded.dailySummaries,
    );
    expect(plan.date).toBe('2026-10-27');
    expect(plan.childId).toBe('c1');
    expect(plan.plannedNewWords).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(plan.reviewQueue)).toBe(true);
    // 昨日（10-26）作答 2 对 1：正确率 0.5 < 0.7 → 调节器惩罚生效（摘要真被消费）
    expect(plan.adjuster.value).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* 性质（混合事件流：作答/升池/降池/每日完成/调整/未知交错）               */
/* ------------------------------------------------------------------ */

const GEN_WORDS = ['w-x1', 'w-x2', 'w-x3'];
const GEN_DEVICES = ['dev-a', 'dev-b'];
const GEN_POOLS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated'];
const GEN_TYPES = ['answer', 'answer', 'answer', 'pool_promoted', 'pool_demoted', 'daily_completed', 'daily_plan_adjusted', 'future_telemetry'];

function genStream(seed: number, n: number): LearningEvent[] {
  const rnd = mulberry32(seed);
  let physical = 1000;
  const seqs: Record<string, number> = { 'dev-a': 0, 'dev-b': 0 };
  const events: LearningEvent[] = [];
  for (let i = 0; i < n; i++) {
    physical += Math.floor(rnd() * 500) + 1;
    const deviceId = GEN_DEVICES[Math.floor(rnd() * GEN_DEVICES.length)]!;
    seqs[deviceId] = seqs[deviceId]! + 1;
    const type = GEN_TYPES[Math.floor(rnd() * GEN_TYPES.length)]!;
    const word = GEN_WORDS[Math.floor(rnd() * GEN_WORDS.length)]!;
    const day = 20 + Math.floor(rnd() * 5); // 20-24（两位数日期，字符串减一天仍合法）
    const base = {
      event_id: `g-${seed}-${i}`,
      child_id: 'c1',
      device_id: deviceId,
      device_seq: seqs[deviceId]!,
      hlc: { physicalMs: physical, counter: Math.floor(rnd() * 3) },
      occurred_at: '2026-10-26T09:00:00Z',
    };
    if (type === 'answer') {
      events.push({
        ...base,
        type,
        payload: {
          lexical_entry_id: word,
          question_type: 'word_pick_meaning',
          correct: rnd() < 0.7,
          reaction_ms: Math.floor(rnd() * 12000),
          answered_on: `2026-10-${day}`,
          stars_earned: Math.floor(rnd() * 3),
        },
      });
    } else if (type === 'pool_promoted' || type === 'pool_demoted') {
      events.push({
        ...base,
        type,
        payload: { lexical_entry_id: word, to_pool: GEN_POOLS[Math.floor(rnd() * GEN_POOLS.length)]!, on: `2026-10-${day}` },
      });
    } else if (type === 'daily_completed') {
      events.push({
        ...base,
        type,
        payload: {
          date: `2026-10-${day}`,
          completed_on_time: rnd() < 0.8,
          segment_seconds: { new_words: Math.floor(rnd() * 600), review: Math.floor(rnd() * 300) },
          shards_earned: Math.floor(rnd() * 2),
        },
      });
    } else if (type === 'daily_plan_adjusted') {
      events.push({
        ...base,
        type,
        payload: {
          date: `2026-10-${day}`,
          from: 3 + Math.floor(rnd() * 7),
          to: 3 + Math.floor(rnd() * 7),
          reasons: ['three_day_streak'],
          signal_snapshot: {
            date: `2026-10-${day - 1}`,
            answered: 10,
            correct: 9,
            accuracy: 0.9,
            completedOnTime: true,
            overtime: false,
            timeInBand: true,
            digestIndex: 0.95,
          },
        },
      });
    } else {
      events.push({ ...base, type, payload: { note: 'future' } });
    }
  }
  return events;
}

function referenceCounts(events: readonly LearningEvent[]): FoldCounters {
  const seen = new Set<string>();
  const counters: FoldCounters = { answered: 0, correct: 0, stars: 0, shards: 0 };
  for (const e of sortEvents(events)) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    if (e.type === 'answer') {
      counters.answered += 1;
      const p = e.payload as { correct?: unknown; stars_earned?: number };
      if (p.correct === true) counters.correct += 1;
      counters.stars += p.stars_earned ?? 0;
    } else if (e.type === 'daily_completed') {
      const p = e.payload as { stars_earned?: number; shards_earned?: number };
      counters.stars += p.stars_earned ?? 0;
      counters.shards += p.shards_earned ?? 0;
    }
  }
  return counters;
}

describe('性质：混合事件流', () => {
  it('乱序到达同终态：30 种子×各 20 次打乱，fold 恒等基线', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const events = genStream(seed, 50);
      const baseline = fold(events);
      const rnd = mulberry32(seed * 7919);
      for (let k = 0; k < 20; k++) {
        expect(fold(shuffled(events, rnd))).toEqual(baseline);
      }
    }
  });

  it('幂等重复投递：事件集整体重复 3 遍折叠同态（15 种子）', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const events = genStream(seed, 40);
      const once = fold(events);
      expect(fold([...events, ...events, ...events])).toEqual(once);
    }
  });

  it('计数只增不减：任意前缀折叠的计数逐前缀非降（含降池/手动调级事件在内）', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const events = genStream(seed, 60);
      let prev: FoldCounters = { answered: 0, correct: 0, stars: 0, shards: 0 };
      for (let cut = 0; cut <= events.length; cut += 5) {
        const c = fold(events.slice(0, cut)).counters;
        expect(c.answered).toBeGreaterThanOrEqual(prev.answered);
        expect(c.correct).toBeGreaterThanOrEqual(prev.correct);
        expect(c.stars).toBeGreaterThanOrEqual(prev.stars);
        expect(c.shards).toBeGreaterThanOrEqual(prev.shards);
        prev = c;
      }
    }
  });

  it('计数与独立重算对账：answered/correct/stars/shards 逐项相等（20 种子）', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const events = genStream(seed, 60);
      expect(fold(events).counters).toEqual(referenceCounts(events));
    }
  });

  it('occurred_at 完全不参与折叠：墙钟乱写终态不变', () => {
    const events = genStream(7, 40);
    const baseline = fold(events);
    const rewritten = events.map((e, i) => ({
      ...e,
      occurred_at: i % 2 === 0 ? '1970-01-01T00:00:00Z' : '2099-12-31T23:59:59Z',
    }));
    expect(fold(rewritten)).toEqual(baseline);
  });

  it('输出确定性：池位合法、poolStates 按词 id 升序无重复、dailySummaries 按日期升序', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const folded = fold(genStream(seed, 60));
      for (const s of folded.poolStates) expect(GEN_POOLS).toContain(s.pool);
      const ids = folded.poolStates.map((s) => s.lexicalEntryId);
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      const dates = folded.dailySummaries.map((d) => d.date);
      expect([...dates].sort()).toEqual(dates);
    }
  });
});
