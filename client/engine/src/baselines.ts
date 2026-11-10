/**
 * 题型基线常量表（R3：熟练度＝正误×反应时，题型分基线；初值可调）。
 *
 * 「快对」定义：答对且反应时 ≤ 该题型基线（毫秒）。
 * 初值为一本（儿童向，给足余量；低年级反应偏慢）：
 *   认知负荷低的选择题给短基线，拼写/句填给长基线。
 * 调用方可用 resolveBaselines(overrides) 覆盖任意子集，无需整体重述。
 */

import type { BaselineTable, QuestionType } from './types.js';

/** 未登记题型的兜底基线（毫秒）。 */
export const DEFAULT_BASELINE_MS = 10_000;

/** 快对判定：反应时 ≤ 基线（恰好等于基线也算快对，边界有单测钉住）。 */
export function isFastCorrect(correct: boolean, reactionTimeMs: number, baselineMs: number): boolean {
  return correct && reactionTimeMs >= 0 && reactionTimeMs <= baselineMs;
}

/** 初值表（可调：所有消费方都应经 resolveBaselines 取值）。 */
export const REACTION_BASELINES_MS: BaselineTable = {
  teach_picture_audio: 8_000, // P0 看图听音（教学，宽裕）
  teach_trace: 10_000, // P0 跟点（动作引导，最宽裕）
  teach_audio_pick_picture: 6_000, // P0 教学三连第三步听音选图
  audio_pick_picture: 5_000, // P1 听音选图
  word_pick_meaning: 6_000, // P2 看词选义
  near_sound_discrimination: 7_000, // P3 音近对比辨析
  word_family_blend: 8_000, // P3 词族串烧
  spelling_letter_bank: 12_000, // P4 字母集合提示拼写
  spelling_full_keyboard: 18_000, // P5 全键盘拼写
  sentence_fill: 15_000, // P5 句子填空
  boss_mix: 12_000, // boss 段综合题
};

/** 取某题型基线：覆盖表优先，未登记题型落兜底值。 */
export function getBaseline(type: QuestionType, overrides?: Partial<BaselineTable>): number {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, type)) {
    const v = overrides[type];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v;
    }
  }
  const base = REACTION_BASELINES_MS[type];
  return typeof base === 'number' && base > 0 ? base : DEFAULT_BASELINE_MS;
}

/** 合并出完整基线表（overrides 只需给要调的题型）。 */
export function resolveBaselines(overrides?: Partial<BaselineTable>): BaselineTable {
  const merged = { ...REACTION_BASELINES_MS };
  if (overrides) {
    for (const key of Object.keys(overrides) as QuestionType[]) {
      const v = overrides[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        merged[key] = v;
      }
    }
  }
  return merged;
}
