/**
 * 七池调度引擎核心类型定义。
 *
 * 状态类型与 spec S7 `card_pool_states` 概念字段一致：
 *   child×lexical_entry 唯一、池位（P0-P5/毕业）、快对连击、错误连击、
 *   到期时间、变式档、暂停标记、毕业池抽查标记。
 * 另带一个可由事件全量重建的派生缓存 recentOutcomes（近 3 次作答结果，
 * 供 R5「近 3 次快对率」选档使用），不新增事实源。
 *
 * 铁律（spec S2）：本包零 I/O、零运行时依赖、不感知 Vue/PixiJS/浏览器 API。
 * 一切「当前时间」都由调用方以 ISO 日期字符串显式传入，引擎内部
 * 不调用 Date.now()/Math.random()，保证同输入必同输出（可重放收敛）。
 */

/** 学习阶段池位：P0 新词池、P1-P5 熟练池、graduated 毕业池。 */
export type PoolId = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'graduated';

/** 熟练池（可升可退档）的池位集合。 */
export const PROFICIENCY_POOLS = ['P1', 'P2', 'P3', 'P4', 'P5'] as const;
export type ProficiencyPool = (typeof PROFICIENCY_POOLS)[number];

/** 变式三档（R5）。`relearn` 不是档位，是答错当日回教学重学的形态标记（E1/R5）。 */
export type VariationTier = 'easy' | 'standard' | 'hard';
export type VariationForm = VariationTier | 'relearn';

/**
 * 题型（R5 池-题型绑定）。
 * teach_* 为 P0 教学三连形态；boss_mix 为关末 boss 段综合题。
 */
export type QuestionType =
  | 'teach_picture_audio' // 看图听音
  | 'teach_trace' // 跟点
  | 'teach_audio_pick_picture' // 听音选图（教学三连第三步）
  | 'audio_pick_picture' // P1 听音选图
  | 'word_pick_meaning' // P2 看词选义
  | 'near_sound_discrimination' // P3 音近对比辨析
  | 'word_family_blend' // P3 词族串烧
  | 'spelling_letter_bank' // P4 拼写（字母集合提示）
  | 'spelling_full_keyboard' // P5 全键盘拼写
  | 'sentence_fill' // P5 句子填空
  | 'boss_mix'; // boss 段综合题

/** ISO 日期字符串（YYYY-MM-DD），本地日历日；引擎不做时区换算。 */
export type IsoDate = string;

/** 近 3 次作答结果（派生缓存，最近一次在数组末尾，最多保留 3 条）。 */
export interface OutcomeRecord {
  correct: boolean;
  /** 是否「快对」：答对且反应时 ≤ 该题型基线（题型分基线，见 baselines.ts）。 */
  fast: boolean;
  /** 作答日（ISO 日期）：供 R5「答错词当日回教学重学」的同日判定。 */
  answeredOn: IsoDate;
}

/**
 * 卡池状态（spec S7 card_pool_states 概念字段）。
 * 单条状态对应一个孩子×一个稳定词 id（lexical_entries.id，R16 进度锚点）。
 */
export interface CardPoolState {
  /** 孩子档案 id（S7 children.id）。 */
  childId: string;
  /** 稳定词 id（S7 lexical_entries.id，跨包版本连续）。 */
  lexicalEntryId: string;
  /** 池位（S7 池位字段）。 */
  pool: PoolId;
  /** 快对连击（S7 快对连击）：在当前池位连续「快对」的轮数，非快对即清零。 */
  fastStreak: number;
  /** 错误连击（S7 错误连击）：连续答错次数，答对即清零；E4 截断优先级第二键。 */
  errorStreak: number;
  /** 到期时间（S7 到期时间），ISO 日期；毕业池词仅在抽样被选中时由调用方设置。 */
  dueDate: IsoDate | null;
  /** 变式档（S7 变式档）：按近 3 次快对率自动选档（R5）。 */
  variationTier: VariationTier;
  /** 暂停标记（S7 暂停标记）：暂停的卡不进到期集合、不参与计划。 */
  paused: boolean;
  /** 毕业池抽查标记（S7）：最近一次被月度抽样选中的月份键（YYYY-MM），未被抽为 null。 */
  graduatedSampledMonth: string | null;
  /** 近 3 次作答结果（派生缓存，可由 learning_events 全量重建）。 */
  recentOutcomes: OutcomeRecord[];
}

/**
 * 答题事件（调度相关切片；learning_events 的 event_id/HLC/设备字段
 * 属折叠器与同步域职责，本票不含折叠器）。
 */
export interface AnswerEvent {
  lexicalEntryId: string;
  questionType: QuestionType;
  /** 正误。 */
  correct: boolean;
  /** 反应时（毫秒），≥ 0。 */
  reactionTimeMs: number;
  /** 作答日（ISO 日期），由调用方传入，引擎不取系统时间。 */
  answeredOn: IsoDate;
}

/** 题型基线表：题型 → 快对判定基线反应时（毫秒），初值可调（R3 题型分基线）。 */
export type BaselineTable = Record<QuestionType, number>;

/**
 * 单步转移结果：applyAnswer 的产出。
 * 含升级后的完整状态（不可变替换）与转移明细（下游折叠器/演出消费）。
 */
export interface TransitionResult {
  /** 转移后的新状态对象（原状态不被修改）。 */
  state: CardPoolState;
  transition: {
    fromPool: PoolId;
    toPool: PoolId;
    kind: 'promote' | 'demote' | 'stay' | 'graduate';
    /** 是否快对（答对且反应时 ≤ 题型基线）。 */
    fast: boolean;
    /** 熟练度分（0-1，正误×反应时×题型基线，见 mastery.ts）。 */
    masteryScore: number;
    /** 转移后到期时间；毕业（进入毕业池且未被抽样）为 null。 */
    nextDueDate: IsoDate | null;
    /** 本次作答进入毕业池（P5 连续 2 轮快对）。 */
    graduated: boolean;
    /** E1 跟进：答错当日追加 1 道变式题，且该题回教学重学形态（R5）。 */
    followUps: {
      appendVariationToday: boolean;
      form: VariationForm;
    };
  };
}

/* ------------------------------------------------------------------ */
/* 每日计划类型（R4/E4）                                                */
/* ------------------------------------------------------------------ */

/** 孩子档案中影响计划的配置（S7 children 概念字段的计划切片）。 */
export interface PlanProfile {
  /** 每日新词数，家长可调 3-10（R4）；越界值按边界收敛。 */
  dailyNewWords: number;
}

/** 计划中的一张卡（含其当前状态快照）。 */
export interface PlannedCard {
  lexicalEntryId: string;
  pool: PoolId;
  /** 该卡当前到期时间（顺延卡早于计划日）。 */
  dueDate: IsoDate | null;
  errorStreak: number;
}

/** 关内段（R4：复习段→教学段→boss 段）。 */
export type SegmentKind = 'review' | 'teach' | 'boss';

export interface PlanSegment {
  kind: SegmentKind;
  cards: PlannedCard[];
}

/** 音近引入约束上下文（R6 接口；混淆词对本票只留接口）。 */
export interface NearSoundContext {
  /** 音近词对（词 id 二元组，无序）。 */
  pairs: Array<[string, string]>;
  /** 词 id → 引入日（ISO 日期）；已引入的词由调用方登记。 */
  introDates: Record<string, IsoDate>;
  /** 最小引入间隔天数，默认 3（R6：学习期音近词引入日隔开 ≥3 天）。 */
  minGapDays?: number;
}

/** 单关计划输入。 */
export interface PlanLevelInput {
  /** 计划日（ISO 日期）。 */
  date: IsoDate;
  profile: PlanProfile;
  /** 该孩子全部卡池状态（引擎自行筛到期/新词）。 */
  poolStates: CardPoolState[];
  /** 前一日整关被跳过时传 true：次日复习上限放宽到 20 张（R4 括注）。 */
  previousDaySkipped?: boolean;
  /** 音近引入约束（R6 接口，可选）。 */
  nearSound?: NearSoundContext;
}

/** 单关计划输出（含关内三段顺序）。 */
export interface LevelPlan {
  date: IsoDate;
  isWeekend: boolean;
  /** 关内段，顺序固定：复习段→教学段→boss 段（R4）。 */
  segments: [PlanSegment, PlanSegment, PlanSegment];
  newCount: number;
  reviewCount: number;
  /** 复习容量（截断前上限）。 */
  reviewCapacity: number;
  /** 本日是否发生了 E4 截断。 */
  truncationApplied: boolean;
  /** E4 未竟卡：到期但今日未被排入的复习卡，顺延次日（调用方原样带回）。 */
  deferred: PlannedCard[];
}
