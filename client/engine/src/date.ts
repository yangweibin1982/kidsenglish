/**
 * 纯日期工具：只处理 ISO 日期字符串（YYYY-MM-DD），无时区、无系统时钟。
 * 引擎内禁止 Date.now()/new Date() 无参调用——一切日期由调用方显式传入。
 */

import type { IsoDate } from './types.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 解析 ISO 日期为 UTC 午夜的 Date（仅作日历算术用，不读系统时钟）。 */
function parse(date: IsoDate): Date {
  const m = DATE_RE.exec(date);
  if (!m) {
    throw new Error(`invalid ISO date: ${JSON.stringify(date)}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== mo - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new Error(`invalid calendar date: ${JSON.stringify(date)}`);
  }
  return parsed;
}

/** 格式化 UTC 午夜 Date 为 ISO 日期字符串。 */
function format(d: Date): IsoDate {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** date + n 天的 ISO 日期（n 可为负）。 */
export function addDays(date: IsoDate, n: number): IsoDate {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return format(d);
}

/** daysBetween(b, a) = a - b 的天数差（a 晚于 b 为正）。 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = parse(to).getTime() - parse(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** 星期几：0=周日 … 6=周六（日历日，不涉时区）。 */
export function dayOfWeek(date: IsoDate): number {
  return parse(date).getUTCDay();
}

/** 周末判定（R4：周末不加新只复习）。周六或周日。 */
export function isWeekend(date: IsoDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/** 月份键（YYYY-MM），毕业池月度抽样用。 */
export function monthKey(date: IsoDate): string {
  return date.slice(0, 7);
}

/** 校验 ISO 日期格式（含日历有效性）。 */
export function isValidIsoDate(date: string): date is IsoDate {
  return DATE_RE.test(date) && (() => {
    try {
      parse(date);
      return true;
    } catch {
      return false;
    }
  })();
}
