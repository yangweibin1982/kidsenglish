/**
 * 复习段状态机测试 v3（Ticket 30 VALIDATE；v2 基础上增 combo/score 断言）。
 * 覆盖：拼写驱动流转（拼完→performance→弹出）；首试全对口径；非首试重排
 * 一次；游戏内 combo/score（纯展示不进事件流）；时间盒到点即停（注入 mock
 * 时钟）＋顺延张数（E4）；一年级 10 张上限防呆；演出错误兜底推进；
 * review_fill 载荷形状（跨端契约钉死）。
 */
import { describe, expect, it } from 'vitest';
import {
  DAILY_NEW_WORDS_MAX,
  REVIEW_SEGMENT_BUDGET_SECONDS,
  type DailyReviewCard,
} from '@kidsenglish/engine';
import { buildMockPoolStates, buildMockReviewPlan } from './mockPlan';
import { buildReviewFillPayload } from '../../store/learningData';
import { REVIEW_WORDS_PER_BOSS } from './stageContract';
import {
  REVIEW_SESSION_HARD_CAP,
  REVIEW_TIMEBOX_MS,
  createRvSession,
  reduceRv,
  remainingDeferred,
  type RvCard,
  type RvState,
} from './stateMachine';

const TODAY = '2026-10-26'; // 周一（周末 R4 无新词，会破坏 newWords 断言）

function mkCard(id: string, word: string, pool: DailyReviewCard['pool'] = 'P3', dueDate = TODAY): RvCard {
  return {
    entryId: id,
    pool,
    form: 'shooting',
    dueReason: 'due_today',
    dueDate,
    errorStreak: 0,
    word,
    meaning: `义-${id}`,
    blocks: null,
  };
}

/** 逐格拼完当前词（missSlots 指定格先拼错一次制造重试） */
function spell(s: RvState, missSlots: Record<number, string> = {}): RvState {
  let cur = s;
  const word = cur.queue[0]!.word;
  for (let i = 0; i < word.length; i++) {
    if (missSlots[i] !== undefined) {
      cur = reduceRv(cur, { type: 'pickLetter', letter: missSlots[i]! });
    }
    cur = reduceRv(cur, { type: 'pickLetter', letter: word[i]! });
  }
  return cur;
}

describe('队列装配与防呆上限', () => {
  it('默认时间盒＝引擎 REVIEW_SEGMENT_BUDGET_SECONDS=300s（常量语义消费，非 UI 裸值）', () => {
    const s = createRvSession([mkCard('a', 'cat')], { startMs: 1000 });
    expect(REVIEW_SEGMENT_BUDGET_SECONDS).toBe(300);
    expect(REVIEW_TIMEBOX_MS).toBe(300_000);
    expect(s.deadlineMs).toBe(1000 + REVIEW_TIMEBOX_MS);
  });

  it('Boss 出词周期＝每 6 词一次（票 30；常量落契约侧供演出调度）', () => {
    expect(REVIEW_WORDS_PER_BOSS).toBe(6);
  });

  it('一年级 10 张上限防呆：超量队列硬顶截断（消费引擎常量语义）', () => {
    expect(REVIEW_SESSION_HARD_CAP).toBe(DAILY_NEW_WORDS_MAX);
    expect(DAILY_NEW_WORDS_MAX).toBe(10);
    const twelve = Array.from({ length: 12 }, (_, i) => mkCard(`w${i}`, 'cat'));
    const s = createRvSession(twelve, { startMs: 0 });
    expect(s.queue).toHaveLength(10);
  });

  it('空队列直接 done（周末/全顺延防御）', () => {
    const s = createRvSession([], { startMs: 0 });
    expect(s.step).toBe('done');
    expect(s.fill).toBeNull();
    expect(remainingDeferred(s)).toBe(0);
  });

  it('mock 计划经引擎 buildDailyPlan 产出：双形态齐全，新鲜 P0 不入复习', () => {
    const plan = buildMockReviewPlan(TODAY);
    expect(plan.reviewQueue.length).toBeGreaterThan(0);
    expect(plan.reviewQueue.some((c) => c.form === 'plain')).toBe(true);
    expect(plan.reviewQueue.some((c) => c.form === 'shooting')).toBe(true);
    // 新鲜 P0（w_sunday，无作答历史）只进新词段
    expect(plan.reviewQueue.some((c) => c.entryId === 'w_sunday')).toBe(false);
    expect(plan.newWords.map((c) => c.entryId)).toContain('w_sunday');
    // 入队原因来自引擎映射（overdue/relearn/graduated_maintenance 均出现）
    expect(plan.reviewQueue.some((c) => c.dueReason === 'overdue')).toBe(true);
    expect(plan.reviewQueue.some((c) => c.dueReason === 'relearn')).toBe(true);
    expect(plan.reviewQueue.some((c) => c.dueReason === 'graduated_maintenance')).toBe(true);
  });

  it('mock 卡池夹具形态覆盖：P0 重学/P1-P5/毕业池抽样齐全', () => {
    const pools = buildMockPoolStates(TODAY).map((s) => s.pool);
    expect(pools).toContain('P0');
    expect(pools).toContain('P3');
    expect(pools).toContain('graduated');
  });
});

describe('拼写驱动流转（question→performance→弹出）', () => {
  it('首试全对拼完：进 performance、记账 correct=true、等回报弹出', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    expect(s.step).toBe('question');
    expect(s.fill?.slotIndex).toBe(0);
    s = spell(s);
    expect(s.step).toBe('performance');
    expect(s.results).toEqual([{ entryId: 'a', correct: true, combo: 1, score: 30 }]); // cat=3 字母×10×combo1
    expect(s.pendingRequeue).toBe(false);
    s = reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' });
    expect(s.step).toBe('question');
    expect(s.queue[0]?.entryId).toBe('b');
    expect(s.fill?.slotIndex).toBe(0); // 新卡新 fill
    s = spell(s);
    s = reduceRv(s, { type: 'stageComplete', outcome: 'defeat', targetId: 'b' });
    expect(s.step).toBe('done');
  });

  it('选错字母：slotMistakes/totalMistakes 计数、slotIndex 不动（视图洗牌承接）', () => {
    const s0 = createRvSession([mkCard('a', 'cat')], { startMs: 0 });
    const s1 = reduceRv(s0, { type: 'pickLetter', letter: 'x' });
    expect(s1).not.toBe(s0);
    expect(s1.fill?.slotIndex).toBe(0);
    expect(s1.fill?.slotMistakes).toBe(1);
    expect(s1.fill?.totalMistakes).toBe(1);
    expect(s1.step).toBe('question');
  });

  it('大小写不敏感判定（大写字母命中小写目标，同新词段语义）', () => {
    let s = createRvSession([mkCard('a', 'cat')], { startMs: 0 });
    s = reduceRv(s, { type: 'pickLetter', letter: 'C' });
    expect(s.fill?.slotIndex).toBe(1);
    expect(s.fill?.firstTryCorrect[0]).toBe(true);
  });

  it('首试全对口径：中途错一次再拼对 → correct=false（引擎裁决进重学）', () => {
    let s = createRvSession([mkCard('a', 'cat')], { startMs: 0 });
    s = spell(s, { 1: 'x' }); // 第 2 格先拼错
    expect(s.step).toBe('performance');
    expect(s.results).toEqual([{ entryId: 'a', correct: false, combo: 0, score: 0 }]);
    expect(s.pendingRequeue).toBe(true);
  });

  it('游戏内 combo/score：连击累计、错误归零、错误词不得分（纯展示，P-11 决策 3）', () => {
    let s = createRvSession(
      [mkCard('a', 'cat'), mkCard('b', 'dog'), mkCard('c', 'elephant')],
      { startMs: 0 },
    );
    s = spell(s); // cat：combo1、得分 3×10×1=30
    expect(s.combo).toBe(1);
    expect(s.score).toBe(30);
    s = reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' });
    s = spell(s); // dog：combo2、3×10×2=60 → 累计 90
    expect(s.combo).toBe(2);
    expect(s.score).toBe(90);
    s = reduceRv(s, { type: 'stageComplete', outcome: 'defeat', targetId: 'b' });
    s = spell(s, { 0: 'z' }); // elephant 非首试：combo 归零、零得分、总分不变
    expect(s.combo).toBe(0);
    expect(s.results[2]).toEqual({ entryId: 'c', correct: false, combo: 0, score: 0 });
    expect(s.score).toBe(90);
  });

  it('非首试全对重排队尾一次：第二次拼对不再重排（防死循环），done 收口', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    s = spell(s, { 0: 'z' }); // a 非首试
    s = reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' });
    expect(s.queue.map((c) => c.entryId)).toEqual(['b', 'a']); // 重排队尾
    s = spell(s); // b 首试全对
    s = reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'b' });
    expect(s.queue[0]?.entryId).toBe('a');
    s = spell(s); // a 第二次：全对
    expect(s.results.filter((r) => r.entryId === 'a')).toHaveLength(2); // 两次尝试都记账
    s = reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' });
    expect(s.step).toBe('done'); // 第二次不重排
    expect(s.requeuedOnce).toEqual(['a']);
  });

  it('performance 步输入锁定：pickLetter 不被受理（原状态不变）', () => {
    let s = createRvSession([mkCard('a', 'cat')], { startMs: 0 });
    s = spell(s);
    expect(s.step).toBe('performance');
    expect(reduceRv(s, { type: 'pickLetter', letter: 'c' })).toBe(s);
  });

  it('首卡拼完即可 stageComplete 弹出（演出回报与口径无关，fail-open）', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    s = spell(s, { 2: 'q' }); // 非首试 → 仍进 performance（P-10 决策 1：全进战斗）
    // 期望 hit 却报 defeat 也放行（fail-open，防演出回报丢失卡死）
    s = reduceRv(s, { type: 'stageComplete', outcome: 'defeat', targetId: 'a' });
    expect(s.step).toBe('question'); // 弹出进下一卡；a 非首试重排队尾
    expect(s.queue.map((c) => c.entryId)).toEqual(['b', 'a']);
  });
});

describe('时间盒到点即停（mock 时钟注入）', () => {
  it('注入时长生效：durationMs 覆盖引擎默认', () => {
    const s = createRvSession([mkCard('a', 'cat')], { startMs: 0, durationMs: 500 });
    expect(reduceRv(s, { type: 'tick', nowMs: 499 }).step).toBe('question');
    expect(reduceRv(s, { type: 'tick', nowMs: 500 }).step).toBe('timeup');
  });

  it('到点即停：question/performance 两步均可被打断', () => {
    const q = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    expect(reduceRv(q, { type: 'tick', nowMs: q.deadlineMs }).step).toBe('timeup');

    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    s = spell(s); // performance
    expect(reduceRv(s, { type: 'tick', nowMs: s.deadlineMs }).step).toBe('timeup');
  });

  it('timeup 为终态：pickLetter/stageComplete/stageError/tick 均无效', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    s = reduceRv(s, { type: 'tick', nowMs: s.deadlineMs });
    const t = reduceRv(s, { type: 'pickLetter', letter: 'c' });
    expect(t).toBe(s);
    expect(reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' })).toBe(s);
    expect(reduceRv(s, { type: 'stageError', message: 'x' })).toBe(s);
    expect(reduceRv(s, { type: 'tick', nowMs: s.deadlineMs + 1000 })).toBe(s);
  });

  it('到点即停顺延张数（E4）：卡 2 进行中 timeup → 剩 2 张（当前卡计入）', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog'), mkCard('c', 'pig')], { startMs: 0 });
    s = spell(s);
    s = reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' }); // a 完，b 进行中
    s = reduceRv(s, { type: 'tick', nowMs: s.deadlineMs });
    expect(s.step).toBe('timeup');
    expect(remainingDeferred(s)).toBe(2);
  });

  it('时间盒到点后演出回报不再推进（即停优先）', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    s = spell(s);
    s = reduceRv(s, { type: 'tick', nowMs: s.deadlineMs });
    expect(reduceRv(s, { type: 'stageComplete', outcome: 'hit', targetId: 'a' })).toBe(s);
  });
});

describe('演出错误兜底（第三向 stage-error）', () => {
  it('performance 中 stageError：立即推进到下一张并计数（孩子不卡死）', () => {
    let s = createRvSession([mkCard('a', 'cat'), mkCard('b', 'dog')], { startMs: 0 });
    s = spell(s);
    s = reduceRv(s, { type: 'stageError', message: 'WebGL 上下文丢失' });
    expect(s.step).toBe('question');
    expect(s.queue[0]?.entryId).toBe('b');
    expect(s.stageErrors).toBe(1);
  });

  it('question 步 stageError 忽略（只影响演出等待期）', () => {
    const s = createRvSession([mkCard('a', 'cat')], { startMs: 0 });
    const ignored = reduceRv(s, { type: 'stageError', message: 'x' });
    expect(ignored).toBe(s);
    expect(ignored.stageErrors).toBe(0);
  });
});

describe('review_fill 载荷形状（跨端契约钉死，同 buildNewWordFillPayload 先例）', () => {
  it('首试全对：correct=true；question_type=review_fill；snake_case 全形', () => {
    const p = buildReviewFillPayload('w_hello', 12_345.6, { slots: 5, firstTryCorrectSlots: 5 }, TODAY);
    expect(p).toEqual({
      lexical_entry_id: 'w_hello',
      question_type: 'review_fill',
      correct: true,
      reaction_ms: 12_346, // 四舍五入
      answered_on: TODAY,
    });
  });

  it('有重试：correct=false（首试全对严格口径）', () => {
    const p = buildReviewFillPayload('w_hi', 0, { slots: 2, firstTryCorrectSlots: 1 }, TODAY);
    expect(p.correct).toBe(false);
    expect(p.reaction_ms).toBe(0); // 负/零停留钳 0
  });

  it('空词防御：slots=0 → correct=false（视图已剔除空词，兜底不硬真）', () => {
    const p = buildReviewFillPayload('w_a', 5, { slots: 0, firstTryCorrectSlots: 0 }, TODAY);
    expect(p.correct).toBe(false);
  });
});
