import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/** 读取包版本（构建期注入，供首页接线证明显示） */
function readPkgVersion(pkgPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const appVersion = readPkgVersion(fileURLToPath(new URL('./package.json', import.meta.url)));
const engineVersion = readPkgVersion(fileURLToPath(new URL('../engine/package.json', import.meta.url)));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // sql.js 经 workspace 提升装在 client/node_modules（Vite root 之外）：dev 下
      // `?url` 解析出的 /node_modules/... 会被 SPA fallback 成 HTML（WASM magic word
      // 报错根因）。钉到真实路径后 dev 走 /@fs/ 内部 URL（server.fs.allow 默认已覆盖
      // workspace 根），构建期仍出哈希资产，语义不变。
      {
        find: 'sql.js',
        replacement: fileURLToPath(new URL('../node_modules/sql.js', import.meta.url)),
      },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __ENGINE_VERSION__: JSON.stringify(engineVersion),
  },
});
