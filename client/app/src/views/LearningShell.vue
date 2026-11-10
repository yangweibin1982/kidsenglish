<script setup lang="ts">
/**
 * 学习流域父级布局（Ticket 10 注册，Ticket 11 复用）：
 * 承载学习流域分段导航壳，子路由＝各段视图（新词段 /learning/new-words，
 * 复习段 /learning/review 归 Ticket 11 在 children 里追加）。
 * 票 31：复习段游戏全屏化（P-12）——该路由的自带返回/标题 chrome 隐藏，
 * 由复习段自身 HUD 承接（← 首页 语义迁入 HUD 回航 chip）。
 */
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { computed } from 'vue';

const route = useRoute();
const gameFullscreen = computed(() => route.name === 'learning-review');
</script>

<template>
  <section class="view learning-shell">
    <header v-if="!gameFullscreen" class="learning-shell-head">
      <RouterLink class="learning-back" to="/">← 首页</RouterLink>
      <h2 class="learning-shell-title">学习流域</h2>
    </header>
    <RouterView />
  </section>
</template>
