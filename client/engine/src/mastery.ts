/**
 * 熟练度判定（R3：熟练度＝正误×反应时，题型分基线）。
 *
 * 分值形状（连续、单调、以题型基线为锚）：
 *   答错                          → 0
 *   答对且快（rt ≤ 基线）          → 0.5 + 0.5 × (1 − rt/基线)      ∈ (0.5, 1]
 *   答对但慢（rt > 基线）          → 0.5 × (1 − (rt−基线)/基线)     ∈ [0, 0.5)
 * 基线处左右两侧同为 0.5（连续）；rt ≥ 2×基线的慢答对趋近 0。
 * 决策面只依赖 {correct, fast}（transition.ts），分值供周报/家长面展示。
 */

import { getBaseline } from './baselines.js';
import type { AnswerEvent, BaselineTable } from './types.js';

const EPS = 1e-9;

/** 熟练度分（0-1，保留 3 位小数；无效反应时按 0 处理）。 */
export function assessMastery(event: AnswerEvent, baselines?: Partial<BaselineTable>): number {
  const baseline = getBaseline(event.questionType, baselines);
  if (!event.correct || !Number.isFinite(event.reactionTimeMs) || event.reactionTimeMs < 0) {
    return 0;
  }
  const rt = event.reactionTimeMs;
  let score: number;
  if (rt <= baseline) {
    score = 0.5 + 0.5 * (1 - rt / baseline);
  } else {
    score = 0.5 * Math.max(0, 1 - (rt - baseline) / baseline);
  }
  if (score < EPS) score = 0;
  if (score > 1) score = 1;
  return Math.round(score * 1000) / 1000;
}
