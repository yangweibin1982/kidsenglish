/**
 * 新词卡词义呈现辅助（票 51；纯函数独立导出＝回归测试面，
 * 同 slotOptions/buildNewWordFillPayload 先例）。
 *
 * 词性 ECDICT 缩写 → 中文徽章（用户裁定：儿童不用 n./vt. 缩写体系；
 * v./vt./vi. 并入「动词」；未知缩写/无值 → null＝徽章隐藏，宁缺勿滥）。
 * 词性全分布实测（2026-11-08，5,580 词条首义项）：n. 3448／vt. 1125／a. 1059／
 * vi. 515／v. 329／adv. 260／prep. 67／pron. 58／num. 30／conj. 25／phra. 17／
 * adj. 14／int. 10／aux. 10／abbr. 7／pl. 6／art. 5／interj.／na.／phr. 各 1。
 */

/** ECDICT 词性缩写 → 中文徽章映射表（键小写归一比对）。 */
const POS_LABELS: Readonly<Record<string, string>> = {
  'n.': '名词',
  'v.': '动词',
  'vt.': '动词',
  'vi.': '动词',
  'a.': '形容词',
  'adj.': '形容词',
  'adv.': '副词',
  'prep.': '介词',
  'pron.': '代词',
  'num.': '数词',
  'conj.': '连词',
  'int.': '感叹词',
  'interj.': '感叹词',
  'aux.': '助动词',
  'art.': '冠词',
  'abbr.': '缩写',
  'pl.': '复数',
  'phra.': '词组',
  'phr.': '词组',
  'na.': '词组',
};

/**
 * 词性徽章文案。null＝不渲染徽章（无值/未知缩写——不猜，兜底宁缺勿滥）。
 * @param pos 词包词条 senses[].pos 原值（ECDICT 缩写；null/undefined＝无值）
 */
export function posLabel(pos: string | null | undefined): string | null {
  if (!pos) return null;
  return POS_LABELS[pos.toLowerCase().trim()] ?? null;
}
