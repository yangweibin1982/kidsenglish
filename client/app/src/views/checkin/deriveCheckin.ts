/**
 * 打卡页数据派生（票 36；dailySummaries 只读投影，引擎零触碰）。
 *
 * 三态语义（票面裁定）：
 * - done＝当日双段按时完成（DailySummary.completedOnTime，引擎裁决口径）；
 * - partial＝当日有学习但未双段全完成；
 * - none＝当日无学习记录。
 * streak 规则：当日双段全完成计入；断日清零重计；**今日未完成不清零**
 * （当日尚未结束，从昨日回溯计数）。
 */

import type { DailySummary } from '@kidsenglish/engine';

/** 单日打卡态。 */
export interface CheckinDay {
  /** ISO 日期。 */
  date: string;
  /** done=双段全完成｜partial=有学习未全完成｜none=无学习。 */
  state: 'done' | 'partial' | 'none';
  /** 双段合计用时秒。 */
  seconds: number;
}

/** 打卡页视图数据。 */
export interface CheckinCalendar {
  /** 近 30 天窗口（升序，含今日）。 */
  days: CheckinDay[];
  /** 今日（窗口末位；无记录即 none 态）。 */
  today: CheckinDay;
  /** 连续打卡天数（今日未完成时从昨日回溯）。 */
  streak: number;
}

const WINDOW_DAYS = 30;

/** ISO 日期加 N 天（UTC 算术，避免时区漂移；输入输出均 YYYY-MM-DD）。 */
function addIsoDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 派生打卡日历（纯函数；dailySummaries 按日期升序由 fold 保证，本函数不依赖顺序）。
 *
 * done 判据＝双段用时均有记录（segmentSeconds.newWords>0 且 review>0）——
 * 不用 completedOnTime：fold 对该字段是「同日后到者生效」（末段按时口径），
 * 单段完成的日子它也可能为 true，做不得「双段全完成」的判据（票 36 裁定口径）。
 * partial＝有学习记录（作答或任段用时）但双段未全完成。
 *
 * @param dailySummaries 引擎折叠日摘要
 * @param todayIso 今日（ISO；与 learningData.todayIso 同源）
 */
export function deriveCheckin(dailySummaries: readonly DailySummary[], todayIso: string): CheckinCalendar {
  const byDate = new Map(dailySummaries.map((d) => [d.date, d]));
  const days: CheckinDay[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = addIsoDays(todayIso, -i);
    const s = byDate.get(date);
    const learned = (s?.answered ?? 0) > 0 || (s ? s.segmentSeconds.newWords + s.segmentSeconds.review : 0) > 0;
    const bothDone = (s?.segmentSeconds.newWords ?? 0) > 0 && (s?.segmentSeconds.review ?? 0) > 0;
    days.push({
      date,
      state: bothDone ? 'done' : learned ? 'partial' : 'none',
      seconds: s ? s.segmentSeconds.newWords + s.segmentSeconds.review : 0,
    });
  }
  const today = days[days.length - 1];
  // streak：今日 done 从今日起算；否则从昨日回溯（今日未完成不清零）。
  const doneSet = new Set(days.filter((d) => d.state === 'done').map((d) => d.date));
  let cursor = doneSet.has(today.date) ? today.date : addIsoDays(todayIso, -1);
  let streak = 0;
  while (doneSet.has(cursor)) {
    streak += 1;
    cursor = addIsoDays(cursor, -1);
  }
  return { days, today, streak };
}
