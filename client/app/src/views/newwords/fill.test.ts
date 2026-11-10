/**
 * 拼阶段纯函数测试（Ticket 28 VALIDATE 1）：
 * - slotOptions：易混优先／词内池／随机补足／洗牌确定性／大小写与去重防御；
 * - spellChain／wordChain：朗读链形状（逐字母＋整体；逐音节拼读→整词——票 28 用户补正）；
 * - pickPraise：洗牌循环队列——随机且不连续重复（任意连续窗口互不相同）。
 */
import { describe, expect, it } from 'vitest';
import { shuffled, slotOptions, spellChain, wordChain } from './fill';
import { PRAISE_LINES, pickPraise } from './praise';

/** 注入 rand：固定返回同一值（退化序列，用于确定性断言） */
function constRand(v: number): () => number {
  return () => v;
}

/** 注入 rand：按序返回（耗尽后重复末值） */
function seqRand(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe('slotOptions：干扰来源优先级', () => {
  it('镜像易混优先：b 的干扰必含 d（b↔d 一档；rand 不消耗）', () => {
    const opts = slotOptions('bat', 0, constRand(0.5));
    expect(opts).toHaveLength(3); // 词长 3 → 1 正确＋2 干扰
    expect(opts).toContain('b');
    expect(opts).toContain('d'); // 易混镜像必入选项
    expect([...opts].sort()).toEqual(['a', 'b', 'd']);
  });

  it('p↔q 镜像：q 的干扰必含 p', () => {
    const opts = slotOptions('quick', 1, constRand(0.5)); // u — 用 q 词验证 p↔q
    expect(slotOptions('quit', 0, constRand(0.5))).toContain('p'); // q → p
    expect(opts).toHaveLength(4);
  });

  it('无易混组时回落词内字母池：e 的干扰取词内其他字母', () => {
    const opts = slotOptions('hello', 1, constRand(0.5)); // e
    expect([...opts].sort()).toEqual(['e', 'h', 'l', 'o']);
  });

  it('词内池按词序取且去重：l（重复字母）干扰不重复', () => {
    const opts = slotOptions('hello', 2, constRand(0.5)); // l → 易混 i ＋ 词内 h,e,o
    expect([...opts].sort()).toEqual(['e', 'h', 'i', 'l']);
  });

  it('词内池不足时随机 a-z 补足：ax 的 a 只有一个词内字母', () => {
    // remaining = a-z 去 a/x；rand=0 恒取 remaining 首个 b → 选项集 {a,x,b}
    const opts = slotOptions('ax', 0, constRand(0));
    expect(opts).toHaveLength(3);
    expect([...opts].sort()).toEqual(['a', 'b', 'x']);
  });

  it('词长 ≤3 用 2 干扰、否则 3', () => {
    expect(slotOptions('me', 0, constRand(0.5))).toHaveLength(3); // m → n ＋ e
    expect(slotOptions('cat', 1, constRand(0.5))).toHaveLength(3);
    expect(slotOptions('cats', 0, constRand(0.5))).toHaveLength(4);
  });

  it('slot 越界返回空数组（防御）', () => {
    expect(slotOptions('hi', 99, constRand(0.5))).toEqual([]);
    expect(slotOptions('', 0, constRand(0.5))).toEqual([]);
  });
});

describe('slotOptions：洗牌确定性与大小写防御', () => {
  it('同注入 rand 序列 ⇒ 输出完全一致（洗牌确定性）', () => {
    const a = slotOptions('panda', 0, seqRand(0.1, 0.9, 0.3, 0.7, 0.2));
    const b = slotOptions('panda', 0, seqRand(0.1, 0.9, 0.3, 0.7, 0.2));
    expect(a).toEqual(b);
  });

  it('rand=0 的 Fisher-Yates 有确定序（洗牌可测性钉死）', () => {
    // 手推：['a','x','b']，i=2 swap(2,0)→[b,x,a]；i=1 swap(1,0)→[x,b,a]
    expect(shuffled(['a', 'x', 'b'], constRand(0))).toEqual(['x', 'b', 'a']);
  });

  it('大小写跟随词形且比对不敏感：M 的干扰为 N/E（大写），无 m/e 泄入', () => {
    const opts = slotOptions('Me', 0, constRand(0.5));
    expect(opts).toContain('M');
    expect([...opts].sort()).toEqual(['E', 'M', 'N']);
  });

  it('禁双正确项：干扰永不等于目标字母（大小写不敏感）', () => {
    for (let slot = 0; slot < 'banana'.length; slot += 1) {
      const opts = slotOptions('banana', slot, constRand(0.3));
      const target = 'banana'[slot]!.toLowerCase();
      const others = opts.filter((o) => o.toLowerCase() !== target);
      expect(others.length).toBe(opts.length - 1); // 恰一个正确项
      expect(opts).toHaveLength(4);
    }
  });
});

describe('spellChain：字母名朗读链形状（整词链/块链同构；逐字母大写＝票 52）', () => {
  it('整词链＝逐字母字母名（大写，防冠词读音）＋整词原形', () => {
    expect(spellChain('hello')).toEqual(['H', 'E', 'L', 'L', 'O', 'hello']);
  });

  it('块链＝块内逐字母（大写）＋块音（视图层拼装：进卡播整词链、点块播块链）', () => {
    expect(spellChain('hel')).toEqual(['H', 'E', 'L', 'hel']);
  });

  it("小写 'a' 大写化＝防冠词读音（票 52 用户实听：引擎把 'a' 读 /ə/ 冠词非字母名 /eɪ/；exchange 全链钉死）", () => {
    expect(spellChain('a')).toEqual(['A', 'a']);
    expect(wordChain(null, 'exchange')).toEqual(['E', 'X', 'C', 'H', 'A', 'N', 'G', 'E', 'exchange']);
  });

  it('全字母不变式（票 52 审计）：a-z 26 字母逐字母项全大写＋末项原形——单字母唯一出口 spellChain', () => {
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    for (const ch of lower) {
      const chain = spellChain(ch);
      expect(chain).toHaveLength(2);
      expect(chain[0]).toBe(ch.toUpperCase()); // 逐字母项大写＝引擎读字母名（防词形歧义）
      expect(chain[1]).toBe(ch); // 整词项原形
    }
    // 大小写混合词逐字母项亦大写（'I' 类词形词同面）
    expect(spellChain('It').slice(0, 2)).toEqual(['I', 'T']);
  });

  it('空串防御：空链', () => {
    expect(spellChain('')).toEqual([]);
  });
});

describe('wordChain：整词朗读链（票 28 用户补正＝逐音节拼读→整词）', () => {
  it('有拆分：每音节字母名→音节音，最后整词（hello＝H E L hel l o lo hello；字母项大写＝票 52）', () => {
    expect(wordChain(['hel', 'lo'], 'hello')).toEqual(['H', 'E', 'L', 'hel', 'L', 'O', 'lo', 'hello']);
  });

  it('无拆分：逐字母→整词（spellChain 同形）', () => {
    expect(wordChain(undefined, 'cat')).toEqual(['C', 'A', 'T', 'cat']);
    expect(wordChain([], 'cat')).toEqual(['C', 'A', 'T', 'cat']);
  });

  it('单块且块＝整词：块音与整词同音去重，不连读两遍', () => {
    expect(wordChain(['cat'], 'cat')).toEqual(['C', 'A', 'T', 'cat']);
  });
});

describe('pickPraise：洗牌循环队列（随机且不连续重复）', () => {
  it('预设 ≥8 条（票 28；spec 门槛 ≥5）', () => {
    expect(PRAISE_LINES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(PRAISE_LINES).size).toBe(PRAISE_LINES.length); // 无重复条目
  });

  it('200 连取不连续重复（Math.random 实随路径）', () => {
    let prev: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const p = pickPraise();
      expect(PRAISE_LINES).toContain(p);
      expect(p).not.toBe(prev); // 相邻两次必不同（票 28 契约＝随机且不连续重复）
      prev = p;
    }
  });

  it('洗牌循环性质：800 连取（100 整轮）每条恰好出现 100 次', () => {
    const counts = new Map<string, number>(PRAISE_LINES.map((p) => [p, 0]));
    for (let i = 0; i < 800; i += 1) {
      const p = pickPraise();
      counts.set(p, counts.get(p)! + 1);
    }
    for (const [line, n] of counts) {
      expect(n).toBe(100); // 每轮发尽 8 条再重洗 ⇒ 每条频率严格相等
      expect(line).toBeTruthy();
    }
  });
});
