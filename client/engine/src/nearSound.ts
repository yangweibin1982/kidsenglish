/**
 * 音近词引入间隔约束接口（R6：学习期音近词引入日隔开 ≥3 天）。
 *
 * 本票只留接口：混淆词对数据来自错因埋点/内容标注（后续票供给），
 * 这里提供纯函数判定——候选新词若其音近伙伴在 [date−minGap, date] 窗口内
 * 已被引入，则本日不得引入（挡下不顺延惩罚，过窗自动放行）。
 */

import type { CardPoolState, IsoDate, NearSoundContext } from './types.js';
import { daysBetween } from './date.js';

/** 默认最小引入间隔（R6：≥3 天）。 */
export const NEAR_SOUND_MIN_GAP_DAYS = 3;

function normalize(word: string): string {
  return word.trim().toLowerCase();
}

/** 两词是否构成登记的音近对。 */
export function isNearSoundPair(a: string, b: string, pairs: ReadonlyArray<[string, string]>): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return pairs.some(([p, q]) => {
    const np = normalize(p);
    const nq = normalize(q);
    return (np === x && nq === y) || (np === y && nq === x);
  });
}

/**
 * 找出 candidate 在窗口内已引入的音近伙伴引入日（未找到返回 null）。
 * 窗口 = [date − (minGap−1), date]：伙伴引入距今不满 minGap 天即命中。
 */
export function findConflictingIntro(
  candidate: string,
  ctx: NearSoundContext,
  date: IsoDate,
): { partner: string; introducedOn: IsoDate; gapDays: number } | null {
  const minGap = ctx.minGapDays ?? NEAR_SOUND_MIN_GAP_DAYS;
  for (const [word, introducedOn] of Object.entries(ctx.introDates)) {
    if (normalize(word) === normalize(candidate)) continue;
    if (!isNearSoundPair(candidate, word, ctx.pairs)) continue;
    const gap = daysBetween(introducedOn, date);
    if (gap < minGap) {
      return { partner: word, introducedOn, gapDays: gap };
    }
  }
  return null;
}

/**
 * 过滤候选新词：音近伙伴未满引入间隔的挡下（不惩罚，过窗自动放行）。
 * 用于教学段选词前的约束检查；被挡的卡保持 P0 原状（调用方留待后续日期）。
 */
export function filterNewWordsByNearSoundSpacing(
  candidates: readonly CardPoolState[],
  ctx: NearSoundContext,
  date: IsoDate,
): { allowed: CardPoolState[]; blocked: CardPoolState[] } {
  const allowed: CardPoolState[] = [];
  const blocked: CardPoolState[] = [];
  const pendingIntros: Record<string, IsoDate> = { ...ctx.introDates };
  for (const c of candidates) {
    const conflict = findConflictingIntro(c.lexicalEntryId, { ...ctx, introDates: pendingIntros }, date);
    if (conflict) {
      blocked.push(c);
    } else {
      allowed.push(c);
      // 同批候选之间的间隔也生效：视为当日引入，约束同批其余成员
      pendingIntros[c.lexicalEntryId] = date;
    }
  }
  return { allowed, blocked };
}
