<script setup lang="ts">
// 引擎域占位页：展示 engine 包导出的调度常量，佐证依赖方向（UI → 引擎单向）。
import {
  DAILY_NEW_WORDS_MIN,
  DAILY_NEW_WORDS_MAX,
  DAILY_NEW_WORDS_DEFAULT,
  REVIEW_PER_NEW_RATIO,
  REVIEW_CAPACITY_MAX,
} from '@kidsenglish/engine';
</script>

<template>
  <section class="view">
    <h2>引擎域（占位）</h2>
    <p>调度引擎为纯函数 TS 模块（零 I/O、不感知 Vue/PixiJS），本页仅展示其导出常量：</p>
    <ul>
      <li>每日新词区间：{{ DAILY_NEW_WORDS_MIN }}–{{ DAILY_NEW_WORDS_MAX }}（默认 {{ DAILY_NEW_WORDS_DEFAULT }}）</li>
      <li>复习∶新词配比：{{ REVIEW_PER_NEW_RATIO }}∶1（复习容量上限 {{ REVIEW_CAPACITY_MAX }}）</li>
    </ul>
  </section>
</template>
