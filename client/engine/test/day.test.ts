/**
 * Ticket 09：day 层编排＋三信号自适应调节器（spec v1.1 S9）。
 *
 * 覆盖面（票面 VALIDATE）：
 * 1. 调整规则逐条（+1 / -1 / ±1 / 带 [3,10] / 天花板 / 锁定）各 ≥2 例，
 *    测试名含规则字面量可反查；
 * 2. 池分摊：单元用例（归一化水填/封顶回流/决胜序）＋总和守恒性质；
 * 3. 接口契约（Ticket 11 消费）：entryId/pool/form/dueReason、
 *    P0-P2=plain、P3+=shooting，导出类型直接 import；
 * 4. 性质：重放确定性（同输入必同输出）；连续 100 天随机行为
 *    单日调整幅度 ≤1 且终值在带内。
 */
import { describe, expect, it } from 'vitest';

import {
  ADJUSTER_STREAK_DAYS,
  ADJUSTER_STEP,
  DIGEST_ACCURACY_FLOOR,
  DIGEST_PASS_THRESHOLD,
  DIGEST_WEIGHTS,
  NEW_SEGMENT_BUDGET_SECONDS,
  PLAIN_REVIEW_EST_SECONDS,
  POOL_REVIEW_WEIGHTS,
  REVIEW_SEGMENT_BUDGET_SECONDS,
  SHOOTING_REVIEW_EST_SECONDS,
  addDays,
  allocateReviewQuota,
  buildDailyPlan,
  compareDailyReviewCards,
  createNewCardState,
  evaluateDigest,
} from '../src/index.js';
import type {
  CardPoolState,
  DayDigest,
  DayPlanProfile,
  PoolId,
} from '../src/index.js';
import { MON, SAT, SUN, TUE, card, mulberry32 } from './helpers.js';

/* ------------------------------------------------------------------ */
/* 造数帮手                                                             */
/* ------------------------------------------------------------------ */

/** 计划日（周二）；昨日＝周一。 */
const PLAN_DATE = TUE;

/** 往前数 n 天的日期（n=1 即昨日）。 */
function back(n: number): string {
  return addDays(PLAN_DATE, -n);
}

/** 达标日缺省信号：正确率 0.9、按时完成、用时在带内 → 指数 0.95。 */
function passDigest(overrides: Partial<DayDigest> = {}): DayDigest {
  return {
    date: MON,
    answered: 10,
    correct: 9,
    completedOnTime: true,
    segmentSeconds: { newWords: 480, review: 240 },
    ...overrides,
  };
}

/** 正确率惩罚日（69% < 70%）。 */
function lowAccuracyDigest(overrides: Partial<DayDigest> = {}): DayDigest {
  return passDigest({ answered: 100, correct: 69, ...overrides });
}

/** 超时惩罚日（复习段 301s > 300s 盒）。 */
function overtimeDigest(overrides: Partial<DayDigest> = {}): DayDigest {
  return passDigest({ segmentSeconds: { newWords: 480, review: 301 }, ...overrides });
}

/** 中性日：全对但未按时完成 → 指数 0.7 < 0.75 不达标、无惩罚。 */
function neutralDigest(overrides: Partial<DayDigest> = {}): DayDigest {
  return passDigest({ completedOnTime: false, ...overrides });
}

/** 连续信号日序列：patterns 从远到近，最后一天＝昨日。 */
function historyOf(...patterns: DayDigest[]): DayDigest[] {
  return patterns.map((d, i) => ({ ...d, date: back(patterns.length - i) }));
}

function profile(overrides: Partial<DayPlanProfile> = {}): DayPlanProfile {
  return { childId: 'child-1', date: PLAN_DATE, dailyNewWords: 5, ...overrides };
}

/** 新鲜 P0 新词卡（无作答历史）。 */
function freshNew(ids: string[], date: string = PLAN_DATE): CardPoolState[] {
  return ids.map((id) => card({ lexicalEntryId: id, pool: 'P0', dueDate: date, recentOutcomes: [] }));
}

function planOf(p: DayPlanProfile, pools: CardPoolState[] = [], history: DayDigest[] = []): DailyPlan {
  return buildDailyPlan(p, pools, history);
}

const ALL_POOLS: PoolId[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated'];

/* ------------------------------------------------------------------ */
/* 常量钉死                                                             */
/* ------------------------------------------------------------------ */

describe('调节器常量钉死（spec S9 定案＋实现定值，禁运行时漂移）', () => {
  it('消化指数权重：正确率 0.5 严格最大，三项和为 1', () => {
    expect(DIGEST_WEIGHTS.accuracy).toBe(0.5);
    expect(DIGEST_WEIGHTS.completedOnTime).toBe(0.3);
    expect(DIGEST_WEIGHTS.timeInBand).toBe(0.2);
    expect(DIGEST_WEIGHTS.accuracy).toBeGreaterThan(DIGEST_WEIGHTS.completedOnTime);
    expect(DIGEST_WEIGHTS.completedOnTime).toBeGreaterThan(DIGEST_WEIGHTS.timeInBand);
    expect(DIGEST_WEIGHTS.accuracy + DIGEST_WEIGHTS.completedOnTime + DIGEST_WEIGHTS.timeInBand).toBeCloseTo(1, 10);
  });

  it('阈值与步长：达标 0.75、正确率惩罚线 0.7、单日 ±1、连击 3 天', () => {
    expect(DIGEST_PASS_THRESHOLD).toBe(0.75);
    expect(DIGEST_ACCURACY_FLOOR).toBe(0.7);
    expect(ADJUSTER_STEP).toBe(1);
    expect(ADJUSTER_STREAK_DAYS).toBe(3);
  });

  it('时间盒与估时：新词段 600s、复习段 300s、plain 10s、shooting 25s（spec S9 数字）', () => {
    expect(NEW_SEGMENT_BUDGET_SECONDS).toBe(600);
    expect(REVIEW_SEGMENT_BUDGET_SECONDS).toBe(300);
    expect(PLAIN_REVIEW_EST_SECONDS).toBe(10);
    expect(SHOOTING_REVIEW_EST_SECONDS).toBe(25);
  });

  it('池权重表：七池齐全、全为正、和为 1、P1 最高', () => {
    for (const pool of ALL_POOLS) {
      expect(POOL_REVIEW_WEIGHTS[pool]).toBeGreaterThan(0);
    }
    const sum = ALL_POOLS.reduce((s, p) => s + POOL_REVIEW_WEIGHTS[p], 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(POOL_REVIEW_WEIGHTS.P1).toBe(Math.max(...ALL_POOLS.map((p) => POOL_REVIEW_WEIGHTS[p])));
  });
});

describe('三信号消化指数（evaluateDigest）', () => {
  it('完美日指数 1.0 达标；正确率 0.7＋按时＋带内 → 0.85 达标', () => {
    expect(evaluateDigest(passDigest({ answered: 10, correct: 10 }))).toMatchObject({ index: 1, pass: true, penalty: false });
    expect(evaluateDigest(passDigest({ answered: 100, correct: 70 }))).toMatchObject({ index: 0.85, pass: true, penalty: false });
  });

  it('全对但未按时完成 → 指数 0.7 不达标也不罚（中性日，阈值钉死依据）', () => {
    const ev = evaluateDigest(neutralDigest({ answered: 10, correct: 10 }));
    expect(ev.index).toBe(0.7);
    expect(ev.pass).toBe(false);
    expect(ev.penalty).toBe(false);
  });

  it('正确率 <70% → 惩罚 accuracy_below_70；恰好 70% 不罚', () => {
    expect(evaluateDigest(lowAccuracyDigest())).toMatchObject({ penalty: true, pass: false, accuracy: 0.69 });
    expect(evaluateDigest(passDigest({ answered: 100, correct: 70 })).penalty).toBe(false);
  });

  it('超时判定：复习段 301s 或新词段 601s 即超时；恰好 300s/600s 不超', () => {
    expect(evaluateDigest(overtimeDigest())).toMatchObject({ overtime: true, timeInBand: false, penalty: true });
    expect(
      evaluateDigest(passDigest({ segmentSeconds: { newWords: 601, review: 100 } })).overtime,
    ).toBe(true);
    expect(
      evaluateDigest(passDigest({ segmentSeconds: { newWords: 600, review: 300 } })).overtime,
    ).toBe(false);
  });

  it('无作答日：正确率记 0、不触发正确率惩罚（无证据），指数不足不达标', () => {
    const ev = evaluateDigest(passDigest({ answered: 0, correct: 0 }));
    expect(ev.accuracy).toBe(0);
    expect(ev.penalty).toBe(false);
    expect(ev.pass).toBe(false);
  });

  it('调用方异常数据（correct > answered）正确率夹逼到 1，指数不越界', () => {
    const ev = evaluateDigest(passDigest({ answered: 10, correct: 15 }));
    expect(ev.accuracy).toBe(1);
    expect(ev.index).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* 调整规则逐条（票面 §2；测试名含规则字面量可反查）                      */
/* ------------------------------------------------------------------ */

describe('调整规则：连续 3 天达标 +1（授予后重新起算）', () => {
  it('两天缺口后连续 3 天达标 → 恰好 +1，事件 from/to 与原因齐备', () => {
    const plan = planOf(profile(), [], historyOf(lowAccuracyDigest(), lowAccuracyDigest(), passDigest(), passDigest(), passDigest()));
    expect(plan.adjuster.offset).toBe(-1); // -2（两天惩罚）+1（连击授予）
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({ type: 'daily_plan_adjusted', from: 3, to: 4, reasons: ['three_day_streak'] });
  });

  it('只有 2 天达标 → 不授予（连击不满 3）', () => {
    const plan = planOf(profile(), [], historyOf(lowAccuracyDigest(), lowAccuracyDigest(), passDigest(), passDigest()));
    expect(plan.adjuster.value).toBe(3);
    expect(plan.adjustment).toBeNull();
  });

  it('连续 6 天达标 → 授予两次（每次授予后连击清零重新起算）', () => {
    const passes = Array.from({ length: 6 }, () => passDigest());
    const plan = planOf(profile({ dailyNewWords: 5 }), [], historyOf(lowAccuracyDigest(), lowAccuracyDigest(), ...passes));
    expect(plan.adjuster.offset).toBe(0); // -2 +1 +1
    expect(plan.adjuster.value).toBe(5);
    expect(plan.adjustment).toMatchObject({ from: 4, to: 5 });
  });

  it('连击被中性日打断 → 重新累计，不满 3 天不授予', () => {
    const plan = planOf(
      profile({ dailyNewWords: 5 }),
      [],
      historyOf(lowAccuracyDigest(), passDigest(), passDigest(), neutralDigest(), passDigest()),
    );
    expect(plan.adjuster.offset).toBe(-1);
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toBeNull();
  });

  it('日期断档（昨日无信号）连击清零：达标序列跨断档不授予', () => {
    const plan = planOf(
      profile({ dailyNewWords: 5 }),
      [],
      [lowAccuracyDigest({ date: back(5) }), passDigest({ date: back(4) }), passDigest({ date: back(3) }), passDigest({ date: back(1) })],
    );
    // back(3) → back(1) 断档：第 3 个达标日不计入连击（连击清零后重计 1）
    expect(plan.adjustment).toBeNull();
    expect(plan.adjuster.offset).toBe(-1); // 仅惩罚生效，无授予相抵
    expect(plan.adjuster.value).toBe(4);
  });
});

describe('调整规则：正确率 <70% → 次日 -1', () => {
  it('昨日正确率 69% → 天花板 5 降至 4，事件原因 accuracy_below_70', () => {
    const plan = planOf(profile(), [], historyOf(lowAccuracyDigest()));
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({ from: 5, to: 4, reasons: ['accuracy_below_70'] });
  });

  it('昨日正确率恰好 70% → 不罚（边界钉死）', () => {
    const plan = planOf(profile(), [], historyOf(passDigest({ answered: 100, correct: 70 })));
    expect(plan.adjuster.value).toBe(5);
    expect(plan.adjustment).toBeNull();
  });

  it('惩罚优先于授予：连击第 3 天恰逢正确率 <70% → 净 -1 而非 +1', () => {
    const plan = planOf(
      profile(),
      [],
      historyOf(lowAccuracyDigest(), passDigest(), passDigest(), lowAccuracyDigest()),
    );
    expect(plan.adjuster.offset).toBe(-2); // 两天惩罚，授予被惩罚覆盖
    expect(plan.adjuster.value).toBe(3);
    expect(plan.adjustment).toMatchObject({ from: 4, to: 3, reasons: ['accuracy_below_70'] });
  });
});

describe('调整规则：超时 → 次日 -1', () => {
  it('复习段 301s（>300s 盒）→ -1，事件原因 overtime', () => {
    const plan = planOf(profile(), [], historyOf(overtimeDigest()));
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({ from: 5, to: 4, reasons: ['overtime'] });
  });

  it('新词段 601s（>600s 盒）同样 → -1', () => {
    const plan = planOf(profile(), [], historyOf(passDigest({ segmentSeconds: { newWords: 601, review: 100 } })));
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({ reasons: ['overtime'] });
  });

  it('恰好压线（复习段 300s、新词段 600s）→ 不罚（边界钉死）', () => {
    const plan = planOf(profile(), [], historyOf(passDigest({ segmentSeconds: { newWords: 600, review: 300 } })));
    expect(plan.adjuster.value).toBe(5);
    expect(plan.adjustment).toBeNull();
  });

  it('正确率 <70% 与超时同日双触发 → 仍只 -1（单日幅度钉死），原因双记', () => {
    const plan = planOf(
      profile(),
      [],
      historyOf(passDigest({ answered: 100, correct: 50, segmentSeconds: { newWords: 601, review: 301 } })),
    );
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({
      from: 5,
      to: 4,
      reasons: ['accuracy_below_70', 'overtime'],
    });
  });
});

describe('调整规则：单日 ±1（幅度上界）', () => {
  it('深坑恢复每步恰 +1：3 天惩罚后 3 天达标 → 一次只回 1', () => {
    const plan = planOf(
      profile({ dailyNewWords: 10 }),
      [],
      historyOf(lowAccuracyDigest(), lowAccuracyDigest(), lowAccuracyDigest(), passDigest(), passDigest(), passDigest()),
    );
    expect(plan.adjuster.offset).toBe(-2); // -3 +1
    expect(plan.adjuster.value).toBe(8);
    expect(plan.adjustment).toMatchObject({ from: 7, to: 8 });
    expect((plan.adjustment as { to: number }).to - (plan.adjustment as { from: number }).from).toBe(1);
  });

  it('惩罚连发不叠加：多日连续惩罚每日恰 -1（性质测试另证 100 天幅度 ≤1）', () => {
    const penalties = Array.from({ length: 4 }, () => lowAccuracyDigest());
    const plan = planOf(profile({ dailyNewWords: 10 }), [], historyOf(...penalties));
    expect(plan.adjuster.offset).toBe(-4);
    expect(plan.adjuster.value).toBe(6);
  });
});

describe('调整规则：带 [3,10] 与家长硬天花板（先夹上限、末端 clamp）', () => {
  it('谷底兜底：连续惩罚压穿下限 → 值钉在 3，且贴底后不再发事件', () => {
    const penalties = Array.from({ length: 25 }, () => lowAccuracyDigest());
    const plan = planOf(profile({ dailyNewWords: 10 }), [], historyOf(...penalties));
    expect(plan.adjuster.value).toBe(3);
    expect(plan.adjustment).toBeNull(); // from = to = 3，贴底吸收
  });

  it('档案越界收敛：15 → 天花板 10；2 → 天花板 3（clampDailyNewWords 末端兜底）', () => {
    expect(planOf(profile({ dailyNewWords: 15 })).adjuster.ceiling).toBe(10);
    expect(planOf(profile({ dailyNewWords: 15 })).adjuster.value).toBe(10);
    expect(planOf(profile({ dailyNewWords: 2 })).adjuster.value).toBe(3);
    expect(planOf(profile({ dailyNewWords: 7.6 })).adjuster.value).toBe(8);
  });

  it('硬天花板：无惩罚历史下连击达标也不越天花板（值＝天花板、不发事件）', () => {
    const plan = planOf(profile({ dailyNewWords: 5 }), [], historyOf(passDigest(), passDigest(), passDigest()));
    expect(plan.adjuster.offset).toBe(1); // 偏移可为正，但被天花板压回
    expect(plan.adjuster.value).toBe(5);
    expect(plan.adjustment).toBeNull();
  });

  it('调节器只在天花板之下浮动：值恒 ≤ clampDailyNewWords(档案配置)', () => {
    const plan = planOf(profile({ dailyNewWords: 6 }), [], historyOf(...Array.from({ length: 9 }, () => lowAccuracyDigest())));
    expect(plan.adjuster.value).toBeLessThanOrEqual(6);
    expect(plan.adjuster.value).toBeGreaterThanOrEqual(3);
  });
});

describe('调整规则：家长锁定后只降不升', () => {
  it('锁定时连击达标不授予（升档抑制）：本应 +1 的日子保持原值', () => {
    const plan = planOf(
      profile({ dailyNewWords: 5, parentLocked: true }),
      [],
      historyOf(lowAccuracyDigest(), passDigest(), passDigest(), passDigest()),
    );
    expect(plan.adjuster.locked).toBe(true);
    expect(plan.adjuster.offset).toBe(-1); // 授予被抑制
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toBeNull();
  });

  it('锁定时惩罚降档保留：正确率 <70% 照样 -1（只降）', () => {
    const plan = planOf(profile({ dailyNewWords: 5, parentLocked: true }), [], historyOf(lowAccuracyDigest()));
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({ from: 5, to: 4, reasons: ['accuracy_below_70'] });
  });

  it('锁定且无缺口 → 恒等于天花板，无事件', () => {
    const plan = planOf(
      profile({ dailyNewWords: 5, parentLocked: true }),
      [],
      historyOf(passDigest(), passDigest(), passDigest(), passDigest()),
    );
    expect(plan.adjuster.value).toBe(5);
    expect(plan.adjustment).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* daily_plan_adjusted 事件（进既有事件流契约）                          */
/* ------------------------------------------------------------------ */

describe('daily_plan_adjusted 事件（S7 字段：旧值→新值、触发原因、信号快照）', () => {
  it('事件字段齐备且 JSON 可序列化（signalSnapshot 全原始值）', () => {
    const plan = planOf(profile(), [], historyOf(lowAccuracyDigest()));
    const event = plan.adjustment;
    expect(event).not.toBeNull();
    expect(event!.type).toBe('daily_plan_adjusted');
    expect(event!.childId).toBe('child-1');
    expect(event!.date).toBe(PLAN_DATE);
    expect(event!.from).toBe(5);
    expect(event!.to).toBe(4);
    expect(event!.reasons).toEqual(['accuracy_below_70']);
    expect(event!.signalSnapshot).toEqual({
      date: MON,
      answered: 100,
      correct: 69,
      accuracy: 0.69,
      completedOnTime: true,
      overtime: false,
      timeInBand: true,
      digestIndex: 0.845,
    });
    const roundTrip = JSON.parse(JSON.stringify(event)) as typeof event;
    expect(roundTrip).toEqual(event);
  });

  it('无历史 → 无事件；生效值无变化 → 无事件；昨日无信号（值结转）→ 无事件', () => {
    expect(planOf(profile()).adjustment).toBeNull();
    expect(planOf(profile(), [], historyOf(passDigest())).adjustment).toBeNull();
    expect(planOf(profile(), [], [lowAccuracyDigest({ date: back(3) })]).adjustment).toBeNull();
  });

  it('值结转：断档后计划值保持回放结果（不回弹、不发事件）', () => {
    const plan = planOf(profile(), [], [lowAccuracyDigest({ date: back(3) })]);
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjuster.offset).toBe(-1);
    expect(plan.adjustment).toBeNull();
  });

  it('周末照常跟踪调节器（事件照发），但新词段为空', () => {
    const plan = buildDailyPlan(
      { childId: 'child-1', date: SUN, dailyNewWords: 5 },
      [],
      [lowAccuracyDigest({ date: SAT })],
    );
    expect(plan.isWeekend).toBe(true);
    expect(plan.newWords).toEqual([]);
    expect(plan.plannedNewWords).toBe(0);
    expect(plan.adjuster.value).toBe(4);
    expect(plan.adjustment).toMatchObject({ from: 5, to: 4 });
  });
});

/* ------------------------------------------------------------------ */
/* day 层编排：新词段                                                   */
/* ------------------------------------------------------------------ */

describe('day 层编排：新词段（音节块拼读队列）', () => {
  it('工作日按调节器值截取新鲜 P0：8 张可用、天花板 5 → 队列 5 张（到期 asc＋词 id asc）', () => {
    const plan = planOf(profile({ dailyNewWords: 5 }), freshNew(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']));
    expect(plan.newWords.map((c) => c.entryId)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(plan.plannedNewWords).toBe(5);
    expect(plan.adjuster.value).toBe(5);
  });

  it('新鲜 P0 不足 → 队列取实际可用量（plannedNewWords ＜ 调节器值）', () => {
    const plan = planOf(profile({ dailyNewWords: 5 }), freshNew(['n1', 'n2', 'n3']));
    expect(plan.newWords).toHaveLength(3);
    expect(plan.plannedNewWords).toBe(3);
    expect(plan.adjuster.value).toBe(5);
  });

  it('周末无新词只复习（R4 冻结语义）：队列空、plannedNewWords 0；新鲜 P0 挂起不入复习段', () => {
    const plan = buildDailyPlan(
      { childId: 'child-1', date: SAT, dailyNewWords: 5 },
      [...freshNew(['n1', 'n2', 'n3'], SAT), card({ lexicalEntryId: 'r1', pool: 'P1', dueDate: SAT })],
      [],
    );
    expect(plan.newWords).toEqual([]);
    expect(plan.plannedNewWords).toBe(0);
    expect(plan.reviewQueue.map((c) => c.entryId)).toEqual(['r1']);
  });

  it('重学 P0（有作答历史）不进新词段、进复习段（plain/relearn），不占新词配额', () => {
    const relearned = card({
      lexicalEntryId: 'relearn-w',
      pool: 'P0',
      dueDate: MON,
      recentOutcomes: [{ correct: false, fast: false, answeredOn: MON }],
      errorStreak: 1,
    });
    const plan = planOf(profile({ dailyNewWords: 3 }), [relearned, ...freshNew(['n1', 'n2', 'n3', 'n4'])]);
    expect(plan.newWords.map((c) => c.entryId)).toEqual(['n1', 'n2', 'n3']);
    const relearnCard = plan.reviewQueue.find((c) => c.entryId === 'relearn-w');
    expect(relearnCard).toMatchObject({ pool: 'P0', form: 'plain', dueReason: 'relearn' });
  });

  it('音近约束（R6）：同批冲突候选挡下不引入，无约束上下文时全量放行', () => {
    const constrained = planOf(
      { ...profile({ dailyNewWords: 5 }), nearSound: { pairs: [['cat', 'cap']], introDates: {} } },
      freshNew(['cat', 'cap', 'dog']),
    );
    // 候选按词 id 升序：cap 先引入，cat 与 cap 音近且间隔 0 < 3 被挡，dog 放行
    expect(constrained.newWords.map((c) => c.entryId)).toEqual(['cap', 'dog']);
    const unconstrained = planOf(profile({ dailyNewWords: 5 }), freshNew(['cat', 'cap', 'dog']));
    expect(unconstrained.newWords).toHaveLength(3);
  });

  it('新鲜 P0 不出现在复习段（两段互斥）', () => {
    const plan = planOf(profile({ dailyNewWords: 2 }), [
      ...freshNew(['n1', 'n2', 'n3']),
      card({ lexicalEntryId: 'r1', pool: 'P1', dueDate: PLAN_DATE }),
    ]);
    const reviewIds = plan.reviewQueue.map((c) => c.entryId);
    expect(reviewIds).toEqual(['r1']);
  });
});

/* ------------------------------------------------------------------ */
/* day 层编排：复习段契约（Ticket 11/12 消费形状）                       */
/* ------------------------------------------------------------------ */

describe('接口契约：复习段队列元素 entryId/pool/form/dueReason（Ticket 11 消费）', () => {
  it('form 映射：P0-P2 plain、P3/P4/P5/graduated shooting（spec S9 池位分层）', () => {
    const states: CardPoolState[] = [
      card({ lexicalEntryId: 'r1', pool: 'P0', dueDate: MON, recentOutcomes: [{ correct: false, fast: false, answeredOn: MON }] }),
      card({ lexicalEntryId: 'p1a', pool: 'P1', dueDate: PLAN_DATE }),
      card({ lexicalEntryId: 'p2a', pool: 'P2', dueDate: PLAN_DATE }),
      card({ lexicalEntryId: 'p3a', pool: 'P3', dueDate: PLAN_DATE }),
      card({ lexicalEntryId: 'p4a', pool: 'P4', dueDate: PLAN_DATE }),
      card({ lexicalEntryId: 'p5a', pool: 'P5', dueDate: PLAN_DATE }),
      card({ lexicalEntryId: 'g1', pool: 'graduated', dueDate: PLAN_DATE, graduatedSampledMonth: '2026-10' }),
    ];
    const plan = planOf(profile(), states);
    const byId = new Map(plan.reviewQueue.map((c) => [c.entryId, c]));
    expect(byId.get('r1')).toMatchObject({ form: 'plain' });
    expect(byId.get('p1a')).toMatchObject({ form: 'plain' });
    expect(byId.get('p2a')).toMatchObject({ form: 'plain' });
    expect(byId.get('p3a')).toMatchObject({ form: 'shooting' });
    expect(byId.get('p4a')).toMatchObject({ form: 'shooting' });
    expect(byId.get('p5a')).toMatchObject({ form: 'shooting' });
    expect(byId.get('g1')).toMatchObject({ form: 'shooting' });
    // 契约形状：每元素至少含 entryId/pool/form/dueReason
    for (const c of plan.reviewQueue) {
      expect(typeof c.entryId).toBe('string');
      expect(ALL_POOLS).toContain(c.pool);
      expect(['plain', 'shooting']).toContain(c.form);
      expect(['relearn', 'overdue', 'due_today', 'graduated_maintenance']).toContain(c.dueReason);
    }
  });

  it('dueReason 映射：relearn／graduated_maintenance／overdue／due_today', () => {
    const states: CardPoolState[] = [
      card({ lexicalEntryId: 'r1', pool: 'P0', dueDate: MON, recentOutcomes: [{ correct: false, fast: false, answeredOn: MON }] }),
      card({ lexicalEntryId: 'g1', pool: 'graduated', dueDate: PLAN_DATE, graduatedSampledMonth: '2026-10' }),
      card({ lexicalEntryId: 'late', pool: 'P1', dueDate: MON }),
      card({ lexicalEntryId: 'today', pool: 'P2', dueDate: PLAN_DATE }),
    ];
    const plan = planOf(profile(), states);
    const byId = new Map(plan.reviewQueue.map((c) => [c.entryId, c]));
    expect(byId.get('r1')).toMatchObject({ dueReason: 'relearn' });
    expect(byId.get('g1')).toMatchObject({ dueReason: 'graduated_maintenance' });
    expect(byId.get('late')).toMatchObject({ dueReason: 'overdue' });
    expect(byId.get('today')).toMatchObject({ dueReason: 'due_today' });
  });

  it('队列按 E4 优先级排序：到期早者优先，同到期错误多者优先，词 id 兜底', () => {
    const states: CardPoolState[] = [
      card({ lexicalEntryId: 'wD', pool: 'P2', dueDate: SAT, errorStreak: 5 }),
      card({ lexicalEntryId: 'wC', pool: 'P1', dueDate: '2026-10-22', errorStreak: 1 }),
      card({ lexicalEntryId: 'wB', pool: 'P3', dueDate: '2026-10-22', errorStreak: 3 }),
      card({ lexicalEntryId: 'wA', pool: 'P1', dueDate: '2026-10-20', errorStreak: 0 }),
      card({ lexicalEntryId: 'wE', pool: 'P5', dueDate: MON, errorStreak: 9 }),
    ];
    const plan = planOf(profile(), states);
    expect(plan.reviewQueue.map((c) => c.entryId)).toEqual(['wA', 'wB', 'wC', 'wD', 'wE']);
  });

  it('暂停卡与未设到期日的毕业池卡不进队列', () => {
    const states: CardPoolState[] = [
      card({ lexicalEntryId: 'paused-w', pool: 'P2', dueDate: PLAN_DATE, paused: true }),
      card({ lexicalEntryId: 'grad-raw', pool: 'graduated', dueDate: null, graduatedSampledMonth: null }),
      card({ lexicalEntryId: 'in', pool: 'P1', dueDate: PLAN_DATE }),
    ];
    const plan = planOf(profile(), states);
    expect(plan.reviewQueue.map((c) => c.entryId)).toEqual(['in']);
  });
});

/* ------------------------------------------------------------------ */
/* 池分摊（票面 §1：数量按池权重分摊，测试钉死）                          */
/* ------------------------------------------------------------------ */

describe('池分摊：按池权重分摊（归一化水填＋封顶回流，总和守恒）', () => {
  it('容量富余 → 到期全入（无稀缺时权重不裁量）', () => {
    const quotas = allocateReviewQuota(
      [
        { pool: 'P1', due: 5 },
        { pool: 'P2', due: 3 },
      ],
      100,
    );
    expect(quotas).toEqual([
      { pool: 'P1', quota: 5 },
      { pool: 'P2', quota: 3 },
    ]);
  });

  it('稀缺分摊＋余数决胜：25 容量分 P1/P3（权重归一化 0.625/0.375）→ 16/9', () => {
    const quotas = allocateReviewQuota(
      [
        { pool: 'P1', due: 30 },
        { pool: 'P3', due: 30 },
      ],
      25,
    );
    expect(quotas).toEqual([
      { pool: 'P1', quota: 16 },
      { pool: 'P3', quota: 9 },
    ]);
  });

  it('封顶回流：小池配额被到期数封顶，余额回流大池（P1 19 / P2 4 / P3 6）', () => {
    const quotas = allocateReviewQuota(
      [
        { pool: 'P1', due: 25 },
        { pool: 'P2', due: 4 },
        { pool: 'P3', due: 6 },
      ],
      29,
    );
    expect(quotas).toEqual([
      { pool: 'P1', quota: 19 },
      { pool: 'P2', quota: 4 },
      { pool: 'P3', quota: 6 },
    ]);
  });

  it('决胜序钉死：权重同值按池序（P4 先于 P5），结果确定', () => {
    const quotas = allocateReviewQuota(
      [
        { pool: 'P4', due: 10 },
        { pool: 'P5', due: 10 },
      ],
      3,
    );
    expect(quotas).toEqual([
      { pool: 'P4', quota: 2 },
      { pool: 'P5', quota: 1 },
    ]);
  });

  it('空输入与零到期池：无分配、无除零', () => {
    expect(allocateReviewQuota([], 10)).toEqual([]);
    expect(allocateReviewQuota([{ pool: 'P1', due: 0 }], 10)).toEqual([]);
    expect(allocateReviewQuota([{ pool: 'P1', due: 5 }], 0)).toEqual([{ pool: 'P1', quota: 0 }]);
  });

  it('整合：20 P1＋10 P3 → 时间盒容量 24（估时 300s），配额 P1 15 / P3 9，队列全局 E4 序', () => {
    const states = [
      ...Array.from({ length: 20 }, (_, i) => card({ lexicalEntryId: `a${String(i + 1).padStart(2, '0')}`, pool: 'P1', dueDate: PLAN_DATE })),
      ...Array.from({ length: 10 }, (_, i) => card({ lexicalEntryId: `b${String(i + 1).padStart(2, '0')}`, pool: 'P3', dueDate: PLAN_DATE })),
    ];
    const plan = planOf(profile({ dailyNewWords: 3 }), states);
    expect(plan.reviewCapacity).toBe(24); // 20×10 + 4×25 = 300s 恰满
    expect(plan.poolAllocation).toEqual([
      { pool: 'P1', due: 20, quota: 15, weight: 0.25 },
      { pool: 'P3', due: 10, quota: 9, weight: 0.15 },
    ]);
    expect(plan.reviewQueue.map((c) => c.entryId)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 9 }, (_, i) => `b${String(i + 1).padStart(2, '0')}`),
    ]);
    expect(plan.reviewEstimatedSeconds).toBe(15 * 10 + 9 * 25);
    // 估时超盒被截的 E4 未竟卡：顺延面可见（a16..a20 + b10）
    expect(plan.reviewDeferred.map((c) => c.entryId)).toEqual([
      ...Array.from({ length: 5 }, (_, i) => `a${String(i + 16).padStart(2, '0')}`),
      'b10',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 性质测试（票面 VALIDATE 2）                                           */
/* ------------------------------------------------------------------ */

/** 随机场景：池状态＋消化信号历史（种子确定性）。 */
function randomScenario(seed: number): { profile: DayPlanProfile; pools: CardPoolState[]; history: DayDigest[] } {
  const rnd = mulberry32(seed);
  const pools: CardPoolState[] = [];
  const count = 10 + Math.floor(rnd() * 30);
  for (let i = 0; i < count; i++) {
    const pool = ALL_POOLS[Math.floor(rnd() * ALL_POOLS.length)] as PoolId;
    const fresh = pool === 'P0' && rnd() < 0.5;
    pools.push(
      card({
        lexicalEntryId: `w${String(i).padStart(2, '0')}`,
        pool,
        dueDate: back(Math.floor(rnd() * 6)),
        errorStreak: Math.floor(rnd() * 5),
        paused: rnd() < 0.1,
        recentOutcomes: fresh ? [] : [{ correct: true, fast: true, answeredOn: PLAN_DATE }],
        graduatedSampledMonth: pool === 'graduated' ? '2026-10' : null,
      }),
    );
  }
  const history: DayDigest[] = [];
  const days = 5 + Math.floor(rnd() * 10);
  for (let d = days; d >= 1; d--) {
    const answered = 5 + Math.floor(rnd() * 30);
    history.push({
      date: back(d),
      answered,
      correct: Math.floor(rnd() * (answered + 1)),
      completedOnTime: rnd() < 0.85,
      segmentSeconds: { newWords: Math.floor(rnd() * 700), review: Math.floor(rnd() * 400) },
    });
  }
  return { profile: { childId: 'child-1', date: PLAN_DATE, dailyNewWords: 3 + Math.floor(rnd() * 8) }, pools, history };
}

describe('性质：重放确定性与 100 天随机行为（票面 VALIDATE 2）', () => {
  it('同一（档案×池×信号历史）重放 N 次结果全等（40 种子）', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const scenario = randomScenario(seed);
      const first = JSON.stringify(buildDailyPlan(scenario.profile, scenario.pools, scenario.history));
      const second = JSON.stringify(buildDailyPlan(scenario.profile, scenario.pools, scenario.history));
      const third = JSON.stringify(buildDailyPlan(scenario.profile, scenario.pools, scenario.history));
      expect(second).toBe(first);
      expect(third).toBe(first);
    }
  });

  it('连续 100 天随机行为：单日调整幅度 ≤1、终值在带内、池分摊总和守恒', () => {
    const rnd = mulberry32(2026);
    const pools: CardPoolState[] = Array.from({ length: 30 }, (_, i) =>
      card({
        lexicalEntryId: `s${String(i).padStart(2, '0')}`,
        pool: ALL_POOLS[i % ALL_POOLS.length] as PoolId,
        dueDate: '2026-01-01',
        recentOutcomes: i % ALL_POOLS.length === 0 ? [] : [{ correct: true, fast: true, answeredOn: '2026-01-01' }],
      }),
    );
    const START = '2026-01-05';
    let history: DayDigest[] = [];
    let prev: number | null = null;
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const date = addDays(START, i);
      const plan = buildDailyPlan({ childId: 'child-1', date, dailyNewWords: 6 }, pools, history);
      if (prev !== null) {
        expect(Math.abs(plan.adjuster.value - prev)).toBeLessThanOrEqual(1);
      }
      expect(plan.adjuster.value).toBeGreaterThanOrEqual(3);
      expect(plan.adjuster.value).toBeLessThanOrEqual(6);
      const sumQuota = plan.poolAllocation.reduce((s, a) => s + a.quota, 0);
      expect(sumQuota).toBe(plan.reviewQueue.length);
      seen.add(plan.adjuster.value);
      // 由当日计划生成消化信号：正确率多数日 ≥70%（偶发低于）、偶发超时/未完成
      const answered = Math.max(1, plan.reviewQueue.length + plan.plannedNewWords);
      const accuracy = 0.55 + rnd() * 0.45;
      const overtime = rnd() < 0.2;
      history = [
        ...history,
        {
          date,
          answered,
          correct: Math.round(answered * accuracy),
          completedOnTime: rnd() < 0.85,
          segmentSeconds: {
            newWords: rnd() < 0.1 ? 601 + Math.floor(rnd() * 100) : Math.floor(rnd() * 550),
            review: overtime ? 301 + Math.floor(rnd() * 100) : Math.floor(rnd() * 280),
          },
        },
      ];
      prev = plan.adjuster.value;
    }
    expect(seen.size).toBeGreaterThan(1); // 非空泛：100 天内调节器确实动过
  });

  it('30 种子随机场景：Σ配额＝队列长度、配额 ≤ 池到期数、队列无重复且有序', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const scenario = randomScenario(seed);
      const plan = buildDailyPlan(scenario.profile, scenario.pools, scenario.history);
      const sumQuota = plan.poolAllocation.reduce((s, a) => s + a.quota, 0);
      expect(sumQuota).toBe(plan.reviewQueue.length);
      for (const a of plan.poolAllocation) {
        expect(a.quota).toBeLessThanOrEqual(a.due);
      }
      const ids = plan.reviewQueue.map((c) => c.entryId);
      expect(new Set(ids).size).toBe(ids.length);
      const sorted = [...plan.reviewQueue].sort(compareDailyReviewCards);
      expect(JSON.stringify(sorted)).toBe(JSON.stringify(plan.reviewQueue));
      for (const c of plan.reviewQueue) {
        expect(c.dueDate === null || c.dueDate <= PLAN_DATE).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 非法输入                                                             */
/* ------------------------------------------------------------------ */

describe('非法输入', () => {
  it('非法计划日抛错（与 planDailyLevel 同款纪律）', () => {
    expect(() => buildDailyPlan({ childId: 'child-1', date: '2026-13-01', dailyNewWords: 5 }, [], [])).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 契约 smoke：createNewCardState → 建卡当日即入新词段（引擎内闭环）       */
/* ------------------------------------------------------------------ */

describe('day 层与 transition 层衔接 smoke', () => {
  it('createNewCardState 建的新卡当日在新词段，不在复习段', () => {
    const fresh = createNewCardState('child-1', 'brand-new', PLAN_DATE);
    const plan = planOf(profile({ dailyNewWords: 5 }), [fresh]);
    expect(plan.newWords.map((c) => c.entryId)).toEqual(['brand-new']);
    expect(plan.reviewQueue).toHaveLength(0);
  });
});
