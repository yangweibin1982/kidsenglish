# @kidsenglish/app — 战机英语应用壳

Vue3 + Vite + Capacitor 空壳工程（Ticket 04）。npm workspaces 由上级目录 `client/package.json` 管理（engine + app）。

## 一条命令重跑完整构建

前置：Node ≥ 20；出 APK 需 JDK 21 + Android SDK（环境缺失时见下方「环境归因」）。

```bash
cd E:\kidsenglish\client
npm install              # 首次或依赖变更后
npm run apk:debug        # 引擎 build → 应用 build → cap sync → gradlew assembleDebug
```

产物：`client/app/android/app/build/outputs/apk/debug/app-debug.apk`

只跑 Web 构建（不出 APK）：

```bash
cd E:\kidsenglish\client\app
npm run build            # vue-tsc 类型检查 + vite build（VALIDATE 1 硬门）
npm run dev              # 浏览器 dev server
```

## 结构

- `src/views/` — 四域占位路由骨架：学习流域 / 引擎域 / 演出域 / 同步域 / 家长域
- `src/App.vue` — 末尾 `#stage-canvas-root` 为 S5 演出域独立画布挂载点（与 Vue 树并存，本票不实现 PixiJS）
- `src/views/HomeView.vue` — 首页 import `@kidsenglish/engine` 实调纯函数（接线证明）＋版本号
- `android/` — `npx cap add android` 生成的原生工程（已入库；构建输出已 ignore）

## 环境归因（2026-10-24 构建时快照）

本机缺 JDK 与 Android SDK（`java`/`adb`/`sdkmanager` 均不存在，`ANDROID_HOME` 未设），
APK 构建待环境补齐后重跑 `npm run apk:debug`。补齐口径：JDK 21（Temurin）＋
Android SDK Platform 35＋Build-Tools 35＋platform-tools（Capacitor 7 要求），
装 C 盘默认位置（`%USERPROFILE%`／`%LOCALAPPDATA%`），禁迁 E 盘（E 盘余量保护）。
