<script setup lang="ts">
/**
 * 美术样张预览页（Ticket 15）——【dev-only：禁进儿童主路径】
 * 入口：开发路由 /art-preview（仅 dev server 或生产构建带 ?art=1 时可达；
 * 双保险见下方 devOnly 守卫）。本页不注册进任何导航，儿童正常使用零触达。
 *
 * 内容：案 C 色板（HEX 标签运行时从 CSS token 读取，零硬编码）＋
 * U2 情景图样张＋1 上其余 11 单元情景图（Ticket 20 批量，seed 逐图注册）＋
 * 怪兽×3 打样＋组件五件套实物（引用主路径同款 class 换皮效果）。
 * 样张参数唯一事实源：docs/art-style-bible.md。
 */
import { computed } from 'vue';
import sceneUrl from '../assets/art/scenes/u2-my-classmates.svg';
import blobUrl from '../assets/art/monsters/monster-blob.svg';
import tallUrl from '../assets/art/monsters/monster-tall.svg';
import trioUrl from '../assets/art/monsters/monster-trio.svg';
import u1Url from '../assets/art/scenes/u1-hello.svg';
import u3Url from '../assets/art/scenes/u3-my-face.svg';
import u4Url from '../assets/art/scenes/u4-i-can-sing.svg';
import u5Url from '../assets/art/scenes/u5-my-family.svg';
import u6Url from '../assets/art/scenes/u6-my-friends.svg';
import u7Url from '../assets/art/scenes/u7-lets-count.svg';
import u8Url from '../assets/art/scenes/u8-apples-please.svg';
import u9Url from '../assets/art/scenes/u9-may-i-have-a-pie.svg';
import u10Url from '../assets/art/scenes/u10-on-the-farm.svg';
import u11Url from '../assets/art/scenes/u11-in-the-zoo.svg';
import u12Url from '../assets/art/scenes/u12-in-the-park.svg';

/** Ticket 20 批量情景图（U1、U3-U12；U2 已在上方独立展示）。热点坐标见各 SVG 头注释 */
const unitScenes: Array<{ url: string; alt: string; desc: string }> = [
  { url: u1Url, alt: 'U1 Hello 情景图：上学清晨校门口挥手问好的两个孩子', desc: 'U1 Hello · hello/hi/morning/school · seed 101/201/301' },
  { url: u3Url, alt: 'U3 My face 情景图：画架大脸海报和摸眼睛摸耳朵的孩子', desc: 'U3 My face · face/eye/ear/touch · seed 103/203/303' },
  { url: u4Url, alt: 'U4 I can sing 情景图：唱歌跳舞看书画画四个孩子', desc: 'U4 I can sing · sing/dance/read/draw · seed 104/204/304' },
  { url: u5Url, alt: 'U5 My family 情景图：房子前的一家五口', desc: 'U5 My family · grandfather/grandmother/father/mother · seed 105/205/305' },
  { url: u6Url, alt: 'U6 My friends 情景图：高矮朋友和牵手小伙伴', desc: 'U6 My friends · tall/short/friend · seed 106/206/306' },
  { url: u7Url, alt: "U7 Let's count 情景图：课桌 1 2 3 数数卡和点数的孩子", desc: "U7 Let's count · one/two/three/count · seed 107/207/307" },
  { url: u8Url, alt: 'U8 Apples, please 情景图：水果摊后的摊主和苹果桃子橙子梨', desc: 'U8 Apples, please · apple/peach/orange/pear · seed 108/208/308' },
  { url: u9Url, alt: 'U9 May I have a pie 情景图：点心柜台的派汉堡披萨蛋糕与厨师和小吃客', desc: 'U9 May I have a pie? · pie/hamburger/pizza/cake · seed 109/209/309' },
  { url: u10Url, alt: 'U10 On the farm 情景图：谷仓栅栏前的奶牛小猪鸭子和鸡宝宝', desc: 'U10 On the farm · cow/pig/duck/chick · seed 110/210/310' },
  { url: u11Url, alt: 'U11 In the zoo 情景图：动物园里的小猴棕熊熊猫和老虎', desc: 'U11 In the zoo · monkey/bear/panda/tiger · seed 111/211/311' },
  { url: u12Url, alt: 'U12 In the park 情景图：公园里孩子牵着四只颜色气球', desc: 'U12 In the park · red/blue/yellow/green · seed 112/212/312' },
];

function hasArtParam(): boolean {
  return new URLSearchParams(window.location.search).get('art') === '1'
    || new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('art') === '1';
}

/** 双保险：import.meta.env.DEV（dev server）或 ?art=1 显式开关，二者其一才渲染 */
const devOnly = computed(() => import.meta.env.DEV || hasArtParam());

/** 色板：值从 :root token 运行时读取（本页不写死任何色值） */
const swatches = computed(() => {
  if (typeof window === 'undefined') return [];
  const s = getComputedStyle(document.documentElement);
  const read = (name: string, label: string, dark = false): { name: string; label: string; hex: string; dark: boolean } => ({
    name,
    label,
    hex: (s.getPropertyValue(name) || '').trim().toUpperCase(),
    dark,
  });
  return [
    read('--ke-sky', '蜡笔蓝'),
    read('--ke-coral', '蜡笔橘红'),
    read('--ke-sun', '蜡笔黄', true),
    read('--ke-sky-deep', '蓝文字档'),
    read('--ke-coral-deep', '红深档'),
    read('--ke-grass', '蜡笔绿', true),
    read('--ke-paper', '米纸底', true),
    read('--ke-card', '奶油纸卡', true),
    read('--ke-line', '暖棕线稿'),
    read('--ke-line-soft', '纸边淡棕', true),
    read('--ke-ink', '深墨正文'),
    read('--ke-ink-soft', '次级墨'),
    read('--ke-on-crayon', '蜡笔上文字'),
    read('--ke-ok-fg', '成功 fg'),
    read('--ke-no-fg', '错误 fg', true),
    read('--ke-warn-fg', '警示 fg'),
    read('--ke-paper-night', '夜纸底'),
  ];
});
</script>

<template>
  <section class="view art-preview">
    <header>
      <h2>美术样张预览（Ticket 15/20 · dev-only）</h2>
      <p class="nw-sub">
        案 C 蜡笔绘本 · 参数唯一事实源 docs/art-style-bible.md · U2 滤镜 seed 7/8/11 已锁 ·
        批量图 seed 逐图注册（101-112 系列）
      </p>
    </header>

    <template v-if="devOnly">
      <!-- 色板（token 运行时读值） -->
      <div class="art-swatches" data-testid="art-swatches">
        <div
          v-for="sw in swatches"
          :key="sw.name"
          class="art-swatch"
          :style="{ background: `var(${sw.name})`, color: sw.dark ? 'var(--ke-ink)' : 'var(--ke-on-crayon)' }"
        >
          <b>{{ sw.hex || '—' }}</b>
          <span>{{ sw.label }} <code>{{ sw.name }}</code></span>
        </div>
      </div>

      <!-- U2 情景图样张 -->
      <figure data-testid="art-scene">
        <img :src="sceneUrl" alt="U2 My classmates 情景图样张：教室里老师和同学们" style="width: 100%; height: auto; display: block; border-radius: 8px">
        <figcaption>
          U2「My classmates」单元情景图 · 900×560 · wobble(seed7)＋crayon(seed8)＋papergrain(seed11) ·
          热点圈＝涂改圈隐喻（<code>dasharray 10 8</code>），量产时坐标接词包热点配置
        </figcaption>
      </figure>

      <!-- 1 上其余 11 单元情景图（Ticket 20 批量；网格布局内联样式，禁动 main.css） -->
      <div
        data-testid="art-scenes-batch"
        style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px"
      >
        <figure v-for="s in unitScenes" :key="s.desc" style="margin: 0">
          <img :src="s.url" :alt="s.alt" style="width: 100%; height: auto; display: block; border-radius: 8px">
          <figcaption><code>{{ s.desc }}</code></figcaption>
        </figure>
      </div>

      <!-- 怪兽×3 打样（pixi 参数映射见各 SVG 注释与圣经 §7） -->
      <div class="art-swatches">
        <figure v-for="m in [
          { url: blobUrl, alt: '怪兽一号：圆胖双触角怪', desc: 'blob 圆胖怪 --ke-sky / drawEllipse(0,0,46,42)' },
          { url: tallUrl, alt: '怪兽二号：高瘦独角怪', desc: 'tall 高瘦怪 --ke-coral-deep / drawRoundedRect(-30,-64,60,128,30)' },
          { url: trioUrl, alt: '怪兽三号：三眼团圆怪', desc: 'trio 三眼怪 --ke-sun / drawCircle(0,0,44)' },
        ]" :key="m.desc" style="margin: 0">
          <img :src="m.url" :alt="m.alt" style="width: 100%; height: auto; display: block; border-radius: 8px; background: var(--ke-card); border: 2px solid var(--ke-line-soft); border-radius: 12px">
          <figcaption><code>{{ m.desc }}</code></figcaption>
        </figure>
      </div>

      <!-- 组件五件套实物（主路径同款 class，换皮效果直查） -->
      <figure data-testid="art-components">
        <figcaption style="margin: 0 0 12px">组件五件套（主路径同款 class）</figcaption>
        <div style="display: flex; flex-direction: column; gap: 14px; align-items: center">
          <div class="nw-card" style="width: 100%; max-width: 420px">
            <div class="nw-blocks">
              <button type="button" class="nw-block nw-block--c1">ap</button>
              <button type="button" class="nw-block nw-block--c2">ple</button>
              <button type="button" class="nw-block nw-block--c3 nw-block--heard">听</button>
            </div>
            <div class="nw-actions">
              <output class="nw-timer">09:41</output>
              <output class="nw-timer nw-timer--urgent">00:38</output>
            </div>
            <div class="rv-grid--fill" aria-label="拼写槽样例">
              <span>h</span><span class="rv-fill-slot rv-fill-slot--done">e</span><span class="rv-fill-slot">?</span><span>lo</span>
            </div>
            <div class="rv-fill-options">
              <button type="button" class="rv-fill-option">a</button>
              <button type="button" class="rv-fill-option rv-fill-option--hint">e</button>
              <button type="button" class="rv-fill-option">p</button>
            </div>
            <div class="nw-actions">
              <button type="button" class="nw-btn">主按钮</button>
              <button type="button" class="nw-btn nw-btn--ghost">ghost</button>
              <span class="nw-chip">词片</span>
            </div>
          </div>
        </div>
      </figure>
    </template>

    <!-- 生产构建未带 ?art=1：不渲染样张（儿童主路径隔离） -->
    <p v-else class="nw-hint" data-testid="art-locked">开发预览页：生产环境请带 ?art=1 访问。</p>
  </section>
</template>
