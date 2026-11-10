/**
 * 词性中文徽章映射单测（票 51；纯函数回归面）。
 * 映射表覆盖词性全分布 21 值实测（2026-11-08，详见 meaning.ts 头注）——
 * 未列值/无值一律 null＝徽章隐藏（宁缺勿滥，不猜）。
 */
import { describe, expect, it } from 'vitest';
import { posLabel } from './meaning';

describe('posLabel 词性中文徽章（票 51）', () => {
  it('主频缩写映射（n./vt./vi./v. → 名词/动词合并）', () => {
    expect(posLabel('n.')).toBe('名词');
    expect(posLabel('vt.')).toBe('动词');
    expect(posLabel('vi.')).toBe('动词');
    expect(posLabel('v.')).toBe('动词');
  });

  it('形容词双写法与其他高频（a./adj./adv./prep./pron./conj.）', () => {
    expect(posLabel('a.')).toBe('形容词');
    expect(posLabel('adj.')).toBe('形容词');
    expect(posLabel('adv.')).toBe('副词');
    expect(posLabel('prep.')).toBe('介词');
    expect(posLabel('pron.')).toBe('代词');
    expect(posLabel('conj.')).toBe('连词');
  });

  it('长尾缩写全覆盖（num./phra./int./interj./aux./art./abbr./pl./phr./na.）', () => {
    expect(posLabel('num.')).toBe('数词');
    expect(posLabel('phra.')).toBe('词组');
    expect(posLabel('phr.')).toBe('词组');
    expect(posLabel('na.')).toBe('词组');
    expect(posLabel('int.')).toBe('感叹词');
    expect(posLabel('interj.')).toBe('感叹词');
    expect(posLabel('aux.')).toBe('助动词');
    expect(posLabel('art.')).toBe('冠词');
    expect(posLabel('abbr.')).toBe('缩写');
    expect(posLabel('pl.')).toBe('复数');
  });

  it('未知缩写/无值/空串 → null（徽章隐藏，不猜）', () => {
    expect(posLabel('modal.')).toBe(null);
    expect(posLabel('unknown')).toBe(null);
    expect(posLabel(null)).toBe(null);
    expect(posLabel(undefined)).toBe(null);
    expect(posLabel('')).toBe(null);
  });

  it('键归一：大小写与首尾空白不炸映射', () => {
    expect(posLabel('N.')).toBe('名词');
    expect(posLabel(' vt. ')).toBe('动词');
  });
});
