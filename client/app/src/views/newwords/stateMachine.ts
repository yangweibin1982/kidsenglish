/**
 * 新词段「读→拼」两阶段卡片流状态机（spec v1.2 S9 ＋ P-08 拍板）。
 *
 * 纯函数、零 IO、零框架依赖——时间用动作参数注入（可 mock 时钟测试）。
 * 步骤语义（简单可解释）：
 *   有拆分词：read（大字整词四线三格＋音节横线＋点块听读）→ fill（字母填空拼回）
 *   无拆分词：whole（整词呈现，禁猜拆）→ fill（同样填空——填空对整词同样适用）
 *   fill 填完（slotIndex === word.length）→ next 放行 advanceCard；未填完 next＝no-op
 *   （拼阶段必须完成才放行——这是考核面）；全部卡完成 → boss（段尾收官，boss＝本段
 *   词表）→ finish → done；时间盒（默认 ≤10 分钟）到点 → timeup（到点即停，未完成
 *   卡顺延 E4）。
 *
 * 考核面（v1.2 修订）：＝字母拼写产出（retrieval practice，pickLetter 首试正确率
 * 进段消化指数信号）；音节切分仍不考核（P-06 决策 1 不变——read 步点读不设限、
 * 禁做成切分测验/打分）。
 *
 * 再学一次（P-09）：done 步可 replay——同批卡原地重建会话（isReplay 标志）；
 * 视图层凭 isReplay 屏蔽事件回写（练习效应不进消化信号、不重复驱动 SRS 池位）。
 */

/** 一年级新词段时间盒上限（S9：≤10 分钟，到点即停） */
export const NEW_WORDS_TIMEBOX_MS = 10 * 60 * 1000;

/** 单张新词卡（字段落自词包词条：headword / lexical_entry_id / phonics_split） */
export type SyllableCard = {
  /** 稳定词身份 id（进度锚点，S7 lexical_entries） */
  entryId: string;
  word: string;
  /** 词包拼读拆分字段原值：形如 "mor·ning"，null＝无拆分数据（整词呈现） */
  phonicsSplit: string | null;
};

/** 会话内卡：拆分已预解析（宁缺勿滥，可疑拆分回退整词） */
export type SessionCard = SyllableCard & {
  /** 解析后的音节块；null＝整词呈现分支 */
  blocks: string[] | null;
};

export type NwStep = 'read' | 'whole' | 'fill' | 'boss' | 'done' | 'timeup';

/** 拼阶段（字母填空）进度状态：仅 fill 步非 null */
export type NwFillState = {
  /** 当前待填格下标（0 起）；=== word.length ＝整词填完 */
  readonly slotIndex: number;
  /** 各格是否首试即对（口径：该格填对时 slotMistakes === 0） */
  readonly firstTryCorrect: readonly boolean[];
  /** 当前格已错次数（连错 2 次 → 视图正确项高亮防挫败） */
  readonly slotMistakes: number;
  /** 本卡累计错误次数（信号观测面） */
  readonly totalMistakes: number;
  /** 本卡错选对 [期望, 实选]（小写归一；混淆图谱记录面，票 49） */
  readonly wrongPicks: readonly (readonly [string, string])[];
};

export type NwState = {
  readonly step: NwStep;
  readonly cards: readonly SessionCard[];
  readonly cardIndex: number;
  /** 已点读过的块下标集合（read 步的听读足迹，仅展示不考核） */
  readonly tappedBlocks: readonly boolean[];
  /** 拼阶段状态（read/whole/boss/done/timeup 步为 null） */
  readonly fill: NwFillState | null;
  /** 时间盒起止（绝对毫秒，支持注入 mock 时钟） */
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  /** 再学一次会话（P-09）：true＝重放，视图层凭此屏蔽事件回写 */
  readonly isReplay: boolean;
};

export type NwAction =
  | { type: 'tick'; nowMs: number }
  | { type: 'tapBlock'; index: number }
  | { type: 'pickLetter'; letter: string }
  | { type: 'next' }
  | { type: 'finish' }
  | { type: 'replay'; nowMs: number };

/**
 * 解析 phonics_split 为音节块。防御规则（宁缺勿滥）：
 * null／空 → null（整词）；块拼回 ≠ 词形 → null（可疑数据不硬拆）。
 */
export function syllablesOf(word: string, phonicsSplit: string | null): string[] | null {
  if (phonicsSplit === null) return null;
  const parts = phonicsSplit
    .split('·')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 2) return null; // 单块或空拆分＝没有有效拆分信息
  if (parts.join('').toLowerCase() !== word.toLowerCase()) return null;
  return parts;
}

/** 某张卡的读阶段起始步骤（有拆分→read；无拆分→whole；两分支都进 fill 拼阶段） */
export function firstStepOf(card: SessionCard): NwStep {
  return card.blocks === null ? 'whole' : 'read';
}

/** 新卡的 fill 初始状态（全空格、零错误） */
function freshFillState(card: SessionCard): NwFillState {
  return {
    slotIndex: 0,
    firstTryCorrect: Array.from({ length: card.word.length }, () => false),
    slotMistakes: 0,
    totalMistakes: 0,
    wrongPicks: [],
  };
}

export type CreateSessionOpts = {
  /** 会话起始时刻（注入，可 mock） */
  startMs: number;
  /** 时间盒时长，默认 NEW_WORDS_TIMEBOX_MS */
  durationMs?: number;
};

/**
 * 创建新词段会话。张数上限防呆由调用方完成（UI 消费引擎
 * DAILY_NEW_WORDS_MAX 常量，见 dayPlan.ts）；空计划直接 done。
 */
export function createSession(cards: readonly SyllableCard[], opts: CreateSessionOpts): NwState {
  const sessionCards: SessionCard[] = cards.map((c) => ({
    ...c,
    blocks: syllablesOf(c.word, c.phonicsSplit),
  }));
  const durationMs = opts.durationMs ?? NEW_WORDS_TIMEBOX_MS;
  return {
    step: sessionCards.length === 0 ? 'done' : firstStepOf(sessionCards[0]),
    cards: sessionCards,
    cardIndex: 0,
    tappedBlocks: sessionCards.length > 0 && sessionCards[0].blocks !== null
      ? sessionCards[0].blocks.map(() => false)
      : [],
    fill: null,
    startedAtMs: opts.startMs,
    deadlineMs: opts.startMs + durationMs,
    isReplay: false,
  };
}

/** 推进到下一张卡；无下一张则进 boss 收官（新卡从读阶段重新开始） */
function advanceCard(state: NwState): NwState {
  const nextIndex = state.cardIndex + 1;
  if (nextIndex >= state.cards.length) {
    return { ...state, step: 'boss', fill: null };
  }
  const nextCard = state.cards[nextIndex];
  return {
    ...state,
    cardIndex: nextIndex,
    step: firstStepOf(nextCard),
    tappedBlocks: nextCard.blocks !== null ? nextCard.blocks.map(() => false) : [],
    fill: null,
  };
}

/** 时间盒内未完成的卡数（到点即停后的顺延张数，E4；done＝0） */
export function remainingCards(state: NwState): number {
  if (state.step === 'done') return 0;
  return state.cards.length - state.cardIndex;
}

export function reduce(state: NwState, action: NwAction): NwState {
  switch (action.type) {
    case 'tick': {
      // 终态不再被时间打断
      if (state.step === 'done' || state.step === 'timeup') return state;
      if (action.nowMs >= state.deadlineMs) {
        return { ...state, step: 'timeup' };
      }
      return state;
    }
    case 'tapBlock': {
      // 点块听读仅 read 步（儿童探索不设限）；足迹仅展示不考核
      if (state.step !== 'read') return state;
      const card = state.cards[state.cardIndex];
      if (card.blocks === null) return state;
      if (action.index < 0 || action.index >= card.blocks.length) return state;
      const tappedBlocks = state.tappedBlocks.map((v, i) => (i === action.index ? true : v));
      return { ...state, tappedBlocks };
    }
    case 'pickLetter': {
      // 字母填空仅 fill 步响应；大小写不敏感比对当前格
      if (state.step !== 'fill' || state.fill === null) return state;
      const card = state.cards[state.cardIndex];
      const fill = state.fill;
      if (fill.slotIndex >= card.word.length) return state; // 已填完：后续点选无效
      const expected = card.word[fill.slotIndex].toLowerCase();
      if (action.letter.toLowerCase() === expected) {
        // 填对：本格首试口径＝该格此前零错误；推进到下一格
        const firstTryCorrect = fill.firstTryCorrect.map((v, i) =>
          i === fill.slotIndex ? fill.slotMistakes === 0 : v,
        );
        return {
          ...state,
          fill: {
            ...fill,
            slotIndex: fill.slotIndex + 1,
            firstTryCorrect,
            slotMistakes: 0,
          },
        };
      }
      // 填错：错误计数＋错选对记录（票 49 混淆图谱；选项洗牌由视图层换 rand 重取 slotOptions）
      return {
        ...state,
        fill: {
          ...fill,
          slotMistakes: fill.slotMistakes + 1,
          totalMistakes: fill.totalMistakes + 1,
          wrongPicks: [...fill.wrongPicks, [expected, action.letter.toLowerCase()]],
        },
      };
    }
    case 'next': {
      if (state.step === 'read' || state.step === 'whole') {
        // 读阶段完成 → 进拼阶段（进格即开考）
        return { ...state, step: 'fill', fill: freshFillState(state.cards[state.cardIndex]) };
      }
      if (state.step === 'fill') {
        // 未填完 no-op（拼阶段必须完成才放行——考核面）；填完才 advanceCard
        const card = state.cards[state.cardIndex];
        if (state.fill === null || state.fill.slotIndex < card.word.length) return state;
        return advanceCard(state);
      }
      return state; // boss/done/timeup 对 next 无响应
    }
    case 'finish': {
      if (state.step === 'boss') return { ...state, step: 'done' };
      return state;
    }
    case 'replay': {
      // 再学一次（P-09）：仅完成后可用——同批卡原地重建会话；时长沿用原会话
      // 时间盒（支持 ?box 覆盖链路）；isReplay 供视图层屏蔽事件回写
      if (state.step !== 'done') return state;
      const fresh = createSession(state.cards, {
        startMs: action.nowMs,
        durationMs: Math.max(1, state.deadlineMs - state.startedAtMs),
      });
      return { ...fresh, isReplay: true };
    }
    default: {
      return state;
    }
  }
}

/** 编译期穷尽断言（导出以通过 noUnusedLocals）：NwAction 新增成员而未在 reduce 处理时此处类型报错 */
export type AssertActionsExhaustive = Exclude<NwAction, { type: 'tick' | 'tapBlock' | 'pickLetter' | 'next' | 'finish' | 'replay' }> extends never
  ? true
  : never;
