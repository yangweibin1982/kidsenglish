/**
 * 当日关卡配比计划（R4/E4）。
 *
 * 规则（全部对应 requirement-brief 原文）：
 * 1. 新词：按档案配置（家长可调 3-10，越界收敛；默认档 5-8）；
 *    周末不加新只复习（R4「周末不加新」）。
 * 2. 复习配额：新:旧≈1:3 → 配额 = min(新词数×3, 18)。默认档（新词 5-8）
 *    落在 R4 的「复习 15-18 张」带内；纯复习日（周末/无新词可教）取 18。
 * 3. 跳过顺延不惩罚：前一日整关被跳过（previousDaySkipped）时，
 *    次日复习上限放宽到 20 张（R4 括注），按优先级截断。
 * 4. E4 截断优先级：到期时间（最早到期＝最久未复习优先）
 *    ＋错误次数（错误连击高者优先），词 id 兜底保证确定性；
 *    未竟卡进 deferred 顺延次日（调用方原样带回，无惩罚计数）。
 * 5. 关内顺序固定：复习段→教学段→boss 段；boss 段＝本关新词综合题（R8）。
 *
 * 容量常量全部导出可调。本函数不产生随机性、不读时钟。
 */

import { collectDueCards, toPlannedCard } from './due.js';
import { isWeekend as computeWeekend, isValidIsoDate } from './date.js';
import { filterNewWordsByNearSoundSpacing } from './nearSound.js';
import type {
  CardPoolState,
  IsoDate,
  LevelPlan,
  PlanLevelInput,
  PlannedCard,
  PlanSegment,
} from './types.js';

/** 每日新词下限（R4：家长可调 3-10）。 */
export const DAILY_NEW_WORDS_MIN = 3;
/** 每日新词上限（R4）。 */
export const DAILY_NEW_WORDS_MAX = 10;
/** 默认每日新词（R4：低年级 5、高年级 8；无档位信息时取保守值 5）。 */
export const DAILY_NEW_WORDS_DEFAULT = 5;
/** 新:旧配比（R4：≈1:3）。 */
export const REVIEW_PER_NEW_RATIO = 3;
/** 复习段容量上限（R4「复习 15-18 张」带的上沿；防止新词配大后复习无限膨胀）。 */
export const REVIEW_CAPACITY_MAX = 18;
/** 纯复习日（周末/无新词）的复习配额：取带的上沿。 */
export const REVIEW_ONLY_CAPACITY = REVIEW_CAPACITY_MAX;
/** 顺延次日复习上限（R4 括注「次日复习上限 20 张」；E4 截断）。 */
export const DEFERRED_REVIEW_CAP = 20;

/** E4 截断优先级比较：到期早者优先；错误连击高者优先；词 id 字典序兜底。 */
export function compareReviewPriority(a: PlannedCard, b: PlannedCard): number {
  const da = a.dueDate ?? '9999-12-31';
  const db = b.dueDate ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  if (a.errorStreak !== b.errorStreak) return b.errorStreak - a.errorStreak;
  if (a.lexicalEntryId !== b.lexicalEntryId) return a.lexicalEntryId < b.lexicalEntryId ? -1 : 1;
  return 0;
}

/** 把档案新词配置收敛进 3-10（R4 家长可调区间）。 */
export function clampDailyNewWords(n: number): number {
  if (!Number.isFinite(n)) return DAILY_NEW_WORDS_DEFAULT;
  return Math.min(DAILY_NEW_WORDS_MAX, Math.max(DAILY_NEW_WORDS_MIN, Math.round(n)));
}

/** 复习容量：顺延 catch-up 日 20；纯复习日 18；常规日 min(新词×3, 18)。 */
export function reviewCapacityFor(newCount: number, catchUpDay: boolean): number {
  if (catchUpDay) return DEFERRED_REVIEW_CAP;
  if (newCount === 0) return REVIEW_ONLY_CAPACITY;
  return Math.min(newCount * REVIEW_PER_NEW_RATIO, REVIEW_CAPACITY_MAX);
}

/**
 * 生成当日单关计划（1 关约 15 分钟）。
 * 多关/加练（R4 加练硬顶）不在本票交付面，调用方自行按需重复调用并控量。
 */
export function planDailyLevel(input: PlanLevelInput): LevelPlan {
  const { date, profile, poolStates } = input;
  if (!isValidIsoDate(date)) throw new Error(`planDailyLevel: invalid date ${JSON.stringify(date)}`);
  const weekend = computeWeekend(date);
  const catchUpDay = input.previousDaySkipped === true;

  // ---- 教学段候选：P0 到期卡（新鲜建卡 ＋ 留池重学卡） ----------------
  const due = collectDueCards(poolStates, date);
  const p0Due = due.filter((s) => s.pool === 'P0');
  // 重学卡：已有作答历史的 P0 卡（答错当日回教学重学形态，R5/E1）
  const relearnCards = p0Due.filter((s) => s.recentOutcomes.length > 0);
  // 新鲜建卡：尚无作答历史的 P0 卡
  const freshCards = p0Due.filter((s) => s.recentOutcomes.length === 0);

  // ---- 新词数：周末 0；否则档案配置收敛后受可用量限制 -----------------
  const newTarget = weekend ? 0 : clampDailyNewWords(profile.dailyNewWords);

  // ---- 音近引入间隔约束（R6 接口）：只约束「引入」，不挡重学 ----------
  let freshAllowed = freshCards;
  if (input.nearSound) {
    freshAllowed = filterNewWordsByNearSoundSpacing(freshCards, input.nearSound, date).allowed;
  }
  const freshScheduled = freshAllowed.slice(0, newTarget);
  const newCount = freshScheduled.length;

  // ---- 复习段候选：P1-P5 到期 ＋ 毕业池抽样维护卡（已设到期日） --------
  const reviewCandidates = due
    .filter((s) => s.pool !== 'P0')
    .map(toPlannedCard)
    .sort(compareReviewPriority);

  const reviewCapacity = reviewCapacityFor(newCount, catchUpDay);
  const reviewCards = reviewCandidates.slice(0, reviewCapacity);
  const deferred = reviewCandidates.slice(reviewCapacity);
  const truncationApplied = deferred.length > 0;

  // ---- 教学段：重学卡在前（先补救后新授），新词在后 -------------------
  const teachCards: PlannedCard[] = [
    ...relearnCards.map(toPlannedCard),
    ...freshScheduled.map(toPlannedCard),
  ];

  // ---- boss 段：本关新词综合题（R8）＝教学段全部词 ---------------------
  const bossCards: PlannedCard[] = teachCards.map((c) => ({ ...c }));

  const segments: [PlanSegment, PlanSegment, PlanSegment] = [
    { kind: 'review', cards: reviewCards },
    { kind: 'teach', cards: teachCards },
    { kind: 'boss', cards: bossCards },
  ];

  return {
    date,
    isWeekend: weekend,
    segments,
    newCount,
    reviewCount: reviewCards.length,
    reviewCapacity,
    truncationApplied,
    deferred,
  };
}
