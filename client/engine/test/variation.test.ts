/**
 * US-05：变式三档选档（R5：按近 3 次快对率自动选档；答错当日回教学重学形态）。
 */
import { describe, expect, it } from 'vitest';

import { applyAnswer, recentFastRate, selectVariationForm, selectVariationTier } from '../src/index.js';
import type { OutcomeRecord } from '../src/index.js';
import { MON, answer, card } from './helpers.js';

function o(correct: boolean, fast: boolean, answeredOn = MON): OutcomeRecord {
  return { correct, fast, answeredOn };
}

describe('按近 3 次快对率选三档（阈值：≥2/3 难、<1/3 易、其间标准）', () => {
  it('无历史 → standard', () => {
    expect(selectVariationTier([])).toBe('standard');
  });

  it('3 次全快 → hard（快对的词吃升级变式）', () => {
    expect(selectVariationTier([o(true, true), o(true, true), o(true, true)])).toBe('hard');
  });

  it('3 次 2 快 1 慢 → hard（快对率 2/3 达阈值）', () => {
    expect(selectVariationTier([o(true, true), o(true, true), o(true, false)])).toBe('hard');
  });

  it('3 次 1 快 → standard', () => {
    expect(selectVariationTier([o(true, true), o(true, false), o(true, false)])).toBe('standard');
  });

  it('3 次 0 快（含答错）→ easy（勉强的词吃脚手架）', () => {
    expect(selectVariationTier([o(true, false), o(false, false), o(true, false)])).toBe('easy');
  });

  it('只看最近 3 次：更早的样本被滑出窗口', () => {
    // 历史 [快,快,快] 已滑出，最近 3 次 = [快,慢,慢] → 1/3 → standard
    const recent = [o(true, true, '2026-10-01'), o(true, true, '2026-10-02'), o(true, true, '2026-10-03'), o(true, true, '2026-10-04'), o(true, false, '2026-10-05'), o(true, false, '2026-10-06')];
    expect(selectVariationTier(recent)).toBe('standard');
  });

  it('快对率口径：recentFastRate 只取末尾 3 条', () => {
    expect(recentFastRate([o(true, true), o(true, true), o(true, true), o(true, false)])).toBe(2 / 3);
  });

  it('样本不足 2 次不升 hard（避免单次快对即升级）', () => {
    expect(selectVariationTier([o(true, true)])).toBe('standard');
  });

  it('样本 2 次全快 → hard（达到最少样本且比率达标）', () => {
    expect(selectVariationTier([o(true, true), o(true, true)])).toBe('hard');
  });
});

describe('答错当日回教学重学形态（R5/E1 同日规则）', () => {
  it('最近一次答错且作答日=出题日 → relearn', () => {
    const recent = [o(true, true, '2026-10-20'), o(false, false, MON)];
    expect(selectVariationForm(recent, MON)).toBe('relearn');
  });

  it('答错但不是当日（历史错）→ 正常三档，不强制 relearn', () => {
    const recent = [o(false, false, '2026-10-20'), o(true, true, '2026-10-22'), o(true, true, '2026-10-24')];
    expect(selectVariationForm(recent, MON)).toBe('hard');
  });

  it('省略出题日 → 只做三档判定', () => {
    expect(selectVariationForm([o(false, false, MON)])).toBe('easy');
  });

  it('集成：applyAnswer 答错后，当日出题形态为 relearn、次日为三档', () => {
    let state = card({ pool: 'P2' });
    const wrong = applyAnswer(state, answer({ correct: false, answeredOn: MON }));
    state = wrong.state;
    const latest = state.recentOutcomes[state.recentOutcomes.length - 1];
    expect(latest?.correct).toBe(false);
    expect(selectVariationForm(state.recentOutcomes, MON)).toBe('relearn');
    expect(selectVariationForm(state.recentOutcomes, '2026-10-27')).not.toBe('relearn');
  });

  it('集成：连错三次后状态变式档降为 easy', () => {
    let state = card({ pool: 'P2' });
    for (let i = 0; i < 3; i++) {
      state = applyAnswer(state, answer({ correct: false, answeredOn: MON, questionType: 'word_pick_meaning' })).state;
    }
    expect(state.variationTier).toBe('easy');
    expect(state.errorStreak).toBe(3);
  });

  it('集成：连快后状态变式档升为 hard', () => {
    let state = card({ pool: 'P0', recentOutcomes: [] });
    // P0 快对会升 P1，连答三次快对，近 3 次全快
    state = applyAnswer(state, answer({ answeredOn: MON, questionType: 'teach_audio_pick_picture', reactionTimeMs: 800 })).state;
    state = applyAnswer(state, answer({ answeredOn: '2026-10-27', questionType: 'audio_pick_picture', reactionTimeMs: 900 })).state;
    state = applyAnswer(state, answer({ answeredOn: '2026-10-30', questionType: 'word_pick_meaning', reactionTimeMs: 900 })).state;
    expect(state.variationTier).toBe('hard');
  });
});
