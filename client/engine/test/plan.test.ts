/**
 * US-04：每日配比/周末/顺延/截断（E4）/关内三段顺序。
 * 含票面点名边界用例：「周末无新词」。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFERRED_REVIEW_CAP,
  REVIEW_CAPACITY_MAX,
  clampDailyNewWords,
  planDailyLevel,
  reviewCapacityFor,
} from '../src/index.js';
import type { CardPoolState, IsoDate } from '../src/index.js';
import { MON, SAT, SUN, card, mulberry32 } from './helpers.js';

/** 造一批到期复习卡（P1-P5）。 */
function dueReviews(ids: string[], opts: { due?: IsoDate; errors?: number; pool?: CardPoolState['pool'] } = {}): CardPoolState[] {
  const rnd = mulberry32(42);
  return ids.map((id, i) =>
    card({
      lexicalEntryId: id,
      pool: opts.pool ?? (['P1', 'P2', 'P3', 'P4', 'P5'] as const)[i % 5],
      dueDate: opts.due ?? MON,
      errorStreak: opts.errors ?? Math.floor(rnd() * 3),
    }),
  );
}

/** 造一批 P0 新词卡（新鲜建卡，无作答历史）。 */
function freshNew(ids: string[], date: IsoDate = MON): CardPoolState[] {
  return ids.map((id) =>
    card({ lexicalEntryId: id, pool: 'P0', dueDate: date, recentOutcomes: [] }),
  );
}

describe('配比（R4：新词按档案 3-10，新:旧≈1:3）', () => {
  it('档案 5 → 复习配额 15（1:3，落在 15-18 带）', () => {
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: [...freshNew(['n1', 'n2', 'n3', 'n4', 'n5']), ...dueReviews(['r1', 'r2', 'r3'])],
    });
    expect(plan.newCount).toBe(5); // 档案 5，5 张 P0 全可用
    expect(plan.reviewCapacity).toBe(15);
  });

  it('新词充足时按档案配比：5→15、6→18、7→18、10→18、3→9（1:3，带上限 18）', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i + 1}`);
    for (const [dailyNew, expectedCap] of [
      [5, 15],
      [6, 18],
      [7, 18],
      [10, 18],
      [3, 9],
    ] as const) {
      const plan = planDailyLevel({
        date: MON,
        profile: { dailyNewWords: dailyNew },
        poolStates: [...freshNew(ids), ...dueReviews(['r1'])],
      });
      expect(plan.newCount).toBe(dailyNew);
      expect(plan.reviewCapacity).toBe(expectedCap);
    }
  });

  it('档案越界收敛进 3-10（R4 家长可调区间）', () => {
    expect(clampDailyNewWords(0)).toBe(3);
    expect(clampDailyNewWords(2)).toBe(3);
    expect(clampDailyNewWords(15)).toBe(10);
    expect(clampDailyNewWords(7.6)).toBe(8);
  });

  it('容量规则函数：catch-up 日 20 优先于一切', () => {
    expect(reviewCapacityFor(0, true)).toBe(DEFERRED_REVIEW_CAP);
    expect(reviewCapacityFor(5, true)).toBe(DEFERRED_REVIEW_CAP);
    expect(reviewCapacityFor(0, false)).toBe(REVIEW_CAPACITY_MAX);
  });
});

describe('票面边界用例「周末无新词」', () => {
  it.each([SAT, SUN])('%s 周末：新词 0，只复习（配额取带上沿 18）', (weekendDay) => {
    const plan = planDailyLevel({
      date: weekendDay,
      profile: { dailyNewWords: 8 },
      poolStates: [...freshNew(['n1', 'n2', 'n3'], weekendDay), ...dueReviews(['r1', 'r2', 'r3'], { due: weekendDay })],
    });
    expect(plan.isWeekend).toBe(true);
    expect(plan.newCount).toBe(0);
    expect(plan.segments[1].cards).toEqual([]); // 教学段空
    expect(plan.reviewCapacity).toBe(18);
    expect(plan.reviewCount).toBe(3);
  });

  it('工作日无新词可用 → 同样纯复习，配额 18', () => {
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: dueReviews(['r1', 'r2']),
    });
    expect(plan.isWeekend).toBe(false);
    expect(plan.newCount).toBe(0);
    expect(plan.reviewCapacity).toBe(18);
  });
});

describe('E4 截断：按「到期时间＋错误次数」优先级，未竟卡顺延次日', () => {
  it('超容截断排序语义：到期早者优先，同到期错误多者优先，词 id 兜底', () => {
    const states: CardPoolState[] = [
      card({ lexicalEntryId: 'wD', pool: 'P2', dueDate: '2026-10-24', errorStreak: 5 }),
      card({ lexicalEntryId: 'wC', pool: 'P1', dueDate: '2026-10-22', errorStreak: 1 }),
      card({ lexicalEntryId: 'wB', pool: 'P3', dueDate: '2026-10-22', errorStreak: 3 }),
      card({ lexicalEntryId: 'wA', pool: 'P1', dueDate: '2026-10-20', errorStreak: 0 }),
      card({ lexicalEntryId: 'wE', pool: 'P5', dueDate: '2026-10-26', errorStreak: 9 }),
    ];
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: states, // 无 P0 → 纯复习日容量 18，5 张不触发截断，验证排序
    });
    expect(plan.reviewCount).toBe(5);
    expect(plan.segments[0].cards.map((c) => c.lexicalEntryId)).toEqual(['wA', 'wB', 'wC', 'wD', 'wE']);
  });

  it('25 张到期复习＋5 张新词（档案 5）→ 截到 15 张，10 张进 deferred（truncationApplied）', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
    const states = [
      ...freshNew(['n1', 'n2', 'n3', 'n4', 'n5']), // 有新词 → 容量 = 5×3 = 15
      ...ids.map((id, i) =>
        card({ lexicalEntryId: id, pool: 'P1', dueDate: isoPlus(MON, -i), errorStreak: 0 }),
      ),
    ];
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: states,
    });
    expect(plan.truncationApplied).toBe(true);
    expect(plan.reviewCount).toBe(15);
    expect(plan.deferred).toHaveLength(10);
    // 最久未复习（到期最早）的先入选：r25 到期 MON-24 最久，r01 到期 MON 最近
    expect(plan.segments[0].cards[0]!.lexicalEntryId).toBe('r25');
    expect(plan.segments[0].cards[14]!.lexicalEntryId).toBe('r11');
    // 顺延卡保留原到期时间（不惩罚：不后移、不丢失）
    expect(plan.deferred[0]!.lexicalEntryId).toBe('r10');
    expect(plan.deferred[0]!.dueDate).toBe(isoPlus(MON, -9));
  });

  it('同到期日按错误次数截断：连错多的卡优先入围', () => {
    const states = [
      card({ lexicalEntryId: 'low-err', pool: 'P1', dueDate: MON, errorStreak: 0 }),
      card({ lexicalEntryId: 'high-err', pool: 'P2', dueDate: MON, errorStreak: 4 }),
      card({ lexicalEntryId: 'mid-err', pool: 'P3', dueDate: MON, errorStreak: 2 }),
      card({ lexicalEntryId: 'filler-1', pool: 'P4', dueDate: isoPlus(MON, 1), errorStreak: 0 }),
      card({ lexicalEntryId: 'filler-2', pool: 'P5', dueDate: isoPlus(MON, 1), errorStreak: 0 }),
      card({ lexicalEntryId: 'filler-3', pool: 'P1', dueDate: isoPlus(MON, 1), errorStreak: 0 }),
    ];
    // 档案 3 → 容量 9，6 张候选全入围不截断；断言排序：同日三张按错误次数降序在前
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 3 },
      poolStates: states,
    });
    const top3 = plan.segments[0].cards.slice(0, 3).map((c) => c.lexicalEntryId);
    expect(top3).toEqual(['high-err', 'mid-err', 'low-err']); // 同日：错误多者优先
  });

  it('跳过顺延不惩罚：次日 catch-up 容量 20，顺延卡按原到期日参与优先级', () => {
    // 昨日 25 张到期只做了 15，10 张顺延；今日又有新到期
    const deferredYesterday = Array.from({ length: 10 }, (_, i) =>
      card({ lexicalEntryId: `d${i}`, pool: 'P1', dueDate: '2026-10-26', errorStreak: 0 }),
    );
    const dueToday = Array.from({ length: 8 }, (_, i) =>
      card({ lexicalEntryId: `t${i}`, pool: 'P2', dueDate: '2026-10-27', errorStreak: 0 }),
    );
    const plan = planDailyLevel({
      date: '2026-10-27',
      profile: { dailyNewWords: 5 },
      poolStates: [...deferredYesterday, ...dueToday],
      previousDaySkipped: true,
    });
    expect(plan.reviewCapacity).toBe(20);
    expect(plan.reviewCount).toBe(18); // 18 < 20 全部入围
    expect(plan.deferred).toHaveLength(0);
    // 昨日顺延卡（到期更早）排在前段
    expect(plan.segments[0].cards[0]!.lexicalEntryId).toBe('d0');
    expect(plan.segments[0].cards[9]!.lexicalEntryId).toBe('d9');
  });

  it('顺延超 20 张同样截断（上限是硬顶）', () => {
    const states = Array.from({ length: 30 }, (_, i) =>
      card({ lexicalEntryId: `o${String(i).padStart(2, '0')}`, pool: 'P1', dueDate: '2026-10-20', errorStreak: 0 }),
    );
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: states,
      previousDaySkipped: true,
    });
    expect(plan.reviewCapacity).toBe(20);
    expect(plan.reviewCount).toBe(20);
    expect(plan.deferred).toHaveLength(10);
  });
});

describe('关内三段顺序与段内容（R4：复习段→教学段→boss 段）', () => {
  it('段顺序固定为 review→teach→boss；boss 段＝本关新词（教学段词表）', () => {
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: [
        ...freshNew(['n1', 'n2', 'n3']),
        ...dueReviews(['r1', 'r2', 'r3', 'r4']),
      ],
    });
    expect(plan.segments.map((s) => s.kind)).toEqual(['review', 'teach', 'boss']);
    expect(plan.segments[1].cards.map((c) => c.lexicalEntryId)).toEqual(['n1', 'n2', 'n3']);
    expect(plan.segments[2].cards.map((c) => c.lexicalEntryId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('重学卡（P0 有作答历史）进教学段且排在新词之前，不计入新词数', () => {
    const relearned = card({
      lexicalEntryId: 'relearn-w',
      pool: 'P0',
      dueDate: MON, // 当日答错留池重学
      recentOutcomes: [{ correct: false, fast: false, answeredOn: MON }],
      errorStreak: 1,
    });
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 2 }, // 越界配置收敛到 3（R4 家长可调 3-10）
      poolStates: [relearned, ...freshNew(['n1', 'n2', 'n3', 'n4'])],
    });
    expect(plan.segments[1].cards.map((c) => c.lexicalEntryId)).toEqual(['relearn-w', 'n1', 'n2', 'n3']);
    expect(plan.newCount).toBe(3); // 新词数=3（收敛后配额），重学卡是第 4 张、不占配额
  });

  it('暂停卡不进任何段；毕业池抽样卡（设有到期日）进复习段', () => {
    const paused = card({ lexicalEntryId: 'paused-w', pool: 'P2', dueDate: MON, paused: true });
    const sampled = card({ lexicalEntryId: 'grad-w', pool: 'graduated', dueDate: MON, graduatedSampledMonth: '2026-10' });
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 3 },
      poolStates: [paused, sampled, ...freshNew(['n1'])],
    });
    const reviewIds = plan.segments[0].cards.map((c) => c.lexicalEntryId);
    expect(reviewIds).toContain('grad-w');
    expect(reviewIds).not.toContain('paused-w');
    const allIds = plan.segments.flatMap((s) => s.cards.map((c) => c.lexicalEntryId));
    expect(allIds).not.toContain('paused-w');
  });

  it('音近约束接入计划（R6）：冲突候选当日不引入，重学卡不受限', () => {
    const nearPairs: Array<[string, string]> = [['cat', 'cap']];
    const plan = planDailyLevel({
      date: MON,
      profile: { dailyNewWords: 5 },
      poolStates: [...freshNew(['cat', 'cap', 'dog'])],
      nearSound: { pairs: nearPairs, introDates: {} },
    });
    // cat 先引入（同批记当日），cap 与 cat 音近且间隔 0 < 3 → 挡下
    expect(plan.newCount).toBe(2);
    const teachIds = plan.segments[1].cards.map((c) => c.lexicalEntryId);
    expect(teachIds).toEqual(['cat', 'dog']);
  });
});

describe('非法输入', () => {
  it('非法日期抛错', () => {
    expect(() =>
      planDailyLevel({ date: '2026-13-01', profile: { dailyNewWords: 5 }, poolStates: [] }),
    ).toThrow();
  });
});

function isoPlus(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
