/**
 * 变式三档选档（R5）。
 *
 * 规则：
 * 1. 档位由该词近 3 次作答的快对率决定（fastRate = 快对次数 / 样本数）：
 *      fastRate ≥ 2/3（且样本 ≥ 2）→ hard（快对的词吃升级变式）
 *      1/3 ≤ fastRate < 2/3        → standard
 *      fastRate < 1/3              → easy（勉强的词吃脚手架：二选一/首字母提示）
 *    无历史样本 → standard。阈值以常量导出，可调。
 * 2. 答错的词当日出题回教学重学形态（R5/E1）：最近一次作答为「错」且作答日
 *    等于出题日时，返回 'relearn'（这不是档位，是当日出题形态标记；
 *    状态里 materialize 的 variationTier 始终是三档之一）。
 */

import type { OutcomeRecord, IsoDate, VariationForm, VariationTier } from './types.js';

/** hard 档最低快对率（近 3 次 ≥2 次快对）。 */
export const HARD_FAST_RATE = 2 / 3;
/** hard 档最少样本数（避免单次快对即升级）。 */
export const MIN_SAMPLES_FOR_HARD = 2;
/** easy 档快对率下界（低于此值吃脚手架）。 */
export const EASY_FAST_RATE = 1 / 3;

/** 近 3 次快对率（样本最多取 3，按传入顺序的末尾 3 条）。 */
export function recentFastRate(recent: readonly OutcomeRecord[]): number {
  const slice = recent.slice(-3);
  if (slice.length === 0) return 0;
  const fastCount = slice.filter((o) => o.fast).length;
  return fastCount / slice.length;
}

/** 按近 3 次快对率选三档（不含 relearn 形态判定）。 */
export function selectVariationTier(recent: readonly OutcomeRecord[]): VariationTier {
  const slice = recent.slice(-3);
  if (slice.length === 0) return 'standard';
  const rate = recentFastRate(slice);
  if (rate >= HARD_FAST_RATE && slice.length >= MIN_SAMPLES_FOR_HARD) return 'hard';
  if (rate < EASY_FAST_RATE) return 'easy';
  return 'standard';
}

/**
 * 出题形态判定：三档选档 ＋「答错当日回教学重学」同日覆盖。
 * @param recent    近 3 次作答（最近的在末尾）
 * @param today     出题日（ISO 日期）；省略则不做同日 relearn 判定
 */
export function selectVariationForm(
  recent: readonly OutcomeRecord[],
  today?: IsoDate,
): VariationForm {
  if (today !== undefined) {
    const latest = recent[recent.length - 1];
    if (latest && !latest.correct && latest.answeredOn === today) {
      return 'relearn';
    }
  }
  return selectVariationTier(recent);
}
