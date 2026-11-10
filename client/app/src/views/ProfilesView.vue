<template>
  <section class="view profiles">
    <header class="profiles-head">
      <h1 class="profiles-title">谁要学英语？</h1>
      <RouterLink class="profiles-back" to="/" data-testid="profiles-back">← 首页</RouterLink>
    </header>

    <!-- 档案卡网格（点击＝激活切换；激活卡描边高亮；跨孩子进度零暴露——只显名字/头像/册次） -->
    <div class="profile-grid" data-testid="profile-grid">
      <button
        v-for="child in children"
        :key="child.id"
        class="profile-card"
        :class="{ 'profile-card--active': child.id === activeId }"
        :data-testid="`profile-card-${child.id}`"
        type="button"
        @click="onSelect(child)"
      >
        <span class="profile-avatar" aria-hidden="true">
          <img v-if="avatarImageUrl(child.avatar)" :src="avatarImageUrl(child.avatar)!" class="avatar-img" alt="" />
          <template v-else>{{ child.avatar }}</template>
        </span>
        <span class="profile-name">{{ child.name }}</span>
        <span class="profile-point">{{ child.startPoint }}</span>
        <span v-if="child.id === activeId" class="profile-badge">学习中</span>
        <span
          class="profile-edit"
          role="button"
          tabindex="0"
          :data-testid="`profile-edit-${child.id}`"
          @click.stop="onEdit(child)"
          @keydown.enter.stop="onEdit(child)"
        >编辑</span>
      </button>

      <button class="profile-card profile-card--add" type="button" data-testid="profile-add" @click="onAdd">
        <span class="profile-avatar" aria-hidden="true">➕</span>
        <span class="profile-name">新建档案</span>
      </button>
    </div>

    <!-- 新建/编辑表单（名字＋头像池＋起点册次；圣经 token 配色，触控 ≥56px） -->
    <form v-if="editing" class="profile-form" data-testid="profile-form" @submit.prevent="onSave">
      <h2 class="profile-form-title">{{ draftId === null ? '新建档案' : '编辑档案' }}</h2>

      <label class="profile-field">
        <span class="profile-label">名字</span>
        <input
          v-model="draftName"
          class="profile-input"
          data-testid="profile-name"
          type="text"
          maxlength="12"
          placeholder="孩子的名字或小名"
        />
      </label>

      <div class="profile-field">
        <span class="profile-label">选个头像</span>
        <div class="avatar-grid" data-testid="avatar-grid">
          <button
            v-for="a in AVATAR_POOL"
            :key="a"
            class="avatar-cell"
            :class="{ 'avatar-cell--active': a === draftAvatar }"
            type="button"
            :data-testid="`avatar-${a}`"
            @click="draftAvatar = a"
          ><img v-if="avatarImageUrl(a)" :src="avatarImageUrl(a)!" class="avatar-img avatar-img--cell" alt="" /><template v-else>{{ a }}</template></button>
        </div>
      </div>

      <div class="profile-field">
        <span class="profile-label">上几年级啦（选课本册次）</span>
        <div class="point-groups" data-testid="point-grid">
          <div v-for="g in START_POINT_GROUPS" :key="g.label" class="point-group">
            <span class="point-group-label">{{ g.label }}</span>
            <div class="point-grid">
              <button
                v-for="p in g.points"
                :key="p"
                class="point-cell"
                :class="{ 'point-cell--active': p === draftStartPoint }"
                type="button"
                :data-testid="`point-${p}`"
                @click="draftStartPoint = p"
              >{{ p }}</button>
            </div>
          </div>
        </div>
        <p v-if="resolvePackId(draftStartPoint).fallback" class="profile-hint">
          这个册次的词包还在准备中，先从一年级课本开始学哦
        </p>
      </div>

      <p v-if="formError" class="profile-error" data-testid="profile-error">{{ formError }}</p>

      <div class="profile-actions">
        <button class="profile-save" type="submit" data-testid="profile-save">
          {{ draftId === null ? '就学这个！' : '保存' }}
        </button>
        <button class="profile-cancel" type="button" data-testid="profile-cancel" @click="editing = false">
          先不了
        </button>
      </div>
      <button
        v-if="draftId !== null"
        class="profile-remove"
        type="button"
        data-testid="profile-remove"
        @click="onRemove"
      >删除这个档案</button>
    </form>
  </section>
</template>

<script setup lang="ts">
/**
 * 多孩档案页（票 34；R10 主界面头像切换/R11 起点自选 v1）。
 * 档案卡点击＝激活切换（整页回首页重建会话状态：learningData/SyncClient 的
 * childId 在启动时绑定，重载是防串号的最强保证）；新建/编辑表单共用一份 draft。
 * 跨孩子进度零暴露：本页只消费 children store（名字/头像/册次），不触学习数据。
 */
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  addChild,
  AVATAR_POOL,
  avatarImageUrl,
  getChild,
  listChildren,
  removeChild,
  setActiveChild,
  START_POINT_GROUPS,
  updateChild,
  type ChildProfile,
} from '../store/children';
import { resolvePackId } from '../store/packs';

const router = useRouter();
const children = ref<ChildProfile[]>([]);
const activeId = ref<string | null>(null);

const editing = ref(false);
const draftId = ref<string | null>(null); // null＝新建
const draftName = ref('');
const draftAvatar = ref<string>(AVATAR_POOL[0]);
const draftStartPoint = ref<string>('1上');
const formError = ref('');

function reloadList(): void {
  children.value = listChildren();
  activeId.value = window.localStorage.getItem('ke.activeChild');
}

/** 首启引导：零档案时直接展开新建表单（首页守卫会把首次使用带到这里）。 */
onMounted(() => {
  reloadList();
  if (children.value.length === 0) onAdd();
});

function onAdd(): void {
  draftId.value = null;
  draftName.value = '';
  draftAvatar.value = AVATAR_POOL[0];
  draftStartPoint.value = '1上';
  formError.value = '';
  editing.value = true;
}

function onEdit(child: ChildProfile): void {
  draftId.value = child.id;
  draftName.value = child.name;
  draftAvatar.value = child.avatar;
  draftStartPoint.value = child.startPoint;
  formError.value = '';
  editing.value = true;
}

async function onSave(): Promise<void> {
  formError.value = '';
  const draft = {
    name: draftName.value,
    avatar: draftAvatar.value,
    startPoint: draftStartPoint.value,
  };
  try {
    if (draftId.value === null) {
      addChild(draft); // 新建即激活（children.ts 语义）
    } else {
      updateChild(draftId.value, draft);
    }
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err);
    return;
  }
  editing.value = false;
  await goHomeWithActive();
}

/** 激活切换：写指针→整页回首页（重载重建全部单例状态，防跨孩子串号）。 */
async function onSelect(child: ChildProfile): Promise<void> {
  try {
    setActiveChild(child.id);
  } catch {
    return;
  }
  await goHomeWithActive();
}

async function goHomeWithActive(): Promise<void> {
  reloadList();
  await router.isReady();
  window.location.hash = '#/';
  window.location.reload();
}

/** 删除档案（低频操作挂编辑表单底部；确认后删除，激活指针 children.ts 负责清除）。 */
function onRemove(): void {
  if (draftId.value === null) return;
  const child = getChild(draftId.value);
  if (!child) return;
  if (!window.confirm(`确定删除「${child.name}」的档案吗？学习记录会保留，但档案要重新建。`)) return;
  removeChild(draftId.value);
  editing.value = false;
  reloadList();
}
</script>
