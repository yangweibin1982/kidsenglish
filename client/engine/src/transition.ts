/**
 * 七池升退档转移（R3/E1）＋毕业判定＋熟练度评估——引擎核心单步纯函数。
 *
 * 转移矩阵（requirement-brief 引擎池模型图逐格对应）：
 *
 *   快对（答对且 rt ≤ 题型基线）：
 *     P0→P1、P1→P2、P2→P3、P3→P4、P4→P5（升一档，到期 = D + 新池间隔）
 *     P5：快对轮数 +1，累计满 2 轮 → 毕业（P5 连续 2 轮快对）；
 *         未满 2 轮留在 P5，到期 = D+30
 *   答对但慢（rt > 基线）：
 *     P0：留池（教学循环当日再练，到期 = 当日）
 *     P1-P5：留池，到期 = D + 本池间隔
 *     毕业池：留在毕业池（维护走月度抽样接口）
 *   答错（E1：降一档＋当日追加 1 道变式题，变式回教学重学形态）：
 *     P0：留池重学（到期 = 当日）
 *     P1：留池（图中 P1 自环，降档地板是 P1）
 *     P2→P1、P3→P2、P4→P3、P5→P4（到期 = D + 新池间隔）
 *     毕业池：回 P5 重学（到期 = D+30）【解释性默认，见报告 Deviations】
 *
 * 快对连击语义：在当前池位连续快对的轮数——升档进新池清零
 * （毕业要求的是「P5 的两轮」，不是「一路上来的快对数」）；
 * 非快对作答清零；P5 内快对在原地累计。
 */

import { getBaseline, isFastCorrect } from './baselines.js';
import { addDays, isValidIsoDate } from './date.js';
import { assessMastery } from './mastery.js';
import { selectVariationTier } from './variation.js';
import type {
  AnswerEvent,
  BaselineTable,
  CardPoolState,
  IsoDate,
  PoolId,
  ProficiencyPool,
  TransitionResult,
} from './types.js';

/** 熟练池复习间隔（天）：P1=D+1、P2=D+3、P3=D+7、P4=D+14、P5=D+30（R3）。 */
export const POOL_INTERVALS_DAYS: Record<ProficiencyPool, number> = {
  P1: 1,
  P2: 3,
  P3: 7,
  P4: 14,
  P5: 30,
};

/** 毕业条件：P5 连续 2 轮快对（R3）。 */
export const GRADUATION_REQUIRED_FAST_ROUNDS = 2;

/** 答错降档目标（R3 图：P1 自环地板、P0 留池）。 */
const DEMOTE_TARGET: Partial<Record<PoolId, PoolId>> = {
  P2: 'P1',
  P3: 'P2',
  P4: 'P3',
  P5: 'P4',
};

function requireProficiency(pool: PoolId, where: string): ProficiencyPool {
  if (pool === 'P1' || pool === 'P2' || pool === 'P3' || pool === 'P4' || pool === 'P5') {
    return pool;
  }
  throw new Error(`${where}: pool ${pool} is not a proficiency pool`);
}

function validateEvent(event: AnswerEvent): void {
  if (!event.lexicalEntryId) throw new Error('answer event: lexicalEntryId is required');
  if (!Number.isFinite(event.reactionTimeMs) || event.reactionTimeMs < 0) {
    throw new Error(`answer event: invalid reactionTimeMs ${event.reactionTimeMs}`);
  }
  if (!isValidIsoDate(event.answeredOn)) {
    throw new Error(`answer event: invalid answeredOn ${JSON.stringify(event.answeredOn)}`);
  }
}

/** 新词建卡：进 P0，到期 = 建卡当日（R3 图「当日末小复习」进 P1 的前置）。 */
export function createNewCardState(childId: string, lexicalEntryId: string, on: IsoDate): CardPoolState {
  if (!isValidIsoDate(on)) throw new Error(`createNewCardState: invalid date ${JSON.stringify(on)}`);
  return {
    childId,
    lexicalEntryId,
    pool: 'P0',
    fastStreak: 0,
    errorStreak: 0,
    dueDate: on,
    variationTier: 'standard',
    paused: false,
    graduatedSampledMonth: null,
    recentOutcomes: [],
  };
}

/**
 * 单步转移：给定当前卡池状态与一次答题事件，返回新状态与转移明细。
 * 纯函数：不修改入参状态；同输入必同输出。
 *
 * @param baselines 题型基线覆盖（可调，缺省用内置初值表）
 */
export function applyAnswer(
  state: CardPoolState,
  event: AnswerEvent,
  baselines?: Partial<BaselineTable>,
): TransitionResult {
  validateEvent(event);
  if (state.lexicalEntryId !== event.lexicalEntryId) {
    throw new Error(
      `applyAnswer: state is for ${state.lexicalEntryId}, event for ${event.lexicalEntryId}`,
    );
  }
  if (!isValidIsoDate(event.answeredOn)) {
    throw new Error(`applyAnswer: invalid answeredOn`);
  }

  const baseline = getBaseline(event.questionType, baselines);
  const fast = isFastCorrect(event.correct, event.reactionTimeMs, baseline);
  const masteryScore = assessMastery(event, baselines);
  const fromPool = state.pool;
  const d = event.answeredOn;

  let toPool: PoolId;
  let kind: TransitionResult['transition']['kind'];
  let nextDueDate: IsoDate | null;
  let graduated = false;
  let fastStreak: number;

  if (event.correct) {
    // 快对连击：留在原池的快对累计；升档进新池清零；慢对清零。
    fastStreak = fast ? state.fastStreak + 1 : 0;
    if (fromPool === 'graduated') {
      toPool = 'graduated';
      kind = 'stay';
      nextDueDate = null; // 毕业池维护走月度抽样，到期由抽样接口的调用方设置
    } else if (fromPool === 'P5') {
      if (fast && fastStreak >= GRADUATION_REQUIRED_FAST_ROUNDS) {
        toPool = 'graduated';
        kind = 'graduate';
        nextDueDate = null;
        graduated = true;
      } else {
        toPool = 'P5';
        kind = 'stay';
        nextDueDate = addDays(d, POOL_INTERVALS_DAYS.P5);
      }
    } else if (fast) {
      // P0-P4 快对：升一档（R3「答对快升档」）。此处 fromPool 必属 P0-P4。
      const nextPool: ProficiencyPool =
        fromPool === 'P0' ? 'P1' : (`P${Number(fromPool.slice(1)) + 1}` as ProficiencyPool);
      toPool = nextPool;
      kind = 'promote';
      nextDueDate = addDays(d, POOL_INTERVALS_DAYS[nextPool]);
      fastStreak = 0; // 进入新池，从 0 轮起算
    } else {
      // P0-P4 答对但慢：留池
      toPool = fromPool;
      kind = 'stay';
      nextDueDate =
        fromPool === 'P0' ? d : addDays(d, POOL_INTERVALS_DAYS[requireProficiency(fromPool, 'stay')]);
    }
  } else {
    // 答错：降一档（E1），快对连击清零
    fastStreak = 0;
    if (fromPool === 'P0') {
      toPool = 'P0';
      kind = 'stay';
      nextDueDate = d; // 留池重学：当日回教学形态再练
    } else if (fromPool === 'graduated') {
      toPool = 'P5';
      kind = 'demote';
      nextDueDate = addDays(d, POOL_INTERVALS_DAYS.P5);
    } else {
      toPool = DEMOTE_TARGET[fromPool] ?? 'P1'; // P1 自环地板
      kind = toPool === fromPool ? 'stay' : 'demote';
      nextDueDate = addDays(d, POOL_INTERVALS_DAYS[requireProficiency(toPool, 'demote')]);
    }
  }

  // 近 3 次作答缓存（可由事件重建）＋变式档刷新（R5）
  const recentOutcomes = [
    ...state.recentOutcomes,
    { correct: event.correct, fast, answeredOn: d },
  ].slice(-3);

  const nextState: CardPoolState = {
    ...state,
    pool: toPool,
    fastStreak,
    errorStreak: event.correct ? 0 : state.errorStreak + 1,
    dueDate: nextDueDate,
    variationTier: selectVariationTier(recentOutcomes),
    graduatedSampledMonth: toPool === 'graduated' ? state.graduatedSampledMonth : null,
    recentOutcomes,
  };

  return {
    state: nextState,
    transition: {
      fromPool,
      toPool,
      kind,
      fast,
      masteryScore,
      nextDueDate,
      graduated,
      followUps: event.correct
        ? { appendVariationToday: false, form: nextState.variationTier }
        : { appendVariationToday: true, form: 'relearn' },
    },
  };
}
