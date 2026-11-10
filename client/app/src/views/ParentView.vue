<template>
  <section class="view parent">
    <header class="learning-shell-head">
      <RouterLink class="learning-back" to="/">← 首页</RouterLink>
      <h2>家长区</h2>
    </header>

    <!-- 算术门禁（E8：未通过时儿童进度数据零暴露；两位数加法＋会话级解锁） -->
    <form v-if="!unlocked" class="parent-gate" data-testid="parent-gate" @submit.prevent="onGateSubmit">
      <p class="parent-gate-q" data-testid="parent-gate-question">
        请回答：<b>{{ gate.a }} + {{ gate.b }}</b> = ？
      </p>
      <input
        v-model="gateInput"
        class="parent-gate-input"
        data-testid="parent-gate-input"
        type="number"
        inputmode="numeric"
        :placeholder="`${gate.a + gate.b}`"
      />
      <p v-if="gateWrong" class="parent-gate-wrong" data-testid="parent-gate-wrong">答案不对，再想想</p>
      <button class="parent-gate-btn" type="submit" data-testid="parent-gate-submit">进入家长区</button>
      <p class="parent-gate-hint">家长区入口：请家长完成这道两位数加法（孩子进度数据在此门后）</p>
    </form>

    <!-- 统计区（门禁通过后渲染；R17 周报 v1：池分布/今日到期/近 7 天时长/摘要行） -->
    <template v-else-if="stats">
      <div class="parent-summary" data-testid="parent-summary">
        <span>已学 <b>{{ stats.introduced }}</b> 词</span>
        <span>作答 <b>{{ stats.answered }}</b> 次</span>
        <span v-if="stats.correctRate !== null">正确率 <b>{{ stats.correctRate }}%</b></span>
        <span>连续打卡 <b>{{ stats.streak }}</b> 天</span>
      </div>

      <div class="parent-card" data-testid="parent-pools">
        <h3 class="parent-card-title">七池分布</h3>
        <div class="parent-pool-row" v-for="p in stats.pools" :key="p.pool">
          <span class="parent-pool-label">{{ poolLabel(p.pool) }}</span>
          <div class="parent-pool-bar-wrap">
            <div class="parent-pool-bar" :style="{ width: poolBarWidth(p.count) }"></div>
          </div>
          <span class="parent-pool-count">{{ p.count }}</span>
        </div>
        <p class="parent-note" data-testid="parent-due">今日到期 {{ stats.dueToday }} 卡</p>
      </div>

      <!-- 学习周报（票 47；R17 周报图表化：7 天趋势＋本周 vs 上周三维对比） -->
      <div class="parent-card" data-testid="parent-week">
        <h3 class="parent-card-title">学习周报（近 7 天）</h3>
        <div class="parent-week-bars" data-testid="parent-week-bars">
          <div class="parent-week-bar-col" v-for="d in weekly?.days ?? []" :key="d.date">
            <div class="parent-week-bar" :style="{ height: weekBarHeight(d.minutes) }"></div>
            <span class="parent-week-bar-label">{{ weekBarLabel(d.date) }}</span>
          </div>
        </div>
        <p class="parent-week-line">
          时长 本周 <b>{{ fmtMin(weekly?.thisWeek.minutes ?? 0) }}</b> 分 · 上周
          <b>{{ fmtMin(weekly?.lastWeek.minutes ?? 0) }}</b> 分 {{ deltaGlyph(weekly?.deltas.minutes.status) }}
        </p>
        <p class="parent-week-line">
          作答 本周 <b>{{ weekly?.thisWeek.answered ?? 0 }}</b> 次 · 上周
          <b>{{ weekly?.lastWeek.answered ?? 0 }}</b> 次 {{ deltaGlyph(weekly?.deltas.answered.status) }}
          　积分 本周 <b>{{ weekly?.thisWeek.points ?? 0 }}</b> {{ deltaGlyph(weekly?.deltas.points.status) }}
        </p>
        <p class="parent-note" v-if="weekly && weekly.correctRate !== null" data-testid="parent-week-rate">
          本周正确率 {{ weekly.correctRate }}%
        </p>
      </div>

      <!-- 混淆图谱（票 49；R17 第三面收口：字母对混淆 top 对条形） -->
      <div class="parent-card" data-testid="parent-confusion">
        <h3 class="parent-card-title">易混字母（拼词错选统计）</h3>
        <template v-if="confusion && confusion.rows.length > 0">
          <div class="parent-pool-row" v-for="r in confusion.rows" :key="`${r.expected}${r.picked}`">
            <span class="parent-pool-label" :data-testid="`confusion-pair-${r.expected}-${r.picked}`">{{ r.expected }} → {{ r.picked }}</span>
            <div class="parent-pool-bar-wrap">
              <div class="parent-pool-bar" :style="{ width: confusionBarWidth(r.count) }"></div>
            </div>
            <span class="parent-pool-count">×{{ r.count }}</span>
          </div>
          <p class="parent-note">共 {{ confusion.totalWrong }} 次错选 · 跨 {{ confusion.daysWithWrong }} 天</p>
        </template>
        <p class="parent-note" v-else data-testid="confusion-empty">还没有拼错记录，继续加油！</p>
      </div>

      <!-- 家庭内排名开关（票 39；P-14 拍板＝家长开启才生效，默认关） -->
      <label class="parent-card parent-rank-toggle" data-testid="parent-rank-toggle">
        <input type="checkbox" v-model="familyRanking" @change="onRankToggle" />
        <span>开启家庭内积分排名（多个孩子时，打卡页显示家庭积分榜）</span>
      </label>

      <!-- 每日目标（票 48/50/R17：分孩新词上限＋每段时长，引擎 spec S9 天花板入参＋客户端时间盒） -->
      <div class="parent-card" data-testid="parent-goals">
        <h3 class="parent-card-title">每日目标</h3>
        <div v-for="c in goalChildren" :key="c.id" class="parent-goal-child">
          <div class="parent-goal-row">
            <span aria-hidden="true">{{ c.avatar }}</span>
            <span class="parent-goal-name">{{ c.name }}</span>
            <button
              class="parent-goal-btn"
              type="button"
              :data-testid="`parent-goal-dec-${c.id}`"
              :disabled="(c.dailyNewWords ?? DAILY_DEFAULT) <= DAILY_MIN"
              @click="bumpGoal(c, -1)"
            >−</button>
            <b class="parent-goal-value" :data-testid="`parent-goal-value-${c.id}`">{{ c.dailyNewWords ?? DAILY_DEFAULT }}</b>
            <button
              class="parent-goal-btn"
              type="button"
              :data-testid="`parent-goal-inc-${c.id}`"
              :disabled="(c.dailyNewWords ?? DAILY_DEFAULT) >= DAILY_MAX"
              @click="bumpGoal(c, 1)"
            >＋</button>
            <span class="parent-goal-unit">词/日</span>
          </div>
          <div class="parent-goal-row">
            <span aria-hidden="true"></span>
            <span class="parent-goal-name">每段时长</span>
            <button
              class="parent-goal-btn"
              type="button"
              :data-testid="`parent-goal-min-dec-${c.id}`"
              :disabled="(c.dailyMinutes ?? MINUTES_DEFAULT) <= MINUTES_MIN"
              @click="bumpMinutes(c, -1)"
            >−</button>
            <b class="parent-goal-value" :data-testid="`parent-goal-min-value-${c.id}`">{{ c.dailyMinutes ?? MINUTES_DEFAULT }}</b>
            <button
              class="parent-goal-btn"
              type="button"
              :data-testid="`parent-goal-min-inc-${c.id}`"
              :disabled="(c.dailyMinutes ?? MINUTES_DEFAULT) >= MINUTES_MAX"
              @click="bumpMinutes(c, 1)"
            >＋</button>
            <span class="parent-goal-unit">分钟</span>
          </div>
        </div>
        <p class="parent-note">每日新词上限＋每段学习时长，保存后立即生效</p>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * 家长区（票 37 落门禁＋统计 v1；票 47 周报图表化；票 48 每日目标）：两位数加法门
 * （会话级解锁，sessionStorage——关页即重锁，防孩子顺路进）；统计＝FoldedState 只读
 * 派生（deriveParentStats/deriveParentWeekly 纯函数）。混淆图谱/自定义词/调级归 backlog。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { DAILY_NEW_WORDS_DEFAULT, DAILY_NEW_WORDS_MAX, DAILY_NEW_WORDS_MIN, type PoolId } from '@kidsenglish/engine';
import { learningData } from '../store/learningData';
import {
  DAILY_MINUTES_DEFAULT,
  DAILY_MINUTES_MAX,
  DAILY_MINUTES_MIN,
  listChildren,
  updateDailyMinutes,
  updateDailyNewWords,
  type ChildProfile,
} from '../store/children';
import { deriveParentStats, type ParentStats } from './parent/deriveParentStats';
import { deriveParentWeekly, type ParentWeekly, type WeeklyDeltaStatus } from './parent/deriveParentWeekly';
import { deriveParentConfusion, type ConfusionMap } from './parent/deriveParentConfusion';

const DAILY_MIN = DAILY_NEW_WORDS_MIN;
const DAILY_MAX = DAILY_NEW_WORDS_MAX;
const DAILY_DEFAULT = DAILY_NEW_WORDS_DEFAULT;
const MINUTES_MIN = DAILY_MINUTES_MIN;
const MINUTES_MAX = DAILY_MINUTES_MAX;
const MINUTES_DEFAULT = DAILY_MINUTES_DEFAULT;

const GATE_KEY = 'ke.parentUnlock';

const unlocked = ref(sessionStorage.getItem(GATE_KEY) === '1');
const stats = ref<ParentStats | null>(null);
const weekly = ref<ParentWeekly | null>(null);
const confusion = ref<ConfusionMap | null>(null);
/** 每孩每日目标（票 48；快照列表，bump 后重读）。 */
const goalChildren = ref<ChildProfile[]>([]);
const gate = ref({ a: 0, b: 0 });
const gateInput = ref('');
const gateWrong = ref(false);
/** 家庭内排名开关（票 39；P-14 拍板＝家长开启才生效，默认关）。 */
const familyRanking = ref(localStorage.getItem('ke.familyRanking') === '1');

function onRankToggle(): void {
  if (familyRanking.value) localStorage.setItem('ke.familyRanking', '1');
  else localStorage.removeItem('ke.familyRanking');
}

function newGate(): void {
  // 两位数加法（10-49 ＋ 10-49，和 < 100 家长口算友好；随机数＝门禁面非演出面）
  gate.value = { a: 10 + Math.floor(Math.random() * 40), b: 10 + Math.floor(Math.random() * 40) };
  gateInput.value = '';
}

const POOL_LABELS: Record<PoolId, string> = {
  P0: '新词池', P1: 'D+1', P2: 'D+3', P3: 'D+7', P4: 'D+14', P5: 'D+30', graduated: '毕业池',
};
function poolLabel(pool: PoolId): string {
  return POOL_LABELS[pool];
}
const maxPool = computed(() => Math.max(1, ...stats.value?.pools.map((p) => p.count) ?? [1]));
function poolBarWidth(count: number): string {
  return `${Math.round((count / maxPool.value) * 100)}%`;
}
/** 混淆图谱条形宽（占顶对计数的比例）。 */
const maxConfusion = computed(() => Math.max(1, ...confusion.value?.rows.map((r) => r.count) ?? [1]));
function confusionBarWidth(count: number): string {
  return `${Math.max(4, Math.round((count / maxConfusion.value) * 100))}%`;
}

onMounted(async () => {
  newGate();
  if (unlocked.value) await loadStats(); // 会话内已解锁：直接取数
});

/** 门禁通过后取统计（首过与已解锁共用；E8 门禁前零取数）。 */
async function loadStats(): Promise<void> {
  try {
    await learningData.ensureReady(); // 幂等（HomeView/CheckinView 同款惯例）
    const todayIso = new Date().toISOString().slice(0, 10);
    stats.value = deriveParentStats(learningData.foldedState, todayIso);
    weekly.value = deriveParentWeekly(learningData.foldedState.dailySummaries, todayIso);
    confusion.value = deriveParentConfusion(learningData.answerPayloads);
    goalChildren.value = listChildren();
  } catch {
    stats.value = null;
    weekly.value = null;
    confusion.value = null;
  }
}

/** 周报条形高度（当日分钟占 7 天峰值的百分比；零数据日 2px 底线）。 */
const maxWeekMinutes = computed(() => Math.max(1, ...(weekly.value?.days.map((d) => d.minutes) ?? [1])));
function weekBarHeight(minutes: number): string {
  return `${Math.max(4, Math.round((minutes / maxWeekMinutes.value) * 100))}%`;
}
function weekBarLabel(date: string): string {
  return date.slice(5).replace('-', '/');
}
function fmtMin(minutes: number): string {
  return String(Math.round(minutes));
}
const DELTA_GLYPHS: Record<WeeklyDeltaStatus, string> = { up: '↑', flat: '→', down: '↓', none: '—' };
function deltaGlyph(status?: WeeklyDeltaStatus): string {
  return status === undefined ? '' : DELTA_GLYPHS[status];
}

/** 每日目标步进（票 48；±1，clamp 在存储层；步进后刷新快照列表）。 */
function bumpGoal(child: ChildProfile, direction: -1 | 1): void {
  const current = child.dailyNewWords ?? DAILY_DEFAULT;
  updateDailyNewWords(child.id, current + direction);
  goalChildren.value = listChildren();
}

/** 每段时长步进（票 50；±1 分钟，clamp 在存储层）。 */
function bumpMinutes(child: ChildProfile, direction: -1 | 1): void {
  const current = child.dailyMinutes ?? MINUTES_DEFAULT;
  updateDailyMinutes(child.id, current + direction);
  goalChildren.value = listChildren();
}

function onGateSubmit(): void {
  if (Number(gateInput.value) === gate.value.a + gate.value.b) {
    sessionStorage.setItem(GATE_KEY, '1');
    unlocked.value = true;
    gateWrong.value = false;
    void loadStats(); // 首次过门禁即刻取数（修复：解锁后无人触发取数＝空统计）
  } else {
    gateWrong.value = true;
    newGate();
  }
}
</script>
