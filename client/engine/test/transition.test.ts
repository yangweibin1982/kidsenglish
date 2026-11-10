/**
 * US-03：七池升退档/毕业判定矩阵逐格单测（正误×反应时×池位）。
 * 含票面点名的边界用例：「答错降档后再升」「P5 一快一慢不毕业」。
 */
import { describe, expect, it } from 'vitest';

import {
  GRADUATION_REQUIRED_FAST_ROUNDS,
  POOL_INTERVALS_DAYS,
  applyAnswer,
  createNewCardState,
  resolveBaselines,
} from '../src/index.js';
import type { CardPoolState, PoolId } from '../src/index.js';
import { MON, answer, card } from './helpers.js';

/** 池位推进日历：从 MON 起步的快对链，校验每格转移与到期间隔。 */
describe('升档矩阵（快对：答对且反应时 ≤ 题型基线）', () => {
  const cases: Array<{ from: PoolId; to: PoolId; gapDays: number }> = [
    { from: 'P0', to: 'P1', gapDays: 1 },
    { from: 'P1', to: 'P2', gapDays: 3 },
    { from: 'P2', to: 'P3', gapDays: 7 },
    { from: 'P3', to: 'P4', gapDays: 14 },
    { from: 'P4', to: 'P5', gapDays: 30 },
  ];

  for (const { from, to, gapDays } of cases) {
    it(`${from} 快对 → ${to}，到期 D+${gapDays}（R3 间隔）`, () => {
      const state = card({ pool: from, dueDate: MON, fastStreak: 2 });
      const result = applyAnswer(state, answer({ answeredOn: MON, reactionTimeMs: 1000 }));
      expect(result.state.pool).toBe(to);
      expect(result.transition.kind).toBe('promote');
      expect(result.transition.nextDueDate).toBe(
        // 到期 = 作答日 + 新池间隔
        isoPlus(MON, POOL_INTERVALS_DAYS[to as keyof typeof POOL_INTERVALS_DAYS] ?? gapDays),
      );
      // 进入新池，快对连击从 0 起算（毕业要求的是本池轮数）
      expect(result.state.fastStreak).toBe(0);
      expect(result.state.errorStreak).toBe(0);
      expect(result.transition.fast).toBe(true);
      expect(result.transition.followUps.appendVariationToday).toBe(false);
    });
  }

  it('到期间隔常量表与 R3 原文一致：P1=1 P2=3 P3=7 P4=14 P5=30', () => {
    expect(POOL_INTERVALS_DAYS).toEqual({ P1: 1, P2: 3, P3: 7, P4: 14, P5: 30 });
  });

  it('P0 建卡落在当日（当日末小复习的前置）', () => {
    const fresh = createNewCardState('child-1', 'w-new', MON);
    expect(fresh.pool).toBe('P0');
    expect(fresh.dueDate).toBe(MON);
    expect(fresh.variationTier).toBe('standard');
  });
});

describe('降档矩阵（答错：降一档，E1 当日追加变式题回教学重学形态）', () => {
  const cases: Array<{ from: PoolId; to: PoolId; gapDays: number | 'same-day' }> = [
    { from: 'P0', to: 'P0', gapDays: 'same-day' }, // 留池重学
    { from: 'P1', to: 'P1', gapDays: 1 }, // 降档地板：P1 自环
    { from: 'P2', to: 'P1', gapDays: 1 },
    { from: 'P3', to: 'P2', gapDays: 3 },
    { from: 'P4', to: 'P3', gapDays: 7 },
    { from: 'P5', to: 'P4', gapDays: 14 },
  ];

  for (const { from, to, gapDays } of cases) {
    it(`${from} 答错 → ${to}${gapDays === 'same-day' ? '（当日）' : `，到期 D+${gapDays}`}`, () => {
      const state = card({ pool: from, errorStreak: 1, fastStreak: 1 });
      const result = applyAnswer(state, answer({ correct: false, answeredOn: MON }));
      expect(result.state.pool).toBe(to);
      expect(result.state.errorStreak).toBe(2);
      expect(result.state.fastStreak).toBe(0);
      if (gapDays === 'same-day') {
        expect(result.transition.nextDueDate).toBe(MON);
      } else {
        expect(result.transition.nextDueDate).toBe(isoPlus(MON, gapDays));
      }
      // E1：答错当日追加 1 道变式题，且回教学重学形态（R5）
      expect(result.transition.followUps).toEqual({
        appendVariationToday: true,
        form: 'relearn',
      });
    });
  }

  it('毕业池答错 → 回 P5 重学（到期 D+30）【解释性默认，见报告】', () => {
    const state = card({ pool: 'graduated', dueDate: null, graduatedSampledMonth: '2026-10' });
    const result = applyAnswer(state, answer({ correct: false }));
    expect(result.state.pool).toBe('P5');
    expect(result.state.dueDate).toBe(isoPlus(MON, 30));
    expect(result.state.graduatedSampledMonth).toBeNull();
    expect(result.transition.kind).toBe('demote');
  });

  it('票面边界用例「答错降档后再升」：P3 答错降到 P2，快对再升回 P3', () => {
    let state = card({ pool: 'P3', dueDate: MON });
    const wrong = applyAnswer(state, answer({ correct: false, answeredOn: MON }));
    expect(wrong.state.pool).toBe('P2');
    expect(wrong.transition.nextDueDate).toBe(isoPlus(MON, 3));
    state = wrong.state;
    const recover = applyAnswer(state, answer({ correct: true, answeredOn: isoPlus(MON, 3), reactionTimeMs: 1200 }));
    expect(recover.state.pool).toBe('P3');
    expect(recover.transition.kind).toBe('promote');
    expect(recover.transition.nextDueDate).toBe(isoPlus(isoPlus(MON, 3), 7));
  });
});

describe('答对但慢（rt > 基线）：留池不升不降', () => {
  const cases: Array<{ from: PoolId; due: string | null }> = [
    { from: 'P0', due: MON },
    { from: 'P1', due: MON },
    { from: 'P2', due: MON },
    { from: 'P3', due: MON },
    { from: 'P4', due: MON },
    { from: 'P5', due: MON },
  ];

  for (const { from } of cases) {
    it(`${from} 慢对 → 留在 ${from}`, () => {
      const state = card({ pool: from, dueDate: MON });
      // audio_pick_picture 基线 5000ms → 8000ms 属慢对
      const result = applyAnswer(state, answer({ reactionTimeMs: 8000, answeredOn: MON }));
      expect(result.state.pool).toBe(from);
      expect(result.transition.kind).toBe('stay');
      expect(result.transition.fast).toBe(false);
      if (from === 'P0') {
        expect(result.transition.nextDueDate).toBe(MON); // 教学循环当日再练
      } else {
        expect(result.transition.nextDueDate).toBe(isoPlus(MON, POOL_INTERVALS_DAYS[from as keyof typeof POOL_INTERVALS_DAYS]));
      }
    });
  }

  it('毕业池慢对 → 留在毕业池（维护走抽样，无到期日）', () => {
    const state = card({ pool: 'graduated', dueDate: null });
    const result = applyAnswer(state, answer({ reactionTimeMs: 9000 }));
    expect(result.state.pool).toBe('graduated');
    expect(result.transition.nextDueDate).toBeNull();
    expect(result.state.dueDate).toBeNull();
  });
});

describe('快对判定边界（题型分基线，基线处含边界）', () => {
  it('rt 恰好等于基线 → 快对；基线+1ms → 慢对', () => {
    const state = card({ pool: 'P1' });
    const atBaseline = applyAnswer(state, answer({ reactionTimeMs: 5000 }));
    expect(atBaseline.transition.fast).toBe(true);
    expect(atBaseline.state.pool).toBe('P2');
    const overBaseline = applyAnswer(state, answer({ reactionTimeMs: 5001 }));
    expect(overBaseline.transition.fast).toBe(false);
    expect(overBaseline.state.pool).toBe('P1');
  });

  it('同反应时在不同题型下判定不同（题型分基线）', () => {
    const state = card({ pool: 'P1' });
    // 7000ms：听音选图（基线 5000）慢；全键盘拼写（基线 18000）快
    const slow = applyAnswer(state, answer({ questionType: 'audio_pick_picture', reactionTimeMs: 7000 }));
    expect(slow.transition.fast).toBe(false);
    const fast = applyAnswer(state, answer({ questionType: 'spelling_full_keyboard', reactionTimeMs: 7000 }));
    expect(fast.transition.fast).toBe(true);
  });

  it('基线覆盖表可调：覆盖后判定随新基线走', () => {
    const state = card({ pool: 'P1' });
    const baselines = resolveBaselines({ audio_pick_picture: 8000 });
    const result = applyAnswer(state, answer({ reactionTimeMs: 7000 }), baselines);
    expect(result.transition.fast).toBe(true);
  });
});

describe('毕业判定（R3：P5 连续 2 轮快对）', () => {
  it('P5 连续两轮快对 → 毕业，到期清空', () => {
    let state = card({ pool: 'P5', dueDate: MON });
    const round1 = applyAnswer(state, answer({ questionType: 'spelling_full_keyboard', answeredOn: MON, reactionTimeMs: 4000 }));
    expect(round1.state.pool).toBe('P5');
    expect(round1.state.fastStreak).toBe(1);
    expect(round1.transition.graduated).toBe(false);
    expect(round1.transition.nextDueDate).toBe(isoPlus(MON, 30));
    state = round1.state;
    const round2 = applyAnswer(state, answer({ questionType: 'spelling_full_keyboard', answeredOn: isoPlus(MON, 30), reactionTimeMs: 5000 }));
    expect(round2.state.pool).toBe('graduated');
    expect(round2.transition.graduated).toBe(true);
    expect(round2.transition.kind).toBe('graduate');
    expect(round2.state.dueDate).toBeNull();
    expect(round2.transition.nextDueDate).toBeNull();
  });

  it('票面边界用例「P5 一快一慢不毕业」：慢对打断连击并清零', () => {
    let state = card({ pool: 'P5', dueDate: MON });
    const fast1 = applyAnswer(state, answer({ answeredOn: MON }));
    expect(fast1.state.fastStreak).toBe(1);
    state = fast1.state;
    const slow = applyAnswer(state, answer({ reactionTimeMs: 20_000, answeredOn: isoPlus(MON, 30) }));
    expect(slow.state.pool).toBe('P5');
    expect(slow.state.fastStreak).toBe(0);
    expect(slow.transition.graduated).toBe(false);
    state = slow.state;
    const fast2 = applyAnswer(state, answer({ answeredOn: isoPlus(MON, 60) }));
    // 重新计 1 轮，仍未毕业
    expect(fast2.state.fastStreak).toBe(1);
    expect(fast2.transition.graduated).toBe(false);
  });

  it('P5 答错同样打断连击（降到 P4），再升回 P5 后从 0 轮重计', () => {
    let state = card({ pool: 'P5', dueDate: MON, fastStreak: 1 });
    const wrong = applyAnswer(state, answer({ correct: false, answeredOn: MON }));
    expect(wrong.state.pool).toBe('P4');
    expect(wrong.state.fastStreak).toBe(0);
    state = wrong.state;
    const back = applyAnswer(state, answer({ answeredOn: isoPlus(MON, 7) }));
    expect(back.state.pool).toBe('P5');
    expect(back.state.fastStreak).toBe(0); // 回到 P5 不继承旧连击
    expect(back.transition.graduated).toBe(false);
  });

  it('P4 快对进 P5 的那一次不计入 P5 轮数（毕业轮数从 P5 起算）', () => {
    const state = card({ pool: 'P4', dueDate: MON, fastStreak: 9 });
    const enter = applyAnswer(state, answer({ answeredOn: MON }));
    expect(enter.state.pool).toBe('P5');
    expect(enter.state.fastStreak).toBe(0);
    const round1 = applyAnswer(enter.state, answer({ answeredOn: isoPlus(MON, 30) }));
    expect(round1.state.fastStreak).toBe(1);
    expect(round1.transition.graduated).toBe(false);
  });

  it('毕业常量：连击门槛 = 2', () => {
    expect(GRADUATION_REQUIRED_FAST_ROUNDS).toBe(2);
  });

  it('已处毕业态且连击≥1 的 P5 卡再快对直接毕业（连击语义一致性）', () => {
    const state = card({ pool: 'P5', fastStreak: 1, dueDate: MON });
    const result = applyAnswer(state, answer({ answeredOn: MON }));
    expect(result.transition.graduated).toBe(true);
  });
});

describe('熟练度分（R3：正误×反应时，题型分基线）', () => {
  it('答错 → 0；rt=0 → 1；rt=基线 → 0.5；慢对单调递减且低于 0.5', () => {
    expect(applyAnswer(card(), answer({ correct: false })).transition.masteryScore).toBe(0);
    const m0 = applyAnswer(card(), answer({ reactionTimeMs: 0 })).transition.masteryScore;
    expect(m0).toBe(1);
    const mBase = applyAnswer(card(), answer({ reactionTimeMs: 5000 })).transition.masteryScore;
    expect(mBase).toBe(0.5);
    const mSlow1 = applyAnswer(card(), answer({ reactionTimeMs: 7500 })).transition.masteryScore;
    const mSlow2 = applyAnswer(card(), answer({ reactionTimeMs: 9000 })).transition.masteryScore;
    expect(mSlow1).toBe(0.25);
    expect(mSlow2).toBeLessThan(mSlow1);
    expect(mSlow2).toBeGreaterThan(0);
  });
});

describe('连击记账与纯函数性', () => {
  it('错误连击累计、答对清零', () => {
    let state = card({ pool: 'P1' });
    for (let i = 0; i < 3; i++) {
      const r = applyAnswer(state, answer({ correct: false, answeredOn: isoPlus(MON, i) }));
      state = r.state;
      expect(state.errorStreak).toBe(i + 1);
    }
    const ok = applyAnswer(state, answer({ correct: true, answeredOn: isoPlus(MON, 5) }));
    expect(ok.state.errorStreak).toBe(0);
  });

  it('不修改入参状态（不可变纯函数）', () => {
    const state: CardPoolState = card({ pool: 'P2', recentOutcomes: [{ correct: true, fast: true, answeredOn: '2026-10-01' }] });
    const frozen = Object.freeze({ ...state, recentOutcomes: Object.freeze([...state.recentOutcomes]) });
    const snapshot = JSON.stringify(frozen);
    const result = applyAnswer(frozen as CardPoolState, answer({ answeredOn: MON }));
    expect(JSON.stringify(frozen)).toBe(snapshot);
    expect(result.state).not.toBe(frozen);
    expect(result.state.pool).toBe('P3');
  });

  it('非法输入抛错：词不匹配 / 负反应时 / 非法日期', () => {
    expect(() => applyAnswer(card({ lexicalEntryId: 'w1' }), answer({ lexicalEntryId: 'w2' }))).toThrow();
    expect(() => applyAnswer(card(), answer({ reactionTimeMs: -1 }))).toThrow();
    expect(() => applyAnswer(card(), answer({ reactionTimeMs: Number.NaN }))).toThrow();
    expect(() => applyAnswer(card(), answer({ answeredOn: '2026/10/26' }))).toThrow();
    expect(() => applyAnswer(card(), answer({ answeredOn: '2026-02-30' }))).toThrow();
    expect(() => createNewCardState('c', 'w', 'not-a-date')).toThrow();
  });
});

/** ISO 日期加 n 天（测试本地实现，与引擎实现互为对照）。 */
function isoPlus(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
