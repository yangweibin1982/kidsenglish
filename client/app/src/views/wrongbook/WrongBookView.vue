<template>
  <section class="view wrongbook">
    <header class="checkin-head">
      <h1 class="checkin-title">我的错题本</h1>
      <RouterLink class="checkin-back" to="/checkin" data-testid="wrongbook-back">← 打卡</RouterLink>
    </header>

    <!-- 空态：全部答对（或还没学） -->
    <div v-if="rows.length === 0" class="wrongbook-empty" data-testid="wrongbook-empty">
      <span class="wrongbook-empty-icon" aria-hidden="true">🎈</span>
      <p class="wrongbook-empty-line">还没有错题，太棒了！</p>
    </div>

    <!-- 错词列表：词＋义＋连错次数＋最近答错日；按最近答错降序（票 41） -->
    <ul v-else class="wrongbook-list" data-testid="wrongbook-list">
      <li
        v-for="r in rows"
        :key="r.entryId"
        class="wrongbook-row"
        :data-testid="`wrongbook-row-${r.entryId}`"
      >
        <RouterLink class="wrongbook-word" :to="`/learning/word/${r.entryId}`" :data-testid="`wrongbook-wordlink-${r.entryId}`">{{ r.word }}</RouterLink>
        <span class="wrongbook-meaning">{{ r.meaning }}</span>
        <span class="wrongbook-meta">{{ r.errorStreak > 0 ? `连错 ${r.errorStreak} 次` : '刚答错过' }}</span>
      </li>
    </ul>

    <p v-if="rows.length > 0" class="wrongbook-hint">
      复习段会自动安排这些词再来一次——
      <RouterLink class="checkin-link" to="/learning/review" data-testid="wrongbook-review-link">去复习段再练</RouterLink>
    </p>
  </section>
</template>

<script setup lang="ts">
/**
 * 错题本页（票 41；孩子可达）。数据＝当前档案 FoldedState 只读派生
 * （deriveWrongBook 纯函数），childId 隔离由 learningData 保证；
 * 重练不自建队列——入口指向复习段，引擎调度承接（票面 WRONG 条款）。
 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { learningData } from '../../store/learningData';
import { deriveWrongBook, type WrongBookRow } from './deriveWrongBook';

const rows = ref<WrongBookRow[]>([]);

onMounted(async () => {
  try {
    await learningData.ensureReady(); // 幂等；lexicon/foldedState 就绪
    rows.value = deriveWrongBook(learningData.foldedState.poolStates, learningData.pack.byId);
  } catch {
    // 拿不到数据＝静默空态（零档案/库失败不报错）
  }
});
</script>
