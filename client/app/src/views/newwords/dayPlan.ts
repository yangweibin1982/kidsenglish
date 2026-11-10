/**
 * 新词段日计划装配（票 14 换装：mock → fold 状态＋词包真词 → 引擎直出）。
 *
 * 单事实源分工（禁自行实现抽词/排序的边界划清）：
 * - **引擎 buildDailyPlan**（票 09 契约、票 12 FoldedState 直喂）：调节器值、
 *   复习段队列、容量与分摊——调度面全部引擎产出；
 * - **词包 loadBuiltinPack**（内容域）：新词的教学序（unit_no→ordinal）与
 *   词内容（word/phonicsSplit）——引擎只掌握词 id，内容取数归词包（票 09 头注）；
 * - **本文件只做拼装**：新词队列＝「引擎计划的新词位」＋「词包中尚无池位状态
 *   的词按教学序补位」，张数上限仍由引擎 adjuster.value 钳制（capToDailyMax
 *   防御再切一次）。冷启动零事件时引擎计划为空，队列＝词包头 N 词（真实课程
 *   起点，零编造进度）。
 *
 * mock 夹具（MOCK_CARDS/buildMockDailyPlan）退役为开发模式垫底（?mock=1 开关，
 * profile.isMockMode），文件保留供 UI 开发（票面「mock 保留文件＋开关位」）。
 */
import { DAILY_NEW_WORDS_MAX, type DailyPlan } from '@kidsenglish/engine';
import type { SyllableCard } from './stateMachine';
import type { PackLexicon } from '../../store/packs';

/**
 * 一年级防呆上限：当日新词队列硬顶 10 张（引擎 DAILY_NEW_WORDS_MAX 常量，
 * UI 直接消费；引擎侧 clampDailyNewWords 已在源头夹逼，此处防御性再切一次）。
 */
export function capToDailyMax(cards: readonly SyllableCard[]): SyllableCard[] {
  return cards.slice(0, DAILY_NEW_WORDS_MAX);
}

/** 当日新词段计划（真数据；形状与退役 mock 版一致，视图状态机零改动）。 */
export type DailyNewWordsPlan = {
  /** 计划日期 YYYY-MM-DD（展示用） */
  date: string;
  newWords: SyllableCard[];
};

/**
 * 真数据装配：引擎日计划＋词包 → 当日新词队列。
 *
 * @param plan          引擎 buildDailyPlan(profile, poolStates, history) 产物
 * @param lexicon       内置词包（loadBuiltinPack()；教学序与词内容）
 * @param stateEntryIds 已有池位状态的词 id 集（FoldedState.poolStates 投影）——
 *                      已引入过的词不再进新词队列（作答事件已使其进入复习轮转）
 */
export function buildDailyNewWordsPlan(
  plan: DailyPlan,
  lexicon: PackLexicon,
  stateEntryIds: ReadonlySet<string>,
): DailyNewWordsPlan {
  // 周末挡新词仅在当日确有复习卡时生效（票 26 兜底）：无复习可做即放行新词补位——
  // 否则周末×冷启动/复习做完＝「新词 0＋复习 0」死胡同（2026-11-01 周六首用实测）。
  // engine 层 day.ts 周末挡顺延卡语义保持不变，本行只管词包补位通道。
  const cap =
    plan.isWeekend && plan.reviewQueue.length > 0
      ? 0
      : Math.min(plan.adjuster.value, DAILY_NEW_WORDS_MAX);
  const merged: SyllableCard[] = [];
  const seen = new Set<string>();
  const push = (entryId: string): void => {
    if (seen.has(entryId) || merged.length >= cap) return;
    const w = lexicon.byId.get(entryId);
    if (!w) return; // 计划里的词不在当前词包（包版本漂移）：跳过不硬凑
    seen.add(entryId);
    merged.push({ entryId: w.entryId, word: w.word, phonicsSplit: w.phonicsSplit });
  };
  // 1) 引擎计划的新词位（新鲜 P0 顺延卡——首推零事件时为空）
  for (const c of plan.newWords) push(c.entryId);
  // 2) 词包补位：尚无任何池位状态的词按教学序（unit→ordinal）填满调节器容量
  for (const w of lexicon.ordered) {
    if (merged.length >= cap) break;
    if (stateEntryIds.has(w.entryId)) continue;
    push(w.entryId);
  }
  return { date: plan.date, newWords: capToDailyMax(merged) };
}

/* ------------------------------------------------------------------ */
/* 退役 mock（开发模式 ?mock=1 专用；保留文件与开关位，票面要求）          */
/* ------------------------------------------------------------------ */

/** 开发期 mock：有拆分词与无拆分词混排（覆盖整词分支演示） */
const MOCK_CARDS: readonly SyllableCard[] = [
  { entryId: 'w_pencil', word: 'pencil', phonicsSplit: 'pen·cil' },
  { entryId: 'w_give', word: 'give', phonicsSplit: null },
  { entryId: 'w_picture', word: 'picture', phonicsSplit: 'pic·ture' },
  { entryId: 'w_monkey', word: 'monkey', phonicsSplit: 'mon·key' },
  { entryId: 'w_hamburger', word: 'hamburger', phonicsSplit: 'ham·bur·ger' },
  { entryId: 'w_me', word: 'me', phonicsSplit: null },
  { entryId: 'w_panda', word: 'panda', phonicsSplit: 'pan·da' },
  { entryId: 'w_yellow', word: 'yellow', phonicsSplit: 'yel·low' },
];

/** 开发模式专用：mock 当日计划（?mock=1；真数据路径未通时的 UI 开发垫底）。 */
export function buildMockDailyPlan(todayIso: string): DailyNewWordsPlan {
  return { date: todayIso, newWords: capToDailyMax(MOCK_CARDS) };
}
