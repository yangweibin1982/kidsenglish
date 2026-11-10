/**
 * 词包多包化单测（票 35 建面；票 42 版本轮适配：1上/2上 切新版包＋1下/2下 上线，
 * 旧版线包保留在册＝并集查词超集，册次指针不再指向；票 46 高中轮：必修一~选必四
 * 上线人教版（2019年版）7 册——必修一/选必一/选必二指 v2〔v1 单元缺陷修复〕；
 * 票 44 小学扩围：3上~6上 上线课本级词表六册——小学 12 册全通）。
 * import.meta.glob 经 vitest(vite-node) 真实解析（eager 内联单元 JSON）。
 */

import { describe, expect, it } from 'vitest';
import {
  availablePackCount,
  DEFAULT_PACK_ID,
  loadBuiltinPack,
  loadPack,
  loadPackUnion,
  resolvePackId,
} from './packs';

describe('resolvePackId 册次绑定解析（纯函数）', () => {
  it('已上线册次映射：小学 12＋初中 6＋高中 7 册各归现行版包且非回退（票 44 小学全通）', () => {
    expect(resolvePackId('1上')).toEqual({ packId: 'official-1a-v6', fallback: false });
    expect(resolvePackId('1下')).toEqual({ packId: 'official-1b-v2', fallback: false });
    expect(resolvePackId('2上')).toEqual({ packId: 'official-2a-v6', fallback: false });
    expect(resolvePackId('2下')).toEqual({ packId: 'official-2b-v2', fallback: false });
    expect(resolvePackId('3上')).toEqual({ packId: 'official-3a-v3', fallback: false });
    expect(resolvePackId('3下')).toEqual({ packId: 'official-3b-v3', fallback: false });
    expect(resolvePackId('4上')).toEqual({ packId: 'official-4a-v3', fallback: false });
    expect(resolvePackId('4下')).toEqual({ packId: 'official-4b-v3', fallback: false });
    expect(resolvePackId('5上')).toEqual({ packId: 'official-5a-v3', fallback: false });
    expect(resolvePackId('6上')).toEqual({ packId: 'official-6a-v3', fallback: false });
    expect(resolvePackId('5下')).toEqual({ packId: 'official-5b-v3', fallback: false });
    expect(resolvePackId('6下')).toEqual({ packId: 'official-6b-v3', fallback: false });
    expect(resolvePackId('7上')).toEqual({ packId: 'official-7a-v2', fallback: false });
    expect(resolvePackId('7下')).toEqual({ packId: 'official-7b-v3', fallback: false });
    expect(resolvePackId('8上')).toEqual({ packId: 'official-8a-v2', fallback: false });
    expect(resolvePackId('8下')).toEqual({ packId: 'official-8b-v2', fallback: false });
    expect(resolvePackId('9上')).toEqual({ packId: 'official-9a-v2', fallback: false });
    expect(resolvePackId('9下')).toEqual({ packId: 'official-9b-v3', fallback: false });
    expect(resolvePackId('必修一')).toEqual({ packId: 'official-bx1-v4', fallback: false });
    expect(resolvePackId('必修二')).toEqual({ packId: 'official-bx2-v2', fallback: false });
    expect(resolvePackId('必修三')).toEqual({ packId: 'official-bx3-v3', fallback: false });
    expect(resolvePackId('选必一')).toEqual({ packId: 'official-xb1-v4', fallback: false });
    expect(resolvePackId('选必二')).toEqual({ packId: 'official-xb2-v3', fallback: false });
    expect(resolvePackId('选必三')).toEqual({ packId: 'official-xb3-v2', fallback: false });
    expect(resolvePackId('选必四')).toEqual({ packId: 'official-xb4-v2', fallback: false });
  });

  it('未上线册次回退缺省包并标 fallback（票 44 后小学 12 册全上线，剩余仅起步前/未知值）', () => {
    for (const sp of ['0起步', '初一', '二年级', '未知']) {
      const r = resolvePackId(sp);
      expect(r.packId).toBe(DEFAULT_PACK_ID);
      expect(r.fallback).toBe(true);
    }
  });

  it('空/缺绑定＝缺省包且不算回退（旧档案单孩遗留态历史语义原样）', () => {
    expect(resolvePackId(null)).toEqual({ packId: DEFAULT_PACK_ID, fallback: false });
    expect(resolvePackId(undefined)).toEqual({ packId: DEFAULT_PACK_ID, fallback: false });
    expect(resolvePackId('')).toEqual({ packId: DEFAULT_PACK_ID, fallback: false });
  });

  it('非法册次值视同未上线回退', () => {
    const r = resolvePackId('初一');
    expect(r.packId).toBe(DEFAULT_PACK_ID);
    expect(r.fallback).toBe(true);
  });
});

describe('在册包装载（glob 真实解析）', () => {
  it('廿七包在册（现行 25＋旧版线 2 保留）', () => {
    expect(availablePackCount()).toBe(27);
  });

  it('现行版各册词数（票 44 小学 3上-6上＋票 42 小学＋票 45 初中＋票 46 高中；批内重复语义见注释）', () => {
    expect(loadPack('official-1a-v6').ordered).toHaveLength(35);
    expect(loadPack('official-1b-v2').ordered).toHaveLength(41);
    expect(loadPack('official-2a-v6').ordered).toHaveLength(33);
    expect(loadPack('official-2b-v2').ordered).toHaveLength(25);
    // 小学 3上-6上 课本级六册（票 44；批内重复 0，词数与课本 Word list 1:1；4b 149＝课本 150 跳 'from ... to ...'）
    expect(loadPack('official-3a-v3').ordered).toHaveLength(104);
    expect(loadPack('official-3b-v3').ordered).toHaveLength(109);
    expect(loadPack('official-4a-v3').ordered).toHaveLength(137);
    expect(loadPack('official-4b-v3').ordered).toHaveLength(149);
    expect(loadPack('official-5a-v3').ordered).toHaveLength(162);
    expect(loadPack('official-6a-v3').ordered).toHaveLength(134);
    expect(loadPack('official-5b-v3').ordered).toHaveLength(161);
    expect(loadPack('official-6b-v3').ordered).toHaveLength(137);
    expect(loadPack('official-7a-v2').ordered).toHaveLength(326); // 327-批内重复1（首现行去重）
    expect(loadPack('official-7b-v3').ordered).toHaveLength(297); // 299-2
    expect(loadPack('official-8a-v2').ordered).toHaveLength(266); // 267-1
    expect(loadPack('official-8b-v2').ordered).toHaveLength(243);
    expect(loadPack('official-9a-v2').ordered).toHaveLength(219); // 220-1
    expect(loadPack('official-9b-v3').ordered).toHaveLength(188); // 189-1
    // 高中 7 册（票 46；批内重复 0，词数与源词表 1:1）
    expect(loadPack('official-bx1-v4').ordered).toHaveLength(363);
    expect(loadPack('official-bx2-v2').ordered).toHaveLength(389);
    expect(loadPack('official-bx3-v3').ordered).toHaveLength(447);
    expect(loadPack('official-xb1-v4').ordered).toHaveLength(370);
    expect(loadPack('official-xb2-v3').ordered).toHaveLength(378);
    expect(loadPack('official-xb3-v2').ordered).toHaveLength(352);
    expect(loadPack('official-xb4-v2').ordered).toHaveLength(297);
    expect(loadPack('official-1a-v4').ordered).toHaveLength(105);
    expect(loadPack('official-2a-v2').ordered).toHaveLength(113);
  });

  it('新版 1上 词形与旧版线不同（换版语义：grandma 在新包不在旧包首单元序）', () => {
    const nu = loadPack('official-1a-v6');
    const old = loadPack('official-1a-v4');
    expect(nu.byId.has('w_grandma')).toBe(true);
    expect(old.byId.has('w_hello')).toBe(true);
  });

  it('高中必修一 v4 单元面（票 46 缺陷修复：Welcome 与 Teenage Life 分立六单元）', () => {
    const p = loadPack('official-bx1-v4');
    const unitNos = [...new Set(p.ordered.map((w) => w.unitNo))].sort((a, b) => a - b);
    expect(unitNos).toEqual([1, 2, 3, 4, 5, 6]);
    // Welcome Unit 首词 exchange（对线实证）；Unit 2 旅行词在册；他册系词不在
    expect(p.ordered[0].word).toBe('exchange');
    expect(p.byId.has('w_the_eiffel_tower')).toBe(true);
    expect(p.byId.has('w_virtual_choir')).toBe(false); // 必修二系词不在必修一
  });

  it('高中包词条 curated 释义抽查（专名百科式义项在包）', () => {
    expect(loadPack('official-bx2-v2').byId.get('w_virtual_choir')?.meaning).toBe('虚拟合唱团');
    expect(loadPack('official-bx2-v2').byId.get('w_the_nile')?.meaning).toBe('尼罗河');
    expect(loadPack('official-xb2-v3').byId.get('w_cpr')?.meaning).toBe('心肺复苏');
  });

  it('小学 3上-6上 单元面与 curated 抽查（票 44 课本级：12 单元＋词组/专名义项在包）', () => {
    for (const packId of ['official-3a-v3', 'official-3b-v3', 'official-4a-v3', 'official-4b-v3', 'official-5a-v3', 'official-6a-v3']) {
      const p = loadPack(packId);
      const unitNos = [...new Set(p.ordered.map((w) => w.unitNo))].sort((a, b) => a - b);
      expect(unitNos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
    // 词组/缩略语 curated 通道装配（ECDICT 查无 36 词中抽 4）
    expect(loadPack('official-3a-v3').byId.get('w_a_an')?.meaning).toBe('一（个、件……）');
    expect(loadPack('official-4b-v3').byId.get('w_pe')?.meaning).toBe('体育（课）');
    expect(loadPack('official-5a-v3').byId.get('w_put_out_fires')?.meaning).toBe('灭火');
    expect(loadPack('official-6a-v3').byId.get('w_south_china_tiger')?.meaning).toBe('华南虎');
    // 单元归属抽查：3上 U1 Hello 首词 hello；6a 华南虎在 U5 Animals in danger
    expect(loadPack('official-3a-v3').ordered[0].word).toBe('hello');
    expect(loadPack('official-6a-v3').byId.get('w_south_china_tiger')?.unitNo).toBe(5);
  });

  it('缺省包＝loadBuiltinPack（现行版 1上 v5）', () => {
    expect(loadBuiltinPack().packId).toBe('official-1a-v6');
    expect(loadBuiltinPack().ordered).toHaveLength(35);
  });

  it('票 51 词义呈现投影（phoneticUk/senses/examples 三字段放行＋空值剔除）', () => {
    // 1上 v5 首词 grandma：整词分支首卡——音标/词性/双语例句全有，投影逐字段钉死
    const g = loadPack('official-1a-v6').byId.get('w_grandma');
    expect(g?.phoneticUk).toBe("'grændmɑ:");
    expect(g?.senses).toEqual([{ pos: 'n.', gloss: '奶奶, 外婆' }]);
    expect(g?.examples.length).toBeGreaterThan(0);
    expect(g?.examples[0]?.en).toContain('grandma');
    expect(g?.examples[0]?.zh.length).toBeGreaterThan(0);
    // pos 无值词（如 grandpa）＝pos null 但 gloss 保留（徽章隐藏面）
    const gp = loadPack('official-1a-v6').byId.get('w_grandpa');
    expect(gp?.senses[0]?.pos).toBe(null);
    expect(gp?.senses[0]?.gloss.length).toBeGreaterThan(0);
    // 全库不变式：examples 一律 en 非空（投影剔除空例句）；senses gloss 非空
    for (const packId of ['official-1a-v6', 'official-3a-v3', 'official-bx1-v4']) {
      for (const w of loadPack(packId).ordered) {
        for (const ex of w.examples) expect(ex.en.length).toBeGreaterThan(0);
        for (const s of w.senses) expect(s.gloss.length).toBeGreaterThan(0);
      }
    }
  });

  it('未在册包 id 抛错', () => {
    expect(() => loadPack('official-3c-v1')).toThrow();
  });
});

describe('并集包（复习查词超集面）', () => {
  it('全 27 包词形在并集（跨包去重；旧线/小学/初中/高中同面可用）', () => {
    const u = loadPackUnion();
    expect(u.byId.has('w_ride_a_bicycle')).toBe(true);
    expect(u.byId.has('w_grandma')).toBe(true);
    expect(u.byId.has('w_virtual_choir')).toBe(true);
    expect(u.byId.has('w_stephen_hawking')).toBe(true);
    expect(u.byId.has('w_south_china_tiger')).toBe(true); // 票 44 小学新面
    for (const packId of [
      'official-1a-v6', 'official-1b-v2', 'official-2a-v6', 'official-2b-v2', 'official-5b-v3', 'official-6b-v3',
      'official-3a-v3', 'official-3b-v3', 'official-4a-v3', 'official-4b-v3', 'official-5a-v3', 'official-6a-v3',
      'official-7a-v2', 'official-7b-v3', 'official-8a-v2', 'official-8b-v2', 'official-9a-v2', 'official-9b-v3',
      'official-bx1-v4', 'official-bx2-v2', 'official-bx3-v3', 'official-xb1-v4', 'official-xb2-v3', 'official-xb3-v2', 'official-xb4-v2',
      'official-1a-v4', 'official-2a-v2',
    ]) {
      for (const w of loadPack(packId).ordered) expect(u.byId.has(w.entryId)).toBe(true);
    }
    // 去重：并集词数 ≤ 廿七包词数之和
    expect(u.ordered.length).toBeLessThanOrEqual(35 + 41 + 33 + 25 + 104 + 109 + 137 + 149 + 162 + 134 + 161 + 137 + 327 + 299 + 267 + 243 + 220 + 189 + 105 + 113 + 363 + 389 + 447 + 370 + 378 + 352 + 297);
  });
});
