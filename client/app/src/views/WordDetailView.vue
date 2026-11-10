<script setup lang="ts">
/**
 * 词卡详情页（票 56；wordsfunny 词详情聚合页信息架构吸收）。
 *
 * 一页看全量：词头（大字＋英音标＋听词）→ 释义（词性徽章＋中文释义）→
 * 例句（双语＋点读）→ 拓展资料（词光 CC BY 4.0：用法提示/搭配/同义词/
 * 反义词/同根词——空段不渲染＝宁缺勿滥；页脚署名行）。数据源＝并集包
 * byId（跨包查词语义，票 35 并集面）＋atlasExtra 拓展。零引擎/server 触碰。
 */
import { onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { learningData } from '../store/learningData';
import { atlasExtraFor, ATLAS_SOURCE, type AtlasExtra } from '../store/atlasExtra';
import type { PackWord } from '../store/packs';
import { getSpeaker } from './newwords/tts';

const route = useRoute();
const speaker = getSpeaker();
const loading = ref(true);
const fatal = ref<string | null>(null);
const word = ref<PackWord | null>(null);
const extra = ref<AtlasExtra | null>(null);

/** 词→拓展资料按当前参数装载（onMounted＋参数变化双入口：vue-router 参数级
 * 导航复用组件实例，不 watch 则词与词之间跳转页面不刷新）。 */
async function load(): Promise<void> {
  try {
    await learningData.ensureReady(); // 幂等（HomeView/CheckinView 同款惯例）
    const entryId = String(route.params.entryId ?? '');
    word.value = learningData.pack.byId.get(entryId) ?? null;
    extra.value = word.value ? atlasExtraFor(word.value.word) : null;
  } catch (err) {
    fatal.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => route.params.entryId, load);

function speakText(text: string): void {
  void speaker.speak(text);
}
</script>

<template>
  <section class="view wd">
    <header class="wd-head">
      <RouterLink class="learning-back" to="/learning" data-testid="wd-back">← 学习流域</RouterLink>
    </header>

    <main v-if="loading" class="wd-card" data-testid="wd-loading">
      <p class="wd-hint">正在打开这个词…</p>
    </main>

    <main v-else-if="fatal" class="wd-card wd-card--end" data-testid="wd-fatal">
      <h3>数据加载失败</h3>
      <p class="wd-hint">{{ fatal }}</p>
    </main>

    <main v-else-if="!word" class="wd-card wd-card--end" data-testid="wd-missing">
      <h3>这个词不在词库里</h3>
      <p class="wd-hint">回学习流域看看别的词吧。</p>
    </main>

    <main v-else class="wd-card" data-testid="wd-card">
      <!-- 词头：大字＋听词＋音标 -->
      <div class="wd-headline" data-testid="wd-headline">
        <span class="wd-word" data-testid="wd-word">{{ word.word }}</span>
        <button type="button" class="wd-speak" data-testid="wd-speak-word" @click="speakText(word.word)">🔊 听词</button>
      </div>
      <p v-if="word.phoneticUk" class="wd-phonetic" data-testid="wd-phonetic">/{{ word.phoneticUk }}/</p>

      <!-- 释义（词性徽章＋中文；票 51 同款徽章） -->
      <div v-if="word.senses.length" class="wd-section" data-testid="wd-senses">
        <p
          v-for="(s, i) in word.senses"
          :key="i"
          class="wd-sense"
          :data-testid="`wd-sense-${i}`"
        >
          <span v-if="s.pos" class="nw-pos">{{ s.pos }}</span>
          <span class="wd-gloss">{{ s.gloss }}</span>
        </p>
      </div>

      <!-- 例句（双语＋逐句点读） -->
      <div v-if="word.examples.length" class="wd-section" data-testid="wd-examples">
        <p
          v-for="(ex, i) in word.examples"
          :key="i"
          class="wd-example"
          :data-testid="`wd-example-${i}`"
          role="button"
          @click="speakText(ex.en)"
        >
          <span class="wd-example-en">{{ ex.en }}</span>
          <span class="wd-example-zh">{{ ex.zh }}</span>
        </p>
      </div>

      <!-- 拓展资料（词光 CC BY 4.0；空段不渲染） -->
      <template v-if="extra">
        <p v-if="extra.tip" class="wd-extra" data-testid="wd-tip">
          <span class="wd-extra-label">用法提示</span>
          <span class="wd-extra-body">{{ extra.tip }}</span>
        </p>
        <div v-if="extra.col?.length" class="wd-extra" data-testid="wd-col">
          <span class="wd-extra-label">常用搭配</span>
          <span v-for="(c, i) in extra.col" :key="i" class="wd-extra-item">{{ c }}</span>
        </div>
        <div v-if="extra.syn?.length" class="wd-extra" data-testid="wd-syn">
          <span class="wd-extra-label">同义词</span>
          <span class="wd-extra-body">{{ extra.syn.join(' · ') }}</span>
        </div>
        <div v-if="extra.ant?.length" class="wd-extra" data-testid="wd-ant">
          <span class="wd-extra-label">反义词</span>
          <span class="wd-extra-body">{{ extra.ant.join(' · ') }}</span>
        </div>
        <div v-if="extra.fam?.length" class="wd-extra" data-testid="wd-fam">
          <span class="wd-extra-label">同根词</span>
          <span class="wd-extra-body">{{ extra.fam.join(' · ') }}</span>
        </div>
        <p class="wd-atlas-source" data-testid="wd-atlas-source">拓展资料：{{ ATLAS_SOURCE }}</p>
      </template>
    </main>
  </section>
</template>
