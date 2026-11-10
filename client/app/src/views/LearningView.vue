<template>
  <section class="view learning">
    <!-- 装载/失败态 -->
    <p v-if="loading" class="learning-note" data-testid="learning-loading">正在读取学习进度…</p>
    <p v-else-if="fatal" class="learning-note" data-testid="learning-fatal">进度读取失败：{{ fatal }}</p>

    <template v-else-if="snap">
      <!-- 真实进度面（票 14：fold 重建物化状态；冷启动零编造） -->
      <div class="learning-progress" data-testid="learning-progress">
        <p v-if="snap.coldStart" class="learning-note" data-testid="learning-coldstart">
          第一次学习：今天从新词段开始吧！
        </p>
        <p class="learning-note" data-testid="learning-daily-plan">
          今日计划：新词 {{ snap.newWordsPlan.newWords.length }} 词 · 复习 {{ snap.plan.reviewQueue.length }} 卡
        </p>
        <p class="learning-note" data-testid="learning-counters">
          已学 {{ snap.poolCount }} / {{ snap.packWords }} 词 · 作答 {{ snap.counters.answered }} 次 ·
          答对 {{ snap.counters.correct }} 次
        </p>
        <p class="learning-note" data-testid="learning-sync">
          同步：{{ syncLabel }}
        </p>
      </div>
    </template>

    <!-- Ticket 10：新词段入口（S9 双段日计划，段顺序＝新词段→复习段） -->
    <p><RouterLink class="view-link" to="/learning/new-words">进入新词段（音节块拼读支架）→</RouterLink></p>
    <!-- Ticket 11：复习段入口（答题驱动射击＋5 分钟时间盒；同款入口模式） -->
    <p><RouterLink class="view-link" to="/learning/review">进入复习段（答题驱动射击）→</RouterLink></p>
  </section>
</template>

<script setup lang="ts">
/**
 * 学习流域入口（票 14 接线：占位壳 → 真实进度摘要＋同步状态）。
 * 数据面＝learningData 快照（fold 重建＋引擎日计划）；进视图即 refresh
 * （段结束后回本页即可看到最新进度）。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { learningData, type LearningSnapshot } from '../store/learningData';

const loading = ref(true);
const fatal = ref<string | null>(null);
const snap = ref<LearningSnapshot | null>(null);

const syncLabel = computed(() => {
  if (!snap.value) return '未初始化';
  if (snap.value.lastSyncError) return `待重试（${snap.value.lastSyncError}）`;
  if (snap.value.pendingSync > 0) return `待上行 ${snap.value.pendingSync} 条`;
  if (snap.value.lastSyncAt) return `已同步 ${snap.value.lastSyncAt.slice(11, 19)}`;
  return '尚未同步';
});

onMounted(async () => {
  try {
    await learningData.ensureReady(); // 幂等；每次进入刷新快照
    snap.value = learningData.snapshot.value;
    loading.value = false;
  } catch (err) {
    fatal.value = err instanceof Error ? err.message : String(err);
    loading.value = false;
  }
});
</script>
