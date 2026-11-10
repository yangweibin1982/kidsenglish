<script setup lang="ts">
/**
 * 新词段视图（spec v1.2 S9「读→拼」两阶段；票 28 重设计）。
 *
 * 读阶段：四线三格大字整词（音节 span 按块色加底边横线）＋Q 版箭头指向下方
 * 音节块行（分色可点读）；进卡自动播进卡链（逐音节拼读→整词→例句朗读——票 51
 * 用户裁定反转票 10 拒绝线），点块播块链（逐字母→块音），「听整词」重播整词链、
 * 「读例句」重播例句。读/整/拼三步带词义呈现（词性中文徽章＋释义＋音标＋双语
 * 例句——票 51：bindLexicon 按 entryId 回查，状态机零触碰）。
 * 无拆分词整词呈现（禁猜拆）。
 * 拼阶段：四线格空格槽（一格一字母）＋选项点选——进格自动读整词发音；选对
 * 填充＋随机英语表扬语；选错选项洗牌重来；连错 2 次正确项轻微高亮防挫败；
 * 填完→表扬＋整词朗读→朗读结束后短暂停留自动下一张（unmount 清 timer）。
 *
 * 数据面（票 14 换装）：learningData 快照（fold 状态＋内置词包 → 引擎日计划 →
 * 新词队列装配）替代退役 mock；?mock=1 开发模式走 dayPlan.buildMockDailyPlan。
 * 作答回写：填空完成 → answer 事件（question_type=new_words_fill，correct＝
 * 首试全对严格口径，reaction_ms＝整卡停留）；段结束 → daily_completed＋触发同步。
 * 再学一次（P-09）：完成页同批卡重放（stateMachine replay 动作），isReplay 屏蔽
 * 全部回写（练习效应不进消化信号、不重复驱动 SRS）。
 * 时间盒：≤10 分钟到点即停＋顺延展示（查询参数 ?box=10s 可覆盖演示）。
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { DAILY_NEW_WORDS_MAX } from '@kidsenglish/engine';
import {
  createSession,
  reduce,
  remainingCards,
  NEW_WORDS_TIMEBOX_MS,
  type NwState,
} from './stateMachine';
import { slotOptions, spellChain, wordChain } from './fill';
import { posLabel } from './meaning';
import { pickPraise } from './praise';
import { buildMockDailyPlan } from './dayPlan';
import { learningData } from '../../store/learningData';
import type { PackWord } from '../../store/packs';
import { isMockMode, resolveSegmentTimeboxMs } from '../../store/profile';
import { getSpeaker, type TtsStatus } from './tts';

/** 填完后的收尾停留（整词朗读【结束后】再停此时长进下一张；随朗读解析推进，不截断听感） */
const FILL_DONE_PAUSE_MS = 800;

const props = defineProps<{
  /** 时间盒覆盖（毫秒）——演示/测试注入用，缺省 10 分钟 */
  durationMs?: number;
}>();

const loading = ref(true);
const fatal = ref<string | null>(null);

/** 查询参数演示钩子：?box=10s ／ ?box=1500（毫秒）覆盖时间盒时长 */
function parseBoxOverride(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('box') ?? new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('box');
  if (!raw) return props.durationMs;
  const m = raw.match(/^(\d+)(s|ms)?$/);
  if (!m) return props.durationMs;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

// ?box（毫秒演示钩子）> 孩子每段时长目标（票 50）> 既有常量
const durationMs = parseBoxOverride() ?? resolveSegmentTimeboxMs() ?? NEW_WORDS_TIMEBOX_MS;
const nowFn = (): number => Date.now();

/** 会话状态（异步装载后替换；空会话占位防早渲染） */
const state = shallowRef<NwState>(createSession([], { startMs: 0, durationMs: 1 }));
/** 当前卡展示起点（填空完成的 reaction_ms 取整卡真实停留毫秒） */
let cardShownAtMs = 0;
const nowMs = ref(nowFn());

const speaker = getSpeaker();
const ttsStatus = ref<TtsStatus | null>(null);

const currentCard = computed(() => state.value.cards[state.value.cardIndex]);
const totalCards = computed(() => state.value.cards.length);
const cardNo = computed(() => Math.min(state.value.cardIndex + 1, totalCards.value));
const remainingMs = computed(() => Math.max(0, state.value.deadlineMs - nowMs.value));
const mmss = computed(() => {
  const s = Math.ceil(remainingMs.value / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
const doneCount = computed(() => state.value.cardIndex);
const deferredCount = computed(() => remainingCards(state.value));
const usedSeconds = computed(() =>
  Math.round((Math.min(nowMs.value, state.value.deadlineMs) - state.value.startedAtMs) / 1000),
);

const fillState = computed(() => state.value.fill);

const stepHint = computed(() => {
  switch (state.value.step) {
    case 'read':
      return '听听这个词，点下面的块听发音';
    case 'whole':
      return '点一点，听这个词';
    default:
      return '';
  }
});

const fillHint = computed(() => {
  const card = currentCard.value;
  const fill = state.value.fill;
  if (!card || !fill) return '';
  if (fill.slotIndex >= card.word.length) return '拼好啦，听一听整词';
  return `拼出这个词：第 ${fill.slotIndex + 1} / ${card.word.length} 个字母`;
});

const canAdvance = computed(() =>
  state.value.step === 'read' || state.value.step === 'whole' || state.value.step === 'fill',
);

/** 读阶段（read/whole）的下一步按钮：去拼词（fill 无手动按钮——填完自动进） */
const nextLabel = '去拼词';

/**
 * 票 51 词义呈现（读/拼三步共用数据面）：按 entryId 回查绑定包词条
 * （boundLexicon 与教学队列同源——并集去重可能取到旧版线词条，不用）。
 * 状态机零触碰：显示字段不进 SessionCard，纯视图层投影。
 */
const cardDetail = computed<PackWord | null>(() => {
  const entry = currentCard.value?.entryId;
  if (!entry) return null;
  const lex = learningData.boundLexicon;
  return lex.byId.get(entry) ?? null;
});
const detailPos = computed(() => posLabel(cardDetail.value?.senses[0]?.pos ?? null));
const detailGloss = computed(() => cardDetail.value?.senses[0]?.gloss ?? '');
const detailPhonetic = computed(() => cardDetail.value?.phoneticUk ?? null);
const detailExample = computed(() => cardDetail.value?.examples[0] ?? null);

/** 读例句（常驻按钮；无例句词不渲染——宁缺勿滥）。 */
function speakExample(): void {
  const ex = detailExample.value;
  if (ex) void speaker.speak(ex.en);
}

/** 当前格选项（依赖 slotMistakes：选错洗牌＝换 rand 重取 slotOptions） */
const fillOptions = computed(() => {
  const card = currentCard.value;
  const fill = state.value.fill;
  if (!card || !fill || fill.slotIndex >= card.word.length) return [];
  void fill.slotMistakes; // 显式依赖：错误数变化即重算（重洗）
  return slotOptions(card.word, fill.slotIndex);
});

/** 连错 ≥2 次：正确项轻微高亮防挫败（票 28） */
const hintCorrect = computed(() => (state.value.fill?.slotMistakes ?? 0) >= 2);

const targetLetter = computed(() => {
  const card = currentCard.value;
  const fill = state.value.fill;
  if (!card || !fill) return '';
  return card.word[fill.slotIndex] ?? '';
});

/** 拼格字号（px）：按词长收缩，保 375px 视口不破版（每格≈1.25 字号宽含间隙） */
const fillFontPx = computed(() => {
  const len = Math.max(1, currentCard.value?.word.length ?? 1);
  const fit = Math.floor(300 / (len * 1.25));
  return Math.max(20, Math.min(36, fit));
});

let timer: ReturnType<typeof setInterval> | undefined;
let fillNextTimer: ReturnType<typeof setTimeout> | undefined;
let segmentClosed = false;

/** 装载当日计划（真数据路径；mock 开关走退役夹具）并创建会话 */
async function loadSession(): Promise<void> {
  try {
    await learningData.ensureReady();
    const snap = learningData.snapshot.value;
    const cards = isMockMode()
      ? buildMockDailyPlan(new Date().toISOString().slice(0, 10)).newWords
      : (snap?.newWordsPlan.newWords ?? []);
    state.value = createSession(cards, { startMs: nowFn(), durationMs });
    cardShownAtMs = nowFn();
    loading.value = false;
    if (state.value.step === 'read' || state.value.step === 'whole') playEntryChain(); // 首卡自动播进卡链（整词→例句，票 51）
  } catch (err) {
    fatal.value = err instanceof Error ? err.message : String(err);
    loading.value = false;
  }
}

/** 段结束回写（一次）：daily_completed＋触发同步（S1 学习单元结束） */
function closeSegment(completedOnTime: boolean): void {
  if (segmentClosed) return;
  segmentClosed = true;
  void learningData.finishSegment('new_words', completedOnTime, usedSeconds.value);
}

onMounted(() => {
  timer = setInterval(() => {
    nowMs.value = nowFn();
    const before = state.value;
    const after = reduce(before, { type: 'tick', nowMs: nowMs.value });
    if (after !== before) {
      state.value = after;
      if (after.step === 'timeup') closeSegment(false); // 时间盒到点即停（E4 顺延）
    }
  }, 250);
  void refreshTtsStatus();
  void loadSession();
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (fillNextTimer) clearTimeout(fillNextTimer);
  speaker.stop();
});

async function refreshTtsStatus(): Promise<void> {
  ttsStatus.value = await speaker.status();
}

/** 整词朗读链（票 28 用户补正）：逐音节拼读→整词发音；无拆分＝逐字母→整词。「听整词」按钮同链。 */
function playWholeChain(): void {
  const card = currentCard.value;
  if (card) void speaker.speakSeq(wordChain(card.blocks, card.word));
}

/**
 * 进卡自动链（票 51 裁定 1：整词链→例句完整朗读——票 10「不读整句英文解释」
 * 拒绝线经用户裁定反转，本票文书留痕）。无例句词＝纯整词链（兜底）。
 */
function playEntryChain(): void {
  const card = currentCard.value;
  if (!card) return;
  const ex = detailExample.value;
  void speaker.speakSeq(ex ? [...wordChain(card.blocks, card.word), ex.en] : wordChain(card.blocks, card.word));
}

/** 块朗读链：块内逐字母→块音（点块播） */
function onTapBlock(index: number): void {
  state.value = reduce(state.value, { type: 'tapBlock', index });
  const block = currentCard.value?.blocks?.[index];
  if (block) void speaker.speakSeq(spellChain(block));
}

function speakText(text: string): void {
  void speaker.speak(text);
}

/** 统一 next 推进：换卡时刷新整卡停留计时起点 */
function advanceViaNext(): void {
  const beforeCard = state.value.cardIndex;
  state.value = reduce(state.value, { type: 'next' });
  if (state.value.cardIndex !== beforeCard) cardShownAtMs = nowFn();
}

function onNext(): void {
  advanceViaNext(); // read/whole → fill；fill 未填完 no-op（状态机考核面）
}

/** 拼阶段点选字母：状态机记对错；视图负责表扬语/填完自动进（儿童反馈面） */
function onPickLetter(letter: string): void {
  const before = state.value;
  const after = reduce(before, { type: 'pickLetter', letter });
  state.value = after;
  const card = after.cards[after.cardIndex];
  const fill = after.fill;
  if (!card || !fill || fill === before.fill) return;
  const progressed = fill.slotIndex > (before.fill?.slotIndex ?? 0);
  if (!progressed) return; // 选错：状态机已记错误；视图靠 slotMistakes 洗牌/高亮
  if (fill.slotIndex >= card.word.length) {
    // 填完：表扬→整词朗读→朗读结束后短暂停留自动进下一张（2.5s 定时器会截断
    // 较长朗读——票 28 复核探针实测整词被下一张卡链打断；改为随 speakSeq 解析推进。
    // unmount 清 timer；timeup 竞态由状态机 no-op 兜底）
    const parts = [pickPraise(), card.word];
    void speaker
      .speakSeq(parts)
      .then(() => {
        if (fillNextTimer) clearTimeout(fillNextTimer);
        fillNextTimer = setTimeout(() => {
          fillNextTimer = undefined;
          advanceViaNext();
        }, FILL_DONE_PAUSE_MS);
      });
    // 再学一次（isReplay）不回写：练习效应会虚高首试正确率→污染消化指数，
    // 重复 answer 还会双次 applyAnswer 扰乱 SRS 池位调度（fold.ts ensureCard）
    if (!after.isReplay) {
      void learningData.recordNewWordFillDone(card, nowFn() - cardShownAtMs, {
        slots: card.word.length,
        firstTryCorrectSlots: fill.firstTryCorrect.filter(Boolean).length,
        wrongPicks: fill.wrongPicks,
      });
    }
  } else {
    void speaker.speak(pickPraise());
  }
}

function onFinish(): void {
  state.value = reduce(state.value, { type: 'finish' });
  if (state.value.step === 'done') closeSegment(true);
}

/** 再学一次（P-09）：同批卡原地重建会话；isReplay 屏蔽回写＝练习效应不进消化信号。
 *  segmentClosed 保持 true：再学的完成/超时不改写当日 daily_completed（首过已记）。 */
function onReplay(): void {
  const after = reduce(state.value, { type: 'replay', nowMs: nowFn() });
  if (after === state.value) return; // 非 done 步 no-op 防御
  state.value = after;
  cardShownAtMs = nowFn();
  playEntryChain(); // 显式播：单卡会话 cardIndex 不变时 watch 不触发（整词→例句，票 51）
}

// 换卡即自动播进卡链（read/whole；整词→例句，票 51）；同卡进拼格自动读整词发音（票 28 锚点）
watch(
  () => [state.value.cardIndex, state.value.step] as const,
  ([, step], prev) => {
    if (!prev || prev[0] !== state.value.cardIndex) {
      if (step === 'read' || step === 'whole') playEntryChain(); // 换卡听感锚
      return;
    }
    if (step === 'fill' && prev[1] !== 'fill') {
      const card = currentCard.value;
      if (card) void speaker.speak(card.word); // 进拼格：自动读整词发音
    }
  },
);
</script>

<template>
  <section class="view nw" :data-nw-step="state.step">
    <header class="nw-head">
      <div>
        <h2 class="nw-title">新词段</h2>
        <p class="nw-sub">今日 {{ totalCards }} 词（上限 {{ DAILY_NEW_WORDS_MAX }}） · 第 {{ cardNo }} 词</p>
      </div>
      <output class="nw-timer" :class="{ 'nw-timer--urgent': remainingMs < 60000 }" data-testid="nw-timer">
        {{ mmss }}
      </output>
    </header>

    <!-- 装载中（开库＋fold 重建＋计划装配） -->
    <main v-if="loading" class="nw-card" data-testid="nw-loading">
      <p class="nw-hint">正在准备今日的词…</p>
    </main>

    <!-- 初始化失败（含冒烟门未过）：明示不静默 -->
    <main v-else-if="fatal" class="nw-card nw-card--end" data-testid="nw-fatal">
      <h3>数据加载失败</h3>
      <p class="nw-hint">{{ fatal }}</p>
      <div class="nw-actions">
        <RouterLink class="nw-btn nw-btn--link" to="/learning">回学习流域</RouterLink>
      </div>
    </main>

    <!-- 进行中：读→拼 词卡 -->
    <main v-else-if="currentCard && canAdvance" class="nw-card" data-testid="nw-card">
      <!-- 拼阶段：四线格空格槽＋选项点选 -->
      <template v-if="state.step === 'fill' && fillState">
        <div class="nw-grid nw-grid--fill" :style="{ fontSize: `${fillFontPx}px` }" data-testid="nw-fill-word">
          <span
            v-for="(ch, i) in currentCard.word.split('')"
            :key="i"
            class="nw-fill-slot"
            :class="{ 'nw-fill-slot--done': i < fillState.slotIndex }"
            :data-testid="`nw-fill-slot-${i}`"
          >{{ i < fillState.slotIndex ? ch : '' }}</span>
        </div>
        <p v-if="detailGloss" class="nw-fill-meaning" data-testid="nw-fill-meaning">
          <span v-if="detailPos" class="nw-pos">{{ detailPos }}</span>
          <span class="nw-gloss">{{ detailGloss }}</span>
        </p>
        <p class="nw-hint" data-testid="nw-fill-hint">{{ fillHint }}</p>
        <div class="nw-fill-options" data-testid="nw-fill-options">
          <button
            v-for="(opt, i) in fillOptions"
            :key="`${fillState.slotIndex}-${fillState.slotMistakes}-${opt}`"
            type="button"
            class="nw-fill-option"
            :class="{ 'nw-fill-option--hint': hintCorrect && opt.toLowerCase() === targetLetter.toLowerCase() }"
            :data-testid="`nw-fill-option-${i}`"
            @click="onPickLetter(opt)"
          >
            {{ opt }}
          </button>
        </div>
        <!-- 再听一次（票 53，用户需求）：拼词中重听整词发音——复习段 rv-replay-word 同款模式 -->
        <div class="nw-actions">
          <button type="button" class="nw-btn nw-btn--ghost" data-testid="nw-fill-replay" @click="speakText(currentCard.word)">
            再听一次
          </button>
        </div>
      </template>

      <!-- 读阶段（有拆分）：四线三格大字整词＋音节横线＋Q 版箭头＋音节块行 -->
      <template v-else-if="currentCard.blocks">
        <div class="nw-grid" data-testid="nw-read-word"><span v-for="(block, i) in currentCard.blocks" :key="i" class="nw-syl" :class="`nw-syl--c${(i % 3) + 1}`">{{ block }}</span></div>
        <div class="nw-arrow" aria-hidden="true">
          <i class="nw-arrow-stem"></i>
          <i class="nw-arrow-head"></i>
        </div>
        <div class="nw-blocks">
          <button
            v-for="(block, i) in currentCard.blocks"
            :key="i"
            type="button"
            class="nw-block"
            :class="[`nw-block--c${(i % 3) + 1}`, { 'nw-block--heard': state.tappedBlocks[i] }]"
            :data-testid="`nw-block-${i}`"
            @click="onTapBlock(i)"
          >
            {{ block }}
          </button>
        </div>
        <!-- 票 51 词义呈现：词性徽章＋释义＋音标＋双语例句（空值行不渲染，宁缺勿滥） -->
        <div class="nw-meaning" data-testid="nw-meaning">
          <p v-if="detailGloss" class="nw-meaning-main" data-testid="nw-meaning-main">
            <span v-if="detailPos" class="nw-pos" data-testid="nw-pos">{{ detailPos }}</span>
            <span class="nw-gloss" data-testid="nw-gloss">{{ detailGloss }}</span>
          </p>
          <p v-if="detailPhonetic" class="nw-phonetic" data-testid="nw-phonetic">/{{ detailPhonetic }}/</p>
          <p v-if="detailExample" class="nw-example" data-testid="nw-example">
            <span class="nw-example-en" data-testid="nw-example-en">{{ detailExample.en }}</span>
            <span class="nw-example-zh" data-testid="nw-example-zh">{{ detailExample.zh }}</span>
          </p>
        </div>
        <p class="nw-hint">{{ stepHint }}</p>
        <div class="nw-actions">
          <button type="button" class="nw-btn nw-btn--ghost" data-testid="nw-speak-word" @click="playWholeChain">
            听整词
          </button>
          <button
            v-if="detailExample"
            type="button"
            class="nw-btn nw-btn--ghost"
            data-testid="nw-speak-example"
            @click="speakExample"
          >
            读例句
          </button>
          <button type="button" class="nw-btn" data-testid="nw-next" @click="onNext">{{ nextLabel }}</button>
        </div>
      </template>

      <!-- 读阶段（无拆分）：整词呈现（禁猜拆） -->
      <template v-else>
        <div class="nw-grid" data-testid="nw-whole"><span class="nw-word">{{ currentCard.word }}</span></div>
        <div class="nw-meaning" data-testid="nw-meaning">
          <p v-if="detailGloss" class="nw-meaning-main" data-testid="nw-meaning-main">
            <span v-if="detailPos" class="nw-pos" data-testid="nw-pos">{{ detailPos }}</span>
            <span class="nw-gloss" data-testid="nw-gloss">{{ detailGloss }}</span>
          </p>
          <p v-if="detailPhonetic" class="nw-phonetic" data-testid="nw-phonetic">/{{ detailPhonetic }}/</p>
          <p v-if="detailExample" class="nw-example" data-testid="nw-example">
            <span class="nw-example-en" data-testid="nw-example-en">{{ detailExample.en }}</span>
            <span class="nw-example-zh" data-testid="nw-example-zh">{{ detailExample.zh }}</span>
          </p>
        </div>
        <p class="nw-hint">{{ stepHint }}</p>
        <div class="nw-actions">
          <button type="button" class="nw-btn nw-btn--ghost" data-testid="nw-speak-word" @click="playWholeChain">
            听整词
          </button>
          <button
            v-if="detailExample"
            type="button"
            class="nw-btn nw-btn--ghost"
            data-testid="nw-speak-example"
            @click="speakExample"
          >
            读例句
          </button>
          <button type="button" class="nw-btn" data-testid="nw-next" @click="onNext">{{ nextLabel }}</button>
        </div>
      </template>
    </main>

    <!-- boss 收官（boss＝本段词表） -->
    <main v-else-if="state.step === 'boss'" class="nw-card nw-card--boss" data-testid="nw-boss">
      <h3 class="nw-boss-title">boss 收官</h3>
      <p class="nw-hint">把今天的词都点一遍，听听它们的声音</p>
      <div class="nw-boss-words">
        <button
          v-for="c in state.cards"
          :key="c.entryId"
          type="button"
          class="nw-chip"
          data-testid="nw-boss-word"
          @click="speakText(c.word)"
        >
          {{ c.word }}
        </button>
      </div>
      <div class="nw-actions">
        <button type="button" class="nw-btn" data-testid="nw-finish" @click="onFinish">完成今日新词段</button>
      </div>
    </main>

    <!-- 完成 -->
    <main v-else-if="state.step === 'done'" class="nw-card nw-card--end" data-testid="nw-done">
      <h3>今日新词段完成</h3>
      <p v-if="totalCards === 0" class="nw-hint" data-testid="nw-empty-plan">今天没有安排新词，去复习段看看吧。</p>
      <p v-else class="nw-hint">学了 {{ totalCards }} 个词，用时 {{ usedSeconds }} 秒</p>
      <div class="nw-actions">
        <button
          v-if="totalCards > 0"
          type="button"
          class="nw-btn"
          data-testid="nw-replay"
          @click="onReplay"
        >
          再学一次
        </button>
        <RouterLink class="nw-btn nw-btn--link" to="/learning">回学习流域</RouterLink>
      </div>
    </main>

    <!-- 时间盒到点即停＋顺延（E4） -->
    <main v-else-if="state.step === 'timeup'" class="nw-card nw-card--end" data-testid="nw-timeup">
      <h3>时间到</h3>
      <p class="nw-hint">
        今天学了 {{ doneCount }} 个词，剩下的 {{ deferredCount }} 个明天再来。
      </p>
      <div class="nw-actions">
        <RouterLink class="nw-btn nw-btn--link" to="/learning">回学习流域</RouterLink>
      </div>
    </main>

    <footer class="nw-tts" data-testid="tts-status">
      <span v-if="ttsStatus">TTS：{{ ttsStatus.detail }}</span>
      <span v-else>TTS：探测中…</span>
    </footer>
  </section>
</template>
