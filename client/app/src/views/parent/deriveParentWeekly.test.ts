/**
 * 家长学习周报派生单测（票 47）：近 7 天序列含今日缺日零填充/本周 vs 上周窗口切分/
 * 三维 delta 三态（none/up 零基线/flat ±10%/down）/积分口径复用票 38/正确率三态。
 */

import { describe, expect, it } from 'vitest';
import type { DailySummary } from '@kidsenglish/engine';
import { deriveParentWeekly } from './deriveParentWeekly';

const TODAY = '2026-11-05';

function mkDay(date: string, over: Partial<DailySummary> = {}): DailySummary {
  return {
    date,
    answered: 10,
    correct: 8,
    completedOnTime: true,
    segmentSeconds: { newWords: 300, review: 300 },
    starsEarned: 0,
    shardsEarned: 0,
    ...over,
  };
}

describe('deriveParentWeekly', () => {
  it('零数据＝7 天零填充序列（含今日，升序）＋三维 delta 全 none＋正确率 null', () => {
    const w = deriveParentWeekly([], TODAY);
    expect(w.days.map((d) => d.date)).toEqual([
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
    ]);
    expect(w.days.every((d) => d.minutes === 0 && d.answered === 0 && d.correctRate === null)).toBe(true);
    expect(w.thisWeek).toEqual({ minutes: 0, answered: 0, points: 0 });
    expect(w.lastWeek).toEqual({ minutes: 0, answered: 0, points: 0 });
    expect(w.deltas.minutes.status).toBe('none');
    expect(w.deltas.answered.status).toBe('none');
    expect(w.deltas.points.status).toBe('none');
    expect(w.correctRate).toBeNull();
  });

  it('窗口切分：本周与上周各日正确入桶；14 天外不入', () => {
    const w = deriveParentWeekly(
      [
        mkDay('2026-11-05', { answered: 4, correct: 4 }), // 今日
        mkDay('2026-10-30', { answered: 6, correct: 3 }), // 本窗口首日（-6）
        mkDay('2026-10-29', { answered: 100, correct: 50 }), // 上周（-7）
        mkDay('2026-10-23', { answered: 100, correct: 50 }), // -13 上周末日
        mkDay('2026-10-22', { answered: 100, correct: 50 }), // -14 窗口外
      ],
      TODAY,
    );
    expect(w.days[0].answered).toBe(6); // 10-30
    expect(w.days[6].answered).toBe(4); // 今日
    expect(w.thisWeek.answered).toBe(10);
    expect(w.lastWeek.answered).toBe(200);
    // 上周基线 200 vs 本周 10＝down
    expect(w.deltas.answered.status).toBe('down');
  });

  it('积分口径＝答对×1＋按时×10；delta 按积分比较', () => {
    const w = deriveParentWeekly(
      [
        mkDay('2026-11-04', { correct: 5, completedOnTime: true }), // 15 分
        mkDay('2026-10-29', { correct: 9, completedOnTime: false }), // 9 分
      ],
      TODAY,
    );
    expect(w.thisWeek.points).toBe(15);
    expect(w.lastWeek.points).toBe(9);
    expect(w.deltas.points).toEqual({ thisWeek: 15, lastWeek: 9, status: 'up' });
  });

  it('delta flat＝±10% 内持平；零基线有数据＝up', () => {
    const flat = deriveParentWeekly(
      [mkDay('2026-11-04', { answered: 95, correct: 95 }), mkDay('2026-10-29', { answered: 100, correct: 90 })],
      TODAY,
    );
    expect(flat.deltas.answered).toEqual({ thisWeek: 95, lastWeek: 100, status: 'flat' });
    const up = deriveParentWeekly(
      [mkDay('2026-11-04', { answered: 3, correct: 3 })],
      TODAY,
    );
    expect(up.deltas.answered.status).toBe('up');
    expect(up.deltas.answered.lastWeek).toBe(0);
  });

  it('正确率：本周加权（Σcorrect/Σanswered）；无作答日 correctRate null', () => {
    const w = deriveParentWeekly(
      [
        mkDay('2026-11-05', { answered: 10, correct: 10 }),
        mkDay('2026-11-04', { answered: 10, correct: 5 }),
        mkDay('2026-11-03', { answered: 0, correct: 0, segmentSeconds: { newWords: 0, review: 0 } }),
      ],
      TODAY,
    );
    expect(w.correctRate).toBe(75); // 15/20
    expect(w.days.find((d) => d.date === '2026-11-03')?.correctRate).toBeNull();
  });
});
