/**
 * 家长学习周报派生（票 47；R17 周报图表化，G1 M3）。
 * 数据源＝dailySummaries 只读派生（foldedState 同源，零新取数），引擎零触碰。
 * 积分口径复用票 38（答对 1 分＋按时完成 10 分），纯重算不入账本。
 * 消费面必须位于算术门禁之后（E8，同 deriveParentStats 纪律）。
 */

import type { DailySummary } from '@kidsenglish/engine';

/** 周报单日切片（缺日零填充；minutes 双段合计分钟，显示层取整）。 */
export interface WeeklyDay {
  date: string;
  minutes: number;
  answered: number;
  /** 当日正确率（0 作答＝null 不呈现）。 */
  correctRate: number | null;
}

/** 周合计切片。 */
export interface WeeklyTotals {
  minutes: number;
  answered: number;
  points: number;
}

export type WeeklyDeltaStatus = 'up' | 'flat' | 'down' | 'none';

/** 单维周对比（up=本周＞上周｜flat=±10% 内持平｜down=回落｜none=本周无数据）。 */
export interface WeeklyDelta {
  thisWeek: number;
  lastWeek: number;
  status: WeeklyDeltaStatus;
}

/** 周报视图。 */
export interface ParentWeekly {
  /** 近 7 天日粒度序列（升序，含今日；缺日零填充）。 */
  days: WeeklyDay[];
  thisWeek: WeeklyTotals;
  lastWeek: WeeklyTotals;
  /** 三维周对比（时长/作答量/积分）。 */
  deltas: { minutes: WeeklyDelta; answered: WeeklyDelta; points: WeeklyDelta };
  /** 本周正确率（0 作答＝null 不呈现）。 */
  correctRate: number | null;
}

/** 单日积分＝答对数×1＋按时完成×10（票 38 口径重算，账本语义归 derivePoints）。 */
function dayPoints(s: DailySummary): number {
  return s.correct + (s.completedOnTime ? 10 : 0);
}

function dayMinutes(s: DailySummary): number {
  return (s.segmentSeconds.newWords + s.segmentSeconds.review) / 60;
}

/** ISO 加 N 天（UTC；与 deriveComparison 同实现）。 */
function addIsoDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function totals(days: readonly DailySummary[]): WeeklyTotals {
  let minutes = 0;
  let answered = 0;
  let points = 0;
  for (const s of days) {
    minutes += dayMinutes(s);
    answered += s.answered;
    points += dayPoints(s);
  }
  return { minutes, answered, points };
}

/**
 * 单维 delta（票 47 口径）：本周无数据＝none；上周零基线且本周有＝up；
 * 变幅 ≤10%（含持平）＝flat；其余按方向 up/down。
 */
function delta(thisWeek: number, lastWeek: number): WeeklyDelta {
  let status: WeeklyDeltaStatus;
  if (thisWeek === 0) status = 'none';
  else if (lastWeek === 0) status = 'up';
  else {
    const change = Math.abs(thisWeek - lastWeek) / lastWeek;
    status = change <= 0.1 ? 'flat' : thisWeek > lastWeek ? 'up' : 'down';
  }
  return { thisWeek, lastWeek, status };
}

/**
 * 派生学习周报（纯函数）。
 * @param dailySummaries 引擎折叠日摘要（升序由 fold 保证，本函数不依赖顺序）
 * @param todayIso 今日（ISO；与 learningData.todayIso 同源）
 */
export function deriveParentWeekly(
  dailySummaries: readonly DailySummary[],
  todayIso: string,
): ParentWeekly {
  const byDate = new Map(dailySummaries.map((d) => [d.date, d]));
  const thisDays: DailySummary[] = [];
  const lastDays: DailySummary[] = [];
  const series: WeeklyDay[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = addIsoDays(todayIso, -i);
    const s = byDate.get(date);
    if (s) thisDays.push(s);
    series.push({
      date,
      minutes: s ? dayMinutes(s) : 0,
      answered: s?.answered ?? 0,
      correctRate: s && s.answered > 0 ? Math.round((s.correct / s.answered) * 100) : null,
    });
  }
  for (let i = 7; i < 14; i += 1) {
    const s = byDate.get(addIsoDays(todayIso, -i));
    if (s) lastDays.push(s);
  }
  const thisWeek = totals(thisDays);
  const lastWeek = totals(lastDays);
  const answeredTotal = thisWeek.answered;
  const correctSum = thisDays.reduce((sum, s) => sum + s.correct, 0);
  return {
    days: series,
    thisWeek,
    lastWeek,
    deltas: {
      minutes: delta(thisWeek.minutes, lastWeek.minutes),
      answered: delta(thisWeek.answered, lastWeek.answered),
      points: delta(thisWeek.points, lastWeek.points),
    },
    correctRate: answeredTotal > 0 ? Math.round((correctSum / answeredTotal) * 100) : null,
  };
}
