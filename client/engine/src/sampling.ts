/**
 * 毕业池月度抽样接口（R3：毕业后每月 10% 抽样维护）。
 *
 * 纯函数、确定性：不用 Math.random，用 FNV-1a 哈希
 * (lexicalEntryId ＋ 月份键 ＋ 盐) 落在阈值内即入选——
 * 同月内同一批毕业词重复调用结果一致（调用方据此打 graduatedSampledMonth 标记），
 * 跨月自动换组，约 10%（rate 可调）。
 */

import type { CardPoolState, IsoDate } from './types.js';
import { monthKey } from './date.js';

/** 默认抽样率 10%（R3）。 */
export const GRADUATED_SAMPLE_RATE = 0.1;

/** FNV-1a 32 位哈希（确定性，跨端一致）。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 选出本月应抽样的毕业词。
 * @param graduated 毕业池状态集合（引擎不筛选，调用方传 pool==='graduated' 的卡）
 * @param date      抽样日（ISO 日期，决定月份键）
 * @param rate      抽样率，默认 0.1
 * @param salt      可选盐（多孩子隔离等场景；默认无）
 */
export function selectGraduatedSample(
  graduated: readonly CardPoolState[],
  date: IsoDate,
  rate: number = GRADUATED_SAMPLE_RATE,
  salt: string = '',
): CardPoolState[] {
  if (!(rate > 0 && rate < 1)) throw new Error(`selectGraduatedSample: rate must be in (0,1), got ${rate}`);
  const key = monthKey(date);
  const threshold = rate * 0xffffffff;
  return graduated.filter((s) => {
    if (s.pool !== 'graduated') return false;
    return fnv1a(`${salt}|${s.childId}|${s.lexicalEntryId}|${key}`) <= threshold;
  });
}
