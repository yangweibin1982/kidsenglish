/**
 * 拼阶段纯函数（spec v1.2 S9「读→拼」；票 28 实施锚点）。
 *
 * - slotOptions：正确字母＋2-3 干扰（干扰优先镜像易混组 b↔d、p↔q，次 m↔n、
 *   u↔v、i↔l——b/d 镜像混淆 5-7 岁发育正常，易混项是有效训练而非陷阱），
 *   再取词内其他字母，不足补随机 a-z；洗牌用注入 rand（可测）。
 * - spellChain：字母名朗读链原语——逐字母＋整体发音；块链＝spellChain(块)。
 * - wordChain：整词朗读链（票 28 用户补正定形）——逐音节拼读（每音节字母名→
 *   音节音，h e l→hel、l o→lo）→整词发音（hello）；无拆分＝逐字母→整词。
 *   单字母字符串直接 TTS（引擎读字母名，无需特殊处理——票 28 锚点）。
 */

/** 随机源（注入可测；缺省 Math.random） */
export type Rand = () => number;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/** 镜像易混组（票 28 优先级序：b↔d、p↔q 一档；m↔n、u↔v、i↔l 二档） */
const CONFUSABLE: Record<string, readonly string[]> = {
  b: ['d'],
  d: ['b'],
  p: ['q'],
  q: ['p'],
  m: ['n'],
  n: ['m'],
  u: ['v'],
  v: ['u'],
  i: ['l'],
  l: ['i'],
};

/** Fisher-Yates 洗牌（注入 rand；返回新数组不改入参；rand 退化值钳制防越界） */
export function shuffled<T>(items: readonly T[], rand: Rand): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * 某格的选项集（正确字母＋干扰，洗牌后返回）。
 * 词长 ≤3 用 2 干扰、否则 3；干扰来源优先级：镜像易混组 → 词内其他字母 → 随机 a-z。
 * 大小写不敏感去重且排除正确字母本身（禁出现双正确项）；干扰项跟随词形大小写。
 * slot 越界返回空数组（防御，视图不会发起）。
 */
export function slotOptions(word: string, slot: number, rand: Rand = Math.random): string[] {
  const letters = [...word];
  const target = letters[slot];
  if (target === undefined || target === '') return [];
  const lower = target.toLowerCase();
  const isLower = target === lower;
  const sameCase = (ch: string): string => (isLower ? ch : ch.toUpperCase());
  const count = letters.length <= 3 ? 2 : 3;
  const picked: string[] = [];
  const seen = (ch: string): boolean => picked.some((d) => d.toLowerCase() === ch.toLowerCase());
  const push = (ch: string): void => {
    if (picked.length >= count) return;
    if (ch === '' || ch.toLowerCase() === lower || seen(ch)) return;
    picked.push(sameCase(ch));
  };
  // 1) 镜像易混组优先（b↔d、p↔q；次 m↔n、u↔v、i↔l）
  for (const c of CONFUSABLE[lower] ?? []) push(c);
  // 2) 词内其他字母（按词序取，排除目标字母本身）
  for (const ch of letters) push(ch);
  // 3) 随机 a-z 补足（remaining 每轮排除已取项，循环必终止）
  while (picked.length < count) {
    const remaining = [...ALPHABET].filter((c) => c !== lower && !seen(c));
    if (remaining.length === 0) break; // 理论不可达（26 字母池）
    const idx = Math.min(remaining.length - 1, Math.floor(rand() * remaining.length));
    push(remaining[idx]!);
  }
  return shuffled([target, ...picked], rand);
}

/**
 * 字母名朗读链：逐字母（TTS 引擎读字母名）→ 整体发音。空串返回空链。
 * 逐字母项一律大写（票 52 用户实听定责）：小写 'a' 是英文冠词，引擎读 /ə/
 * （听感＝中文「呃」）而非字母名 /eɪ/；大写单字母引擎读字母名，'I' 同理归一。
 * 整词/音节项（多字符）保持原形——大写多字符串会被引擎当缩写逐字读，禁全大写。
 */
export function spellChain(text: string): string[] {
  if (text.length === 0) return [];
  return [...[...text].map((ch) => ch.toUpperCase()), text];
}

/**
 * 整词朗读链（票 28 用户补正定形）：有拆分＝逐音节拼读——每音节先逐字母读字母名
 * 再读音节音（h e l→hel、l o→lo），音节读完读整词（hello）；无拆分＝逐字母→整词。
 * 单块且块＝整词（单音节词）时块音与整词同音，去重免连读两遍。
 */
export function wordChain(blocks: readonly string[] | null | undefined, word: string): string[] {
  if (!blocks || blocks.length === 0) return spellChain(word);
  if (blocks.length === 1 && blocks[0]!.toLowerCase() === word.toLowerCase()) return spellChain(word);
  return [...blocks.flatMap((b) => spellChain(b)), word];
}
