/**
 * 家长页统计派生（票 37；R17 落地 v1——池分布/今日到期/近 7 天时长/摘要行）。
 * FoldedState 只读投影，引擎零触碰。消费面必须位于算术门禁之后（E8：未通过时
 * 儿童进度数据零暴露——门禁本身在 ParentView，本函数不含门禁语义）。
 */

import type { FoldCounters, FoldedState, PoolId } from '@kidsenglish/engine';
import { deriveCheckin } from '../checkin/deriveCheckin';

const POOL_ORDER: readonly PoolId[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'graduated'];

/** 家长统计视图数据。 */
export interface ParentStats {
  /** 七池分布（固定顺序零填充；毕业池含月度抽样维护词）。 */
  pools: { pool: PoolId; count: number }[];
  /** 今日到期卡数（dueDate ≤ 今日且未暂停）。 */
  dueToday: number;
  /** 近 7 天双段用时秒（不含今日无记录日）。 */
  week: { newWords: number; review: number };
  /** 已引入词数（poolStates 长度）。 */
  introduced: number;
  /** 累计作答/答对/正确率（0 作答时正确率为 null 不呈现）。 */
  answered: number;
  correct: number;
  correctRate: number | null;
  /** 连续打卡天数（复用打卡页派生口径）。 */
  streak: number;
}

/** ISO 日期差（天）。 */
function isoDiffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * 家长统计派生（纯函数）。
 * @param folded 引擎折叠全量状态
 * @param todayIso 今日（ISO；与 learningData.todayIso 同源）
 */
export function deriveParentStats(folded: FoldedState, todayIso: string): ParentStats {
  const pools = POOL_ORDER.map((pool) => ({
    pool,
    count: folded.poolStates.filter((s) => s.pool === pool).length,
  }));
  const dueToday = folded.poolStates.filter(
    (s) => !s.paused && s.dueDate !== null && s.dueDate <= todayIso,
  ).length;
  const week = { newWords: 0, review: 0 };
  for (const d of folded.dailySummaries) {
    if (isoDiffDays(todayIso, d.date) >= 0 && isoDiffDays(todayIso, d.date) < 7) {
      week.newWords += d.segmentSeconds.newWords;
      week.review += d.segmentSeconds.review;
    }
  }
  const answered: number = (folded.counters as FoldCounters).answered;
  const correct: number = (folded.counters as FoldCounters).correct;
  return {
    pools,
    dueToday,
    week,
    introduced: folded.poolStates.length,
    answered,
    correct,
    correctRate: answered > 0 ? Math.round((correct / answered) * 100) : null,
    streak: deriveCheckin(folded.dailySummaries, todayIso).streak,
  };
}
