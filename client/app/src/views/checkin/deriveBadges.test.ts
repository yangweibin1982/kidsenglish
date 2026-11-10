/**
 * 徽章墙单测（票 40）：九枚静态表派生 earned／判据口径（双段打卡/满分日/连击/词量/毕业）。
 */

import { describe, expect, it } from 'vitest';
import type { CardPoolState, DailySummary, FoldedState, PoolId } from '@kidsenglish/engine';
import { BADGES, deriveBadges } from './deriveBadges';

function mk(date: string, over: Partial<DailySummary> = {}): DailySummary {
  return {
    date,
    answered: 10,
    correct: 8,
    completedOnTime: true,
    segmentSeconds: { newWords: 300, review: 200 },
    starsEarned: 0,
    shardsEarned: 0,
    ...over,
  };
}

function mkPool(entryId: string, pool: PoolId, over: Partial<CardPoolState> = {}): CardPoolState {
  return {
    childId: '1',
    lexicalEntryId: entryId,
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

function mkFolded(summaries: DailySummary[], poolStates: CardPoolState[] = []): FoldedState {
  return {
    childId: '1',
    poolStates,
    counters: { answered: 0, correct: 0, stars: 0, shards: 0 },
    dailySummaries: summaries,
    planAdjustments: [],
    unknownEventTypes: {},
  };
}

function earnedIds(s: FoldedState): Set<string> {
  return new Set(deriveBadges(s, '2026-11-05').filter((b) => b.earned).map((b) => b.id));
}

describe('deriveBadges', () => {
  it('零数据＝九枚全部未达成（灰态）', () => {
    const rows = deriveBadges(mkFolded([]), '2026-11-05');
    expect(rows.length).toBe(BADGES.length);
    expect(rows.every((b) => !b.earned)).toBe(true);
  });

  it('first-checkin：任一双段完成日达成', () => {
    expect(earnedIds(mkFolded([mk('2026-11-05')]))).toContain('first-checkin');
    // 单段完成不算
    const partial = mkFolded([mk('2026-11-05', { segmentSeconds: { newWords: 300, review: 0 } })]);
    expect(earnedIds(partial)).not.toContain('first-checkin');
  });

  it('perfect-day：≥5 题全对达成；全对但 <5 题不达成', () => {
    expect(earnedIds(mkFolded([mk('2026-11-05', { answered: 5, correct: 5 })]))).toContain('perfect-day');
    expect(earnedIds(mkFolded([mk('2026-11-05', { answered: 4, correct: 4 })]))).not.toContain('perfect-day');
  });

  it('streak-3：三连双段日达成（跨今日判据用历史游程）', () => {
    expect(earnedIds(mkFolded([mk('2026-11-03'), mk('2026-11-04'), mk('2026-11-05')]))).toContain('streak-3');
    expect(earnedIds(mkFolded([mk('2026-11-03'), mk('2026-11-04')]))).not.toContain('streak-3');
  });

  it('words-N：词量阈值 10/50/100', () => {
    const ten = Array.from({ length: 10 }, (_, i) => mkPool(`w${i}`, 'P1'));
    const s = mkFolded([mk('2026-11-05')], ten);
    const ids = earnedIds(s);
    expect(ids).toContain('words-10');
    expect(ids).not.toContain('words-50');
  });

  it('graduated-first：毕业池有词即达成', () => {
    const s = mkFolded([mk('2026-11-05')], [mkPool('w1', 'graduated')]);
    expect(earnedIds(s)).toContain('graduated-first');
  });
});
