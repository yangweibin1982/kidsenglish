/**
 * 自我对比榜单测（票 39）：三维切片/超越态四分支/最佳连击游程/家庭排名排序与 isSelf。
 */

import { describe, expect, it } from 'vitest';
import type { DailySummary } from '@kidsenglish/engine';
import { deriveComparison, deriveFamilyRank } from './deriveComparison';

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

describe('deriveComparison', () => {
  it('今日超昨日＝up；切片三维各自成立', () => {
    const c = deriveComparison([mk('2026-11-04', { correct: 6 }), mk('2026-11-05', { correct: 8 })], '2026-11-05');
    expect(c.status).toBe('up');
    expect(c.today).toEqual({ points: 18, answered: 10, correct: 8 });
    expect(c.yesterday).toEqual({ points: 16, answered: 10, correct: 6 });
  });

  it('持平＝flat；低于＝down', () => {
    const same = [mk('2026-11-04'), mk('2026-11-05')];
    expect(deriveComparison(same, '2026-11-05').status).toBe('flat');
    const worse = [mk('2026-11-04', { correct: 9 }), mk('2026-11-05', { correct: 8 })];
    expect(deriveComparison(worse, '2026-11-05').status).toBe('down');
  });

  it('今日未开始＝none（昨日有记录也不误判 down）', () => {
    expect(deriveComparison([mk('2026-11-04')], '2026-11-05').status).toBe('none');
  });

  it('单段完成日（无 review 用时）不算打卡：连击游程断开', () => {
    // 11-01/11-02 双段全完成＝连击 2；11-03 只学新词段（断）；11-04/11-05 再连 2
    const days = [
      mk('2026-11-01'),
      mk('2026-11-02'),
      mk('2026-11-03', { segmentSeconds: { newWords: 300, review: 0 } }),
      mk('2026-11-04'),
      mk('2026-11-05'),
    ];
    expect(deriveComparison(days, '2026-11-05').bestStreak).toBe(2);
  });

  it('最佳连击＝全历史（早于 30 天窗的连击也计入）；乱序输入确定', () => {
    const days = [
      mk('2026-10-01'),
      mk('2026-10-02'),
      mk('2026-10-03'),
      mk('2026-11-04'),
      mk('2026-11-05'),
    ];
    expect(deriveComparison([...days].reverse(), '2026-11-05').bestStreak).toBe(3);
  });
});

describe('deriveFamilyRank', () => {
  it('按积分降序＋isSelf 标记（同分按 childId 字典序）', () => {
    const rows = deriveFamilyRank(
      [
        { childId: '2', name: '妹妹', avatar: '🐱', totalPoints: 30 },
        { childId: '1', name: '哥哥', avatar: '🐶', totalPoints: 58 },
        { childId: '3', name: '弟弟', avatar: '🐰', totalPoints: 30 },
      ],
      '2',
    );
    expect(rows.map((r) => r.childId)).toEqual(['1', '2', '3']); // 58 > 30(=) → id '2' < '3'
    expect(rows[1].isSelf).toBe(true);
    expect(rows[0].isSelf).toBe(false);
    expect(rows[1].totalPoints).toBe(30);
  });

  it('单人榜也成立（isSelf 唯一）', () => {
    const rows = deriveFamilyRank([{ childId: '1', name: '独苗', avatar: '🐶', totalPoints: 12 }], '1');
    expect(rows.length).toBe(1);
    expect(rows[0].isSelf).toBe(true);
  });
});
