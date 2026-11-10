/**
 * 新词段「读→拼」两阶段状态机测试（Ticket 28 VALIDATE 1；spec v1.2 S9）。
 * 覆盖：read/whole→fill 两阶段流转、pickLetter 正误与首试口径、fill 未填完
 * next no-op（考核面）、tapBlock 步约束（仅 read）、timeup 打断 fill、
 * phonics_split=null 整词分支（禁猜拆）、时间盒到点即停＋顺延张数。
 */
import { describe, expect, it } from 'vitest';
import { DAILY_NEW_WORDS_MAX } from '@kidsenglish/engine';
import {
  NEW_WORDS_TIMEBOX_MS,
  createSession,
  firstStepOf,
  reduce,
  remainingCards,
  syllablesOf,
  type NwState,
  type SyllableCard,
} from './stateMachine';
import { buildMockDailyPlan, capToDailyMax } from './dayPlan';

const SPLIT_CARD: SyllableCard = { entryId: 'w1', word: 'morning', phonicsSplit: 'mor·ning' };
const NULL_CARD: SyllableCard = { entryId: 'w2', word: 'give', phonicsSplit: null };

/** 依次填入 word 全部字母（按词序恒为正确答案） */
function fillAll(state: NwState, word: string): NwState {
  let s = state;
  for (const ch of word) s = reduce(s, { type: 'pickLetter', letter: ch });
  return s;
}

describe('syllablesOf 解析与宁缺勿滥防御', () => {
  it('按 · 拆出音节块', () => {
    expect(syllablesOf('morning', 'mor·ning')).toEqual(['mor', 'ning']);
    expect(syllablesOf('hamburger', 'ham·bur·ger')).toEqual(['ham', 'bur', 'ger']);
  });

  it('null＝无拆分数据，禁猜拆', () => {
    expect(syllablesOf('give', null)).toBeNull();
  });

  it('单块/空拆分不算有效拆分', () => {
    expect(syllablesOf('cat', 'cat')).toBeNull();
    expect(syllablesOf('cat', '·')).toBeNull();
  });

  it('块拼回 ≠ 词形时回退整词（可疑数据不硬拆）', () => {
    expect(syllablesOf('morning', 'mo·rningx')).toBeNull();
  });
});

describe('两阶段卡片流（有拆分词）：read→fill→boss 每步可达', () => {
  it('起始步＝read（有拆分）；firstStepOf 语义', () => {
    const s = createSession([SPLIT_CARD], { startMs: 0 });
    expect(s.step).toBe('read');
    expect(firstStepOf(s.cards[0])).toBe('read');
    expect(s.cardIndex).toBe(0);
    expect(s.cards[0].blocks).toEqual(['mor', 'ning']);
    expect(s.fill).toBeNull(); // 读阶段无拼格状态
  });

  it('next：read→fill（born 全空格），填完后 next→boss→finish→done', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('fill');
    expect(s.fill).toEqual({
      slotIndex: 0,
      firstTryCorrect: [false, false, false, false, false, false, false],
      slotMistakes: 0,
      totalMistakes: 0,
      wrongPicks: [],
    });
    s = fillAll(s, 'morning');
    expect(s.fill?.slotIndex).toBe(7); // 填完
    s = reduce(s, { type: 'next' }); // 唯一卡完成 → boss
    expect(s.step).toBe('boss');
    s = reduce(s, { type: 'finish' });
    expect(s.step).toBe('done');
  });

  it('pickLetter 填对推进：逐格前进＋首试口径 firstTryCorrect', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'pickLetter', letter: 'm' });
    expect(s.fill?.slotIndex).toBe(1);
    expect(s.fill?.firstTryCorrect[0]).toBe(true);
    expect(s.fill?.slotMistakes).toBe(0);
    s = reduce(s, { type: 'pickLetter', letter: 'o' });
    s = reduce(s, { type: 'pickLetter', letter: 'r' });
    expect(s.fill?.slotIndex).toBe(3);
    expect(s.fill?.firstTryCorrect.slice(0, 3)).toEqual([true, true, true]);
  });

  it('pickLetter 大小写不敏感比对（儿童输入无大小写门槛）', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'pickLetter', letter: 'M' });
    expect(s.fill?.slotIndex).toBe(1);
    s = reduce(s, { type: 'pickLetter', letter: 'O' });
    expect(s.fill?.slotIndex).toBe(2);
  });

  it('pickLetter 填错：slotMistakes/totalMistakes 递增＋首试口径变 false', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'pickLetter', letter: 'x' }); // 连错 2 次 → 高亮阈值
    s = reduce(s, { type: 'pickLetter', letter: 'y' });
    expect(s.fill?.slotIndex).toBe(0);
    expect(s.fill?.slotMistakes).toBe(2);
    expect(s.fill?.totalMistakes).toBe(2);
    s = reduce(s, { type: 'pickLetter', letter: 'm' }); // 第三次才对＝非首试
    expect(s.fill?.slotIndex).toBe(1);
    expect(s.fill?.firstTryCorrect[0]).toBe(false);
    expect(s.fill?.slotMistakes).toBe(0); // 换格错误计数复位
    expect(s.fill?.totalMistakes).toBe(2); // 全卡累计保留
  });

  it('fill 未填完 next＝no-op（拼阶段必须完成才放行——考核面）', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'pickLetter', letter: 'm' });
    const stuck = reduce(s, { type: 'next' });
    expect(stuck.step).toBe('fill');
    expect(stuck.cardIndex).toBe(0);
    expect(stuck.fill?.slotIndex).toBe(1); // 状态原封不动
  });

  it('fill 填完后 pickLetter 无效（已填完格不接受后续点选）', () => {
    let s = createSession([{ entryId: 'w3', word: 'hi', phonicsSplit: null }], { startMs: 0 });
    s = reduce(s, { type: 'next' }); // whole→fill（hi 无拆分）
    s = fillAll(s, 'hi');
    expect(s.fill?.slotIndex).toBe(2);
    const after = reduce(s, { type: 'pickLetter', letter: 'z' });
    expect(after).toBe(s); // 引用不变＝完全 no-op
  });
});

describe('整词分支（phonics_split=null）：whole→fill（填空对整词同样适用）', () => {
  it('起始步＝whole，blocks 为 null', () => {
    const s = createSession([NULL_CARD], { startMs: 0 });
    expect(s.step).toBe('whole');
    expect(s.cards[0].blocks).toBeNull();
  });

  it('whole → next 进 fill（不再直达 boss）；填完 next 才 advance', () => {
    let s = createSession([NULL_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('fill');
    expect(s.fill?.firstTryCorrect).toEqual([false, false, false, false]); // give 4 格
    s = fillAll(s, 'give');
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('boss');
  });

  it('混合队列：null 词与拆分词各自走各自读分支、都进 fill', () => {
    let s = createSession([NULL_CARD, SPLIT_CARD], { startMs: 0 });
    expect(s.step).toBe('whole');
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('fill');
    s = fillAll(s, 'give');
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('read'); // 卡 2 有拆分 → read
    expect(s.cardIndex).toBe(1);
  });

  it('whole 步上 tapBlock 无效（无块可点）', () => {
    const s = reduce(createSession([NULL_CARD], { startMs: 0 }), { type: 'tapBlock', index: 0 });
    expect(s.tappedBlocks).toEqual([]);
  });
});

describe('点读足迹：read 步可点块（儿童探索不设限，切分不考核）', () => {
  it('tapBlock 记录听读足迹（仅 read 步）', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'tapBlock', index: 0 });
    expect(s.tappedBlocks).toEqual([true, false]);
  });

  it('tapBlock 仅 read 步：fill 步点块无效（票 28 步约束）', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' }); // → fill
    const after = reduce(s, { type: 'tapBlock', index: 0 });
    expect(after).toBe(s); // 引用不变＝no-op
  });

  it('零点读直接 next 不被拦（禁做成切分测验）', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('fill');
  });

  it('越界下标忽略', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'tapBlock', index: 99 });
    expect(s.tappedBlocks).toEqual([false, false]);
  });

  it('非 fill 步 pickLetter 无效（whole/boss 均不响应）', () => {
    // whole 步：无拼格状态
    const whole = createSession([NULL_CARD], { startMs: 0 });
    expect(reduce(whole, { type: 'pickLetter', letter: 'g' })).toBe(whole);
    // boss 步：走完整单卡两阶段后收官
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = fillAll(s, 'morning');
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('boss');
    expect(reduce(s, { type: 'pickLetter', letter: 'm' })).toBe(s);
  });
});

describe('多卡推进：卡间状态复位', () => {
  it('填完 advanceCard：下一张回到读阶段且 fill/足迹复位', () => {
    let s = createSession([SPLIT_CARD, { entryId: 'w4', word: 'panda', phonicsSplit: 'pan·da' }], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'tapBlock', index: 0 });
    s = fillAll(s, 'morning');
    s = reduce(s, { type: 'next' }); // → 卡 2 read
    expect(s.step).toBe('read');
    expect(s.cardIndex).toBe(1);
    expect(s.fill).toBeNull();
    expect(s.tappedBlocks).toEqual([false, false]);
    // 卡 2 独立走完整两阶段
    s = reduce(s, { type: 'next' });
    s = fillAll(s, 'panda');
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('boss');
  });
});

describe('时间盒到点即停（mock 时钟注入）', () => {
  it('默认时间盒＝10 分钟', () => {
    const s = createSession([SPLIT_CARD], { startMs: 1000 });
    expect(NEW_WORDS_TIMEBOX_MS).toBe(10 * 60 * 1000);
    expect(s.deadlineMs).toBe(1000 + NEW_WORDS_TIMEBOX_MS);
  });

  it('截止前 tick 不打断', () => {
    const s0 = createSession([SPLIT_CARD], { startMs: 0 });
    const s = reduce(s0, { type: 'tick', nowMs: s0.deadlineMs - 1 });
    expect(s.step).toBe('read');
  });

  it('到点 tick 即停（读阶段与 boss 步）', () => {
    const s0 = createSession([SPLIT_CARD], { startMs: 0 });
    expect(reduce(s0, { type: 'tick', nowMs: s0.deadlineMs }).step).toBe('timeup');
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = fillAll(s, 'morning');
    s = reduce(s, { type: 'next' });
    expect(s.step).toBe('boss');
    expect(reduce(s, { type: 'tick', nowMs: s.deadlineMs }).step).toBe('timeup');
  });

  it('timeup 打断 fill（票 28：拼到一半到点即停，进度冻结）', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'pickLetter', letter: 'm' });
    s = reduce(s, { type: 'tick', nowMs: s.deadlineMs });
    expect(s.step).toBe('timeup');
    expect(s.fill?.slotIndex).toBe(1); // fill 快照保留（不做清空表演）
  });

  it('注入时长（durationMs）生效：499ms 不到、500ms 到点', () => {
    const s0 = createSession([SPLIT_CARD], { startMs: 0, durationMs: 500 });
    expect(reduce(s0, { type: 'tick', nowMs: 499 }).step).toBe('read');
    expect(reduce(s0, { type: 'tick', nowMs: 500 }).step).toBe('timeup');
  });

  it('timeup 为终态：next/tapBlock/pickLetter/finish/tick 均不再改变', () => {
    let s = createSession([SPLIT_CARD, SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'tick', nowMs: s.deadlineMs });
    expect(s.step).toBe('timeup');
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'tapBlock', index: 0 });
    s = reduce(s, { type: 'pickLetter', letter: 'm' });
    s = reduce(s, { type: 'finish' });
    s = reduce(s, { type: 'tick', nowMs: s.deadlineMs + 1000 });
    expect(s.step).toBe('timeup');
    expect(s.cardIndex).toBe(0);
  });

  it('到点即停顺延张数＝未完成卡数（E4）', () => {
    let s = createSession([SPLIT_CARD, SPLIT_CARD, SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = fillAll(s, 'morning');
    s = reduce(s, { type: 'next' }); // 卡 2 进行中（read）
    s = reduce(s, { type: 'tick', nowMs: s.deadlineMs });
    expect(remainingCards(s)).toBe(2); // 卡 2 未完成＋卡 3
  });

  it('done 后顺延为 0', () => {
    let s = createSession([SPLIT_CARD], { startMs: 0 });
    s = reduce(s, { type: 'next' });
    s = fillAll(s, 'morning');
    s = reduce(s, { type: 'next' });
    s = reduce(s, { type: 'finish' });
    expect(remainingCards(s)).toBe(0);
  });
});

describe('空计划与 mock 数据面', () => {
  it('空计划直接 done（周末无新词语义防御）', () => {
    const s = createSession([], { startMs: 0 });
    expect(s.step).toBe('done');
  });

  it('一年级防呆上限：队列硬顶 DAILY_NEW_WORDS_MAX=10（UI 消费引擎常量）', () => {
    const twelve: SyllableCard[] = Array.from({ length: 12 }, (_, i) => ({
      entryId: `w${i}`,
      word: `word${i}`,
      phonicsSplit: null,
    }));
    expect(DAILY_NEW_WORDS_MAX).toBe(10);
    expect(capToDailyMax(twelve)).toHaveLength(DAILY_NEW_WORDS_MAX);
    expect(capToDailyMax([SPLIT_CARD])).toHaveLength(1); // 不足上限不补齐
  });

  it('mock 计划在上限内且覆盖两种分支（拆分词＋整词）', () => {
    const plan = buildMockDailyPlan('2026-11-01');
    expect(plan.newWords.length).toBeLessThanOrEqual(DAILY_NEW_WORDS_MAX);
    expect(plan.newWords.some((c) => c.phonicsSplit !== null)).toBe(true);
    expect(plan.newWords.some((c) => c.phonicsSplit === null)).toBe(true);
    expect(plan.date).toBe('2026-11-01');
  });
});

describe('票 28 P-09：再学一次（replay 动作）', () => {
  const CARDS: SyllableCard[] = [SPLIT_CARD, NULL_CARD];

  /** 驱动到 done：每卡 读→拼（fillAll）→放行，末卡后 boss→finish */
  function driveToDone(startMs: number, durationMs: number): NwState {
    let s = createSession(CARDS, { startMs, durationMs });
    for (const card of CARDS) {
      s = reduce(s, { type: 'next' });
      s = fillAll(s, card.word);
      s = reduce(s, { type: 'next' });
    }
    return reduce(s, { type: 'finish' });
  }

  it('仅 done 步响应：read 步 replay no-op（同引用）', () => {
    const s = createSession(CARDS, { startMs: 1000 });
    expect(reduce(s, { type: 'replay', nowMs: 2000 })).toBe(s);
  });

  it('done → replay：回首卡＋fresh fill＋isReplay=true＋时间盒按原时长重启', () => {
    const done = driveToDone(1000, 600_000);
    expect(done.step).toBe('done');
    const replayed = reduce(done, { type: 'replay', nowMs: 500_000 });
    expect(replayed.isReplay).toBe(true);
    expect(replayed.cardIndex).toBe(0);
    expect(replayed.step).toBe(firstStepOf(replayed.cards[0]));
    expect(replayed.fill).toBeNull();
    expect(replayed.startedAtMs).toBe(500_000);
    expect(replayed.deadlineMs).toBe(500_000 + 600_000); // 原时长（?box 覆盖链路保持）
    expect(replayed.tappedBlocks).toEqual(replayed.cards[0].blocks!.map(() => false));
  });

  it('replay 会话正常走完整段：填空推进＋再次到达 done（可反复再学）', () => {
    let s = reduce(driveToDone(1000, 600_000), { type: 'replay', nowMs: 500_000 });
    for (const card of CARDS) {
      s = reduce(s, { type: 'next' });
      s = fillAll(s, card.word);
      s = reduce(s, { type: 'next' });
    }
    s = reduce(s, { type: 'finish' });
    expect(s.step).toBe('done');
    expect(s.isReplay).toBe(true); // 重放标志贯穿到收尾
  });

  it('replay 后新时间盒生效：超新 deadline 仍会 timeup（终态不再被时间打断仅限 done/timeup）', () => {
    const replayed = reduce(driveToDone(1000, 60_000), { type: 'replay', nowMs: 500_000 });
    expect(reduce(replayed, { type: 'tick', nowMs: 500_000 + 60_000 }).step).toBe('timeup');
  });
});
