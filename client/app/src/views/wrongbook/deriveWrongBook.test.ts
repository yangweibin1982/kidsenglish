/**
 * 错题本单测（票 41 V1）：错词筛选（errorStreak/recentOutcomes 两来源）/排序/全对排除/缺词投影容错。
 */

import { describe, expect, it } from 'vitest';
import type { CardPoolState } from '@kidsenglish/engine';
import { deriveWrongBook } from './deriveWrongBook';
import type { PackWord } from '../../store/packs';

function mkPool(entryId: string, over: Partial<CardPoolState> = {}): CardPoolState {
  return {
    childId: '1',
    lexicalEntryId: entryId,
    pool: 'P1',
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

function mkWord(entryId: string, word: string): [string, PackWord] {
  return [entryId, { entryId, word, meaning: `${word} 的意思`, phonicsSplit: null, unitNo: 1, phoneticUk: null, senses: [], examples: [] }];
}

describe('deriveWrongBook', () => {
  it('errorStreak>0 ∨ recentOutcomes 含答错＝错词（两来源并集）', () => {
    const byId = new Map([mkWord('w1', 'apple'), mkWord('w2', 'banana')]);
    const rows = deriveWrongBook(
      [
        mkPool('w1', { errorStreak: 2 }), // 来源一：连击未清零（缓存被清的边界也捕获）
        mkPool('w2', {
          errorStreak: 0,
          recentOutcomes: [
            { correct: true, fast: true, answeredOn: '2026-11-05' },
            { correct: false, fast: false, answeredOn: '2026-11-04' },
          ],
        }), // 来源二：近 3 次含答错（答对已清零连击）
      ],
      byId,
    );
    expect(rows.map((r) => r.entryId).sort()).toEqual(['w1', 'w2']);
  });

  it('全对（含毕业词）不出现', () => {
    const rows = deriveWrongBook(
      [
        mkPool('w1', { pool: 'graduated' }),
        mkPool('w2', { recentOutcomes: [{ correct: true, fast: false, answeredOn: '2026-11-05' }] }),
      ],
      new Map(),
    );
    expect(rows).toEqual([]);
  });

  it('投影：词形/释义来自词包；缺词容错＝词形回退 entryId 不丢行', () => {
    const byId = new Map([mkWord('w1', 'apple')]);
    const rows = deriveWrongBook(
      [mkPool('w1', { errorStreak: 1 }), mkPool('ghost', { errorStreak: 1 })],
      byId,
    );
    const w1 = rows.find((r) => r.entryId === 'w1');
    const ghost = rows.find((r) => r.entryId === 'ghost');
    expect(w1?.word).toBe('apple');
    expect(w1?.meaning).toContain('的意思');
    expect(ghost?.word).toBe('ghost');
    expect(ghost?.meaning).toBe('');
  });

  it('排序＝最近答错降序 → 连错降序 → entryId 字典序（确定性）', () => {
    const rows = deriveWrongBook(
      [
        mkPool('old', { errorStreak: 1, recentOutcomes: [{ correct: false, fast: false, answeredOn: '2026-11-01' }] }),
        mkPool('new', { errorStreak: 1, recentOutcomes: [{ correct: false, fast: false, answeredOn: '2026-11-05' }] }),
        mkPool('mid', { errorStreak: 1, recentOutcomes: [{ correct: false, fast: false, answeredOn: '2026-11-03' }] }),
        mkPool('tied', { errorStreak: 3, recentOutcomes: [{ correct: false, fast: false, answeredOn: '2026-11-05' }] }),
      ],
      new Map(),
    );
    // new 与 tied 同日 → 连错 3 > 1 → tied 在前
    expect(rows.map((r) => r.entryId)).toEqual(['tied', 'new', 'mid', 'old']);
  });

  it('childId 混入面不越权：非当前档案词由调用方过滤（本函数只认池状态面）', () => {
    // 隔离边界注记：foldedState 已是单档案投影（learningData 保证）；此处验证零假设下的行为不变
    const rows = deriveWrongBook([mkPool('w1', { childId: 'other', errorStreak: 1 })], new Map());
    expect(rows.length).toBe(1);
  });
});
