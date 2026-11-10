/**
 * 半年热力图派生单测（票 55）：列对齐（周一起）＋零填充＋积分分档＋未来占位。
 */
import { describe, expect, it } from 'vitest';
import { deriveHeatmap, type HeatCell } from './deriveHeatmap';
import type { DailySummary } from '@kidsenglish/engine';

function day(date: string, correct: number, onTime = false): DailySummary {
  return {
    date,
    correct,
    answered: correct,
    completedOnTime: onTime,
    segmentSeconds: { newWords: 60, review: 60 },
  } as unknown as DailySummary;
}

describe('deriveHeatmap 半年热力网格（票 55）', () => {
  it('26 列×每列 7 格；末列含今日与未来占位', () => {
    const view = deriveHeatmap([], '2026-11-05'); // 周四
    expect(view.weeks).toHaveLength(26);
    for (const col of view.weeks) expect(col).toHaveLength(7);
    const last = view.weeks[25]!;
    // 2026-11-05 是周四：末列末 3 格为未来（周五补到周日）
    expect(last[3]!.date).toBe('2026-11-05');
    expect(last[4]!.future).toBe(true);
    expect(last[6]!.future).toBe(true);
    expect(last[3]!.future).toBe(false);
  });

  it('首列对齐周一（列首格非未来非今日外的历史零填充）', () => {
    const view = deriveHeatmap([], '2026-11-05');
    const first = view.weeks[0]!;
    expect(first[0]!.future).toBe(false);
    expect(first[0]!.level).toBe(0); // 无摘要零填充
    // 首格日期＝今日回退 25*7+3 天（周四 trailing=3）
    expect(first[0]!.date).toBe('2026-05-11'); // 周一
  });

  it('积分分档四档（0/1-5/6-15/≥16；答对1分＋按时10分口径）', () => {
    const summaries = [
      day('2026-11-02', 0), // 0 分 → level 0
      day('2026-11-03', 3), // 3 分 → level 1
      day('2026-11-04', 6), // 6 分 → level 2
      day('2026-11-05', 5, true), // 15 分 → level 2
      day('2026-11-01', 2, true), // 12 分 → level 2
    ];
    const view = deriveHeatmap(summaries, '2026-11-05');
    const cells = view.weeks.flat();
    const byDate = new Map(cells.map((c) => [c.date, c]));
    expect(byDate.get('2026-11-02')!.level).toBe(0);
    expect(byDate.get('2026-11-03')!.level).toBe(1);
    expect(byDate.get('2026-11-04')!.level).toBe(2);
    expect(byDate.get('2026-11-05')!.level).toBe(2);
    // ≥16 档：12+6=18 分的日（构造 completedOnTime＋多答对）
    summaries.push(day('2026-10-20', 16, false));
    const view2 = deriveHeatmap(summaries, '2026-11-05');
    const c2 = new Map(view2.weeks.flat().map((c: HeatCell) => [c.date, c]));
    expect(c2.get('2026-10-20')!.level).toBe(3);
  });

  it('今日锚定：today 格恒 future=false 且日期等于入参', () => {
    const view = deriveHeatmap([], '2026-11-08'); // 周日：末列末格
    const last = view.weeks[25]!;
    expect(last[6]!.date).toBe('2026-11-08');
    expect(last[6]!.future).toBe(false);
    expect(view.todayIso).toBe('2026-11-08');
  });
});
