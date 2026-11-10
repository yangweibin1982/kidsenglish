<script setup lang="ts">
/**
 * 复习段视图 v4（spec v1.5 S9 游戏全屏化，Ticket 31；P-12 构图反转——
 * 游戏为体：本组件只叠游戏 HUD，居中答题大卡退役为底部拼写 dock；
 * 考核语义与 testid 零变化）。
 *
 * 分层（S5 三向契约）：
 *   DOM 考核层（本组件：顶栏 HUD＋底部拼写 dock＝中文义 chip＋字母填空＋
 *   判定＋时间盒/得分展示）
 *     ⇕ stageContract 总线（①指令 ②完成回报 ③错误上报）
 *   PixiJS 演出层（pixiStage v4，全屏不透明画布挂 App.vue 兄弟节点）
 *
 * 考核面（听写式检索，票 29 语义保持）：词只听不显——进卡自动读整词、
 * 「再听一遍」重播；字母选项复用新词段 slotOptions 干扰体系，洗牌/连错
 * 高亮同款。每拼对一个字母另发 letter-fire（纯演出反馈）。
 *
 * 得分/连击纯游戏内展示（P-11 决策 3），不进学习事件流。
 * 数据面：learningData 快照 plan.reviewQueue＋词包 enrich；?mock=1 夹具。
 * 回写：review_fill（correct＝首试全对严格口径）；段结束 daily_completed。
 * 时间盒：≤5 分钟到点即停＋顺延展示（?box=10s / ?box=1500 可覆盖演示）。
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { RouterLink } from 'vue-router';
import { REVIEW_SESSION_HARD_CAP, REVIEW_TIMEBOX_MS, createRvSession, reduceRv, remainingDeferred, type RvAction, type RvCard, type RvState } from './stateMachine';
import type { DailyReviewCard } from '@kidsenglish/engine';
import { buildMockReviewPlan } from './mockPlan';
import { syllablesOf } from '../newwords/stateMachine';
import { slotOptions } from '../newwords/fill';
import { pickPraise } from '../newwords/praise';
import { getSpeaker } from '../newwords/tts';
import { learningData } from '../../store/learningData';
import { isMockMode, resolveSegmentTimeboxMs } from '../../store/profile';
import { createStageBus, type StageEvent } from './stageContract';
import type { StageUnmount } from './pixiStage';

const props = defineProps<{
  /** 时间盒覆盖（毫秒）——演示/测试注入用，缺省引擎 300s 常量语义 */
  durationMs?: number;
}>();

const loading = ref(true);
const fatal = ref<string | null>(null);
/** 冷启动/当日无到期卡（真数据空态，禁编造演示队列） */
const emptyPlan = ref(false);
const totalCards = ref(0);

/** 查询参数演示钩子：?box=10s ／ ?box=1500（毫秒）覆盖时间盒时长 */
function parseBoxOverride(): number | undefined {
  const raw =
    new URLSearchParams(window.location.search).get('box') ??
    new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('box');
  if (!raw) return props.durationMs;
  const m = raw.match(/^(\d+)(s|ms)?$/);
  if (!m) return props.durationMs;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

// ?box（毫秒演示钩子）> 孩子每段时长目标（票 50）> 既有常量
const durationMs = parseBoxOverride() ?? resolveSegmentTimeboxMs() ?? REVIEW_TIMEBOX_MS;
const nowFn = (): number => Date.now();

const bus = createStageBus();
const state = shallowRef<RvState>(createRvSession([], { startMs: 0, durationMs: 1 }));
const nowMs = ref(nowFn());
/** 击破怪兽数（数 performance-complete defeat 事件——Boss/小怪混合波次下唯一精确口径） */
const defeats = ref(0);
/** 当前卡展示起点（reaction_ms 取真实毫秒；新卡进入 question 步时刷新） */
let questionShownAtMs = 0;
let segmentClosed = false;

const speaker = getSpeaker();

/** 引擎计划卡＋词包内容 enrich（RvCard）；词包缺失/空词剔除（破损卡不硬出题）。 */
function enrichCard(c: DailyReviewCard): RvCard | null {
  const entry = learningData.pack.byId.get(c.entryId);
  if (!entry || entry.word.length === 0) {
    console.warn(`[review] 词包缺失或空词，剔除出队: ${c.entryId}`);
    return null;
  }
  return { ...c, word: entry.word, meaning: entry.meaning, blocks: syllablesOf(entry.word, entry.phonicsSplit) };
}

/** 装载当日复习计划（真数据路径；mock 开关走夹具）并创建会话 */
async function loadSession(): Promise<void> {
  try {
    await learningData.ensureReady();
    let queue: readonly DailyReviewCard[];
    if (isMockMode()) {
      queue = buildMockReviewPlan(new Date().toISOString().slice(0, 10)).reviewQueue;
    } else {
      queue = learningData.snapshot.value?.plan.reviewQueue ?? [];
    }
    const enriched = queue.flatMap((c) => {
      const card = enrichCard(c);
      return card ? [card] : [];
    });
    emptyPlan.value = enriched.length === 0;
    totalCards.value = Math.min(enriched.length, REVIEW_SESSION_HARD_CAP);
    state.value = createRvSession(enriched, { startMs: nowFn(), durationMs });
    defeats.value = 0;
    questionShownAtMs = nowFn();
    loading.value = false;
    // 开战装载：battle-start（第一只怪兽出场）＋首卡词义气泡（懒挂载经总线缓冲补投）
    const first = state.value.queue[0];
    if (first) {
      void ensureStageMounted();
      bus.sendCommand({ kind: 'battle-start', total: totalCards.value });
      bus.sendCommand({ kind: 'load-word', targetId: first.entryId, meaning: first.meaning });
      void speaker.speak(first.word); // 听写式检索：进卡自动读词（词形不显示）
    }
  } catch (err) {
    fatal.value = err instanceof Error ? err.message : String(err);
    loading.value = false;
  }
}

/* ---------------- 三向契约接线（Vue 考核层 ↔ Pixi 演出层） ---------------- */

let stageUnmount: StageUnmount | null = null;
let stageMounting = false;
let disposed = false;
const stageError = ref<string | null>(null);

/** 演出层懒挂载（dynamic import 让 pixi 独立分包） */
async function ensureStageMounted(): Promise<void> {
  if (stageUnmount || stageMounting || disposed) return;
  stageMounting = true;
  try {
    const mod = await import('./pixiStage');
    const unmount = await mod.mountShootingStage(bus);
    if (disposed) {
      unmount();
    } else {
      stageUnmount = unmount;
    }
  } catch (err) {
    stageError.value = `演出层挂载失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    stageMounting = false;
  }
}

const unsubStage = bus.onEvent((evt: StageEvent) => {
  if (evt.kind === 'performance-complete') {
    if (evt.outcome === 'defeat') defeats.value += 1; // 击破计数（战报精确口径）
    dispatch({ type: 'stageComplete', outcome: evt.outcome, targetId: evt.targetId });
  } else {
    // ③ 错误上报：计数兜底推进（孩子不卡在演出等待）＋证据行展示
    stageError.value = evt.message;
    dispatch({ type: 'stageError', message: evt.message });
  }
});

/** 状态落地后的演出指令同步（① Vue→Pixi 指令向） */
function syncStage(after: RvState, before: RvState): void {
  // 拼完进 performance：每词恰一次 fire（演出层恰一次回报）；载荷携连击/
  // 武器等级/得分（纯游戏内展示，P-11 决策 3）
  if (after.step === 'performance' && before.step !== 'performance') {
    const card = after.queue[0];
    const last = after.results[after.results.length - 1];
    const combo = last?.combo ?? 0;
    if (card) {
      bus.sendCommand({
        kind: 'fire',
        shotId: `${card.entryId}-${after.results.length}`,
        targetId: card.entryId,
        combo,
        weaponLevel: Math.min(3, 1 + Math.floor(combo / 3)),
        score: last?.score ?? 0,
      });
    }
  }
  if (after.step === 'timeup' || after.step === 'done') {
    bus.sendCommand({ kind: 'clear' });
  }
}

/** 段结束回写（一次）：daily_completed＋触发同步（S1 学习单元结束） */
function closeSegment(completedOnTime: boolean): void {
  if (segmentClosed) return;
  segmentClosed = true;
  void learningData.finishSegment('review', completedOnTime, usedSeconds.value);
}

function dispatch(action: RvAction): void {
  const before = state.value;
  const after = reduceRv(before, action);
  if (after === before) return;
  state.value = after;
  // 新卡进入 question 步：刷新反应时起点＋装词（load-word 重挂目标怪义气泡——
  // 演出层每波新怪 currentTargetId=null，缺此调用后续 fire 全走 fail-open，
  // 血条/击破链路断；票 30 探针抓出的 v2 遗留缺陷）＋自动读词（听写锚）
  if (after.step === 'question' && (before.step !== 'question' || before.queue[0]?.entryId !== after.queue[0]?.entryId)) {
    questionShownAtMs = nowFn();
    const card = after.queue[0];
    if (card) {
      bus.sendCommand({ kind: 'load-word', targetId: card.entryId, meaning: card.meaning });
      void speaker.speak(card.word);
    }
  }
  if (after.step === 'done') closeSegment(true);
  if (after.step === 'timeup') closeSegment(false);
  syncStage(after, before);
}

/* ---------------- 考核层派生量 ---------------- */

const currentCard = computed(() => state.value.queue[0]);
const fillState = computed(() => state.value.fill);

const remainingMs = computed(() => Math.max(0, state.value.deadlineMs - nowMs.value));
const mmss = computed(() => {
  const s = Math.ceil(remainingMs.value / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
const deferredCount = computed(() => remainingDeferred(state.value));
const doneCount = computed(() => state.value.results.filter((r) => r.correct).length);
const answeredCount = computed(() => state.value.results.length);
/** 击破怪兽数（defeat 事件计数；重排二次拼写不影响——击破只发生在演出层） */
const defeatedCount = computed(() => defeats.value);
/** 游戏内得分/连击（纯展示；P-11 决策 3 不进事件流） */
const score = computed(() => state.value.score);
const combo = computed(() => state.value.combo);
const weaponLevel = computed(() => Math.min(3, 1 + Math.floor(state.value.combo / 3)));
const usedSeconds = computed(() =>
  Math.round((Math.min(nowMs.value, state.value.deadlineMs) - state.value.startedAtMs) / 1000),
);

/** 当前格选项（依赖 slotMistakes：选错洗牌＝换 rand 重取 slotOptions） */
const fillOptions = computed(() => {
  const card = currentCard.value;
  const fill = state.value.fill;
  if (!card || !fill || fill.slotIndex >= card.word.length) return [];
  void fill.slotMistakes; // 显式依赖：错误数变化即重算（重洗）
  return slotOptions(card.word, fill.slotIndex);
});

/** 连错 ≥2 次：正确项轻微高亮防挫败（新词段同款） */
const hintCorrect = computed(() => (state.value.fill?.slotMistakes ?? 0) >= 2);

const targetLetter = computed(() => {
  const card = currentCard.value;
  const fill = state.value.fill;
  if (!card || !fill) return '';
  return card.word[fill.slotIndex] ?? '';
});

/** 拼格字号（px）：dock 单行流式收缩，保 375px 视口不破版（每格≈1.25 字号宽含间隙） */
const fillFontPx = computed(() => {
  const len = Math.max(1, currentCard.value?.word.length ?? 1);
  const fit = Math.floor(300 / (len * 1.25));
  return Math.max(20, Math.min(30, fit));
});

const fillHint = computed(() => {
  const card = currentCard.value;
  const fill = state.value.fill;
  if (!card || !fill) return '';
  if (state.value.step === 'performance') return '拼好啦！看战机开火——';
  if (fill.slotIndex >= card.word.length) return '拼好啦！看战机开火——';
  return `听发音，拼出它：第 ${fill.slotIndex + 1} / ${card.word.length} 个字母`;
});

let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    nowMs.value = nowFn();
    dispatch({ type: 'tick', nowMs: nowMs.value });
  }, 250);
  void loadSession();
});

onUnmounted(() => {
  disposed = true;
  if (timer) clearInterval(timer);
  unsubStage();
  bus.sendCommand({ kind: 'clear' });
  stageUnmount?.();
  stageUnmount = null;
  speaker.stop();
});

/* ---------------- 交互 ---------------- */

function onReplayWord(): void {
  const card = currentCard.value;
  if (card) void speaker.speak(card.word);
}

function onPickLetter(letter: string): void {
  const before = state.value;
  const card = before.queue[0];
  dispatch({ type: 'pickLetter', letter });
  const after = state.value;
  if (after === before || !card || !after.fill || after.fill === before.fill) return;
  const progressed = after.fill.slotIndex > (before.fill?.slotIndex ?? 0);
  if (!progressed) return; // 选错：状态机已记错误；视图靠 slotMistakes 洗牌/高亮
  if (after.fill.slotIndex >= card.word.length) {
    // 拼完：表扬＋整词朗读（演出回报驱动弹出，无需定时器）
    void speaker.speakSeq([pickPraise(), card.word]);
    // 回写 review_fill（首试全对口径；非首试重排的二次拼写各自成事件）
    void learningData.recordReviewFill(card.entryId, nowFn() - questionShownAtMs, {
      slots: card.word.length,
      firstTryCorrectSlots: after.fill.firstTryCorrect.filter(Boolean).length,
      wrongPicks: after.fill.wrongPicks,
    });
  } else {
    // 字母级弹幕：每拼对一个字母立即一发（纯演出反馈，不扣血不回报）
    bus.sendCommand({ kind: 'letter-fire', targetId: card.entryId });
    void speaker.speak(pickPraise());
  }
}
</script>

<template>
  <section class="view rv" :data-rv-step="state.step">
    <!-- 游戏顶栏 HUD（P-12 构图反转：全屏画布之上，游戏为体） -->
    <header v-if="!loading && !fatal && !emptyPlan" class="rv-hud">
      <div class="rv-hud-left">
        <RouterLink class="rv-hud-back" to="/" data-testid="rv-back">← 首页</RouterLink>
        <div class="rv-hud-title">
          复习段
          <span class="rv-hud-sub">今日 {{ totalCards }} 词 · 剩余 {{ deferredCount }}</span>
        </div>
      </div>
      <div class="rv-hud-right">
        <output class="rv-combo-chip" data-testid="rv-combo">x{{ combo }} · 火力 Lv{{ weaponLevel }}</output>
        <output class="rv-score-chip" data-testid="rv-score">得分 {{ score }}</output>
        <output class="rv-timer" :class="{ 'rv-timer--urgent': remainingMs < 60000 }" data-testid="rv-timer">
          {{ mmss }}
        </output>
      </div>
    </header>

    <!-- 装载中（开库＋fold 重建＋计划装配） -->
    <main v-if="loading" class="rv-card" data-testid="rv-loading">
      <p class="rv-hint">战机准备起飞…</p>
    </main>

    <!-- 初始化失败（含冒烟门未过）：明示不静默 -->
    <main v-else-if="fatal" class="rv-card rv-card--end" data-testid="rv-fatal">
      <h3>数据加载失败</h3>
      <p class="rv-hint">{{ fatal }}</p>
      <div class="rv-actions">
        <RouterLink class="rv-btn rv-btn--link" to="/learning">回学习流域</RouterLink>
      </div>
    </main>

    <!-- 冷启动/当日无到期卡：诚实空态（禁编造演示队列） -->
    <main v-else-if="emptyPlan" class="rv-card rv-card--end" data-testid="rv-empty">
      <h3>今天没有要复习的词</h3>
      <p class="rv-hint">先去新词段学几个词，明天它们就来复习啦。</p>
      <div class="rv-actions">
        <RouterLink class="rv-btn rv-btn--link" to="/learning/new-words">进入新词段 →</RouterLink>
      </div>
    </main>

    <!-- 拼写 HUD dock（P-12：答题大卡退役；考核面不变——词只听不显，字母选填） -->
    <main
      v-else-if="currentCard && (state.step === 'question' || state.step === 'performance')"
      class="rv-dock"
      :class="{ 'rv-locked': state.step === 'performance' }"
      data-testid="rv-card"
    >
      <div class="rv-dock-row">
        <div class="rv-dock-meaning" data-testid="rv-meaning">{{ currentCard.meaning || '（听发音拼写）' }}</div>
        <div class="rv-grid rv-grid--fill" :style="{ fontSize: `${fillFontPx}px` }" data-testid="rv-fill-word">
          <span
            v-for="(ch, i) in currentCard.word.split('')"
            :key="i"
            class="rv-fill-slot"
            :class="{ 'rv-fill-slot--done': fillState !== null && i < fillState.slotIndex }"
            :data-testid="`rv-fill-slot-${i}`"
          >{{ fillState !== null && i < fillState.slotIndex ? ch : '' }}</span>
        </div>
      </div>
      <div class="rv-dock-row rv-dock-row--options">
        <p class="rv-hint rv-dock-status" data-testid="rv-fill-hint">{{ fillHint }}</p>
        <div v-if="state.step === 'question'" class="rv-fill-options" data-testid="rv-fill-options">
          <button
            v-for="(opt, i) in fillOptions"
            :key="`${fillState?.slotIndex}-${fillState?.slotMistakes}-${opt}`"
            type="button"
            class="rv-fill-option"
            :class="{ 'rv-fill-option--hint': hintCorrect && opt.toLowerCase() === targetLetter.toLowerCase() }"
            :data-testid="`rv-fill-option-${i}`"
            :disabled="state.step !== 'question'"
            @click="onPickLetter(opt)"
          >
            {{ opt }}
          </button>
        </div>
        <button type="button" class="rv-btn rv-btn--ghost rv-dock-replay" data-testid="rv-replay-word" @click="onReplayWord">
          再听一遍
        </button>
      </div>
    </main>

    <!-- 完成 -->
    <main v-else-if="state.step === 'done'" class="rv-card rv-card--end" data-testid="rv-done">
      <h3>今日复习完成</h3>
      <p class="rv-stars">🎁 收集了 {{ defeatedCount }} 颗星星！</p>
      <p class="rv-hint">
        拼出 {{ answeredCount }} 词（全对 {{ doneCount }}），击破 {{ defeatedCount }} 只怪兽，得分 {{ score }} 分，用时 {{ usedSeconds }} 秒
      </p>
      <div class="rv-actions">
        <RouterLink class="rv-btn rv-btn--link" to="/learning">回学习流域</RouterLink>
      </div>
    </main>

    <!-- 时间盒到点即停＋顺延（E4） -->
    <main v-else-if="state.step === 'timeup'" class="rv-card rv-card--end" data-testid="rv-timeup">
      <h3>时间到</h3>
      <p class="rv-hint">
        拼对 {{ doneCount }} 词，剩下的 {{ deferredCount }} 个明天再来。
      </p>
      <div class="rv-actions">
        <RouterLink class="rv-btn rv-btn--link" to="/learning">回学习流域</RouterLink>
      </div>
    </main>

    <footer v-if="stageError" class="rv-stage-error" data-testid="rv-stage-error">
      演出层：{{ stageError }}
    </footer>
  </section>
</template>
