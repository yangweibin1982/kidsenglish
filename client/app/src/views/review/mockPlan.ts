/**
 * 复习段日计划与出题（票 14 换装：mock 夹具退役 → 真数据主路径）。
 *
 * ★ 单事实源纪律（票面：禁自行实现抽词/排序）：
 *   真数据路径＝FoldedState.poolStates/dailySummaries 直喂引擎 `buildDailyPlan`
 *   （票 09 day 层），复习队列/形态分流/池分摊/顺延全部引擎产出；词内容取数
 *   归词包（loadBuiltinPack，store/packs）。本文件只保留：
 *   ①buildQuestion——看词选义出题装配（干扰项/选项序确定性）；
 *   ②退役 mock 夹具（buildMockPoolStates/buildMockReviewPlan/MOCK_LEXICON，
 *     开发模式 ?mock=1 专用，票面「mock 保留文件＋开关位」）。
 */

import {
  addDays,
  buildDailyPlan,
  type CardPoolState,
  type DailyPlan,
  type DailyReviewCard,
} from '@kidsenglish/engine';
import type { PackLexicon } from '../../store/packs';

/* ------------------------------------------------------------------ */
/* 出题装配（真数据/mock 共用；lexicon 注入决定取数源）                    */
/* ------------------------------------------------------------------ */

/** 复习选择题（看词选义，word_pick_meaning 的复习段简化形）。 */
export interface ReviewQuestion {
  word: string;
  /** 释义选项（含正确项；3-4 个）。 */
  options: string[];
  correctIndex: number;
}

/**
 * 装配一张卡的选项（确定性，零随机）：干扰项优先取「同单元词」的释义
 * （教学序就近，票 17：U2 单元内 give 的干扰项不再混入全包远词），同单元
 * 候选不足 3 个再按教学序从全包补足；按 seed 旋转选项顺序——同状态同输出，
 * 可测可复现。同义/空释义候选跳过（避免多正确项）。
 * lexicon 缺省＝退役 mock 词表（既有测试/开发模式形状不破；mock 投影统一
 * unitNo=0，同单元即全表，行为与票 17 前一致）；真数据路径由 ReviewView
 * 注入内置词包（learningData.pack）。
 * 队列里出现词表缺失的 entryId 视为数据破损，直接抛错（fail loud）。
 */
export function buildQuestion(
  card: DailyReviewCard,
  seed: number,
  lexicon: PackLexicon = mockLexiconAsPack(),
): ReviewQuestion {
  const entry = lexicon.byId.get(card.entryId);
  if (!entry) {
    throw new Error(`buildQuestion: entryId 不在词包: ${card.entryId}`);
  }
  const sameUnit: string[] = [];
  const rest: string[] = [];
  for (const candidate of lexicon.ordered) {
    if (candidate.meaning === entry.meaning || candidate.meaning === '') continue;
    const bucket = candidate.unitNo === entry.unitNo ? sameUnit : rest;
    if (!bucket.includes(candidate.meaning)) bucket.push(candidate.meaning);
  }
  const distractors = sameUnit.slice(0, 3);
  for (const meaning of rest) {
    if (distractors.length === 3) break;
    if (!distractors.includes(meaning)) distractors.push(meaning);
  }
  const ordered = [entry.meaning, ...distractors];
  const k = ((seed % ordered.length) + ordered.length) % ordered.length;
  const options = ordered.slice(k).concat(ordered.slice(0, k));
  return { word: entry.word, options, correctIndex: (ordered.length - k) % ordered.length };
}

/* ------------------------------------------------------------------ */
/* 退役 mock（开发模式 ?mock=1 专用；票面要求保留文件与开关位）            */
/* ------------------------------------------------------------------ */

/** 词内容行（退役 mock 的开发期垫底映射）。 */
export interface LexiconEntry {
  word: string;
  meaning: string;
}

/** mock 词表（词包真词的投影垫底；仅 ?mock=1 生效）。 */
export const MOCK_LEXICON: Readonly<Record<string, LexiconEntry>> = {
  w_pencil: { word: 'pencil', meaning: '铅笔' },
  w_rubber: { word: 'rubber', meaning: '橡皮' },
  w_sunday: { word: 'sunday', meaning: '星期日' },
  w_me: { word: 'me', meaning: '我' },
  w_give: { word: 'give', meaning: '给' },
  w_picture: { word: 'picture', meaning: '图画' },
  w_pizza: { word: 'pizza', meaning: '披萨' },
  w_hamburger: { word: 'hamburger', meaning: '汉堡包' },
  w_monkey: { word: 'monkey', meaning: '猴子' },
  w_panda: { word: 'panda', meaning: '熊猫' },
  w_yellow: { word: 'yellow', meaning: '黄色' },
};

/** mock 孩子档案 id。 */
const MOCK_CHILD_ID = 'c_mock';

/** 夹具工厂：CardPoolState 缺省合法值（未给字段按引擎语义补默认）。 */
function mkState(
  entryId: string,
  pool: CardPoolState['pool'],
  overrides: Partial<CardPoolState> = {},
): CardPoolState {
  return {
    childId: MOCK_CHILD_ID,
    lexicalEntryId: entryId,
    pool,
    fastStreak: 0,
    errorStreak: 0,
    dueDate: null,
    variationTier: 'standard',
    paused: false,
    graduatedSampledMonth: null,
    recentOutcomes: [],
    ...overrides,
  };
}

/**
 * mock 卡池夹具（?mock=1 演示/验收用）：
 * - w_sunday：新鲜 P0（无作答历史）→ 只进新词段，不入复习（分流对照）；
 * - w_me：P0 有答错史 → 留池重学（relearn，plain）；
 * - w_pencil：P1 到期 / w_rubber：P2 昨日到期（overdue）→ plain；
 * - w_monkey P3 / w_panda P4（含错误连击）/ w_hamburger P5 / w_yellow
 *   毕业池抽样维护 → shooting。
 */
export function buildMockPoolStates(todayIso: string): CardPoolState[] {
  const yesterday = addDays(todayIso, -1);
  return [
    mkState('w_sunday', 'P0', { dueDate: todayIso }), // 新鲜 P0 → 新词段
    mkState('w_me', 'P0', {
      dueDate: todayIso,
      recentOutcomes: [{ correct: false, fast: false, answeredOn: yesterday }],
    }),
    mkState('w_pencil', 'P1', { dueDate: todayIso }),
    mkState('w_rubber', 'P2', { dueDate: yesterday }), // overdue
    mkState('w_monkey', 'P3', { dueDate: todayIso }),
    mkState('w_panda', 'P4', { dueDate: todayIso, errorStreak: 1 }),
    mkState('w_hamburger', 'P5', { dueDate: todayIso }),
    mkState('w_yellow', 'graduated', { dueDate: todayIso, graduatedSampledMonth: '2026-10' }),
  ];
}

/** mock 词表的 PackLexicon 投影（buildQuestion 注入用，?mock=1 专用）。 */
export function mockLexiconAsPack(): PackLexicon {
  const ordered = Object.entries(MOCK_LEXICON).map(([entryId, e]) => ({
    entryId,
    word: e.word,
    meaning: e.meaning,
    phonicsSplit: null,
    unitNo: 0, // mock 无单元概念：统一 0（同单元=全表，出题行为与真包「先同单元」不冲突）
    // 票 51 投影面：mock 无词义呈现数据——空数组/空音标＝显示面天然隐藏（宁缺勿滥同语义）
    phoneticUk: null,
    senses: [],
    examples: [],
  }));
  return { packId: 'mock', ordered, byId: new Map(ordered.map((w) => [w.entryId, w])) };
}

/**
 * 开发模式：mock 卡池直喂引擎出当日计划（?mock=1）。
 * 真数据路径归 learningData.ensureReady/refresh（store/learningData.ts）。
 */
export function buildMockReviewPlan(todayIso: string): DailyPlan {
  return buildDailyPlan(
    { childId: MOCK_CHILD_ID, date: todayIso, dailyNewWords: 5 },
    buildMockPoolStates(todayIso),
    [],
  );
}
