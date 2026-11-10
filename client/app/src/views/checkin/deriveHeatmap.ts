/**
 * 半年学习热力图派生（票 55；wordsfunny 学习日历吸收面）。
 *
 * 数据源＝dailySummaries 只读派生（引擎零触碰）；积分口径复用票 38
 * dayPoints（答对 1 分＋按时完成 10 分）。输出 26 列×7 行网格：列＝周
 * （周一起到周日），末列含未来占位格（灰）。level 分档：0 无学习／1 微
 * （1-5 分）／2 中（6-15 分）／3 强（≥16 分）。纯函数独立导出＝回归测试面
 * （deriveCheckin 先例）。
 */

import type { DailySummary } from '@kidsenglish/engine';

/** 单格。 */
export interface HeatCell {
  date: string;
  points: number;
  /** 0 无学习／1 微（1-5）／2 中（6-15）／3 强（≥16）。 */
  level: 0 | 1 | 2 | 3;
  /** 晚于 today＝本周未来占位（视图灰显，不进图例语义）。 */
  future: boolean;
}

/** 热力网格视图。 */
export interface HeatmapView {
  /** 列＝周（自周一）；每列恒 7 格（含未来占位）。 */
  weeks: HeatCell[][];
  todayIso: string;
}

/** 单日积分＝答对×1＋按时完成×10（票 38 口径复用）。 */
function dayPoints(s: DailySummary): number {
  return s.correct + (s.completedOnTime ? 10 : 0);
}

function levelOf(points: number): HeatCell['level'] {
  if (points <= 0) return 0;
  if (points <= 5) return 1;
  if (points <= 15) return 2;
  return 3;
}

/** ISO 加 N 天（UTC，deriveComparison 同款）。 */
function addIsoDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** ISO 的星期几（周一=0…周日=6；UTC 日面）。 */
function weekdayIndexOf(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 周日=0
  return (day + 6) % 7;
}

/**
 * 派生热力网格（纯函数）。
 * @param dailySummaries 引擎折叠日摘要
 * @param todayIso 今日（ISO；锚定末列）
 * @param weekCount 周数（缺省 26＝半年）
 */
export function deriveHeatmap(
  dailySummaries: readonly DailySummary[],
  todayIso: string,
  weekCount = 26,
): HeatmapView {
  const byDate = new Map(dailySummaries.map((s) => [s.date, s]));
  const trailing = 6 - weekdayIndexOf(todayIso); // 本周补齐到周日
  const totalDays = weekCount * 7;
  const startIso = addIsoDays(todayIso, trailing - (totalDays - 1));
  const weeks: HeatCell[][] = [];
  let current: HeatCell[] = [];
  for (let i = 0; i < totalDays; i += 1) {
    const date = addIsoDays(startIso, i);
    const summary = byDate.get(date);
    const points = summary ? dayPoints(summary) : 0;
    current.push({
      date,
      points,
      level: levelOf(points),
      future: date > todayIso,
    });
    if (current.length === 7) {
      weeks.push(current);
      current = [];
    }
  }
  return { weeks, todayIso };
}
