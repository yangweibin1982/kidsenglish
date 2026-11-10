/**
 * 学习数据门面（视图唯一消费面；票 14 换装的运行时枢纽）。
 *
 * 职责：开库（含首启冒烟门）→ 全量事件 fold 重建 → 引擎 buildDailyPlan →
 * 新词队列词包装配 → 视图响应式快照；作答/段结束事件回写（只追加）；
 * 同步客户端触发（S1：前台恢复/网络恢复/学习单元结束）。
 *
 * 离线优先：同步失败静默退避（syncClient），本门面任何路径不因网络阻塞学习。
 * 冷启动（零事件）：coldStart=true 引导态——counters 全 0、复习队列空、新词
 * 队列＝词包教学序头 N 词（真实课程起点，零编造进度）。
 */

import {
  buildDailyPlan,
  type DailyPlan,
  type DailySummary,
  type FoldCounters,
  type FoldedState,
} from '@kidsenglish/engine';
import { computed, ref, type ComputedRef } from 'vue';
import { mockLexiconAsPack } from '../views/review/mockPlan';
import type { DailyNewWordsPlan } from '../views/newwords/dayPlan';
import { buildDailyNewWordsPlan } from '../views/newwords/dayPlan';
import type { SyllableCard } from '../views/newwords/stateMachine';
import { createPlatformDriver } from './driver';
import { getChild } from './children';
import { LearningStore } from './learningStore';
import { loadPack, loadPackUnion, resolvePackId, type PackLexicon } from './packs';
import {
  isMockMode,
  resolveChildId,
  resolveDailyNewWordsCeiling,
  resolveFamilyToken,
  resolveServerBase,
} from './profile';
import { HlcClock } from '../sync/hlc';
import { SyncClient, type SyncOutcome } from '../sync/syncClient';

/** 学习单元段（S9 双段）。 */
export type SegmentKind = 'new_words' | 'review';

/** 视图快照（响应式；refresh 后整体替换）。 */
export interface LearningSnapshot {
  childId: string;
  /** 计划日（ISO）。 */
  date: string;
  /** 冷启动引导态（零事件；禁编造进度）。 */
  coldStart: boolean;
  /** 引擎日计划（复习队列/调节器/分摊的单事实源）。 */
  plan: DailyPlan;
  /** 当日新词段队列（词包装配后，含词内容；视图状态机直喂）。 */
  newWordsPlan: DailyNewWordsPlan;
  /** 计数面（只增不减）。 */
  counters: FoldCounters;
  /** 已引入池位的词数（FoldedState.poolStates 长度）。 */
  poolCount: number;
  /** 词包词数（绑定包＝孩子课本册次词量）。 */
  packWords: number;
  /** 词库绑定（票 35）：档案册次与实际生效包；fallback＝册次未上线回退缺省包。 */
  packBinding: { startPoint: string | null; packId: string; fallback: boolean };
  /** 待上行事件数（离线队列深度）。 */
  pendingSync: number;
  /** 末次成功同步时刻（ISO；从未同步为 null）。 */
  lastSyncAt: string | null;
  /** 末次同步失败原因（ok 时常为 null）。 */
  lastSyncError: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * daily_completed 载荷拼装（fold 契约 snake_case：segment_seconds.{new_words,review}）。
 * 纯函数独立导出＝回归测试面（票 14 实走曾因 camelCase 键被 fold 拒收——载荷形状
 * 是跨端契约，必须过引擎 fold round-trip 钉死）。
 */
export function buildDailyCompletedPayload(
  todayBase: { newWords: number; review: number } | null,
  segment: SegmentKind,
  usedSeconds: number,
  date: string,
  completedOnTime: boolean,
): { date: string; completed_on_time: boolean; segment_seconds: { new_words: number; review: number } } {
  const base = todayBase ?? { newWords: 0, review: 0 };
  const inc = Math.max(0, Math.round(usedSeconds));
  return {
    date,
    completed_on_time: completedOnTime,
    segment_seconds: {
      new_words: base.newWords + (segment === 'new_words' ? inc : 0),
      review: base.review + (segment === 'review' ? inc : 0),
    },
  };
}

/**
 * answer 事件载荷读端投影（票 49 混淆图谱；fold 只消费 correct/answered_on 等
 * 已知面，wrong_picks 为票 49 加字段——旧事件无此字段，派生端跳过）。
 */
export interface AnswerEventPayload {
  question_type: 'new_words_fill' | 'review_fill';
  correct: boolean;
  answered_on: string;
  wrong_picks?: [string, string][];
}

/**
 * new_words_fill answer 载荷拼装（fold 契约 snake_case；纯函数独立导出＝回归测试面，
 * 同 buildDailyCompletedPayload 先例：载荷形状是跨端契约，必须钉死）。
 * correct＝首试全对严格口径（任何重试＝false → 引擎裁决进重学）；
 * reaction_ms＝整卡停留毫秒。
 */
export function buildNewWordFillPayload(
  card: { entryId: string },
  dwellMs: number,
  fill: {
    slots: number;
    firstTryCorrectSlots: number;
    /** 错选对（票 49 混淆图谱；空/缺省＝不落字段，旧载荷形状保持） */
    wrongPicks?: readonly (readonly [string, string])[];
  },
  date: string,
): {
  lexical_entry_id: string;
  question_type: 'new_words_fill';
  correct: boolean;
  reaction_ms: number;
  answered_on: string;
  wrong_picks?: [string, string][];
} {
  return {
    lexical_entry_id: card.entryId,
    question_type: 'new_words_fill',
    correct: fill.slots > 0 && fill.firstTryCorrectSlots === fill.slots,
    reaction_ms: Math.max(0, Math.round(dwellMs)),
    answered_on: date,
    ...(fill.wrongPicks && fill.wrongPicks.length > 0
      ? { wrong_picks: fill.wrongPicks.map((p) => [p[0], p[1]] as [string, string]) }
      : {}),
  };
}

/**
 * review_fill answer 载荷拼装（spec v1.3 S9「雷霆战机」拼写驱动，票 29；
 * 取代复习段 word_pick_meaning 面——认义选择退役）。
 * 形状镜像 buildNewWordFillPayload（fold 契约 snake_case；纯函数独立导出＝
 * 回归测试面，载荷形状是跨端契约，必须钉死）。
 * correct＝首试全对严格口径（任何重试＝false → 引擎裁决进重学）；
 * 非首试重排的二次拼写各自成事件（两次尝试都进事件流，调度语义引擎裁决）；
 * question_type='review_fill' 未在 fold 登记基线 → DEFAULT_BASELINE_MS 兜底
 * （engine 零触碰，同 new_words_fill 先例）；reaction_ms＝整卡停留毫秒。
 */
export function buildReviewFillPayload(
  entryId: string,
  dwellMs: number,
  fill: {
    slots: number;
    firstTryCorrectSlots: number;
    /** 错选对（票 49 混淆图谱；空/缺省＝不落字段，旧载荷形状保持） */
    wrongPicks?: readonly (readonly [string, string])[];
  },
  date: string,
): {
  lexical_entry_id: string;
  question_type: 'review_fill';
  correct: boolean;
  reaction_ms: number;
  answered_on: string;
  wrong_picks?: [string, string][];
} {
  return {
    lexical_entry_id: entryId,
    question_type: 'review_fill',
    correct: fill.slots > 0 && fill.firstTryCorrectSlots === fill.slots,
    reaction_ms: Math.max(0, Math.round(dwellMs)),
    answered_on: date,
    ...(fill.wrongPicks && fill.wrongPicks.length > 0
      ? { wrong_picks: fill.wrongPicks.map((p) => [p[0], p[1]] as [string, string]) }
      : {}),
  };
}

class LearningData {
  readonly snapshot = ref<LearningSnapshot | null>(null);
  readonly error = ref<string | null>(null);
  readonly ready = ref(false);

  private store: LearningStore | null = null;
  private sync: SyncClient | null = null;
  /** 并集包（复习查词/出题超集面：跨包进度保留语义，旧包到期卡词义必须可命中）。 */
  private lexicon: PackLexicon | null = null;
  /** 绑定包（新词队列教学序来源；按激活档案册次解析，票 35）。 */
  private boundPack: PackLexicon | null = null;
  /** 最近一次 fold 全量状态（日摘要派生源；refresh 时更新）。 */
  private lastState: FoldedState | null = null;
  /** 当前孩子 answer 事件载荷缓存（混淆图谱读端，票 49；refresh 时更新）。 */
  private lastAnswerPayloads: AnswerEventPayload[] = [];
  private starting: Promise<void> | null = null;

  /** 词包（ensureReady 后可用；并集面——ReviewView 查词与出题消费）。 */
  get pack(): PackLexicon {
    if (!this.lexicon) throw new Error('learningData: ensureReady() 未调用');
    return this.lexicon;
  }

  /**
   * 绑定包（ensureReady 后可用；新词队列教学序同源——票 51 读步词义呈现按
   * entryId 回查此包。不走并集面：并集按包序去重，同 entryId 可能取到旧版线
   * 词条（v4 先于 v5），显示面必须与教学队列同源。）
   */
  get boundLexicon(): PackLexicon {
    if (!this.boundPack) throw new Error('learningData: ensureReady() 未调用');
    return this.boundPack;
  }

  /** 最近一次 fold 的日摘要（打卡页只读派生源，票 36；ensureReady 后可用）。 */
  get dailySummaries(): DailySummary[] {
    if (!this.lastState) throw new Error('learningData: ensureReady() 未调用');
    return this.lastState.dailySummaries;
  }

  /** 最近一次 fold 的全量状态（家长统计只读派生源，票 37；ensureReady 后可用）。 */
  get foldedState(): FoldedState {
    if (!this.lastState) throw new Error('learningData: ensureReady() 未调用');
    return this.lastState;
  }

  /** 当前孩子 answer 事件载荷（混淆图谱读端，票 49；ensureReady 后可用）。 */
  get answerPayloads(): AnswerEventPayload[] {
    if (!this.lastState) throw new Error('learningData: ensureReady() 未调用');
    return this.lastAnswerPayloads;
  }

  /** 任意孩子的日摘要（家庭排名跨孩取数，票 39；聚合面，不暴露池位明细）。 */
  async childDailySummaries(childId: string): Promise<DailySummary[]> {
    if (!this.store) throw new Error('learningData: ensureReady() 未调用');
    return (await this.store.foldedState(childId)).dailySummaries;
  }

  /** 幂等启动：开库＋冒烟门＋同步调度器＋首次 refresh。 */
  async ensureReady(): Promise<void> {
    if (this.ready.value) {
      await this.refresh();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (isMockMode()) {
        // 开发模式：不落库不联网，视图直接消费 mock 夹具（dayPlan/mockPlan 保留面）
        this.lexicon = mockLexiconAsPack();
        this.boundPack = this.lexicon;
        this.ready.value = true;
        return;
      }
      // 票 35 绑定生效链：激活档案册次 → 绑定包（新词队列）＋并集包（复习查词超集）。
      // 切换绑定经 ProfilesView 整页重载后由本函数重新解析，无需迁移事件
      // （entryId 词形键跨包稳定，旧包进度锚不漂）。
      const startPoint = getChild(resolveChildId())?.startPoint ?? null;
      const { packId } = resolvePackId(startPoint);
      this.boundPack = loadPack(packId);
      this.lexicon = loadPackUnion();
      const driver = await createPlatformDriver();
      const clock = new HlcClock();
      const deviceId = await this.resolveDeviceId(driver);
      const { store } = await LearningStore.open(driver, clock, deviceId);
      this.store = store;
      this.sync = new SyncClient(store, () => Date.now(), {
        childId: resolveChildId(),
        deviceId,
        serverBase: resolveServerBase(),
        familyToken: resolveFamilyToken(),
      });
      this.sync.start();
      await this.refresh();
      this.ready.value = true;
    })();
    try {
      await this.starting;
    } catch (err) {
      this.error.value = err instanceof Error ? err.message : String(err);
      this.starting = null;
      throw err;
    }
  }

  /** 重建快照：全量事件 → fold → 引擎日计划 → 词包装配。 */
  async refresh(): Promise<void> {
    if (!this.store || !this.lexicon || !this.boundPack) return;
    const childId = resolveChildId();
    const date = todayIso();
    const state: FoldedState = await this.store.foldedState(childId);
    this.lastState = state;
    // answer 事件载荷缓存（票 49 混淆图谱读端；全量事件扫描——儿童量级本地库可负担）
    const events = await this.store.allEvents(childId);
    this.lastAnswerPayloads = events
      .filter((e) => e.type === 'answer')
      .map((e) => e.payload as AnswerEventPayload);
    const plan = buildDailyPlan(
      { childId, date, dailyNewWords: resolveDailyNewWordsCeiling(), parentLocked: false },
      state.poolStates,
      state.dailySummaries,
    );
    const stateEntryIds = new Set(state.poolStates.map((s) => s.lexicalEntryId));
    const newWordsPlan = buildDailyNewWordsPlan(plan, this.boundPack, stateEntryIds);
    const pendingSync = await this.store.pendingCount();
    const cursor = await this.store.getCursor();
    const last: SyncOutcome | null = this.sync?.last ?? null;
    const startPoint = getChild(childId)?.startPoint ?? null;
    this.snapshot.value = {
      childId,
      date,
      coldStart: state.counters.answered === 0 && state.poolStates.length === 0,
      plan,
      newWordsPlan,
      counters: state.counters,
      poolCount: state.poolStates.length,
      packWords: this.boundPack.ordered.length,
      packBinding: { startPoint, packId: this.boundPack.packId, fallback: resolvePackId(startPoint).fallback },
      pendingSync,
      lastSyncAt: cursor.lastSyncedAt,
      lastSyncError: last && !last.ok ? (last.error ?? '同步失败') : null,
    };
  }

  /**
   * 新词段填空完成回写（票 28：spec v1.2 拼阶段考核面）。
   *
   * 事件语义（v1.2 修订，取代 v1.1「new_words_scaffold 前向兼容通道」）：拼阶段
   * ＝字母拼写产出（retrieval practice），有真实首试正确率——以 `answer` 事件
   * （question_type='new_words_fill'；fold 未登记题型走 DEFAULT_BASELINE_MS 兜底，
   * engine 零触碰——fold.ts:15 注释与 baselines.ts:44 实现为证）、
   * correct＝首试全对严格口径（任何重试＝false → 引擎裁决进重学）、
   * reaction_ms＝整卡停留毫秒（读阶段＋拼阶段）进入事件流；调度语义仍全部
   * 引擎裁决，本门面不写池位。
   */
  async recordNewWordFillDone(
    card: SyllableCard,
    dwellMs: number,
    fill: {
      slots: number;
      firstTryCorrectSlots: number;
      wrongPicks?: readonly (readonly [string, string])[];
    },
    nowMs = Date.now(),
  ): Promise<void> {
    if (!this.store) return;
    await this.store.appendLocal(
      resolveChildId(),
      'answer',
      buildNewWordFillPayload(card, dwellMs, fill, todayIso()),
      nowMs,
    );
    await this.refresh();
  }

  /** 复习段作答回写 v2（question_type=review_fill；形状与口径见 buildReviewFillPayload）。 */
  async recordReviewFill(
    entryId: string,
    dwellMs: number,
    fill: {
      slots: number;
      firstTryCorrectSlots: number;
      wrongPicks?: readonly (readonly [string, string])[];
    },
    nowMs = Date.now(),
  ): Promise<void> {
    if (!this.store) return;
    await this.store.appendLocal(
      resolveChildId(),
      'answer',
      buildReviewFillPayload(entryId, dwellMs, fill, todayIso()),
      nowMs,
    );
    await this.refresh();
  }

  /**
   * 学习单元结束回写（S9 daily_completed：完成标记＋段用时快照）。
   * segment_seconds 载当日累计双段用时（fold 语义＝同日后到者整体覆盖，
   * 事件里带「既有快照＋本段增量」才能跨重启累计）。
   */
  async finishSegment(segment: SegmentKind, completedOnTime: boolean, usedSeconds: number): Promise<void> {
    if (!this.store) return;
    const childId = resolveChildId();
    const date = todayIso();
    const state = await this.store.foldedState(childId);
    const today = state.dailySummaries.find((d) => d.date === date);
    const payload = buildDailyCompletedPayload(
      today?.segmentSeconds ?? null,
      segment,
      usedSeconds,
      date,
      completedOnTime,
    );
    await this.store.appendLocal(childId, 'daily_completed', payload, Date.now());
    await this.refresh();
    this.sync?.trigger(); // S1 触发面：学习单元结束
  }

  /** 手动触发一次同步（学习单元结束之外的补充入口）。 */
  triggerSync(): void {
    this.sync?.trigger();
  }

  /* ---------------- 内部 ---------------- */

  private async resolveDeviceId(driver: Awaited<ReturnType<typeof createPlatformDriver>>): Promise<string> {
    // device_id 独立于 store 的 meta（store.open 会写入）；这里先经轻量查询保证
    // 首开即有稳定 id（同一安装卸载重装＝新 id，天然模拟第二设备）。
    await driver.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    const rows = await driver.select<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      ['device_id'],
    );
    if (rows.length > 0) return rows[0].value;
    const id = crypto.randomUUID();
    await driver.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ['device_id', id],
    );
    return id;
  }
}

/** 模块级单例（视图共享同一开库实例与调度器）。 */
export const learningData = new LearningData();

/** 响应式快照（视图便捷引用）。 */
export const learningSnapshot: ComputedRef<LearningSnapshot | null> = computed(
  () => learningData.snapshot.value,
);

export type { FoldCounters };
