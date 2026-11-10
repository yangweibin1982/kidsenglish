<template>
  <section class="view checkin">
    <header class="checkin-head">
      <h1 class="checkin-title">我的打卡</h1>
      <RouterLink class="checkin-back" to="/" data-testid="checkin-back">← 首页</RouterLink>
    </header>

    <!-- 今日状态卡（三态文案＋积分面；圣经 token，零新增色值） -->
    <div class="checkin-today" data-testid="checkin-today">
      <span class="checkin-today-icon" aria-hidden="true">{{ todayGlyph }}</span>
      <div class="checkin-today-body">
        <p class="checkin-today-line" data-testid="checkin-today-line">{{ todayLine }}</p>
        <p class="checkin-today-sub" data-testid="checkin-streak">
          连续打卡 <b>{{ calendar.streak }}</b> 天
        </p>
        <p class="checkin-today-sub" data-testid="checkin-points">
          今日 <b>{{ points.today }}</b> 分 · 累计 <b>{{ points.total }}</b> 分
        </p>
        <p class="checkin-today-sub" data-testid="checkin-goal">
          今日目标 <b>{{ planCeiling }}</b> 个新词 · 每段 <b>{{ segmentMinutes }}</b> 分钟
        </p>
      </div>
    </div>

    <!-- 今日 vs 昨天对比卡（票 39；超昨天默认展示） -->
    <div class="checkin-compare" data-testid="checkin-compare">
      <p class="checkin-compare-status" data-testid="compare-status">
        <span aria-hidden="true">{{ statusGlyph }}</span> {{ statusLine }}
      </p>
      <div class="checkin-compare-grid">
        <div class="checkin-compare-cell">
          <span class="checkin-compare-label">积分</span>
          <span class="checkin-compare-value">今天 <b>{{ comparison.today.points }}</b> · 昨天 <b>{{ comparison.yesterday.points }}</b></span>
        </div>
        <div class="checkin-compare-cell">
          <span class="checkin-compare-label">作答</span>
          <span class="checkin-compare-value">今天 <b>{{ comparison.today.answered }}</b> · 昨天 <b>{{ comparison.yesterday.answered }}</b></span>
        </div>
        <div class="checkin-compare-cell">
          <span class="checkin-compare-label">答对</span>
          <span class="checkin-compare-value">今天 <b>{{ comparison.today.correct }}</b> · 昨天 <b>{{ comparison.yesterday.correct }}</b></span>
        </div>
      </div>
      <p class="checkin-compare-best" data-testid="compare-best">最佳连击 {{ comparison.bestStreak }} 天</p>
    </div>

    <!-- 家庭内积分排名（票 39；家长开关开启且 ≥2 档案才显示；只显聚合积分） -->
    <div v-if="familyRank" class="checkin-rank" data-testid="family-rank">
      <p class="checkin-section-title">家庭积分榜</p>
      <p v-for="(row, i) in familyRank" :key="row.childId" class="checkin-rank-row" :class="{ 'checkin-rank-row--self': row.isSelf }">
        <span class="checkin-rank-pos">{{ i + 1 }}</span>
        <span aria-hidden="true">{{ row.avatar }}</span>
        <span class="checkin-rank-name">{{ row.name }}{{ row.isSelf ? '（我）' : '' }}</span>
        <span class="checkin-rank-points">{{ row.totalPoints }} 分</span>
      </p>
    </div>

    <!-- 近 30 天日历（7 列网格；⭐=双段全完成／·=有学习未全完成／空=无学习；今日描边） -->
    <div class="checkin-cal" data-testid="checkin-cal">
      <span
        v-for="d in calendar.days"
        :key="d.date"
        class="checkin-cell"
        :class="[`checkin-cell--${d.state}`, { 'checkin-cell--today': d.date === calendar.today.date }]"
        :title="`${d.date}（${d.seconds} 分钟）`"
        :data-testid="`checkin-cell-${d.date}`"
      >{{ d.state === 'done' ? '⭐' : d.state === 'partial' ? '·' : '' }}</span>
    </div>
    <p class="checkin-legend">⭐ 双段全完成 · · 学了但没学完 · 空格 = 还没开始</p>

    <!-- 徽章墙（票 40；达成彩色/未达灰态＋进度提示） -->
    <!-- 近半年热力图（票 55；wordsfunny 学习日历吸收）：列＝周，深浅＝当日积分档 -->
    <div class="checkin-heat" data-testid="checkin-heatmap">
      <p class="checkin-heat-title">近半年学习热力</p>
      <div class="checkin-heat-grid">
        <template v-for="(col, ci) in heatmap.weeks" :key="ci">
          <span
            v-for="cell in col"
            :key="cell.date"
            class="checkin-heat-cell"
            :class="[`checkin-heat-cell--l${cell.level}`, { 'checkin-heat-cell--future': cell.future, 'checkin-heat-cell--today': cell.date === heatmap.todayIso }]"
            :data-testid="`heat-${cell.date}`"
          ></span>
        </template>
      </div>
      <p class="checkin-heat-legend">少 <i class="checkin-heat-cell checkin-heat-cell--l0"></i><i class="checkin-heat-cell checkin-heat-cell--l1"></i><i class="checkin-heat-cell checkin-heat-cell--l2"></i><i class="checkin-heat-cell checkin-heat-cell--l3"></i> 多</p>
    </div>
    <div class="badge-wall" data-testid="badge-wall">
      <p class="checkin-section-title">我的徽章</p>
      <div class="badge-grid">
        <div
          v-for="b in badges"
          :key="b.id"
          class="badge-cell"
          :class="{ 'badge-cell--earned': b.earned }"
          :data-testid="`badge-${b.id}`"
          :title="b.earned ? b.earnedText : '还没达成，继续加油！'"
        >
          <span class="badge-icon" aria-hidden="true">{{ b.earned ? b.icon : '🔒' }}</span>
          <span class="badge-name">{{ b.name }}</span>
        </div>
      </div>
    </div>

    <!-- 错题本入口（票 41 占位链接；页面归票 41） -->
    <p class="checkin-footer"><RouterLink class="checkin-link" to="/wrongbook" data-testid="checkin-wrongbook">📝 我的错题本</RouterLink></p>
  </section>
</template>

<script setup lang="ts">
/**
 * 打卡页（票 36；R8/R9 打卡可见面 v1）：今日状态卡＋近 30 天日历＋连续天数。
 * 数据＝learningData.dailySummaries 只读派生（deriveCheckin 纯函数）；碎片经济
 * 与涂装解锁归 M2（本页只做账面可见）。取数惯例同 HomeView（ensureReady 幂等）。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { DAILY_NEW_WORDS_DEFAULT } from '@kidsenglish/engine';
import { learningData } from '../store/learningData';
import { resolveChildId } from '../store/profile';
import { DAILY_MINUTES_DEFAULT, getChild, listChildren } from '../store/children';
import { deriveCheckin, type CheckinCalendar } from './checkin/deriveCheckin';
import { deriveHeatmap, type HeatmapView } from './checkin/deriveHeatmap';
import { deriveBadges, type BadgeRow } from './checkin/deriveBadges';
import { derivePoints, type PointsLedger } from './points/derivePoints';
import { deriveComparison, deriveFamilyRank, type ComparisonView, type FamilyRankRow } from './points/deriveComparison';

const calendar = ref<CheckinCalendar>(
  deriveCheckin([], new Date().toISOString().slice(0, 10)),
);
const points = ref<PointsLedger>({ total: 0, today: 0, yesterday: 0, days: [] });
const comparison = ref<ComparisonView>(
  deriveComparison([], new Date().toISOString().slice(0, 10)),
);
const badges = ref<BadgeRow[]>([]);
/** 近半年热力网格（票 55；wordsfunny 学习日历吸收面）。 */
const heatmap = ref<HeatmapView>(deriveHeatmap([], new Date().toISOString().slice(0, 10)));
/** 家庭排名（null＝未开启或不足两档——P-14 拍板：家长开启才显示）。 */
const familyRank = ref<FamilyRankRow[] | null>(null);

onMounted(async () => {
  try {
    await learningData.ensureReady(); // 幂等；与 HomeView 同款取数惯例
    const todayIso = new Date().toISOString().slice(0, 10);
    calendar.value = deriveCheckin(learningData.dailySummaries, todayIso);
    heatmap.value = deriveHeatmap(learningData.dailySummaries, todayIso);
    points.value = derivePoints(learningData.dailySummaries, todayIso);
    comparison.value = deriveComparison(learningData.dailySummaries, todayIso);
    badges.value = deriveBadges(learningData.foldedState, todayIso);
    // 家庭排名（票 39）：家长开关＋≥2 档案；只取聚合积分（childDailySummaries 面）
    if (localStorage.getItem('ke.familyRanking') === '1' && listChildren().length >= 2) {
      const selfId = resolveChildId();
      const rows = [];
      for (const c of listChildren()) {
        const sums = await learningData.childDailySummaries(c.id);
        rows.push({ childId: c.id, name: c.name, avatar: c.avatar, totalPoints: derivePoints(sums, todayIso).total });
      }
      familyRank.value = deriveFamilyRank(rows, selfId);
    }
  } catch {
    // 拿不到数据＝静默降级空日历（零档案/库失败不报错）
  }
});

const statusGlyph = computed(() =>
  comparison.value.status === 'up' ? '⬆️' : comparison.value.status === 'flat' ? '🤝' : comparison.value.status === 'down' ? '💪' : '🌙',
);
const statusLine = computed(() => {
  switch (comparison.value.status) {
    case 'up':
      return '超过昨天啦，真棒！';
    case 'flat':
      return '和昨天打成平手！';
    case 'down':
      return '昨天更厉害，今天追上去！';
    default:
      return '今天还没开始，学完就能比一比！';
  }
});

const todayGlyph = computed(() =>
  calendar.value.today.state === 'done' ? '🎉' : calendar.value.today.state === 'partial' ? '✏️' : '🌙',
);

/** 今日新词目标（票 48/R17）＝引擎日计划硬天花板投影（plan.adjuster.ceiling）。 */
const planCeiling = computed(() => learningData.snapshot.value?.plan.adjuster.ceiling ?? DAILY_NEW_WORDS_DEFAULT);

/** 每段时长目标（票 50/R17）＝当前孩子档案投影（时间盒在视图层消费，同源解析）。 */
const segmentMinutes = computed(() => getChild(resolveChildId())?.dailyMinutes ?? DAILY_MINUTES_DEFAULT);
const todayLine = computed(() => {
  switch (calendar.value.today.state) {
    case 'done':
      return '今天的卡打好啦，真棒！';
    case 'partial':
      return '今天学了一部分，继续加油！';
    default:
      return '今天还没开始学，点首页按钮出发吧！';
  }
});
</script>
