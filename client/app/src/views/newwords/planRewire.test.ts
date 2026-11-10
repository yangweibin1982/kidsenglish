/**
 * 事件回写集成＋冷启动＋换装装配单测（票 14）：
 * - 点读完成/复习正误 → answer 事件 → fold 池位变化 → 下次计划反映；
 * - daily_completed → dailySummaries（S9 调节器信号源）；
 * - 冷启动零事件 → 空计划引导态（禁编造进度）；
 * - buildDailyNewWordsPlan：词包教学序补位／已引入词排除／周末零新词／容量钳制。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildDailyPlan, fold, type LearningEvent } from '@kidsenglish/engine';
import { createSqlJsDriver } from '../../store/driver';
import { buildDailyCompletedPayload, buildNewWordFillPayload } from '../../store/learningData';
import { LearningStore } from '../../store/learningStore';
import { loadPack, type PackLexicon, type PackWord } from '../../store/packs';
import { buildDailyNewWordsPlan } from './dayPlan';
import { buildQuestion } from '../review/mockPlan';

const TODAY = '2026-10-25'; // 周日（isWeekend=true）
const WORKDAY = '2026-10-27'; // 周二

async function openStore() {
  const driver = await createSqlJsDriver();
  const clock = {
    restore: () => undefined,
    tick: (nowMs: number) => ({ physicalMs: nowMs, counter: 0 }),
    recv: () => ({ physicalMs: 1_730_000_000_000, counter: 0 }),
    snapshot: () => ({ physicalMs: 1_730_000_000_000, counter: 0 }),
  };
  const { store } = await LearningStore.open(driver, clock, 'dev-test');
  return store;
}

/** 引擎日计划便捷入口（与 learningData.refresh 同参形状）。 */
function planOf(store: LearningStore, date: string) {
  return store.foldedState('1').then((state) =>
    buildDailyPlan(
      { childId: '1', date, dailyNewWords: 5, parentLocked: false },
      state.poolStates,
      state.dailySummaries,
    ),
  );
}

describe('事件回写 → 下次计划反映（真数据全链路）', () => {
  let store: LearningStore;

  beforeEach(async () => {
    store = await openStore();
  });

  it('冷启动：零事件 → 空计划引导态（复习空队、计数全 0、新词＝词包头 N 词）', async () => {
    const state = await store.foldedState('1');
    expect(state.counters.answered).toBe(0);
    const plan = await planOf(store, WORKDAY);
    expect(plan.reviewQueue).toEqual([]); // 无到期卡
    expect(plan.newWords).toEqual([]); // 引擎侧零新鲜 P0（池位未建）
    const pack = loadPack('official-1a-v4');
    const newPlan = buildDailyNewWordsPlan(plan, pack, new Set());
    expect(newPlan.newWords.length).toBe(5); // 调节器天花板 5（词包补位）
    expect(newPlan.newWords[0].word).toBe('hello'); // v3 并入 U1：教学序首位＝hello（票 17 验收）
    expect(newPlan.newWords.map((c) => c.word)).toEqual(['hello', 'hi', 'goodbye', 'morning', 'afternoon']);
  });

  it('点读完成回写：scaffold answer（慢对）→ P0 有作答史 → 次日复习段重学', async () => {
    // 周二点读完成 5 词（question_type=new_words_scaffold，reaction 15s 慢对）
    // v3 教学序前五词＝U1 hello/hi/goodbye/morning/afternoon（票 17 换包）
    for (let i = 0; i < 5; i += 1) {
      await store.appendLocal(
        '1',
        'answer',
        {
          lexical_entry_id: ['w_hello', 'w_hi', 'w_goodbye', 'w_morning', 'w_afternoon'][i],
          question_type: 'new_words_scaffold',
          correct: true,
          reaction_ms: 15_000,
          answered_on: WORKDAY,
        },
        1_730_000_000_000 + i,
      );
    }
    const state = await store.foldedState('1');
    expect(state.counters.answered).toBe(5);
    const plan = await planOf(store, '2026-10-28'); // 次日
    // 慢对留 P0 且有作答史 → 进复习段（relearn，plain），不再占新词队列
    expect(plan.reviewQueue.length).toBe(5);
    expect(plan.reviewQueue.every((c) => c.pool === 'P0' && c.form === 'plain')).toBe(true);
    // 新词队列顺延到词包下一批（不重复教已引入词；教学序＝U1 ordinal 6-9＋U2 ordinal 1）
    const pack = loadPack('official-1a-v4');
    const stateEntryIds = new Set(state.poolStates.map((s) => s.lexicalEntryId));
    const newPlan = buildDailyNewWordsPlan(plan, pack, stateEntryIds);
    expect(newPlan.newWords.map((c) => c.word)).toEqual(['I', 'am', 'school', 'day', 'give']);
    expect(newPlan.newWords.every((c) => !stateEntryIds.has(c.entryId))).toBe(true);
  });

  it('复习正误回写：快对升档／答错降档（引擎转移同源）', async () => {
    // 引入 w_pencil（快对：word_pick_meaning 基线 6s 内 → P0 快对升 P1）
    await store.appendLocal(
      '1',
      'answer',
      { lexical_entry_id: 'w_pencil', question_type: 'word_pick_meaning', correct: true, reaction_ms: 3000, answered_on: WORKDAY },
      1_730_000_000_000,
    );
    let state = await store.foldedState('1');
    expect(state.poolStates[0].pool).toBe('P1'); // 快对升档
    // 次日答错 → P1 自环留池＋错误连击
    await store.appendLocal(
      '1',
      'answer',
      { lexical_entry_id: 'w_pencil', question_type: 'word_pick_meaning', correct: false, reaction_ms: 9000, answered_on: '2026-10-28' },
      1_730_000_000_100,
    );
    state = await store.foldedState('1');
    expect(state.poolStates[0].pool).toBe('P1'); // P1 地板
    expect(state.poolStates[0].errorStreak).toBe(1);
    expect(state.counters.correct).toBe(1);
    expect(state.counters.answered).toBe(2);
  });

  it('daily_completed 门面载荷形状：fold round-trip 回归（票 14 实走发现的 camelCase 缺陷钉死）', () => {
    const p1 = buildDailyCompletedPayload(null, 'new_words', 86.4, WORKDAY, true);
    expect(p1.segment_seconds).toEqual({ new_words: 86, review: 0 });
    const p2 = buildDailyCompletedPayload({ newWords: 86, review: 0 }, 'review', 120.2, WORKDAY, false);
    expect(p2.segment_seconds).toEqual({ new_words: 86, review: 120 });
    // 两段事件都必须被引擎 fold 收下（键形错即抛——camelCase 回归面）
    const mk = (id: string, payload: unknown): LearningEvent => ({
      event_id: id,
      child_id: '1',
      device_id: 'dev-test',
      device_seq: 0,
      hlc: { physicalMs: 1_730_000_000_000, counter: 0 },
      occurred_at: `${WORKDAY}T10:00:00Z`,
      type: 'daily_completed',
      payload,
    });
    const state = fold([mk('ev-a', p1), mk('ev-b', p2)]);
    expect(state.dailySummaries[0].segmentSeconds).toEqual({ newWords: 86, review: 120 });
    expect(state.dailySummaries[0].completedOnTime).toBe(false);
  });

  it('daily_completed 回写：双段用时累计跨段可加（fold 同日覆盖语义）', async () => {
    // 新词段 90s
    await store.appendLocal(
      '1',
      'daily_completed',
      { date: WORKDAY, completed_on_time: true, segment_seconds: { new_words: 90, review: 0 } },
      1_730_000_000_000,
    );
    // 复习段 120s（fold 后到者覆盖 → 事件须携带累计值；门面 finishSegment 已做叠加）
    await store.appendLocal(
      '1',
      'daily_completed',
      { date: WORKDAY, completed_on_time: true, segment_seconds: { new_words: 90, review: 120 } },
      1_730_000_000_500,
    );
    const state = await store.foldedState('1');
    expect(state.dailySummaries).toHaveLength(1);
    expect(state.dailySummaries[0].segmentSeconds).toEqual({ newWords: 90, review: 120 });
    expect(state.dailySummaries[0].completedOnTime).toBe(true);
  });
});

describe('buildDailyNewWordsPlan：换装装配语义', () => {
  let store: LearningStore;

  beforeEach(async () => {
    store = await openStore();
  });

  it('周末冷启动兜底放行（票 26）：复习空即放行词包补位，首位教学序 hello', async () => {
    const plan = await planOf(store, TODAY); // 2026-10-25 = 周日
    const pack = loadPack('official-1a-v4');
    const newPlan = buildDailyNewWordsPlan(plan, pack, new Set());
    expect(plan.isWeekend).toBe(true);
    expect(plan.reviewQueue).toEqual([]); // 冷启动无复习可做
    expect(newPlan.newWords.length).toBeGreaterThan(0); // 兜底放行（取代票 09「周末必 0」）
    expect(newPlan.newWords[0]?.word).toBe('hello'); // 词包教学序补位
  });

  it('周末有复习卡仍挡新词（票 09 节奏语义保持）', async () => {
    const plan = await planOf(store, TODAY);
    const pack = loadPack('official-1a-v4');
    // 合成一张复习卡只为其非空（cap 判定只读 reviewQueue.length）
    const fakeCard = { entryId: 'w_fake' } as (typeof plan.reviewQueue)[number];
    const withReview = { ...plan, reviewQueue: plan.reviewQueue.concat([fakeCard]) };
    const newPlan = buildDailyNewWordsPlan(withReview, pack, new Set());
    expect(withReview.isWeekend).toBe(true);
    expect(newPlan.newWords).toEqual([]);
  });

  it('容量钳制：adjuster.value 与 DAILY_NEW_WORDS_MAX 取小（防御再切）', async () => {
    const plan = await planOf(store, WORKDAY);
    const pack = loadPack('official-1a-v4');
    // 用 ceiling=10 的计划验证钳制上限仍 ≤10
    const plan10 = buildDailyPlan({ childId: '1', date: WORKDAY, dailyNewWords: 10 }, [], []);
    const newPlan = buildDailyNewWordsPlan(plan10, pack, new Set());
    expect(newPlan.newWords.length).toBe(Math.min(plan10.adjuster.value, 10));
    expect(plan.reviewQueue).toEqual([]);
  });

  it('已引入词排除：stateEntryIds 中的词不再进队列（真进度驱动）', async () => {
    await store.appendLocal(
      '1',
      'answer',
      { lexical_entry_id: 'w_hello', question_type: 'new_words_scaffold', correct: true, reaction_ms: 20_000, answered_on: WORKDAY },
      1_730_000_000_000,
    );
    const state = await store.foldedState('1');
    const pack = loadPack('official-1a-v4');
    const plan = await planOf(store, '2026-10-28');
    const newPlan = buildDailyNewWordsPlan(plan, pack, new Set(state.poolStates.map((s) => s.lexicalEntryId)));
    expect(newPlan.newWords.map((c) => c.entryId)).not.toContain('w_hello');
    expect(newPlan.newWords[0].entryId).toBe('w_hi'); // 顺延到教学序第二位
  });
});

describe('buildQuestion：词包真词出题（注入 lexicon）', () => {
  const giveCard = {
    entryId: 'w_give',
    pool: 'P1' as const,
    form: 'plain' as const,
    dueReason: 'due_today' as const,
    dueDate: '2026-10-27',
    errorStreak: 0,
  };

  it('正确项在选项中且 word 取词包词形；缺失词条 fail loud', () => {
    const pack = loadPack('official-1a-v4');
    const q = buildQuestion(giveCard, 0, pack);
    const giveGloss = pack.byId.get('w_give')!.meaning; // 词包真值 gloss（unit-02 ordinal 1）
    expect(q.word).toBe('give');
    expect(giveGloss.length).toBeGreaterThan(0);
    expect(q.options).toContain(giveGloss);
    expect(q.options[q.correctIndex]).toBe(giveGloss);
    expect(q.options.length).toBeGreaterThanOrEqual(2);
    expect(() => buildQuestion({ ...giveCard, entryId: 'w_missing' }, 0, pack)).toThrow(/不在词包/);
  });

  it('票 14 P2 闭环：give 卡四选项含「给」；a 卡义项＝「一个」且无 \\r 残留（v3 真包实测）', () => {
    const pack = loadPack('official-1a-v4');
    expect(pack.byId.get('w_give')!.meaning).toBe('给'); // v3 curated 首义（v2 曾是「弹性, 适应性」）
    const q = buildQuestion(giveCard, 0, pack);
    expect(q.options).toContain('给');
    expect(q.options[q.correctIndex]).toBe('给');
    const aMeaning = pack.byId.get('w_a')!.meaning;
    expect(aMeaning).toBe('一个');
    expect(aMeaning.includes('\r')).toBe(false); // v2 曾残留「第一的\r」
  });

  it('干扰项限同单元（票 17）：give（U2）的干扰项全部来自 U2 词义', () => {
    const pack = loadPack('official-1a-v4');
    const unit2Meanings = new Set(
      pack.ordered.filter((w) => w.unitNo === 2).map((w) => w.meaning),
    );
    const q = buildQuestion(giveCard, 0, pack);
    const distractors = q.options.filter((o) => o !== '给');
    expect(distractors).toHaveLength(3); // U2 有 14 词：同单元即凑满，无需全包补
    for (const d of distractors) {
      expect(unit2Meanings.has(d)).toBe(true);
    }
  });

  it('同单元候选不足 3 个时按教学序全包补足（合成词包）', () => {
    const mk = (entryId: string, meaning: string, unitNo: number): PackWord => ({
      entryId,
      word: entryId,
      meaning,
      phonicsSplit: null,
      unitNo,
      phoneticUk: null,
      senses: [],
      examples: [],
    });
    const ordered: PackWord[] = [
      mk('w_a1', '甲', 1),
      mk('w_a2', '乙', 1),
      mk('w_b1', '丙', 2),
      mk('w_b2', '丁', 2),
      mk('w_b3', '戊', 2),
    ];
    const pack: PackLexicon = {
      packId: 'fixture',
      ordered,
      byId: new Map(ordered.map((w) => [w.entryId, w])),
    };
    const q = buildQuestion(
      { ...giveCard, entryId: 'w_a1' },
      0,
      pack,
    );
    // 同单元只有「乙」1 个 → 先取乙，再按教学序从 U2 补 丙、丁
    expect(q.options).toHaveLength(4);
    expect(q.options.filter((o) => o !== '甲')).toEqual(['乙', '丙', '丁']);
  });
});

describe('票 49：wrong_picks 契约（混淆图谱记录面）', () => {
  it('空/缺省＝不落字段（旧载荷形状逐键不变）；非空＝snake_case 序列化', () => {
    const noField = buildNewWordFillPayload({ entryId: 'w_hi' }, 0, { slots: 2, firstTryCorrectSlots: 2 }, WORKDAY);
    expect('wrong_picks' in noField).toBe(false); // 空 wrongPicks 省略
    const withPicks = buildNewWordFillPayload(
      { entryId: 'w_hi' },
      0,
      { slots: 2, firstTryCorrectSlots: 1, wrongPicks: [['h', 'd'], ['i', 'l']] },
      WORKDAY,
    );
    expect(withPicks.wrong_picks).toEqual([['h', 'd'], ['i', 'l']]);
  });
});

describe('票 28：new_words_fill 事件留痕（填空完成回写 → 事件流可断言）', () => {
  it('载荷形状：question_type=new_words_fill、correct=首试全对、snake_case 契约', () => {
    const p1 = buildNewWordFillPayload({ entryId: 'w_hello' }, 12_345.6, { slots: 5, firstTryCorrectSlots: 5 }, WORKDAY);
    expect(p1).toEqual({
      lexical_entry_id: 'w_hello',
      question_type: 'new_words_fill',
      correct: true,
      reaction_ms: 12346, // 四舍五入
      answered_on: WORKDAY,
    });
    // 严格口径：任何重试（firstTryCorrectSlots < slots）＝false → 引擎裁决进重学
    const p2 = buildNewWordFillPayload({ entryId: 'w_hi' }, 0, { slots: 2, firstTryCorrectSlots: 1 }, WORKDAY);
    expect(p2.correct).toBe(false);
    expect(p2.reaction_ms).toBe(0); // 负值/零钳制非负
    const p3 = buildNewWordFillPayload({ entryId: 'w_a' }, 5, { slots: 0, firstTryCorrectSlots: 0 }, WORKDAY);
    expect(p3.correct).toBe(false); // 退化防御：零格不判对
  });

  it('内存 store 全链路：append → allEvents 出现 new_words_fill → fold 收下（未登记题型兜底不抛）', async () => {
    const store = await openStore();
    const payload = buildNewWordFillPayload(
      { entryId: 'w_hello' },
      20_000,
      { slots: 5, firstTryCorrectSlots: 4 },
      WORKDAY,
    );
    const ev = await store.appendLocal('1', 'answer', payload, 1_730_000_000_000);
    expect(ev.type).toBe('answer');
    const events = await store.allEvents('1');
    const found = events.find(
      (e) => (e.payload as Record<string, unknown> | null)?.question_type === 'new_words_fill',
    );
    expect(found).toBeDefined(); // 事件流出现 new_words_fill（票 28 VALIDATE 4）
    expect((found!.payload as Record<string, unknown>).correct).toBe(false);
    // fold 收下未登记题型（DEFAULT_BASELINE_MS 兜底，engine 零触碰）
    const state = await store.foldedState('1');
    expect(state.counters.answered).toBe(1);
  });
});
