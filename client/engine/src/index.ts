/**
 * @kidsenglish/engine 公共出口。
 * 零运行时依赖、零 I/O、不感知 Vue/PixiJS/浏览器 API（spec S2 铁律）。
 * 本包含调度器（状态→计划/抽卡/转移）与折叠器（事件→状态投影，fold.ts，Ticket 12）。
 */

export * from './types.js';
export * from './date.js';
export {
  REACTION_BASELINES_MS,
  DEFAULT_BASELINE_MS,
  getBaseline,
  isFastCorrect,
  resolveBaselines,
} from './baselines.js';
export { assessMastery } from './mastery.js';
export {
  POOL_INTERVALS_DAYS,
  GRADUATION_REQUIRED_FAST_ROUNDS,
  createNewCardState,
  applyAnswer,
} from './transition.js';
export { collectDueCards, toPlannedCard } from './due.js';
export {
  DAILY_NEW_WORDS_MIN,
  DAILY_NEW_WORDS_MAX,
  DAILY_NEW_WORDS_DEFAULT,
  REVIEW_PER_NEW_RATIO,
  REVIEW_CAPACITY_MAX,
  REVIEW_ONLY_CAPACITY,
  DEFERRED_REVIEW_CAP,
  compareReviewPriority,
  clampDailyNewWords,
  reviewCapacityFor,
  planDailyLevel,
} from './plan.js';
export {
  HARD_FAST_RATE,
  MIN_SAMPLES_FOR_HARD,
  EASY_FAST_RATE,
  recentFastRate,
  selectVariationTier,
  selectVariationForm,
} from './variation.js';
export { GRADUATED_SAMPLE_RATE, selectGraduatedSample } from './sampling.js';
export {
  NEAR_SOUND_MIN_GAP_DAYS,
  isNearSoundPair,
  findConflictingIntro,
  filterNewWordsByNearSoundSpacing,
} from './nearSound.js';
export * from './day.js';
export {
  KNOWN_EVENT_TYPES,
  compareHlc,
  compareEvents,
  sortEvents,
  applyPoolChange,
  fold,
} from './fold.js';
export type {
  Hlc,
  KnownEventType,
  LearningEventType,
  LearningEvent,
  AnswerPayload,
  PoolChangePayload,
  DailyPlanAdjustedPayload,
  DailyCompletedPayload,
  FoldCounters,
  DailySummary,
  FoldedState,
} from './fold.js';
