/**
 * 复习段状态机 v3（spec v1.4 S9「雷霆战机」仿真度重制，Ticket 30；
 * v2 基础上增 combo/score 纯游戏内状态，拼写/重排/时间盒语义零变化）。
 *
 * 纯函数、零 IO、零框架依赖——时间用动作参数注入（可 mock 时钟测试，
 * 与新词段状态机同款式）。考核在 DOM 层（字母填空，词只听不显——听写式
 * 检索；判定语义与新词段 pickLetter 同款），演出在 PixiJS 层（经
 * stageContract 三向总线），本状态机只持语义步骤，不碰 DOM/Pixi/题库内容。
 *
 * 步骤语义（spec v1.4 S9＋票 30）：
 *   question（字母填空拼当前词，怪兽头顶只示中文义气泡；视图对每个拼对
 *     字母另发 letter-fire 字幕级弹幕——纯演出，不进本状态机）
 *     ├─ 拼完（含重试）→ performance：视图经契约下发 fire（一串子弹），
 *     │    等 performance-complete 回报 → 弹出本卡 → 下一张/done
 *     └─ 时间盒到点 → timeup（到点即停，未完成顺延 E4）
 *   全部完成 → done。
 *
 * 正确性口径：correct＝首试全对严格口径（任何重试＝false → 引擎裁决进重学）；
 * 非首试全对的卡重排队尾一次（重学语义，防死循环上限同 v1）。
 * 游戏内状态（P-11 决策 3，不进事件流）：combo＝连续首试全对词数（错误归零）；
 * score＝Σ 词长×10×combo（本词 combo）；武器等级＝视图由 combo 派生
 * （min(3, 1+floor(combo/3))），本状态机不另存。
 */

import {
  DAILY_NEW_WORDS_MAX,
  REVIEW_SEGMENT_BUDGET_SECONDS,
  type DailyReviewCard,
} from '@kidsenglish/engine';

/** 复习段时间盒（spec S9 ≤5 分钟；消费引擎 day 层常量语义，禁 UI 侧另写数值）。 */
export const REVIEW_TIMEBOX_MS = REVIEW_SEGMENT_BUDGET_SECONDS * 1000;

/**
 * 一年级复习段硬上限 10 张（spec S9 防呆，参数可调）：
 * 消费引擎 DAILY_NEW_WORDS_MAX 常量语义（一年级 10 张/日的既有防呆定值）；
 * 引擎日后续出复习段专用常量时在此换装，UI 侧不出现裸 10。
 */
export const REVIEW_SESSION_HARD_CAP = DAILY_NEW_WORDS_MAX;

/** 复习段步骤。 */
export type RvStep = 'question' | 'performance' | 'done' | 'timeup';

/**
 * 复习卡＝引擎计划卡＋词包内容 enrich（视图注入，状态机持词判字母）。
 * 词形只在考核层用；演出层只收 meaning（stageContract v2）。
 */
export type RvCard = DailyReviewCard & {
  readonly word: string;
  readonly meaning: string;
  /** 拼读拆分块（null＝无拆分；朗读链展示用，非考核面）。 */
  readonly blocks: readonly string[] | null;
};

/** 拼写会话内一格进度（形状镜像新词段 NwFillState，票 29 同语义复用）。 */
export interface RvFillState {
  readonly slotIndex: number;
  readonly firstTryCorrect: readonly boolean[];
  readonly slotMistakes: number;
  readonly totalMistakes: number;
  /** 本词错选对 [期望, 实选]（小写归一；混淆图谱记录面，票 49）。 */
  readonly wrongPicks: readonly (readonly [string, string])[];
}

/** 会话内拼写结果（append-only；每张卡每次拼完记一条；combo/score 为记账时点快照）。 */
export interface RvResult {
  entryId: string;
  correct: boolean;
  /** 本词后的连击数（首试全对才累计；快照供战报/演出对账）。 */
  combo: number;
  /** 本词得分（correct 时=词长×10×本词 combo，否则 0）。 */
  score: number;
}

/** 复习段会话状态（当前卡恒为 queue[0]，弹出即完成/重排）。 */
export interface RvState {
  readonly step: RvStep;
  /** 待作答队列（引擎 reviewQueue enrich 后入参，E4 序；重排卡追加队尾）。 */
  readonly queue: readonly RvCard[];
  /** 已完成的拼写结果（含当前卡，performance 期间已记账）。 */
  readonly results: readonly RvResult[];
  /** 当前卡拼写进度（performance 保持填完态展示；done/timeup 保持原值不消费）。 */
  readonly fill: RvFillState | null;
  /** 已因非首试全对重排过队尾一次的词（第二次不再重排，防死循环）。 */
  readonly requeuedOnce: readonly string[];
  /** 非首试全对后待重排标记（拼完时判定，弹出时落地队尾）。 */
  readonly pendingRequeue: boolean;
  /** 连续首试全对词数（错误归零；纯游戏内，驱动武器等级/演出浮字）。 */
  readonly combo: number;
  /** 会话累计得分（Σ 词长×10×本词 combo；纯游戏内，不进事件流）。 */
  readonly score: number;
  /** 演出层错误上报次数（stage-error 兜底推进次数，调试证据）。 */
  readonly stageErrors: number;
  /** 时间盒起止（绝对毫秒，支持注入 mock 时钟）。 */
  readonly startedAtMs: number;
  readonly deadlineMs: number;
}

export type RvAction =
  | { type: 'tick'; nowMs: number }
  | { type: 'pickLetter'; letter: string }
  | { type: 'stageComplete'; outcome: 'hit' | 'defeat'; targetId: string }
  | { type: 'stageError'; message: string };

export type CreateRvSessionOpts = {
  /** 会话起始时刻（注入，可 mock）。 */
  startMs: number;
  /** 时间盒时长，默认 REVIEW_TIMEBOX_MS（引擎 300s 常量语义）。 */
  durationMs?: number;
};

function freshFill(word: string): RvFillState {
  return {
    slotIndex: 0,
    firstTryCorrect: Array.from({ length: word.length }, () => false),
    slotMistakes: 0,
    totalMistakes: 0,
    wrongPicks: [],
  };
}

/**
 * 创建复习段会话。队列来自引擎 buildDailyPlan().reviewQueue 经词包 enrich
 * （单事实源，本函数只做一年级 10 张防呆再切，不做任何抽词/排序）；
 * 空队列直接 done。
 */
export function createRvSession(
  cards: readonly RvCard[],
  opts: CreateRvSessionOpts,
): RvState {
  const queue = cards.slice(0, REVIEW_SESSION_HARD_CAP);
  const durationMs = opts.durationMs ?? REVIEW_TIMEBOX_MS;
  const head = queue[0];
  return {
    step: queue.length === 0 ? 'done' : 'question',
    queue,
    results: [],
    fill: head ? freshFill(head.word) : null,
    requeuedOnce: [],
    pendingRequeue: false,
    combo: 0,
    score: 0,
    stageErrors: 0,
    startedAtMs: opts.startMs,
    deadlineMs: opts.startMs + durationMs,
  };
}

/** 弹出队首卡；pendingRequeue 时把该卡追加队尾（每卡至多一次）。 */
function popCurrent(state: RvState): RvState {
  const [current, ...rest] = state.queue;
  if (!current) return state;
  const willRequeue = state.pendingRequeue && !state.requeuedOnce.includes(current.entryId);
  return {
    ...state,
    queue: willRequeue ? [...rest, current] : rest,
    requeuedOnce: willRequeue ? [...state.requeuedOnce, current.entryId] : state.requeuedOnce,
    pendingRequeue: false,
  };
}

/** 队首弹出后的去向：空 → done，否则回 question（新卡新 fill）。 */
function afterPop(state: RvState): RvState {
  const popped = popCurrent(state);
  const head = popped.queue[0];
  return {
    ...popped,
    step: popped.queue.length === 0 ? 'done' : 'question',
    fill: head ? freshFill(head.word) : null,
  };
}

/**
 * 到点即停后未完成的卡数（E4 顺延张数；当前卡在 question/performance
 * 任一步都算未完成）。done＝0。
 */
export function remainingDeferred(state: RvState): number {
  if (state.step === 'done') return 0;
  return state.queue.length;
}

export function reduceRv(state: RvState, action: RvAction): RvState {
  switch (action.type) {
    case 'tick': {
      // 终态不再被时间打断
      if (state.step === 'done' || state.step === 'timeup') return state;
      if (action.nowMs >= state.deadlineMs) {
        return { ...state, step: 'timeup' };
      }
      return state;
    }
    case 'pickLetter': {
      // 仅 question 步受输入（performance/done/timeup 输入锁定）
      if (state.step !== 'question' || !state.fill) return state;
      const current = state.queue[0];
      if (!current) return state;
      const fill = state.fill;
      if (fill.slotIndex >= current.word.length) return state;
      const target = current.word[fill.slotIndex] ?? '';
      // 大小写不敏感判定（与新词段 pickLetter 同语义）；错选记对（票 49 混淆图谱）
      if (action.letter.toLowerCase() !== target.toLowerCase()) {
        return {
          ...state,
          fill: {
            ...fill,
            slotMistakes: fill.slotMistakes + 1,
            totalMistakes: fill.totalMistakes + 1,
            wrongPicks: [...fill.wrongPicks, [target.toLowerCase(), action.letter.toLowerCase()]],
          },
        };
      }
      const firstTryCorrect = fill.firstTryCorrect.map(
        (v, i) => (i === fill.slotIndex ? fill.slotMistakes === 0 : v),
      );
      const nextFill: RvFillState = { ...fill, slotIndex: fill.slotIndex + 1, firstTryCorrect };
      if (nextFill.slotIndex < current.word.length) {
        return { ...state, fill: nextFill };
      }
      // 拼完：正确性＝首试全对严格口径；非首试全对 → 重排队尾一次。
      // 演出照发（奖励不打折）：无论口径，performance 一串子弹都算本词伤害。
      // 游戏内记账（P-11 决策 3）：combo 连续首试全对累计、得分只记 correct 词。
      const correct = firstTryCorrect.every(Boolean);
      const combo = correct ? state.combo + 1 : 0;
      const gained = correct ? current.word.length * 10 * combo : 0;
      const willRequeue = !correct && !state.requeuedOnce.includes(current.entryId);
      return {
        ...state,
        fill: nextFill,
        results: [...state.results, { entryId: current.entryId, correct, combo, score: gained }],
        combo,
        score: state.score + gained,
        pendingRequeue: willRequeue,
        step: 'performance',
      };
    }
    case 'stageComplete': {
      // 完成回报只在 performance 步有效；结局不匹配也放行（fail-open，孩子不卡死）
      if (state.step !== 'performance') return state;
      return afterPop(state);
    }
    case 'stageError': {
      // 演出层错误：performance 步兜底推进（不让孩子卡在等待），计数留证
      if (state.step !== 'performance') return state;
      const advanced = afterPop(state);
      return { ...advanced, stageErrors: advanced.stageErrors + 1 };
    }
    default: {
      return state;
    }
  }
}

/** 编译期穷尽断言（导出以通过 noUnusedLocals）：RvAction 新增成员而未在 reduceRv 处理时此处类型报错 */
export type AssertRvActionsExhaustive = Exclude<
  RvAction,
  { type: 'tick' | 'pickLetter' | 'stageComplete' | 'stageError' }
> extends never
  ? true
  : never;
