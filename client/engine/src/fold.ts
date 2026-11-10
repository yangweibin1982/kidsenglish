/**
 * 折叠器：事件集 → 物化状态投影（spec S1「事件流联合＋确定性重放」，Ticket 12）。
 *
 * 职责边界（S1/S2 铁律）：
 * - **折叠 ≠ 调度**：本文件只做「事件 → 状态」投影，不做计划/抽卡/变式选档；
 *   单词级状态转移全部复用 transition.applyAnswer——折叠器与调度器共享同一
 *   转移实现，TS/Py 同构投影的语义地基。
 * - **排序键全序化**（确定性重放前提）：事件按
 *   `(hlc 物理, hlc 逻辑, device_id, event_id)` 字典序定全序——HLC 保证互见事件
 *   必有序，并列时 device_id/event_id 决胜；墙钟 occurred_at 降级为遥测字段
 *   **不参与排序**（设备时钟偏移不能打乱合并序，R16 不被打穿）。
 * - **幂等**：event_id 全局唯一（S1），重复投递折叠一次（全序首见者胜）。
 * - **「只增不减」**：计数类（答题数/正确数/星星/碎片）单调累加，无任何可减路径。
 * - **前向兼容**：未知事件类型跳过＋计数（unknownEventTypes），不编造语义；
 *   未登记题型（question_type）落兜底基线（baselines.DEFAULT_BASELINE_MS）。
 * - **并发升降**：默认自然合并——全序后到者生效；「并发段取高池位决胜」
 *   （向量时钟）仅为规格显式决策点候选，不在本实现（家庭规模收益低，spec S1）。
 *
 * 事件信封（spec S1）：`{event_id, child_id, device_id, device_seq, hlc,
 * occurred_at, type, payload}`；fold 为单孩子作用域（输入混入多个 child_id 即抛错，
 * 多孩折叠由调用方按 child_id 分流后各调一次）。
 *
 * purity（spec S2）：零 I/O、零时钟、零随机、零运行时依赖——同一事件集
 * 无论到达顺序、重复投递多少次，折叠结果恒同（收敛性，golden 向量钉死）。
 */

import { addDays, isValidIsoDate } from './date.js';
import type {
  DailyPlanAdjustedEvent,
  DailyPlanAdjustReason,
  DailySignalSnapshot,
  DayDigest,
} from './day.js';
import { applyAnswer, createNewCardState, POOL_INTERVALS_DAYS } from './transition.js';
import type { CardPoolState, IsoDate, PoolId, QuestionType } from './types.js';

/* ------------------------------------------------------------------ */
/* 事件信封与载荷类型（snake_case 与 spec S7 learning_events 列名对齐；  */
/* FoldedState 输出面用 camelCase 与引擎 TS 类型对齐——两层命名都是契约， */
/* Py 侧（Ticket 13）读事件 snake、比对终态 camel。）                   */
/* ------------------------------------------------------------------ */

/** 混合逻辑时钟（物理毫秒＋计数器；设备本地生成，sync 下行携带上界供偏移校正）。 */
export interface Hlc {
  physicalMs: number;
  counter: number;
}

/** 本实现认识的载荷事件类型（其余类型一律跳过＋计数）。 */
export const KNOWN_EVENT_TYPES = [
  'answer',
  'pool_promoted',
  'pool_demoted',
  'daily_plan_adjusted',
  'daily_completed',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

/** 事件类型：已知五类＋任意未来扩展字符串（前向兼容通道）。 */
export type LearningEventType = KnownEventType | (string & {});

/** 学习事件信封（spec S1；learning_events 的同步切片）。 */
export interface LearningEvent {
  /** 全局唯一（UUID 或同强唯一 id）；幂等键。 */
  event_id: string;
  child_id: string;
  device_id: string;
  /** 设备内单调序号（遥测；不参与排序——决胜已由 event_id 保证完备）。 */
  device_seq: number;
  hlc: Hlc;
  /** 墙钟遥测字段（不参与排序）。 */
  occurred_at: string;
  type: LearningEventType;
  payload: unknown;
}

/** 作答事件载荷（正误/反应时/题型；可选携带本事件发出的星星/碎片奖励）。 */
export interface AnswerPayload {
  lexical_entry_id: string;
  question_type: QuestionType;
  correct: boolean;
  reaction_ms: number;
  answered_on: IsoDate;
  stars_earned?: number;
  shards_earned?: number;
}

/**
 * 池位变更事件载荷（pool_promoted / pool_demoted；R17 家长手动调级等
 * 引擎外池位事实）。to_pool 为显式目标池——折叠器不复算升降，只按全序后到者生效。
 */
export interface PoolChangePayload {
  lexical_entry_id: string;
  to_pool: PoolId;
  on: IsoDate;
  reason?: string;
}

/** daily_plan_adjusted 事件载荷（S9；server 折叠为 adaptation_log 投影）。 */
export interface DailyPlanAdjustedPayload {
  date: IsoDate;
  from: number;
  to: number;
  reasons: DailyPlanAdjustReason[];
  signal_snapshot: DailySignalSnapshot;
}

/** 每日完成事件载荷（S7 daily_completions 概念字段；喂 day 层消化信号）。 */
export interface DailyCompletedPayload {
  date: IsoDate;
  completed_on_time: boolean;
  segment_seconds: { new_words: number; review: number };
  stars_earned?: number;
  shards_earned?: number;
}

/* ------------------------------------------------------------------ */
/* FoldedState（票 09 契约：poolStates/dailySummaries 可直接喂          */
/* buildDailyPlan(profile, pools, history)，零形状转换）                 */
/* ------------------------------------------------------------------ */

/** 计数类单调累加面（只增不减，禁可减路径）。 */
export interface FoldCounters {
  answered: number;
  correct: number;
  stars: number;
  shards: number;
}

/**
 * 每日完成摘要：DayDigest（Ticket 09 契约形状）＋当日奖励计数。
 * 结构上可赋值给 DayDigest，直接作 buildDailyPlan 的 history 入参。
 */
export interface DailySummary extends DayDigest {
  starsEarned: number;
  shardsEarned: number;
}

/**
 * 折叠产物：可全量重建的物化状态。
 * - poolStates 按词 id 字典序稳定输出（确定性）；
 * - dailySummaries 按日期升序；completedOnTime/segmentSeconds 按
 *   全序后到者生效（同日多份 daily_completed，HLC 后者覆盖）；
 * - planAdjustments 按日期升序、同日 last-wins（S9 adaptation_log 投影）；
 * - unknownEventTypes：前向兼容跳过计数（类型 → 次数）。
 */
export interface FoldedState {
  childId: string;
  poolStates: CardPoolState[];
  counters: FoldCounters;
  dailySummaries: DailySummary[];
  planAdjustments: DailyPlanAdjustedEvent[];
  unknownEventTypes: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* 排序键全序化（导出比较函数；禁依赖到达顺序）                          */
/* ------------------------------------------------------------------ */

/** HLC 比较：物理毫秒 asc → 逻辑计数 asc。 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs < b.physicalMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

/**
 * 事件全序比较：`(hlc 物理, hlc 逻辑, device_id, event_id)` 字典序。
 * 完备性：event_id 为末位决胜键——两个 event_id 不同的事件永不比较相等；
 * 比较相等当且仅当同一事件（重复投递，由 sortEvents 去重）。
 * 字符串比较为逐字符字典序（设备 id/event id 为 UUID/ASCII 习惯命名，
 * TS 与 Python 默认字符串序在此字符集上同构）。
 */
export function compareEvents(a: LearningEvent, b: LearningEvent): number {
  const h = compareHlc(a.hlc, b.hlc);
  if (h !== 0) return h;
  if (a.device_id !== b.device_id) return a.device_id < b.device_id ? -1 : 1;
  if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* 信封校验与排序入口                                                    */
/* ------------------------------------------------------------------ */

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(rec: Record<string, unknown>, field: string, where: string): string {
  const v = rec[field];
  if (typeof v !== 'string' || v.length === 0) fail(where, `${field} must be a non-empty string`);
  return v;
}

function reqBool(rec: Record<string, unknown>, field: string, where: string): boolean {
  const v = rec[field];
  if (typeof v !== 'boolean') fail(where, `${field} must be a boolean`);
  return v;
}

/** 非负整数（计数类：device_seq、奖励数、用时秒数）。 */
function reqUint(rec: Record<string, unknown>, field: string, where: string): number {
  const v = rec[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    fail(where, `${field} must be a non-negative integer`);
  }
  return v;
}

/** 非负有限数（反应时毫秒：与 transition.validateEvent 同则）。 */
function reqNonNegativeNumber(rec: Record<string, unknown>, field: string, where: string): number {
  const v = rec[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    fail(where, `${field} must be a finite number >= 0`);
  }
  return v;
}

/** 可选非负整数：缺省 0（负值即违约——计数面不存在可减路径）。 */
function optUint(rec: Record<string, unknown>, field: string, where: string): number {
  if (!Object.prototype.hasOwnProperty.call(rec, field)) return 0;
  return reqUint(rec, field, where);
}

const ALL_POOLS: readonly PoolId[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated'];

function isPoolId(v: string): v is PoolId {
  return (ALL_POOLS as readonly string[]).includes(v);
}

function reqIsoDate(rec: Record<string, unknown>, field: string, where: string): IsoDate {
  const v = reqString(rec, field, where);
  if (!isValidIsoDate(v)) fail(where, `${field} is not a valid ISO date: ${v}`);
  return v;
}

/** 信封校验（逐字段；报错带 event_id 便于定位）。 */
function assertValidEnvelope(ev: LearningEvent, index: number): void {
  const where = `learning event #${index} (${typeof ev?.event_id === 'string' ? ev.event_id : '?'})`;
  if (!isRecord(ev)) fail(where, 'event must be an object');
  reqString(ev as Record<string, unknown>, 'event_id', where);
  reqString(ev as Record<string, unknown>, 'child_id', where);
  reqString(ev as Record<string, unknown>, 'device_id', where);
  reqUint(ev as Record<string, unknown>, 'device_seq', where);
  reqString(ev as Record<string, unknown>, 'occurred_at', where);
  reqString(ev as Record<string, unknown>, 'type', where);
  const hlc = (ev as Record<string, unknown>)['hlc'];
  if (!isRecord(hlc)) fail(where, 'hlc must be an object {physicalMs, counter}');
  reqUint(hlc, 'physicalMs', `${where} hlc`);
  reqUint(hlc, 'counter', `${where} hlc`);
}

/**
 * 排序＋去重（确定性重放入口）：
 * 1. 先校验全部信封（按输入顺序报错，错误信息与到达顺序无关地稳定）；
 * 2. 按 compareEvents 全序排序（不依赖到达顺序）；
 * 3. event_id 去重——全序首见者胜（幂等；同 id 异容为契约违约，
 *    确定性取全序先到者，不静默合并）。
 */
export function sortEvents(events: readonly LearningEvent[]): LearningEvent[] {
  const input = [...events];
  input.forEach((ev, i) => assertValidEnvelope(ev, i));
  const sorted = input.sort(compareEvents);
  const seen = new Set<string>();
  const out: LearningEvent[] = [];
  for (const ev of sorted) {
    if (seen.has(ev.event_id)) continue;
    seen.add(ev.event_id);
    out.push(ev);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 池位变更（pool_promoted / pool_demoted 的状态转移）                   */
/* ------------------------------------------------------------------ */

/**
 * 显式池位设置：to_pool 直接生效（引擎外池位事实，折叠器不复算）。
 * - 快对连击清零（与 applyAnswer 升档清零同则：连击属于池位）；
 * - 错误连击与近 3 次缓存保留（错误史/作答史不因手动调级消失）；
 * - 到期时间按新池间隔自 on 起算（P0=当日重学、graduated=null 走月度抽样）。
 */
export function applyPoolChange(state: CardPoolState, toPool: PoolId, on: IsoDate): CardPoolState {
  return {
    ...state,
    pool: toPool,
    fastStreak: 0,
    dueDate:
      toPool === 'graduated'
        ? null
        : toPool === 'P0'
          ? on
          : addDays(on, POOL_INTERVALS_DAYS[toPool]),
    graduatedSampledMonth: toPool === 'graduated' ? state.graduatedSampledMonth : null,
  };
}

/* ------------------------------------------------------------------ */
/* 载荷解析（已知类型逐字段校验；未知类型不进这里）                      */
/* ------------------------------------------------------------------ */

function parseAnswerPayload(ev: LearningEvent): AnswerPayload {
  const where = `event ${ev.event_id} (answer payload)`;
  const rec = ev.payload;
  if (!isRecord(rec)) fail(where, 'payload must be an object');
  return {
    lexical_entry_id: reqString(rec, 'lexical_entry_id', where),
    // 未登记题型不拒收：落兜底基线（前向兼容，题库可先于引擎扩类型）
    question_type: reqString(rec, 'question_type', where) as QuestionType,
    correct: reqBool(rec, 'correct', where),
    reaction_ms: reqNonNegativeNumber(rec, 'reaction_ms', where),
    answered_on: reqIsoDate(rec, 'answered_on', where),
    stars_earned: optUint(rec, 'stars_earned', where),
    shards_earned: optUint(rec, 'shards_earned', where),
  };
}

function parsePoolChangePayload(ev: LearningEvent): PoolChangePayload {
  const where = `event ${ev.event_id} (${ev.type} payload)`;
  const rec = ev.payload;
  if (!isRecord(rec)) fail(where, 'payload must be an object');
  const toPool = reqString(rec, 'to_pool', where);
  if (!isPoolId(toPool)) fail(where, `unknown to_pool ${toPool}`);
  return {
    lexical_entry_id: reqString(rec, 'lexical_entry_id', where),
    to_pool: toPool,
    on: reqIsoDate(rec, 'on', where),
    reason: typeof rec['reason'] === 'string' ? rec['reason'] : undefined,
  };
}

function parseSignalSnapshot(value: unknown, where: string): DailySignalSnapshot {
  if (!isRecord(value)) fail(where, 'signal_snapshot must be an object');
  return {
    date: reqIsoDate(value, 'date', where),
    answered: reqUint(value, 'answered', where),
    correct: reqUint(value, 'correct', where),
    accuracy: reqNonNegativeNumber(value, 'accuracy', where),
    completedOnTime: reqBool(value, 'completedOnTime', where),
    overtime: reqBool(value, 'overtime', where),
    timeInBand: reqBool(value, 'timeInBand', where),
    digestIndex: reqNonNegativeNumber(value, 'digestIndex', where),
  };
}

function parseDailyPlanAdjustedPayload(ev: LearningEvent): DailyPlanAdjustedPayload {
  const where = `event ${ev.event_id} (daily_plan_adjusted payload)`;
  const rec = ev.payload;
  if (!isRecord(rec)) fail(where, 'payload must be an object');
  const reasonsRaw = rec['reasons'];
  if (!Array.isArray(reasonsRaw) || reasonsRaw.some((r) => typeof r !== 'string')) {
    fail(where, 'reasons must be an array of strings');
  }
  return {
    date: reqIsoDate(rec, 'date', where),
    from: reqUint(rec, 'from', where),
    to: reqUint(rec, 'to', where),
    reasons: reasonsRaw as DailyPlanAdjustReason[],
    signal_snapshot: parseSignalSnapshot(rec['signal_snapshot'], where),
  };
}

function parseDailyCompletedPayload(ev: LearningEvent): DailyCompletedPayload {
  const where = `event ${ev.event_id} (daily_completed payload)`;
  const rec = ev.payload;
  if (!isRecord(rec)) fail(where, 'payload must be an object');
  const seg = rec['segment_seconds'];
  if (!isRecord(seg)) fail(where, 'segment_seconds must be an object {new_words, review}');
  return {
    date: reqIsoDate(rec, 'date', where),
    completed_on_time: reqBool(rec, 'completed_on_time', where),
    segment_seconds: {
      new_words: reqUint(seg, 'new_words', where),
      review: reqUint(seg, 'review', where),
    },
    stars_earned: optUint(rec, 'stars_earned', where),
    shards_earned: optUint(rec, 'shards_earned', where),
  };
}

/* ------------------------------------------------------------------ */
/* 折叠器主入口                                                          */
/* ------------------------------------------------------------------ */

function byStringAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 折叠：事件集 → FoldedState（纯函数；同事件集必同终态，与到达顺序无关）。
 *
 * 处理序＝sortEvents 全序；逐事件分派：
 * - answer：复用 applyAnswer 推进单词状态（升/降/留池/毕业全走调度同源逻辑），
 *   计数与当日摘要累加；
 * - pool_promoted / pool_demoted：applyPoolChange 显式设池（自然合并：全序后到者生效）；
 * - daily_plan_adjusted：同日 last-wins 落 planAdjustments（adaptation_log 投影源）；
 * - daily_completed：当日摘要的完成标记/用时快照按全序后到者覆盖，奖励累加；
 * - 未知类型：跳过＋unknownEventTypes 计数。
 *
 * @param events 单一 child_id 的事件集（混入多孩即抛错；多孩由调用方分流）
 */
export function fold(events: readonly LearningEvent[]): FoldedState {
  const ordered = sortEvents(events);

  let childId = '';
  for (const ev of ordered) {
    if (childId === '') childId = ev.child_id;
    if (ev.child_id !== childId) {
      throw new Error(
        `fold: mixed child_id in event set (${childId} vs ${ev.child_id}); fold is per-child — split by child_id before folding`,
      );
    }
  }

  const states = new Map<string, CardPoolState>();
  const counters: FoldCounters = { answered: 0, correct: 0, stars: 0, shards: 0 };
  const daily = new Map<IsoDate, DailySummary>();
  const adjustments = new Map<IsoDate, DailyPlanAdjustedEvent>();
  const unknownEventTypes: Record<string, number> = {};

  const ensureDaily = (date: IsoDate): DailySummary => {
    let s = daily.get(date);
    if (!s) {
      s = {
        date,
        answered: 0,
        correct: 0,
        completedOnTime: false,
        segmentSeconds: { newWords: 0, review: 0 },
        starsEarned: 0,
        shardsEarned: 0,
      };
      daily.set(date, s);
    }
    return s;
  };

  const ensureCard = (lexicalEntryId: string, on: IsoDate): CardPoolState => {
    let s = states.get(lexicalEntryId);
    if (!s) {
      s = createNewCardState(childId, lexicalEntryId, on);
      states.set(lexicalEntryId, s);
    }
    return s;
  };

  for (const ev of ordered) {
    switch (ev.type) {
      case 'answer': {
        const p = parseAnswerPayload(ev);
        const stars = p.stars_earned ?? 0;
        const shards = p.shards_earned ?? 0;
        counters.answered += 1;
        if (p.correct) counters.correct += 1;
        counters.stars += stars;
        counters.shards += shards;
        const summary = ensureDaily(p.answered_on);
        summary.answered += 1;
        if (p.correct) summary.correct += 1;
        summary.starsEarned += stars;
        summary.shardsEarned += shards;
        const state = ensureCard(p.lexical_entry_id, p.answered_on);
        states.set(
          p.lexical_entry_id,
          applyAnswer(state, {
            lexicalEntryId: p.lexical_entry_id,
            questionType: p.question_type,
            correct: p.correct,
            reactionTimeMs: p.reaction_ms,
            answeredOn: p.answered_on,
          }).state,
        );
        break;
      }
      case 'pool_promoted':
      case 'pool_demoted': {
        const p = parsePoolChangePayload(ev);
        const state = ensureCard(p.lexical_entry_id, p.on);
        states.set(p.lexical_entry_id, applyPoolChange(state, p.to_pool, p.on));
        break;
      }
      case 'daily_plan_adjusted': {
        const p = parseDailyPlanAdjustedPayload(ev);
        adjustments.set(p.date, {
          type: 'daily_plan_adjusted',
          childId,
          date: p.date,
          from: p.from,
          to: p.to,
          reasons: p.reasons,
          signalSnapshot: p.signal_snapshot,
        });
        break;
      }
      case 'daily_completed': {
        const p = parseDailyCompletedPayload(ev);
        const stars = p.stars_earned ?? 0;
        const shards = p.shards_earned ?? 0;
        const summary = ensureDaily(p.date);
        summary.completedOnTime = p.completed_on_time;
        summary.segmentSeconds = { newWords: p.segment_seconds.new_words, review: p.segment_seconds.review };
        summary.starsEarned += stars;
        summary.shardsEarned += shards;
        counters.stars += stars;
        counters.shards += shards;
        break;
      }
      default: {
        unknownEventTypes[ev.type] = (unknownEventTypes[ev.type] ?? 0) + 1;
        break;
      }
    }
  }

  const poolStates = [...states.values()].sort((a, b) => byStringAsc(a.lexicalEntryId, b.lexicalEntryId));
  const dailySummaries = [...daily.values()].sort((a, b) => byStringAsc(a.date, b.date));
  const planAdjustments = [...adjustments.values()].sort((a, b) => byStringAsc(a.date, b.date));

  return { childId, poolStates, counters, dailySummaries, planAdjustments, unknownEventTypes };
}
