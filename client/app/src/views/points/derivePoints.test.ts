/**
 * 积分账本单测（票 38）：口径（答对分/打卡加成）/今日昨日切片/累计/游戏得分不入账口径注记。
 */

import { describe, expect, it } from 'vitest';
import type { DailySummary } from '@kidsenglish/engine';
import { derivePoints } from './derivePoints';

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

describe('derivePoints', () => {
  it('口径＝答对×1＋按时×10：8 对＋按时＝18 分', () => {
    const c = derivePoints([mk('2026-11-05')], '2026-11-05');
    expect(c.total).toBe(18);
    expect(c.today).toBe(18);
    expect(c.yesterday).toBe(0);
  });

  it('不按时＝仅答对分；零答对按时＝10 分', () => {
    expect(derivePoints([mk('2026-11-05', { completedOnTime: false })], '2026-11-05').total).toBe(8);
    expect(derivePoints([mk('2026-11-05', { correct: 0 })], '2026-11-05').total).toBe(10);
  });

  it('零数据＝全 0', () => {
    const c = derivePoints([], '2026-11-05');
    expect(c).toEqual({ total: 0, today: 0, yesterday: 0, days: [] });
  });

  it('多日累计＋今日昨日切片（乱序输入不依赖顺序）', () => {
    const c = derivePoints(
      [mk('2026-11-03', { correct: 5 }), mk('2026-11-05', { correct: 8 }), mk('2026-11-04', { correct: 6, completedOnTime: false })],
      '2026-11-05',
    );
    expect(c.days.map((d) => d.date)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
    expect(c.total).toBe(15 + 6 + 18);
    expect(c.today).toBe(18);
    expect(c.yesterday).toBe(6);
  });

  it('今日无记录＝0（昨日切片仍可读）', () => {
    const c = derivePoints([mk('2026-11-04', { correct: 7, completedOnTime: false })], '2026-11-05');
    expect(c.today).toBe(0);
    expect(c.yesterday).toBe(7);
    expect(c.total).toBe(7);
  });
});
