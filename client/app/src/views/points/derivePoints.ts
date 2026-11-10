/**
 * 学习行为积分账本（票 38；P-14 拍板口径）。
 *
 * **边界（钉死）**：本账本＝学习行为积分（答对 1 题 1 分＋当日按时完成加成
 * 10 分）；游戏内得分（雷霆战机 score，P-11 决策 3）纯演出面，**不入账**——
 * 游戏表现不污染学习信号。数据源＝dailySummaries 只读派生，零落库零新事件
 * （跨端一致性由事件流保证，引擎零触碰）。
 */

import type { DailySummary } from '@kidsenglish/engine';

/** 单日积分。 */
export interface PointsDay {
  date: string;
  points: number;
}

/** 积分账本视图。 */
export interface PointsLedger {
  /** 累计积分（全历史）。 */
  total: number;
  /** 今日积分（无记录＝0）。 */
  today: number;
  /** 昨日积分（无记录＝0）。 */
  yesterday: number;
  /** 按日积分（升序；仅有记录日）。 */
  days: PointsDay[];
}

/** 单日积分＝答对数×1＋按时完成×10。 */
function dayPoints(s: DailySummary): number {
  return s.correct + (s.completedOnTime ? 10 : 0);
}

/**
 * 派生积分账本（纯函数）。
 * @param dailySummaries 引擎折叠日摘要（升序由 fold 保证，本函数不依赖顺序）
 */
export function derivePoints(dailySummaries: readonly DailySummary[], todayIso: string): PointsLedger {
  const days = dailySummaries
    .map((s) => ({ date: s.date, points: dayPoints(s) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const total = days.reduce((sum, d) => sum + d.points, 0);
  const byDate = new Map(days.map((d) => [d.date, d.points]));
  const shift = (n: number): number => {
    const t = Date.parse(`${todayIso}T00:00:00Z`) - n * 86_400_000;
    return byDate.get(new Date(t).toISOString().slice(0, 10)) ?? 0;
  };
  return { total, today: shift(0), yesterday: shift(1), days };
}
