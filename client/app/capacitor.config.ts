import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kidsenglish.app',
  appName: '战机英语',
  webDir: 'dist',
  // 票 14 实走发现：https://localhost 壳源 fetch http://localhost:8000（adb reverse
  // 回环到宿主 server）＝混合内容，WebView 默认拦（Failed to fetch）。
  // 局域网部署面（S1/S4 内网拓扑）显式放行；公网不适用（R15 红线独立兜底）。
  android: { allowMixedContent: true },
};

export default config;
