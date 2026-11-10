/**
 * 错题本派生（票 41；P-14 M2）。检索练习证据（P-08）：错过的词最需要再练。
 * 纯函数：FoldedState.poolStates 只读面 + 词包投影，零新持久化状态；
 * 重练调度归引擎（E1 答错当日追加变式题——错题词天然高优回流），本面只做可见。
 */

import type { CardPoolState } from '@kidsenglish/engine';
import type { PackWord } from '../../store/packs';

/** 错题本行：词投影 + 错误证据。 */
export interface WrongBookRow {
  entryId: string;
  word: string;
  meaning: string;
  /** 连续答错次数（S7 errorStreak；答对即清零）。 */
  errorStreak: number;
  /** 最近一次答错日（ISO；来自近 3 次作答缓存，理论上 errorStreak>0 时末条必为错）。 */
  lastWrongOn: string;
}

/** 错词判据：错误连击未清零 ∨ 近 3 次作答含答错（两来源并集）。 */
function isWrong(state: CardPoolState): boolean {
  return state.errorStreak > 0 || state.recentOutcomes.some((o) => !o.correct);
}

/**
 * 派生错题列表（纯函数）。
 * @param poolStates 引擎折叠池状态（当前档案——调用方保证 childId 隔离）
 * @param byId 词包索引（并集面；缺词容错＝回退 entryId/空义，不丢行）
 */
export function deriveWrongBook(
  poolStates: readonly CardPoolState[],
  byId: ReadonlyMap<string, PackWord>,
): WrongBookRow[] {
  const rows: WrongBookRow[] = [];
  for (const s of poolStates) {
    if (!isWrong(s)) continue; // 全对（含毕业词）不出现
    const wrongDays = s.recentOutcomes.filter((o) => !o.correct).map((o) => o.answeredOn);
    const lastWrongOn = wrongDays.length > 0 ? wrongDays.reduce((a, b) => (b > a ? b : a)) : '';
    const w = byId.get(s.lexicalEntryId);
    rows.push({
      entryId: s.lexicalEntryId,
      word: w?.word ?? s.lexicalEntryId, // 投影缺词容错：词形回退 id
      meaning: w?.meaning ?? '',
      errorStreak: s.errorStreak,
      lastWrongOn,
    });
  }
  // 最近答错降序 → 连错降序 → 词 id 字典序（确定性，禁依赖池序）
  rows.sort((a, b) => {
    if (a.lastWrongOn !== b.lastWrongOn) return b.lastWrongOn > a.lastWrongOn ? 1 : -1;
    if (a.errorStreak !== b.errorStreak) return b.errorStreak - a.errorStreak;
    return a.entryId < b.entryId ? -1 : 1;
  });
  return rows;
}
