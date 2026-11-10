/**
 * 毕业池月度抽样接口（R3：毕业后每月 10% 抽样维护）＋音近约束接口（R6）＋日期工具。
 */
import { describe, expect, it } from 'vitest';

import {
  NEAR_SOUND_MIN_GAP_DAYS,
  addDays,
  dayOfWeek,
  daysBetween,
  filterNewWordsByNearSoundSpacing,
  findConflictingIntro,
  isNearSoundPair,
  isWeekend,
  isValidIsoDate,
  monthKey,
  selectGraduatedSample,
} from '../src/index.js';
import type { CardPoolState } from '../src/index.js';
import { MON, SAT, SUN, card, mulberry32 } from './helpers.js';

describe('毕业池月度抽样（确定性、约 10%、按月换组）', () => {
  function graduatedBatch(n: number, childId = 'child-1'): CardPoolState[] {
    const rnd = mulberry32(7);
    return Array.from({ length: n }, (_, i) =>
      card({
        childId,
        lexicalEntryId: `grad-${String(i).padStart(4, '0')}`,
        pool: 'graduated',
        dueDate: null,
        errorStreak: Math.floor(rnd() * 2),
      }),
    );
  }

  it('确定性：同月同批重复调用结果一致', () => {
    const batch = graduatedBatch(500);
    const a = selectGraduatedSample(batch, '2026-10-01');
    const b = selectGraduatedSample(batch, '2026-10-28');
    expect(a).toEqual(b); // 同一月份键 → 同一组
  });

  it('抽样率约 10%（2000 词落在 5%-15% 区间）', () => {
    const batch = graduatedBatch(2000);
    const picked = selectGraduatedSample(batch, '2026-10-15');
    expect(picked.length).toBeGreaterThan(100);
    expect(picked.length).toBeLessThan(300);
    expect(picked.every((s) => s.pool === 'graduated')).toBe(true);
  });

  it('跨月换组：11 月的抽样集与 10 月不同', () => {
    const batch = graduatedBatch(2000);
    const oct = selectGraduatedSample(batch, '2026-10-15').map((s) => s.lexicalEntryId);
    const nov = selectGraduatedSample(batch, '2026-11-15').map((s) => s.lexicalEntryId);
    expect(oct).not.toEqual(nov);
  });

  it('rate 可调：0.5 抽约一半；越界 rate 抛错', () => {
    const batch = graduatedBatch(1000);
    const half = selectGraduatedSample(batch, '2026-10-15', 0.5);
    expect(half.length).toBeGreaterThan(400);
    expect(half.length).toBeLessThan(600);
    expect(() => selectGraduatedSample(batch, '2026-10-15', 0)).toThrow();
    expect(() => selectGraduatedSample(batch, '2026-10-15', 1.5)).toThrow();
  });

  it('非毕业池卡永不被抽中；salt 隔离不同孩子', () => {
    const mixed = [...graduatedBatch(100), card({ lexicalEntryId: 'p5-w', pool: 'P5', dueDate: MON })];
    const picked = selectGraduatedSample(mixed, '2026-10-15');
    expect(picked.every((s) => s.pool === 'graduated')).toBe(true);
    const a = selectGraduatedSample(graduatedBatch(500, 'child-1'), '2026-10-15', 0.1, 'salt-a');
    const b = selectGraduatedSample(graduatedBatch(500, 'child-1'), '2026-10-15', 0.1, 'salt-b');
    expect(a).not.toEqual(b);
  });
});

describe('音近引入间隔约束接口（R6：引入日隔 ≥3 天；混淆词对只留接口）', () => {
  const ctx = { pairs: [['cat', 'cap'] as [string, string]], introDates: { cap: '2026-10-24' } };

  it('默认最小间隔 = 3 天', () => {
    expect(NEAR_SOUND_MIN_GAP_DAYS).toBe(3);
  });

  it('伙伴 2 天前引入 → 冲突；满 3 天 → 放行', () => {
    const conflict = findConflictingIntro('cat', ctx, '2026-10-26'); // gap=2
    expect(conflict).not.toBeNull();
    expect(conflict?.partner).toBe('cap');
    expect(conflict?.gapDays).toBe(2);
    expect(findConflictingIntro('cat', ctx, '2026-10-27')).toBeNull(); // gap=3 放行
  });

  it('词对无序且大小写不敏感', () => {
    expect(isNearSoundPair('CAT', 'cap', [['cat', 'cap']])).toBe(true);
    expect(isNearSoundPair('cap', 'CAT', [['Cat', 'CaP']])).toBe(true);
    expect(isNearSoundPair('dog', 'cap', [['cat', 'cap']])).toBe(false);
  });

  it('过滤器：冲突候选挡下，放行者记为当日引入并约束同批伙伴', () => {
    const cat = card({ lexicalEntryId: 'cat', pool: 'P0', dueDate: MON, recentOutcomes: [] });
    const cap = card({ lexicalEntryId: 'cap', pool: 'P0', dueDate: MON, recentOutcomes: [] });
    const bat = card({ lexicalEntryId: 'bat', pool: 'P0', dueDate: MON, recentOutcomes: [] });
    const { allowed, blocked } = filterNewWordsByNearSoundSpacing(
      [cat, cap, bat],
      { pairs: [['cat', 'cap']], introDates: {} },
      MON,
    );
    expect(allowed.map((s) => s.lexicalEntryId)).toEqual(['cat', 'bat']);
    expect(blocked.map((s) => s.lexicalEntryId)).toEqual(['cap']);
  });

  it('已过窗的伙伴不再阻塞新引入', () => {
    const cat = card({ lexicalEntryId: 'cat', pool: 'P0', dueDate: MON, recentOutcomes: [] });
    const { allowed, blocked } = filterNewWordsByNearSoundSpacing(
      [cat],
      { pairs: [['cat', 'cap']], introDates: { cap: '2026-10-20' } }, // 6 天前
      MON,
    );
    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(0);
  });
});

describe('纯日期工具（无时钟、无时区）', () => {
  it('星期判定：2026-10-24 周六、25 周日、26 周一', () => {
    expect(dayOfWeek(SAT)).toBe(6);
    expect(dayOfWeek(SUN)).toBe(0);
    expect(dayOfWeek(MON)).toBe(1);
    expect(isWeekend(SAT)).toBe(true);
    expect(isWeekend(SUN)).toBe(true);
    expect(isWeekend(MON)).toBe(false);
  });

  it('跨月加日与天数差', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // 闰年
    expect(daysBetween('2026-10-20', '2026-10-26')).toBe(6);
    expect(daysBetween('2026-10-26', '2026-10-20')).toBe(-6);
    expect(monthKey('2026-10-26')).toBe('2026-10');
  });

  it('非法日期识别（格式与日历有效性）', () => {
    expect(isValidIsoDate('2026-10-26')).toBe(true);
    expect(isValidIsoDate('2026-2-6')).toBe(false);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('not-a-date')).toBe(false);
  });
});
