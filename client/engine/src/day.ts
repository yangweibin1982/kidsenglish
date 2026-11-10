/**
 * day 层编排＋三信号自适应调节器（spec v1.1 S9，Ticket 09）。
 *
 * 日结构（取代 v1.0 单关结构，本文件为 plan.ts 之上的 day 层纯函数编排）：
 *   新词段 ≤10 分钟（音节块拼读支架；队列只给词 id，word/phonicsSplit
 *   等内容由视图层按词包取数——Ticket 10 的契约换装位）＋
 *   复习段 ≤5 分钟（答题驱动射击；P0-P2 生疏卡纯表单快过 plain、
 *   P3+ 熟练卡进射击演出 shooting，兼作 GPU 节流缓解）。
 *
 * 自适应新词量调节器（S9 定案，参数钉死为导出常量、禁运行时漂移）：
 *   信号＝消化指数：正确率（权重 0.5，严格最大）＋按时完成（0.3）＋
 *         用时在带内（0.2）；指数 ≥ 0.75 记达标（该阈值使「未完成日」
 *         即便全对也不达标：0.5+0.2=0.7 < 0.75）。
 *   规则＝连续 3 天达标 +1（授予后重新起算）；正确率 <70% 或超时 -1
 *         （惩罚优先于授予）；单日 ±1；带 [3,10]（末端 clampDailyNewWords 兜底）；
 *         家长档位（children.dailyNewWords）＝硬天花板：先夹上限，
 *         调节器只在其下浮动；家长锁定（parentLocked）后只降不升。
 *   偏移＝纯事件回放：全部由 history 信号序列逐日推导，无隐藏状态，
 *         同一 history 重放必得同一偏移（确定性）。
 *
 * 复习段池分摊（票面 §1）：总容量按时间盒估时（plain 10s、shooting 25s、
 *   盒 300s）对 E4 优先级序候选贪心得出；再按池权重分摊（对当日有到期卡的
 *   池归一化；逐轮「按归一化权重取整分配＋封顶回流」，余量不足一轮时按
 *   权重 desc→池序 asc 逐张补），总和守恒＝复习队列长度；池内按 E4 优先级
 *   （到期 asc、错误连击 desc、词 id asc）取满配额，队列为全局 E4 序。
 *
 * 铁律（spec S2）：零 I/O、零全局状态、零随机——一切随机性由调用方经
 * history 注入，同输入必同输出，事件历史重放确定。
 */

import { addDays, isWeekend, isValidIsoDate } from './date.js';
import { collectDueCards } from './due.js';
import { filterNewWordsByNearSoundSpacing } from './nearSound.js';
import { clampDailyNewWords } from './plan.js';
import type {
  CardPoolState,
  IsoDate,
  NearSoundContext,
  PlanProfile,
  PoolId,
} from './types.js';

/* ------------------------------------------------------------------ */
/* 契约类型（Ticket 11 直接 import，本票定死即契约）                     */
/* ------------------------------------------------------------------ */

/** 复习段演出形态（spec S9 池位分层）：P0-P2 表单快过、P3+ 射击演出。 */
export type ReviewCardForm = 'plain' | 'shooting';

/** 复习卡入队原因（可解释性，家长域/调试可读）。 */
export type ReviewDueReason = 'relearn' | 'overdue' | 'due_today' | 'graduated_maintenance';

/**
 * 复习段队列元素（Ticket 11/12 消费契约，本票定死）。
 * 至少含 entryId / pool / form / dueReason；dueDate 与 errorStreak
 * 供下游展示与 E4 排序依据复核。
 */
export interface DailyReviewCard {
  /** 稳定词 id（lexical_entries.id，R16 进度锚点）。 */
  entryId: string;
  /** 当前池位。 */
  pool: PoolId;
  /** 演出形态：P0-P2 plain、P3+（含毕业池）shooting。 */
  form: ReviewCardForm;
  /** 入队原因。 */
  dueReason: ReviewDueReason;
  /** 该卡当前到期时间。 */
  dueDate: IsoDate | null;
  /** 错误连击（E4 优先级第二键）。 */
  errorStreak: number;
}

/** 新词段队列元素（引擎只掌握词 id；内容取数归词包/视图层）。 */
export interface DailyNewWordCard {
  entryId: string;
}

/**
 * 单日消化信号（调用方从 daily_completions/learning_events 聚合后传入；
 * 引擎不做遥测推导、不读时钟）。history 须按日期升序、无重复；
 * 计划日当日及其后的条目被忽略。
 */
export interface DayDigest {
  /** 该日 ISO 日期（用于连续性判定：断档即达标连击清零）。 */
  date: IsoDate;
  /** 当日作答数（新词段＋复习段合计；0＝当日无作答，不参与评估）。 */
  answered: number;
  /** 当日答对数。 */
  correct: number;
  /** 当日双段是否按时完成（false＝中途退出/顺延未补）。 */
  completedOnTime: boolean;
  /** 各段用时秒数（S7 segment_seconds_used 快照）。 */
  segmentSeconds: { newWords: number; review: number };
}

/** 调整触发原因（S7 adaptation_log 触发原因的字面量集）。 */
export type DailyPlanAdjustReason = 'accuracy_below_70' | 'overtime' | 'three_day_streak';

/** 信号快照（S7 信号快照 JSON 的来源；全为可序列化原始值）。 */
export interface DailySignalSnapshot {
  /** 触发日（信号所属日，早于生效日一天）。 */
  date: IsoDate;
  answered: number;
  correct: number;
  /** 正确率（0-1，保留 3 位小数；无作答为 0）。 */
  accuracy: number;
  completedOnTime: boolean;
  overtime: boolean;
  timeInBand: boolean;
  /** 消化指数（0-1，三信号加权和）。 */
  digestIndex: number;
}

/** daily_plan_adjusted 事件对象（进既有学习事件流，只追加、可重放）。 */
export interface DailyPlanAdjustedEvent {
  type: 'daily_plan_adjusted';
  childId: string;
  /** 调整生效日（计划日）。 */
  date: IsoDate;
  /** 旧值（前一日的调节器计划值）。 */
  from: number;
  /** 新值（本日的调节器计划值）。 */
  to: number;
  /** 触发原因（可多因，固定顺序：正确率→超时→连击授予）。 */
  reasons: DailyPlanAdjustReason[];
  /** 触发日信号快照。 */
  signalSnapshot: DailySignalSnapshot;
}

/** day 层计划档案（在 PlanProfile 之上补 day 层字段）。 */
export interface DayPlanProfile extends PlanProfile {
  /** 孩子档案 id（事件流归属）。 */
  childId: string;
  /** 计划日（ISO 日期；引擎不读系统时钟）。 */
  date: IsoDate;
  /** 家长锁定（spec S9）：锁定后只降不升（达标升档抑制、惩罚降档保留）。 */
  parentLocked?: boolean;
  /** 音近引入约束（R6 接口，可选；只约束新词段引入，不挡重学）。 */
  nearSound?: NearSoundContext;
}

/** 各池分摊明细（可解释性：家长域/调试）。 */
export interface PoolAllocation {
  pool: PoolId;
  /** 该池当日到期数（复习段候选）。 */
  due: number;
  /** 分摊配额（实际入选张数）。 */
  quota: number;
  /** 归一化前的池权重（POOL_REVIEW_WEIGHTS 原值）。 */
  weight: number;
}

/** 调节器状态快照（可解释性）。 */
export interface AdjusterSnapshot {
  /** 本日调节器值（夹逼后的计划新词目标；周末不排新词但仍跟踪）。 */
  value: number;
  /** 家长硬天花板（clampDailyNewWords(profile.dailyNewWords)）。 */
  ceiling: number;
  /** 相对基线（＝天花板）的累计偏移，≤0 为缺口、>0 表示曾被压到天花板上限。 */
  offset: number;
  /** 家长锁定。 */
  locked: boolean;
}

/** 双段日计划（spec S9；day 层编排产出，取代 v1.0 单关结构）。 */
export interface DailyPlan {
  date: IsoDate;
  childId: string;
  isWeekend: boolean;
  /** 新词段队列（周末为空）。 */
  newWords: DailyNewWordCard[];
  /** 计划新词数＝新词段队列实际长度（周末为 0；fresh 不足时小于调节器值）。 */
  plannedNewWords: number;
  /** 复习段队列（E4 优先级序；时间盒到点即停由调用方主控，本队列即取用顺序）。 */
  reviewQueue: DailyReviewCard[];
  /** E4 未竟卡：到期但估时超盒未入队，顺延次日（调用方原样带回，无惩罚计数）。 */
  reviewDeferred: DailyReviewCard[];
  /** 各池分摊明细。 */
  poolAllocation: PoolAllocation[];
  /** 复习段卡片容量（按时间盒估时得出；truncation 依据）。 */
  reviewCapacity: number;
  /** 复习段估时（秒，按选中卡形态求和）。 */
  reviewEstimatedSeconds: number;
  /** 调节器快照。 */
  adjuster: AdjusterSnapshot;
  /** 本次调整事件（生效值无变化为 null；由调用方写入学习事件流）。 */
  adjustment: DailyPlanAdjustedEvent | null;
}

/* ------------------------------------------------------------------ */
/* 常量（S9 定案参数＋实现定值；单测钉死，禁运行时漂移）                 */
/* ------------------------------------------------------------------ */

/** 消化指数权重：正确率严格最大（S9 定案）；三项和为 1。 */
export const DIGEST_WEIGHTS = {
  accuracy: 0.5,
  completedOnTime: 0.3,
  timeInBand: 0.2,
} as const;

/** 达标阈值：指数 ≥ 0.75 记达标（未完成日全对也只有 0.7，不达标）。 */
export const DIGEST_PASS_THRESHOLD = 0.75;

/** 正确率惩罚线（S9 定案：<70% 次日 -1；恰好 70% 不罚）。 */
export const DIGEST_ACCURACY_FLOOR = 0.7;

/** 单日调整幅度（S9 定案：单日 ±1）。 */
export const ADJUSTER_STEP = 1;

/** 达标连击长度（S9 定案：连续 3 天达标 +1，授予后重新起算）。 */
export const ADJUSTER_STREAK_DAYS = 3;

/** 新词段时间盒（spec S9：≤10 分钟）。 */
export const NEW_SEGMENT_BUDGET_SECONDS = 600;

/** 复习段时间盒（spec S9：≤5 分钟）。 */
export const REVIEW_SEGMENT_BUDGET_SECONDS = 300;

/** 复习段单卡估时：P0-P2 表单快过（spec S9：约 10s/张）。 */
export const PLAIN_REVIEW_EST_SECONDS = 10;

/** 复习段单卡估时：P3+ 射击演出（spec S9：约 20-30s/张，取中值 25）。 */
export const SHOOTING_REVIEW_EST_SECONDS = 25;

/**
 * 复习段池权重表（票面 §1：实现时定、测试钉死）。
 * P0 为复习段中的留池重学卡（最生疏）、P1 间隔最短最易忘，权重最高；
 * 毕业池为月度抽样维护卡，权重最低。分摊前按当日有到期卡的池归一化。
 */
export const POOL_REVIEW_WEIGHTS: Record<PoolId, number> = {
  P0: 0.15,
  P1: 0.25,
  P2: 0.2,
  P3: 0.15,
  P4: 0.1,
  P5: 0.1,
  graduated: 0.05,
};

/** 池序（分摊决胜与明细输出的稳定池序）。 */
const POOL_ORDER: readonly PoolId[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated'];

/**
 * 分摊用整数化权重（×100；两位小数权重无损映射）。
 * 分摊算术全程走小整数（roundStart ≤ 数百、Σw ≤ 100），
 * floor((roundStart×w)/Σw) 的真值要么是精确整数、要么与最近整数至少差
 * 1/Σw ≥ 0.01，远大于双精度误差（~1e-13），取整对浮点噪声免疫。
 */
function weightX100(pool: PoolId): number {
  return Math.round(POOL_REVIEW_WEIGHTS[pool] * 100);
}

/* ------------------------------------------------------------------ */
/* 三信号消化指数                                                       */
/* ------------------------------------------------------------------ */

/** 单日消化评估结果。 */
export interface DigestEvaluation {
  /** 消化指数（0-1，三信号加权和，保留 3 位小数）。 */
  index: number;
  /** 正确率（0-1，保留 3 位小数；无作答为 0）。 */
  accuracy: number;
  completedOnTime: boolean;
  /** 任一段越过时间盒上沿即超时。 */
  overtime: boolean;
  /** 用时在带内（＝未超时；带＝S9 时间盒上沿）。 */
  timeInBand: boolean;
  /** 达标：无惩罚且指数 ≥ DIGEST_PASS_THRESHOLD。 */
  pass: boolean;
  /** 惩罚：有作答且正确率 <70%，或超时。无作答日不罚（无证据）。 */
  penalty: boolean;
  /** 惩罚原因（penalty 时非空）。 */
  reasons: DailyPlanAdjustReason[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 单日三信号合成与达标/惩罚判定（纯函数）。 */
export function evaluateDigest(digest: DayDigest): DigestEvaluation {
  const answered = Math.max(0, digest.answered);
  const accuracy = answered > 0 ? round3(clamp01(digest.correct / answered)) : 0;
  const overtime =
    digest.segmentSeconds.newWords > NEW_SEGMENT_BUDGET_SECONDS ||
    digest.segmentSeconds.review > REVIEW_SEGMENT_BUDGET_SECONDS;
  const index = round3(
    DIGEST_WEIGHTS.accuracy * accuracy +
      DIGEST_WEIGHTS.completedOnTime * (digest.completedOnTime ? 1 : 0) +
      DIGEST_WEIGHTS.timeInBand * (overtime ? 0 : 1),
  );
  const reasons: DailyPlanAdjustReason[] = [];
  if (answered > 0 && accuracy < DIGEST_ACCURACY_FLOOR) reasons.push('accuracy_below_70');
  if (overtime) reasons.push('overtime');
  const penalty = reasons.length > 0;
  return {
    index,
    accuracy,
    completedOnTime: digest.completedOnTime,
    overtime,
    timeInBand: !overtime,
    pass: !penalty && index >= DIGEST_PASS_THRESHOLD,
    penalty,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* 调节器：信号历史回放 → 偏移 → 夹逼                                    */
/* ------------------------------------------------------------------ */

interface AdjusterReplay {
  /** 本日调节器值（夹逼后）。 */
  value: number;
  /** 累计偏移。 */
  offset: number;
  /** 本日调整事件（生效值无变化为 null）。 */
  event: DailyPlanAdjustedEvent | null;
}

/**
 * 夹逼顺序（票面 §1）：家长天花板 → 档案基线＋调节器偏移 → clampDailyNewWords。
 * 档案基线锚定天花板值（spec S9：children.dailyNewWords 即硬天花板，单字段设计），
 * 调节器只在其下浮动：偏移 ≤0 时值＝天花板＋偏移，偏移 >0 时被天花板压回。
 */
function adjusterValueAt(offset: number, ceiling: number): number {
  return clampDailyNewWords(Math.min(ceiling, ceiling + offset));
}

/**
 * 回放消化信号历史，推导累计偏移与本日调整事件。
 * 规则：惩罚日 -1（优先，连击清零）；达标日连击 +1，满 3 天授予 +1 后重新起算；
 * 中性日（不达标不罚）连击清零；日期断档连击清零；锁定日授予抑制（只降不升）。
 * 事件仅在「昨日恰有信号日且生效值确实变化」时产出（值结转日不发事件）。
 */
function replayAdjuster(history: readonly DayDigest[], profile: DayPlanProfile, ceiling: number): AdjusterReplay {
  const planDate = profile.date;
  const locked = profile.parentLocked === true;
  const valid = history.filter((d) => d.date < planDate);

  let offset = 0;
  let streak = 0;
  let offsetBeforeLast = 0;
  let lastDelta = 0;
  let lastReasons: DailyPlanAdjustReason[] = [];
  let lastEval: DigestEvaluation | null = null;
  let lastDigest: DayDigest | null = null;
  let lastDate: IsoDate | null = null;

  for (const digest of valid) {
    const ev = evaluateDigest(digest);
    offsetBeforeLast = offset;
    let delta = 0;
    let reasons: DailyPlanAdjustReason[] = [];
    const consecutive = lastDate !== null && digest.date === addDays(lastDate, 1);
    if (!consecutive) streak = 0;
    if (ev.penalty) {
      // 惩罚优先：同日即便指数达标也只降不升（单日 ±1 的 -1 向）
      delta = -ADJUSTER_STEP;
      reasons = [...ev.reasons];
      streak = 0;
    } else if (ev.pass) {
      streak += 1;
      if (streak >= ADJUSTER_STREAK_DAYS) {
        if (!locked) {
          delta = ADJUSTER_STEP;
          reasons = ['three_day_streak'];
        }
        streak = 0; // 授予（或锁定抑制）后重新起算：每 3 天至多 +1
      }
    } else {
      streak = 0;
    }
    offset += delta;
    lastDelta = delta;
    lastReasons = reasons;
    lastEval = ev;
    lastDigest = digest;
    lastDate = digest.date;
  }

  const value = adjusterValueAt(offset, ceiling);

  let event: DailyPlanAdjustedEvent | null = null;
  if (lastEval && lastDigest && lastDelta !== 0 && lastDate === addDays(planDate, -1)) {
    const from = adjusterValueAt(offsetBeforeLast, ceiling);
    if (from !== value) {
      event = {
        type: 'daily_plan_adjusted',
        childId: profile.childId,
        date: planDate,
        from,
        to: value,
        reasons: lastReasons,
        signalSnapshot: {
          date: lastDigest.date,
          answered: lastDigest.answered,
          correct: lastDigest.correct,
          accuracy: lastEval.accuracy,
          completedOnTime: lastEval.completedOnTime,
          overtime: lastEval.overtime,
          timeInBand: lastEval.timeInBand,
          digestIndex: lastEval.index,
        },
      };
    }
  }

  return { value, offset, event };
}

/* ------------------------------------------------------------------ */
/* 复习段：池分摊与队列装配                                              */
/* ------------------------------------------------------------------ */

/** 演出形态映射（spec S9：P0-P2 plain、P3+ shooting；毕业池按熟练卡处理）。 */
export function reviewFormFor(pool: PoolId): ReviewCardForm {
  return pool === 'P0' || pool === 'P1' || pool === 'P2' ? 'plain' : 'shooting';
}

/** 入队原因映射（P0 进复习段必为留池重学卡：新鲜 P0 已进新词段）。 */
export function dueReasonFor(state: CardPoolState, planDate: IsoDate): ReviewDueReason {
  if (state.pool === 'graduated') return 'graduated_maintenance';
  if (state.pool === 'P0') return 'relearn';
  if (state.dueDate !== null && state.dueDate < planDate) return 'overdue';
  return 'due_today';
}

/** E4 优先级比较（与 plan.ts compareReviewPriority 同则：到期 asc、错误 desc、词 id asc）。 */
export function compareDailyReviewCards(a: DailyReviewCard, b: DailyReviewCard): number {
  const da = a.dueDate ?? '9999-12-31';
  const db = b.dueDate ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  if (a.errorStreak !== b.errorStreak) return b.errorStreak - a.errorStreak;
  if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
  return 0;
}

/**
 * 复习段卡片容量：对 E4 序候选按形态估时贪心累加，
 * 装不下即止（时间盒优先服务最高优先级卡，不为省时跳卡）。
 */
function estimateReviewCapacity(cards: readonly DailyReviewCard[]): number {
  let used = 0;
  let count = 0;
  for (const c of cards) {
    const cost = c.form === 'plain' ? PLAIN_REVIEW_EST_SECONDS : SHOOTING_REVIEW_EST_SECONDS;
    if (used + cost > REVIEW_SEGMENT_BUDGET_SECONDS) break;
    used += cost;
    count += 1;
  }
  return count;
}

/**
 * 池分摊（票面 §1：池内到期数按池权重分摊；总和守恒＝capacity）。
 *
 * 算法（确定性，无随机）：
 * 1. capacity ≥ 总到期数 → 全量入队（无稀缺，权重不裁量）。
 * 2. 否则逐轮水填：对仍有余量的池按「归一化权重 × 剩余容量」取整分配，
 *    封顶（不超过该池到期数）回流；某轮全为 0 取整（剩余量 < 活跃池数）时，
 *    按 权重 desc → 池序 asc 逐张补满。
 * 权重先按当日有到期卡的池归一化（缺席池的权重不闲置）；
 * 分摊全程用 ×100 整数化权重运算（小整数有理数在双精度下精确，
 * 规避 0.25+0.15≠0.4 类浮点噪声把 floor 推过边界）。
 */
export function allocateReviewQuota(
  dueByPool: ReadonlyArray<{ pool: PoolId; due: number }>,
  capacity: number,
): Array<{ pool: PoolId; quota: number }> {
  const entries = dueByPool
    .filter((e) => e.due > 0)
    .map((e) => ({ pool: e.pool, due: e.due, quota: 0 }));
  const totalDue = entries.reduce((sum, e) => sum + e.due, 0);
  if (capacity >= totalDue) {
    return entries.map((e) => ({ pool: e.pool, quota: e.due }));
  }

  let remaining = capacity;
  let active = entries;
  while (remaining > 0 && active.length > 0) {
    // 本轮 entitlement 一律按轮首剩余量计算（同轮内先到者不得挤占后来者份额）
    const roundStart = remaining;
    const totalWeight = active.reduce((sum, e) => sum + weightX100(e.pool), 0);
    const entitlements = new Map<PoolId, number>();
    for (const e of active) {
      entitlements.set(e.pool, totalWeight > 0 ? (roundStart * weightX100(e.pool)) / totalWeight : 0);
    }
    let progressed = false;
    for (const e of active) {
      if (remaining <= 0) break;
      const give = Math.min(e.due - e.quota, Math.floor(entitlements.get(e.pool) ?? 0));
      if (give > 0) {
        e.quota += give;
        remaining -= give;
        progressed = true;
      }
    }
    if (!progressed && remaining > 0) {
      // 剩余量小于活跃池数（本轮全部取整为 0）：按 权重 desc → 池序 asc 逐张补
      const fallback = [...active].sort((a, b) => {
        const wa = weightX100(a.pool);
        const wb = weightX100(b.pool);
        if (wa !== wb) return wb - wa;
        return POOL_ORDER.indexOf(a.pool) - POOL_ORDER.indexOf(b.pool);
      });
      for (const e of fallback) {
        if (remaining <= 0) break;
        if (e.quota < e.due) {
          e.quota += 1;
          remaining -= 1;
        }
      }
    }
    active = active.filter((e) => e.quota < e.due);
  }
  return entries.map((e) => ({ pool: e.pool, quota: e.quota }));
}

/* ------------------------------------------------------------------ */
/* day 层编排入口                                                       */
/* ------------------------------------------------------------------ */

/** 新鲜 P0（新词段候选）排序：到期早者优先，词 id 兜底（确定性）。 */
function compareFreshNew(a: CardPoolState, b: CardPoolState): number {
  const da = a.dueDate ?? '9999-12-31';
  const db = b.dueDate ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  if (a.lexicalEntryId !== b.lexicalEntryId) return a.lexicalEntryId < b.lexicalEntryId ? -1 : 1;
  return 0;
}

function toDailyReviewCard(state: CardPoolState, planDate: IsoDate): DailyReviewCard {
  return {
    entryId: state.lexicalEntryId,
    pool: state.pool,
    form: reviewFormFor(state.pool),
    dueReason: dueReasonFor(state, planDate),
    dueDate: state.dueDate,
    errorStreak: state.errorStreak,
  };
}

/**
 * 生成双段日计划（spec S9；纯函数，同输入必同输出）。
 *
 * @param profile day 层计划档案（含计划日/孩子 id/家长天花板/锁定/音近约束）
 * @param pools   该孩子全部卡池状态（引擎自行筛到期/新鲜 P0）
 * @param history 消化信号历史（升序；计划日当日及以后被忽略）
 */
export function buildDailyPlan(
  profile: DayPlanProfile,
  pools: readonly CardPoolState[],
  history: readonly DayDigest[],
): DailyPlan {
  if (!isValidIsoDate(profile.date)) {
    throw new Error(`buildDailyPlan: invalid date ${JSON.stringify(profile.date)}`);
  }
  const date = profile.date;
  const weekend = isWeekend(date);
  const ceiling = clampDailyNewWords(profile.dailyNewWords);

  // ---- 调节器：三信号回放 → 偏移 → 夹逼（天花板 → 基线+偏移 → clamp）----
  const adjuster = replayAdjuster(history, profile, ceiling);

  // ---- 新词段：新鲜 P0（无作答历史）按到期 asc＋词 id asc，音近约束后截取 ----
  const due = collectDueCards(pools, date);
  const freshP0 = due
    .filter((s) => s.pool === 'P0' && s.recentOutcomes.length === 0)
    .sort(compareFreshNew);
  const freshAllowed = profile.nearSound
    ? filterNewWordsByNearSoundSpacing(freshP0, profile.nearSound, date).allowed
    : freshP0;
  const newTarget = weekend ? 0 : adjuster.value;
  const newWords: DailyNewWordCard[] = freshAllowed
    .slice(0, newTarget)
    .map((s) => ({ entryId: s.lexicalEntryId }));

  // ---- 复习段候选：留池重学 P0 ＋ P1-P5 ＋毕业池抽样卡（新鲜 P0 不入复习）----
  const reviewStates = due.filter((s) => !(s.pool === 'P0' && s.recentOutcomes.length === 0));
  const candidates = reviewStates.map((s) => toDailyReviewCard(s, date)).sort(compareDailyReviewCards);

  const capacity = estimateReviewCapacity(candidates);
  const dueCount = new Map<PoolId, number>();
  for (const c of candidates) {
    dueCount.set(c.pool, (dueCount.get(c.pool) ?? 0) + 1);
  }
  const dueByPool = POOL_ORDER.filter((p) => (dueCount.get(p) ?? 0) > 0).map((p) => ({
    pool: p,
    due: dueCount.get(p) ?? 0,
  }));
  const quotas = allocateReviewQuota(dueByPool, capacity);
  const quotaLeft = new Map(quotas.map((q) => [q.pool, q.quota]));

  // 按全局 E4 序依次取用各池配额（池内天然取到该池最优先卡）
  const reviewQueue: DailyReviewCard[] = [];
  for (const c of candidates) {
    const left = quotaLeft.get(c.pool) ?? 0;
    if (left > 0) {
      reviewQueue.push(c);
      quotaLeft.set(c.pool, left - 1);
    }
  }
  const reviewEstimatedSeconds = reviewQueue.reduce(
    (sum, c) => sum + (c.form === 'plain' ? PLAIN_REVIEW_EST_SECONDS : SHOOTING_REVIEW_EST_SECONDS),
    0,
  );
  const scheduled = new Set(reviewQueue.map((c) => c.entryId));
  const reviewDeferred = candidates.filter((c) => !scheduled.has(c.entryId));
  const poolAllocation: PoolAllocation[] = dueByPool.map((e) => ({
    pool: e.pool,
    due: e.due,
    quota: quotas.find((q) => q.pool === e.pool)?.quota ?? 0,
    weight: POOL_REVIEW_WEIGHTS[e.pool],
  }));

  return {
    date,
    childId: profile.childId,
    isWeekend: weekend,
    newWords,
    plannedNewWords: newWords.length,
    reviewQueue,
    reviewDeferred,
    poolAllocation,
    reviewCapacity: capacity,
    reviewEstimatedSeconds,
    adjuster: {
      value: adjuster.value,
      ceiling,
      offset: adjuster.offset,
      locked: profile.parentLocked === true,
    },
    adjustment: adjuster.event,
  };
}
