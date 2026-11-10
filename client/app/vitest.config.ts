import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Ticket 11 起 views 纳入；票 38 起放宽为 views 全域（逐域枚举到头——
    // points/wrongbook 等激励域新增不再改配置）；store/sync 维持显式。
    include: [
      'src/views/**/*.test.ts',
      'src/store/**/*.test.ts',
      'src/sync/**/*.test.ts',
    ],
    // 确定性要求：与引擎包同款——禁随机序列干扰可复现输出
    sequence: { shuffle: false },
  },
});
