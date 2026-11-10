import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 确定性要求：测试内禁用 vitest 的随机种子特性干扰可复现输出
    sequence: { shuffle: false },
  },
});
