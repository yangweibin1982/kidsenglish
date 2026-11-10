/**
 * 性质测试（spec 测试决策）：
 * 1. 任意事件序列重放收敛——种子伪随机生成事件流，逐步重放：
 *    同序列重复重放终态全等；分段增量重放与整段重放终态全等；
 *    多词交错流按词路由重放与分词独立重放终态全等。
 * 2. 毕业条件不变式——任意序列中每次毕业，其前一步必为「P5 内快对留池」
 *    （连击从 0 起算、累计 2 轮才毕业），且毕业是进入毕业池的唯一路径。
 * 3. 状态不变式——池位合法、非毕业池必有到期日且不早于作答日、
 *    连击/错误计数/近3次缓存/变式档取值域恒成立。
 */
import { describe, expect, it } from 'vitest';

import { applyAnswer, createNewCardState } from '../src/index.js';
import type { AnswerEvent, CardPoolState, QuestionType, TransitionResult } from '../src/index.js';
import { QUESTION_TYPES, mulberry32 } from './helpers.js';

const ALL_POOLS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated'] as const;
const TIERS = ['easy', 'standard', 'hard'] as const;
const START_DATE = '2026-01-05';

function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface GenProfile {
  pCorrect: number;
  rtMin: number;
  rtMax: number;
  steps: number;
}

/** 生成单词条事件序列（确定性）。 */
function genEvents(seed: number, wordId: string, profile: GenProfile): AnswerEvent[] {
  const rnd = mulberry32(seed);
  const events: AnswerEvent[] = [];
  let day = 0;
  for (let i = 0; i < profile.steps; i++) {
    day += Math.floor(rnd() * 3); // 0-2 天推进（含同日追加练）
    const correct = rnd() < profile.pCorrect;
    const reactionTimeMs = Math.round(profile.rtMin + rnd() * (profile.rtMax - profile.rtMin));
    events.push({
      lexicalEntryId: wordId,
      questionType: QUESTION_TYPES[Math.floor(rnd() * QUESTION_TYPES.length)] as QuestionType,
      correct,
      reactionTimeMs,
      answeredOn: plusDays(START_DATE, day),
    });
  }
  return events;
}

function replay(wordId: string, events: AnswerEvent[]): {
  state: CardPoolState;
  steps: TransitionResult[];
} {
  let state = createNewCardState('child-1', wordId, events[0]?.answeredOn ?? START_DATE);
  const steps: TransitionResult[] = [];
  for (const event of events) {
    const result = applyAnswer(state, event);
    state = result.state;
    steps.push(result);
  }
  return { state, steps };
}

/** 状态不变式逐条核查。 */
function assertStateInvariants(state: CardPoolState, steps: TransitionResult[]): void {
  expect(ALL_POOLS).toContain(state.pool);
  expect(TIERS).toContain(state.variationTier);
  expect(state.errorStreak).toBeGreaterThanOrEqual(0);
  expect(state.fastStreak).toBeGreaterThanOrEqual(0);
  if (state.pool !== 'graduated') {
    // 非毕业池必有到期日（不早于最近作答日的检查在调用方带事件日期进行）
    expect(state.dueDate).not.toBeNull();
    expect(state.fastStreak).toBeLessThanOrEqual(1); // 连击到 2 立即毕业，非毕业池 ≤1
  } else {
    expect(state.dueDate).toBeNull();
  }
  expect(state.recentOutcomes.length).toBeLessThanOrEqual(3);
}

function assertSequenceInvariants(wordId: string, events: AnswerEvent[]): number {
  const { state, steps } = replay(wordId, events);
  let graduations = 0;
  let dayCursor = '';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const event = events[i]!;
    const { transition } = step;
    dayCursor = event.answeredOn;
    // 池位转移合法
    expect(ALL_POOLS).toContain(transition.toPool);
    // 到期日不早于作答日（毕业池除外）
    if (transition.nextDueDate !== null) {
      expect(transition.nextDueDate >= event.answeredOn).toBe(true);
    }
    // 毕业是进入毕业池的唯一路径（毕业池留池维护不算进入）
    if (transition.toPool === 'graduated' && transition.fromPool !== 'graduated') {
      expect(transition.graduated).toBe(true);
      expect(transition.kind).toBe('graduate');
      graduations++;
      // 毕业不变式：前一步必为 P5 内快对留池（本轮连击到 2）
      const prev = steps[i - 1]!;
      expect(prev.transition.fromPool).toBe('P5');
      expect(prev.transition.toPool).toBe('P5');
      expect(prev.transition.fast).toBe(true);
      expect(prev.transition.graduated).toBe(false);
    }
    // 非毕业池的每一步状态
    if (step.state.pool !== 'graduated') {
      const due = step.state.dueDate;
      expect(due).not.toBeNull();
      if (due !== null) {
        expect(due >= dayCursor).toBe(true);
      }
    }
  }
  assertStateInvariants(state, steps);
  return graduations;
}

describe('性质：任意事件序列重放收敛', () => {
  const mixed: GenProfile = { pCorrect: 0.7, rtMin: 300, rtMax: 20000, steps: 40 };
  const ace: GenProfile = { pCorrect: 0.95, rtMin: 200, rtMax: 4000, steps: 60 };

  it('同序列重复重放终态全等（确定性）', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const events = genEvents(seed, 'w-prop', mixed);
      const first = replay('w-prop', events).state;
      const second = replay('w-prop', events).state;
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });

  it('分段增量重放 ≡ 整段重放（无隐藏状态）', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const events = genEvents(seed, 'w-prop', mixed);
      const full = replay('w-prop', events).state;
      const cut = Math.floor(events.length / 2);
      let partial = replay('w-prop', events.slice(0, cut)).state;
      for (const event of events.slice(cut)) {
        partial = applyAnswer(partial, event).state;
      }
      expect(JSON.stringify(partial)).toBe(JSON.stringify(full));
    }
  });

  it('多词交错流按词路由重放 ≡ 分词独立重放（词间无串扰）', () => {
    const rnd = mulberry32(999);
    const words = ['w-a', 'w-b', 'w-c'];
    const interleaved: AnswerEvent[] = [];
    for (let i = 0; i < 90; i++) {
      const word = words[i % 3]!;
      interleaved.push({
        lexicalEntryId: word,
        questionType: QUESTION_TYPES[Math.floor(rnd() * QUESTION_TYPES.length)] as QuestionType,
        correct: rnd() < 0.7,
        reactionTimeMs: Math.round(300 + rnd() * 19700),
        answeredOn: plusDays(START_DATE, Math.floor(rnd() * 60)),
      });
    }
    // 全局按作答日排序后路由（HLC 全序的消费侧替身）；分词子列天然保序
    interleaved.sort((a, b) => (a.answeredOn < b.answeredOn ? -1 : a.answeredOn > b.answeredOn ? 1 : 0));
    const routed = new Map<string, CardPoolState>();
    for (const word of words) routed.set(word, createNewCardState('child-1', word, START_DATE));
    for (const event of interleaved) {
      const current = routed.get(event.lexicalEntryId);
      expect(current).toBeDefined();
      routed.set(event.lexicalEntryId, applyAnswer(current as CardPoolState, event).state);
    }
    for (const word of words) {
      const independent = replay(word, interleaved.filter((e) => e.lexicalEntryId === word)).state;
      expect(JSON.stringify(routed.get(word))).toBe(JSON.stringify(independent));
    }
  });
});

describe('性质：毕业条件不变式（任意序列中毕业必经 P5 连续 2 轮快对）', () => {
  const profiles: Array<[string, GenProfile]> = [
    ['mixed', { pCorrect: 0.7, rtMin: 300, rtMax: 20000, steps: 40 }],
    ['ace', { pCorrect: 0.95, rtMin: 200, rtMax: 4000, steps: 60 }],
  ];

  it('120 条种子序列全部满足毕业不变式，且批次中确有毕业发生（非空泛断言）', () => {
    let totalGraduations = 0;
    for (const [name, profile] of profiles) {
      for (let seed = 1; seed <= 60; seed++) {
        totalGraduations += assertSequenceInvariants(`w-${name}-${seed}`, genEvents(seed, `w-${name}-${seed}`, profile));
      }
    }
    expect(totalGraduations).toBeGreaterThan(0);
  });

  it('状态不变式全序列成立（混合档）', () => {
    for (let seed = 1; seed <= 40; seed++) {
      assertSequenceInvariants(`w-inv-${seed}`, genEvents(seed, `w-inv-${seed}`, { pCorrect: 0.6, rtMin: 300, rtMax: 22000, steps: 35 }));
    }
  });
});
