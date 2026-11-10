/**
 * 家长混淆图谱派生（票 49；R17 第三面收口）。
 * 数据源＝answer 事件载荷（learningData.answerPayloads 只读缓存；wrong_picks 为
 * 票 49 加字段，旧事件无此字段即跳过），fold/server 零触碰。
 * 消费面必须位于算术门禁之后（E8，同 deriveParentStats 纪律）。
 */

import type { AnswerEventPayload } from '../../store/learningData';

/** 单条混淆对（期望字母→误选字母；小写归一）。 */
export interface ConfusionRow {
  expected: string;
  picked: string;
  count: number;
}

/** 混淆图谱视图。 */
export interface ConfusionMap {
  /** 混淆对降序（按次数，次按字母序）；前 topN 条。 */
  rows: ConfusionRow[];
  /** 错选总次数（全历史）。 */
  totalWrong: number;
  /** 出现错选的作答日数。 */
  daysWithWrong: number;
}

/**
 * 派生混淆图谱（纯函数）。
 * @param payloads answer 事件载荷列表（含无 wrong_picks 的旧事件——跳过）
 * @param topN 顶对截断（缺省 8）
 */
export function deriveParentConfusion(
  payloads: readonly AnswerEventPayload[],
  topN = 8,
): ConfusionMap {
  const counts = new Map<string, ConfusionRow>();
  const days = new Set<string>();
  let totalWrong = 0;
  for (const p of payloads) {
    for (const [expected, picked] of p.wrong_picks ?? []) {
      const key = `${expected}>${picked}`;
      const row = counts.get(key);
      if (row) row.count += 1;
      else counts.set(key, { expected, picked, count: 1 });
      totalWrong += 1;
      days.add(p.answered_on);
    }
  }
  const rows = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.expected.localeCompare(b.expected) || a.picked.localeCompare(b.picked))
    .slice(0, topN);
  return { rows, totalWrong, daysWithWrong: days.size };
}
