/**
 * 词光拓展资料查询单测（票 56）：真实 atlas-extra.json 加载（构建期工件）——
 * 命中/未命中/归一化查询/署名面。
 */
import { describe, expect, it } from 'vitest';
import { ATLAS_SOURCE, atlasExtraCount, atlasExtraFor } from './atlasExtra';

describe('atlasExtraFor 词光拓展查询（票 56）', () => {
  it('命中词返回拓展字段（morning：tip＋col）', () => {
    const extra = atlasExtraFor('morning');
    expect(extra).not.toBeNull();
    expect(extra?.tip).toBeTruthy();
    expect(Array.isArray(extra?.col)).toBe(true);
    expect((extra?.col ?? []).some((c) => c.includes('清晨') || c.includes('morning'))).toBe(true);
  });

  it('归一化查询：大小写与空白不炸键', () => {
    expect(atlasExtraFor('Morning')).not.toBeNull();
    expect(atlasExtraFor('  morning ')).not.toBeNull();
  });

  it('未命中返回 null（拓展区不渲染＝宁缺勿滥）', () => {
    expect(atlasExtraFor('grandma')).toBeNull();
    expect(atlasExtraFor('zzznotaword')).toBeNull();
    expect(atlasExtraFor('')).toBeNull();
  });

  it('数据面：命中数千词级＋署名行含 CC BY 4.0', () => {
    expect(atlasExtraCount()).toBeGreaterThan(2000);
    expect(ATLAS_SOURCE).toContain('CC BY 4.0');
  });
});
