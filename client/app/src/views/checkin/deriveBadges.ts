/**
 * 成就徽章派生（票 40；R8「星星/连击/徽章体系保留」）。
 * 全派生自 FoldedState 只读面，零新持久化状态；游戏内得分不驱动徽章（P-11 边界）。
 * 新增徽章＝往 BADGES 数组追加一项（可扩展，结构不动）。
 */

import type { DailySummary, FoldedState, PoolId } from '@kidsenglish/engine';
import { deriveComparison } from '../points/deriveComparison';

/** 徽章定义（静态表）。 */
export interface BadgeDef {
  id: string;
  icon: string;
  name: string;
  /** 达成提示语（达成时展示）。 */
  earnedText: string;
  /** 判定：FoldedState＋今日 ISO → 达成与否。 */
  test: (s: FoldedState, todayIso: string) => boolean;
}

/** 双段完成判定（与打卡页/对比榜同口径）。 */
function dayDone(s: DailySummary): boolean {
  return s.segmentSeconds.newWords > 0 && s.segmentSeconds.review > 0;
}

export const BADGES: readonly BadgeDef[] = [
  { id: 'first-checkin', icon: '🌟', name: '第一天打卡', earnedText: '第一次双段全完成！', test: (s) => s.dailySummaries.some(dayDone) },
  { id: 'perfect-day', icon: '🎯', name: '满分日', earnedText: '一天全部答对（≥5 题）！', test: (s) => s.dailySummaries.some((d) => d.answered >= 5 && d.correct === d.answered) },
  { id: 'streak-3', icon: '🔥', name: '连击 3 天', earnedText: '连续 3 天打卡！', test: (s, t) => deriveComparison(s.dailySummaries, t).bestStreak >= 3 },
  { id: 'streak-7', icon: '⚡', name: '连击 7 天', earnedText: '连续 7 天打卡！', test: (s, t) => deriveComparison(s.dailySummaries, t).bestStreak >= 7 },
  { id: 'streak-14', icon: '🌋', name: '连击 14 天', earnedText: '连续 14 天打卡！', test: (s, t) => deriveComparison(s.dailySummaries, t).bestStreak >= 14 },
  { id: 'words-10', icon: '📖', name: '学会 10 词', earnedText: '词库已有 10 个词！', test: (s) => s.poolStates.length >= 10 },
  { id: 'words-50', icon: '📗', name: '学会 50 词', earnedText: '词库已有 50 个词！', test: (s) => s.poolStates.length >= 50 },
  { id: 'words-100', icon: '📚', name: '学会 100 词', earnedText: '词库已有 100 个词！', test: (s) => s.poolStates.length >= 100 },
  { id: 'graduated-first', icon: '🎓', name: '第一颗毕业星', earnedText: '第一个词毕业啦！', test: (s) => s.poolStates.some((p) => p.pool === ('graduated' satisfies PoolId)) },
];

/** 徽章视图行。 */
export interface BadgeRow extends BadgeDef {
  earned: boolean;
}

/**
 * 派生徽章墙（纯函数；固定定义序）。
 * @param folded 引擎折叠全量状态
 * @param todayIso 今日（ISO）
 */
export function deriveBadges(folded: FoldedState, todayIso: string): BadgeRow[] {
  return BADGES.map((def) => ({ ...def, earned: def.test(folded, todayIso) }));
}
