/**
 * 自我对比榜（票 39；P-14 拍板口径：超昨天默认，家庭内排名须家长开启）。
 * 数据源＝dailySummaries 只读派生，引擎零触碰。
 */

import type { DailySummary } from '@kidsenglish/engine';

/** 单日对比切片。 */
export interface ComparisonSlice {
  points: number;
  answered: number;
  correct: number;
}

/** 对比视图。 */
export interface ComparisonView {
  today: ComparisonSlice;
  yesterday: ComparisonSlice;
  /** 超越态：up=今日积分＞昨日｜flat=持平且今日有学习｜none=今日未开始。 */
  status: 'up' | 'flat' | 'down' | 'none';
  /** 历史最佳连续打卡天数（全历史，非 30 天窗）。 */
  bestStreak: number;
}

function slice(s: DailySummary | undefined): ComparisonSlice {
  return {
    points: s ? s.correct + (s.completedOnTime ? 10 : 0) : 0,
    answered: s?.answered ?? 0,
    correct: s?.correct ?? 0,
  };
}

/** ISO 加 N 天（UTC）。 */
function addIsoDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 双段完成判定（与打卡页同口径：双段用时都有记录）。 */
function dayDone(s: DailySummary): boolean {
  return s.segmentSeconds.newWords > 0 && s.segmentSeconds.review > 0;
}

/**
 * 派生今日 vs 昨日对比（纯函数）。
 * @param dailySummaries 引擎折叠日摘要
 * @param todayIso 今日（ISO）
 */
export function deriveComparison(dailySummaries: readonly DailySummary[], todayIso: string): ComparisonView {
  const byDate = new Map(dailySummaries.map((d) => [d.date, d]));
  const today = slice(byDate.get(todayIso));
  const yesterday = slice(byDate.get(addIsoDays(todayIso, -1)));
  // 最佳连击：全历史排序游程（done 判据与打卡页一致）
  const sorted = [...dailySummaries].sort((a, b) => a.date.localeCompare(b.date));
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const s of sorted) {
    if (dayDone(s)) {
      run = prev !== null && addIsoDays(prev, 1) === s.date ? run + 1 : 1;
      best = Math.max(best, run);
      prev = s.date;
    } else {
      run = 0;
      prev = null;
    }
  }
  let status: ComparisonView['status'];
  if (today.points === 0 && today.answered === 0) status = 'none';
  else if (today.points > yesterday.points) status = 'up';
  else if (today.points === yesterday.points) status = 'flat';
  else status = 'down';
  return { today, yesterday, status, bestStreak: best };
}

/** 家庭排名行（聚合积分面；不含详细进度——E8 红线保持）。 */
export interface FamilyRankRow {
  childId: string;
  name: string;
  avatar: string;
  totalPoints: number;
  isSelf: boolean;
}

/**
 * 家庭积分排名（纯排序；开关语义在视图层——家长未开启不得调用）。
 * @param rows 每孩 { childId, name, avatar, totalPoints }（调用方逐孩取账本）
 * @param selfChildId 激活孩子 id
 */
export function deriveFamilyRank(
  rows: { childId: string; name: string; avatar: string; totalPoints: number }[],
  selfChildId: string,
): FamilyRankRow[] {
  return rows
    .map((r) => ({ ...r, isSelf: r.childId === selfChildId }))
    .sort((a, b) => b.totalPoints - a.totalPoints || a.childId.localeCompare(b.childId));
}
