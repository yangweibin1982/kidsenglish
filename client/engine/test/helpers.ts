import type { AnswerEvent, CardPoolState, QuestionType } from '../src/types.js';

export const MON = '2026-10-26'; // 周一
export const TUE = '2026-10-27'; // 周二
export const SAT = '2026-10-24'; // 周六
export const SUN = '2026-10-25'; // 周日

export function card(overrides: Partial<CardPoolState> = {}): CardPoolState {
  return {
    childId: 'child-1',
    lexicalEntryId: 'w1',
    pool: 'P1',
    fastStreak: 0,
    errorStreak: 0,
    dueDate: MON,
    variationTier: 'standard',
    paused: false,
    graduatedSampledMonth: null,
    recentOutcomes: [],
    ...overrides,
  };
}

export function answer(overrides: Partial<AnswerEvent> = {}): AnswerEvent {
  return {
    lexicalEntryId: 'w1',
    questionType: 'audio_pick_picture',
    correct: true,
    reactionTimeMs: 1000,
    answeredOn: MON,
    ...overrides,
  };
}

/** mulberry32 种子伪随机（测试专用，确定性；引擎源码内无任何随机源）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const QUESTION_TYPES: QuestionType[] = [
  'teach_picture_audio',
  'teach_trace',
  'teach_audio_pick_picture',
  'audio_pick_picture',
  'word_pick_meaning',
  'near_sound_discrimination',
  'word_family_blend',
  'spelling_letter_bank',
  'spelling_full_keyboard',
  'sentence_fill',
  'boss_mix',
];
