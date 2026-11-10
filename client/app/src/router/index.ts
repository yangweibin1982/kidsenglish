import { createRouter, createWebHashHistory } from 'vue-router';

/**
 * 五域路由骨架（Ticket 04 占位，空页面即可）：
 * 学习流域 / 引擎域 / 演出域 / 同步域 / 家长域。
 * 使用 hash history：Capacitor WebView 内刷新不 404，原生壳更稳。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
    },
    {
      // 多孩档案选择/创建/切换（票 34；R10 主界面头像切换；壳层 chrome 隐藏见 App.vue）
      path: '/profiles',
      name: 'profiles',
      component: () => import('../views/ProfilesView.vue'),
    },
    {
      // 打卡页（票 36；R8/R9 打卡可见面 v1；dailySummaries 只读派生）
      path: '/checkin',
      name: 'checkin',
      component: () => import('../views/CheckinView.vue'),
    },
    {
      // 错题本页（票 41；poolStates 错词只读派生；重练归引擎不建队列）
      path: '/wrongbook',
      name: 'wrongbook',
      component: () => import('../views/wrongbook/WrongBookView.vue'),
    },
    {
      // 学习流域父级布局（Ticket 10 注册）：Ticket 11 复用本 children 追加复习段
      path: '/learning',
      component: () => import('../views/LearningShell.vue'),
      children: [
        {
          path: '',
          name: 'learning',
          component: () => import('../views/LearningView.vue'),
        },
        {
          // 新词段（spec v1.1 S9 三步卡片流；Ticket 10 注册）
          path: 'new-words',
          name: 'learning-new-words',
          component: () => import('../views/newwords/NewWordsView.vue'),
        },
        {
          // 复习段（spec v1.1 S9 答题驱动射击；路由由指挥官预注册，Ticket 11 只交视图）
          path: 'review',
          name: 'learning-review',
          component: () => import('../views/review/ReviewView.vue'),
        },
        {
          // 词卡详情页（票 56；wordsfunny 信息架构吸收＋词光拓展；并集包查询）
          path: 'word/:entryId',
          name: 'learning-word-detail',
          component: () => import('../views/WordDetailView.vue'),
        },
      ],
    },
    {
      path: '/engine',
      name: 'engine',
      component: () => import('../views/EngineView.vue'),
    },
    {
      path: '/stage',
      name: 'stage',
      component: () => import('../views/StageView.vue'),
    },
    {
      path: '/sync',
      name: 'sync',
      component: () => import('../views/SyncView.vue'),
    },
    {
      path: '/parent',
      name: 'parent',
      component: () => import('../views/ParentView.vue'),
    },
    {
      // 【dev-only】美术样张预览（Ticket 15）：不注册进任何导航，儿童主路径零触达；
      // 组件内双保险守卫——仅 dev server 或生产构建显式带 ?art=1 才渲染样张。
      path: '/art-preview',
      name: 'art-preview',
      component: () => import('../views/ArtPreviewView.vue'),
    },
  ],
});

export default router;
