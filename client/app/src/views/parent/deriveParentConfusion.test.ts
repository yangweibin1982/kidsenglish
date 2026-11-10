/**
 * 混淆图谱派生单测（票 49）：旧事件无 wrong_picks 跳过／聚合计数／排序（次数降序＋
 * 字母序次键）／topN 截断／daysWithWrong 去重。
 */

import { describe, expect, it } from 'vitest';
import type { AnswerEventPayload } from '../../store/learningData';
import { deriveParentConfusion } from './deriveParentConfusion';

function mk(picks: [string, string][], date = '2026-11-06'): AnswerEventPayload {
  return { question_type: 'new_words_fill', correct: picks.length === 0, answered_on: date, wrong_picks: picks };
}

describe('deriveParentConfusion', () => {
  it('空数据＝零行零计数', () => {
    expect(deriveParentConfusion([])).toEqual({ rows: [], totalWrong: 0, daysWithWrong: 0 });
  });

  it('旧事件无 wrong_picks 字段＝跳过（向后兼容）', () => {
    const legacy: AnswerEventPayload = { question_type: 'review_fill', correct: false, answered_on: '2026-11-01' };
    expect(deriveParentConfusion([legacy, mk([])])).toEqual({ rows: [], totalWrong: 0, daysWithWrong: 0 });
  });

  it('聚合计数＋排序（次数降序，同数次按字母序）', () => {
    const m = deriveParentConfusion([
      mk([['b', 'd'], ['d', 'b'], ['b', 'd']]),
      mk([['p', 'q']]),
      mk([['b', 'd']], '2026-11-07'),
    ]);
    expect(m.rows).toEqual([
      { expected: 'b', picked: 'd', count: 3 },
      { expected: 'd', picked: 'b', count: 1 },
      { expected: 'p', picked: 'q', count: 1 },
    ]);
    expect(m.totalWrong).toBe(5);
    expect(m.daysWithWrong).toBe(2);
  });

  it('topN 截断（缺省 8）', () => {
    const picks: [string, string][] = Array.from({ length: 12 }, (_, i) => [
      String.fromCharCode(97 + i),
      String.fromCharCode(98 + i),
    ]);
    const m = deriveParentConfusion([mk(picks)]);
    expect(m.rows).toHaveLength(8);
    expect(m.totalWrong).toBe(12);
  });
});
