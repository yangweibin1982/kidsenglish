<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

// 构建期由 vite define 注入（见 vite.config.ts）
const appVersion = __APP_VERSION__;
const engineVersion = __ENGINE_VERSION__;

const route = useRoute();
// 票 23 收口首页，票 24 扩为儿童路径集合，票 34 增档案页，票 41 增错题本：
// 壳层品牌行与五域占位
// 导航只在 home / profiles / checkin / wrongbook / learning / learning-new-words /
// learning-review / parent 八条路由隐藏（品牌区/家长入口/返回链接由各视图自带；
// engine/stage/sync 开发域保留壳层导航作开发者跳转工具，儿童主路径零触达；
// art-preview dev-only 有独立守卫，不在收口面）。
const SHELL_CHROME_HIDDEN = new Set([
  'home',
  'profiles',
  'checkin',
  'wrongbook',
  'learning',
  'learning-new-words',
  'learning-review',
  'learning-word-detail', // 词卡详情页（票 56；learning-back 自带返回）
  'parent',
]);
const hideShellChrome = computed(() => SHELL_CHROME_HIDDEN.has(String(route.name)));

const domains = [
  { to: '/learning', label: '学习流域', hint: '关卡播放器 · 题型 · 键盘' },
  { to: '/engine', label: '引擎域', hint: '七池调度纯函数' },
  { to: '/stage', label: '演出域', hint: 'PixiJS 独立画布（预留）' },
  { to: '/sync', label: '同步域', hint: '本地库 · 事件流 · HLC' },
  { to: '/parent', label: '家长域', hint: '门禁 · 周报 · 设置' },
];
</script>

<template>
  <div class="app-shell">
    <header v-if="!hideShellChrome" class="app-header">
      <h1 class="app-title">战机英语</h1>
      <p class="app-version">app v{{ appVersion }} · engine v{{ engineVersion }}</p>
    </header>

    <nav v-if="!hideShellChrome" class="domain-nav" aria-label="功能域导航">
      <RouterLink v-for="d in domains" :key="d.to" :to="d.to" class="domain-card">
        <span class="domain-label">{{ d.label }}</span>
        <span class="domain-hint">{{ d.hint }}</span>
      </RouterLink>
    </nav>

    <main class="app-main">
      <RouterView />
    </main>
  </div>

  <!--
    S5 演出域独立画布挂载点：与 Vue 应用树并存的兄弟 DOM 节点（非内嵌于题型组件）。
    后续演出票在此容器挂载 PixiJS canvas（挂载后由演出组件自行接管 pointer-events）；
    契约三向：答题结果 →（开火/命中/连击/充能事件）→ 演出完成回调。
  -->
  <div id="stage-canvas-root" aria-hidden="true"></div>
</template>
