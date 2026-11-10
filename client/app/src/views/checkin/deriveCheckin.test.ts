/**
 * 打卡派生单测（票 36）：三态归类／streak 规则（今日未完成不清零/断日清零）／
 * 30 天窗口／用时聚合。
 */

import { describe, expect, it } from 'vitest';
import type { DailySummary } from '@kidsenglish/engine';
import { deriveCheckin } from './deriveCheckin';

/** 夹具工厂：DayDigest 缺省合法值。 */
function mk(date: string, over: Partial<DailySummary> = {}): DailySummary {
  return {
    date,
    answered: 10,
    correct: 8,
    completedOnTime: true,
    segmentSeconds: { newWords: 300, review: 200 },
    starsEarned: 0,
    shardsEarned: 0,
    ...over,
  };
}

describe('deriveCheckin 三态', () => {
  it('零记录＝全 none＋今日 none＋streak 0', () => {
    const c = deriveCheckin([], '2026-11-05');
    expect(c.days).toHaveLength(30);
    expect(c.today.state).toBe('none');
    expect(c.streak).toBe(0);
  });

  it('今日双段完成＝done（秒数聚合双段）', () => {
    const c = deriveCheckin([mk('2026-11-05')], '2026-11-05');
    expect(c.today.state).toBe('done');
    expect(c.today.seconds).toBe(500);
    expect(c.streak).toBe(1);
  });

  it('单段有用时＝partial（completedOnTime 是末段按时口径，做不得双段判据）', () => {
    const c = deriveCheckin(
      [mk('2026-11-05', { completedOnTime: false, segmentSeconds: { newWords: 120, review: 0 } })],
      '2026-11-05',
    );
    expect(c.today.state).toBe('partial');
    expect(c.streak).toBe(0);
  });

  it('双段用时都有＝done（v1 完成即可，不强制按时）', () => {
    const c = deriveCheckin(
      [mk('2026-11-05', { completedOnTime: false, segmentSeconds: { newWords: 120, review: 200 } })],
      '2026-11-05',
    );
    expect(c.today.state).toBe('done');
  });

  it('仅作答无用时记录＝partial（answered>0 兜底）', () => {
    const c = deriveCheckin(
      [mk('2026-11-05', { completedOnTime: false, segmentSeconds: { newWords: 0, review: 0 } })],
      '2026-11-05',
    );
    expect(c.today.state).toBe('partial');
  });

  it('窗口滚动：昨日记录在窗内，窗外记录不呈现', () => {
    const c = deriveCheckin([mk('2026-10-05'), mk('2026-11-04')], '2026-11-05');
    const dates = c.days.map((d) => d.date);
    expect(dates).toContain('2026-11-04'); // 昨日
    expect(dates).not.toContain('2026-10-05'); // 窗外（窗首=今日-29=2026-10-07）
    expect(c.days[0].date).toBe('2026-10-07'); // 窗口首日=今日-29
  });
});

describe('streak 规则', () => {
  it('今日未完成不清零：昨日 done → streak 1', () => {
    const c = deriveCheckin([mk('2026-11-04')], '2026-11-05'); // 今日无记录
    expect(c.today.state).toBe('none');
    expect(c.streak).toBe(1);
  });

  it('断日清零重计：前天 done＋昨日 none＋今日 done → streak 1（不连前天）', () => {
    const c = deriveCheckin(
      [mk('2026-11-03'), mk('2026-11-05')],
      '2026-11-05',
    );
    expect(c.streak).toBe(1);
  });

  it('连续多日累加：昨前两日 done＋今日未完成 → streak 2', () => {
    const c = deriveCheckin(
      [mk('2026-11-03'), mk('2026-11-04')],
      '2026-11-05',
    );
    expect(c.streak).toBe(2);
  });

  it('今日 done＋昨日 done → streak 2', () => {
    const c = deriveCheckin(
      [mk('2026-11-04'), mk('2026-11-05')],
      '2026-11-05',
    );
    expect(c.streak).toBe(2);
  });
});
