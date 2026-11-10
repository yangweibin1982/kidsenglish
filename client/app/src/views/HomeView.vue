<template>
  <section class="view home">
    <!-- 品牌区（票 23：儿童封面页；版本小字沿用壳层既有形状 .app-version） -->
    <header class="home-brand">
      <h1 class="home-title">战机英语</h1>
      <p class="app-version">app v{{ appVersion }} · engine v{{ engineVersion }}</p>
    </header>

    <!-- 吉祥物贴纸卡（返工 2：视觉锚点；资产复用既有样张 monster-trio.svg，零新增）。
         纯装饰面：alt 空＋aria-hidden（品牌名已在 h1，避免读屏重复）。 -->
    <div class="home-mascot" aria-hidden="true" data-testid="home-mascot">
      <img :src="trioUrl" alt="" />
    </div>

    <!-- 当日计划摘要（返工 1：冷启动分支——第一次学习不显示数字行，改鼓励文案；
         非冷启动照常显示数字行。快照拿不到＝静默降级整行隐藏，不报错） -->
    <p v-if="loading" class="home-plan" data-testid="home-plan-loading">正在读取今日计划…</p>
    <p v-else-if="snap && snap.coldStart" class="home-plan" data-testid="home-plan-coldstart">
      第一次学习？点下面按钮开始吧！
    </p>
    <p v-else-if="snap" class="home-plan" data-testid="home-plan">
      今日计划：新词 {{ snap.newWordsPlan.newWords.length }} 词 · 复习
      {{ snap.plan.reviewQueue.length }} 卡
    </p>

    <!-- 词包回退提示（票 35）：档案册次未上线时回退缺省包，如实告知 -->
    <p v-if="snap?.packBinding?.fallback" class="home-pack-hint" data-testid="home-pack-hint">
      「{{ snap.packBinding.startPoint }}」的词包还在准备中，先用一年级课本继续学哦
    </p>

    <!-- 主 CTA：儿童主路径唯一大入口（触控 ≥56px；胶囊蜡笔蓝＝圣经 §6 主按钮形态） -->
    <RouterLink class="home-cta" to="/learning" data-testid="home-cta">开始今天的学习</RouterLink>

    <!-- 打卡入口（票 36；R8 打卡可见面）：CTA 下方次级链接，孩子可达无门禁 -->
    <RouterLink class="home-checkin" to="/checkin" data-testid="home-checkin">⭐ 我的打卡日历</RouterLink>

    <!-- 孩子档案 chip（票 34；R10 主界面头像切换）：有档案时右上角头像＋名字，
         点击进档案页切换；零档案（单孩遗留态）不渲染，既有视觉零变化 -->
    <RouterLink v-if="activeChild" class="home-child" to="/profiles" data-testid="home-child">
      <span class="home-child-avatar" aria-hidden="true">
        <img v-if="avatarImageUrl(activeChild.avatar)" :src="avatarImageUrl(activeChild.avatar)!" class="avatar-img avatar-img--chip" alt="" />
        <template v-else>{{ activeChild.avatar }}</template>
      </span>
      <span class="home-child-name">{{ activeChild.name }}</span>
    </RouterLink>

    <!-- 家长入口：右下角小字（家长域不与儿童主路径抢注意力，儿童产品惯例） -->
    <RouterLink class="home-parent" to="/parent" data-testid="home-parent">家长</RouterLink>
  </section>
</template>

<script setup lang="ts">
/**
 * 首页主界面（票 23：空壳骨架 → 儿童主入口/封面页；返工 1/2 落 2026-11-01；
 * 票 34 增首启守卫＋孩子档案 chip）。纯视图层：品牌区＋吉祥物贴纸卡＋当日计划
 * 摘要＋主 CTA＋孩子 chip（→/profiles）＋右下角家长入口（→/parent）。
 * engine/sync/stage/art-preview 不进本页任何可见导航（儿童主路径零触达红线）。
 */
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { learningData, type LearningSnapshot } from '../store/learningData';
import { isMockMode } from '../store/profile';
import { getActiveChild, listChildren, type ChildProfile, avatarImageUrl } from '../store/children';
// 既有美术样张复用（圣经 §7 打样怪③；禁新增资产/色值，滤镜锁参在文件内）
import trioUrl from '../assets/art/monsters/monster-trio.svg';

// 构建期由 vite define 注入（见 vite.config.ts；与壳层 App.vue 同源）
const appVersion = __APP_VERSION__;
const engineVersion = __ENGINE_VERSION__;

const router = useRouter();
const loading = ref(true);
const snap = ref<LearningSnapshot | null>(null);
const activeChild = ref<ChildProfile | null>(null);

onMounted(async () => {
  // 首启引导（R10/R11）：零档案→建首档（切档案后经 ProfilesView 整页重载回这里，
  // activeChild 从持久层现读）。mock 模式不引导（探针/演示路径零打扰）。
  if (!isMockMode() && listChildren().length === 0) {
    await router.replace('/profiles');
    return;
  }
  activeChild.value = getActiveChild();
  try {
    await learningData.ensureReady(); // 幂等；与 LearningView 同款取数惯例
    snap.value = learningData.snapshot.value;
  } catch {
    // 拿不到快照＝静默降级：计划摘要不显示、不报错，首页两件套（品牌＋CTA）照常可用
    snap.value = null;
  } finally {
    loading.value = false;
  }
});
</script>

