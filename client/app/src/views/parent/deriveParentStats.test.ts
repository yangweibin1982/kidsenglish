/**
 * 家长统计派生单测（票 37）：七池分布零填充排序/今日到期（含暂停与未来到期排除）/
 * 近 7 天窗口/正确率三态（0 作答 null）/streak 复用打卡口径。
 */

import { describe, expect, it } from 'vitest';
import type { CardPoolState, DailySummary, FoldedState, PoolId } from '@kidsenglish/engine';
import { deriveParentStats } from './deriveParentStats';

const TODAY = '2026-11-05';

function mkPool(pool: PoolId, over: Partial<CardPoolState> = {}): CardPoolState {
  return {
    childId: '1',
    lexicalEntryId: `w_${pool}_${Math.random().toString(36).slice(2, 7)}`,
    pool,
    fastStreak: 0,
    errorStreak: 0,
    dueDate: null,
    variationTier: 'standard',
    paused: false,
    graduatedSampledMonth: null,
    recentOutcomes: [],
    ...over,
  };
}

function mkDay(date: string, seconds: { newWords: number; review: number }): DailySummary {
  return {
    date,
    answered: 10,
    correct: 8,
    completedOnTime: true,
    segmentSeconds: seconds,
    starsEarned: 0,
    shardsEarned: 0,
  };
}

function mkFolded(
  poolStates: CardPoolState[],
  dailySummaries: DailySummary[] = [],
  counters: FoldedState['counters'] = { answered: 0, correct: 0, stars: 0, shards: 0 },
): FoldedState {
  return {
    childId: '1',
    poolStates,
    counters,
    dailySummaries,
    planAdjustments: [],
    unknownEventTypes: {},
  };
}

describe('deriveParentStats', () => {
  it('零数据＝七池全 0（固定顺序）＋到期 0＋正确率 null＋streak 0', () => {
    const s = deriveParentStats(mkFolded([]), TODAY);
    expect(s.pools.map((p) => p.pool)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated']);
    expect(s.pools.every((p) => p.count === 0)).toBe(true);
    expect(s.dueToday).toBe(0);
    expect(s.introduced).toBe(0);
    expect(s.correctRate).toBeNull();
    expect(s.streak).toBe(0);
  });

  it('池分布聚合：各池计数正确', () => {
    const s = deriveParentStats(
      mkFolded([mkPool('P0'), mkPool('P0'), mkPool('P1'), mkPool('graduated')]),
      TODAY,
    );
    expect(s.pools.find((p) => p.pool === 'P0')?.count).toBe(2);
    expect(s.pools.find((p) => p.pool === 'P1')?.count).toBe(1);
    expect(s.pools.find((p) => p.pool === 'graduated')?.count).toBe(1);
    expect(s.introduced).toBe(4);
  });

  it('今日到期：dueDate≤今日计入；未来到期/暂停/无到期排除', () => {
    const s = deriveParentStats(
      mkFolded([
        mkPool('P1', { dueDate: TODAY }),
        mkPool('P2', { dueDate: '2026-11-04' }), // 逾期也算到期
        mkPool('P3', { dueDate: '2026-11-06' }), // 未来
        mkPool('P4', { dueDate: TODAY, paused: true }), // 暂停
        mkPool('P0', { dueDate: null }), // 无到期
      ]),
      TODAY,
    );
    expect(s.dueToday).toBe(2);
  });

  it('近 7 天窗口：今日与 6 天前计入，7 天前排除', () => {
    const s = deriveParentStats(
      mkFolded(
        [],
        [
          mkDay('2026-10-29', { newWords: 999, review: 999 }), // 7 天前出窗
          mkDay('2026-10-30', { newWords: 60, review: 40 }), // 6 天前
          mkDay(TODAY, { newWords: 120, review: 80 }),
        ],
      ),
      TODAY,
    );
    expect(s.week).toEqual({ newWords: 180, review: 120 });
  });

  it('正确率与 streak（复用打卡口径：昨日 done 今日未完成 → 1）', () => {
    const s = deriveParentStats(
      mkFolded([mkPool('P0')], [mkDay('2026-11-04', { newWords: 100, review: 100 })], {
        answered: 20,
        correct: 15,
        stars: 0,
        shards: 0,
      }),
      TODAY,
    );
    expect(s.answered).toBe(20);
    expect(s.correctRate).toBe(75);
    expect(s.streak).toBe(1);
  });
});
