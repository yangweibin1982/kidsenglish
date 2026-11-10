/**
 * 拼词表扬语库（spec v1.2 S9：随机英语表扬语 ≥5 条预设、混过程性表扬；票 28 取 8 条）。
 *
 * pickPraise：洗牌循环队列——把预设洗牌后逐条发尽再重洗，保证「随机且不连续
 * 重复」；跨循环边界（上轮末条 vs 新轮首条）相同时把新首条挪到队尾再取。
 */
import { shuffled, type Rand } from './fill';

/** 预设表扬语（8 条，全过程性英语短句；新增条目须保语句独立可听） */
export const PRAISE_LINES: readonly string[] = [
  'Great job!',
  'Well done!',
  'You did it!',
  'Awesome!',
  'Super!',
  'Amazing!',
  'Nice work!',
  'Excellent!',
];

/** 模块级循环队列（单用户 UI 单实例即可；确定性测试走属性断言，不依赖队列起点） */
let cycle: string[] = [];
let lastPicked = '';

/** 取下一条表扬语：随机、不连续重复（rand 仅在重洗时消费，可注入测试） */
export function pickPraise(rand: Rand = Math.random): string {
  if (cycle.length === 0) {
    cycle = shuffled(PRAISE_LINES, rand);
    if (cycle.length > 1 && cycle[0] === lastPicked) {
      cycle.push(cycle.shift()!); // 跨循环边界防连续重复
    }
  }
  const next = cycle.shift()!;
  lastPicked = next;
  return next;
}
