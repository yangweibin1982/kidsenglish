/**
 * 到期集合（调度器输入侧）：给定全部卡池状态与日期，取当日到期卡。
 * 到期 = dueDate ≤ 当日 且未暂停；含 P0 当日重学卡（教学段候选）
 * 与毕业池中被月度抽样选中、被调用方设置了 dueDate 的维护卡。
 */

import type { CardPoolState, IsoDate, PlannedCard } from './types.js';
import { isValidIsoDate } from './date.js';

/** 当日到期卡（P0-P5 ＋已设到期日的毕业池抽样卡）。不排序，保持入参顺序。 */
export function collectDueCards(states: readonly CardPoolState[], date: IsoDate): CardPoolState[] {
  if (!isValidIsoDate(date)) throw new Error(`collectDueCards: invalid date ${JSON.stringify(date)}`);
  return states.filter((s) => !s.paused && s.dueDate !== null && s.dueDate <= date);
}

/** 到期卡 → 计划卡投影。 */
export function toPlannedCard(s: CardPoolState): PlannedCard {
  return {
    lexicalEntryId: s.lexicalEntryId,
    pool: s.pool,
    dueDate: s.dueDate,
    errorStreak: s.errorStreak,
  };
}
