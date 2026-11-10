/**
 * 多孩档案单测（票 34）：CRUD／id 自增首档='1'／激活指针语义／校验／
 * resolveChildId 解析链优先级（URL > activeChild > 旧 dev > '1'）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addChild,
  AVATAR_POOL,
  DAILY_MINUTES_DEFAULT,
  getChild,
  getActiveChild,
  listChildren,
  removeChild,
  setActiveChild,
  START_POINTS,
  updateChild,
  updateDailyMinutes,
  updateDailyNewWords,
} from './children';
import { resolveChildId, resolveDailyNewWordsCeiling, resolveSegmentTimeboxMs } from './profile';

const DRAFT = { name: '小橙', avatar: AVATAR_POOL[0], startPoint: '1上' };

/* node 环境手搭最小 localStorage/history 面（仓库惯例：不引 jsdom，同 pixiStage.test.ts） */
const lsBacking = new Map<string, string>();
const shimLocation = { search: '', hash: '' } as { search: string; hash: string };
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => lsBacking.get(k) ?? null,
    setItem: (k: string, v: string) => void lsBacking.set(k, v),
    removeItem: (k: string) => void lsBacking.delete(k),
    clear: () => void lsBacking.clear(),
  },
  history: {
    replaceState: (_a: unknown, _b: unknown, url: string) => {
      shimLocation.search = url.includes('?') ? `?${url.split('?')[1]}` : '';
    },
  },
  location: shimLocation,
};

beforeEach(() => {
  lsBacking.clear();
  shimLocation.search = '';
});

describe('children CRUD', () => {
  it('空表首档 id = 1（与既有单孩数据无缝续接）且自动激活', () => {
    const c = addChild(DRAFT);
    expect(c.id).toBe('1');
    expect(listChildren()).toHaveLength(1);
    expect(getActiveChild()?.id).toBe('1');
  });

  it('id 自增：第二档 = 2', () => {
    addChild(DRAFT);
    const c2 = addChild({ ...DRAFT, name: '小蓝' });
    expect(c2.id).toBe('2');
    expect(listChildren()).toHaveLength(2);
  });

  it('名字校验：空/超 12 字抛错且不落表', () => {
    expect(() => addChild({ ...DRAFT, name: '   ' })).toThrow();
    expect(() => addChild({ ...DRAFT, name: '一二三四五六七八九十王十一' })).toThrow();
    expect(listChildren()).toHaveLength(0);
  });

  it('头像/册次校验：池外值抛错', () => {
    expect(() => addChild({ ...DRAFT, avatar: '💀' })).toThrow();
    expect(() => addChild({ ...DRAFT, startPoint: '大一' })).toThrow();
    expect(START_POINTS).toContain('0起步');
    expect(START_POINTS).toContain('6下');
    expect(START_POINTS).toContain('7上'); // 票 42 全学段扩围
    expect(START_POINTS).toContain('选必四');
  });

  it('updateChild 合并更新且校验新值；未知 id 抛错', () => {
    const c = addChild(DRAFT);
    const updated = updateChild(c.id, { name: '小橙子', startPoint: '2上' });
    expect(updated.name).toBe('小橙子');
    expect(updated.avatar).toBe(DRAFT.avatar);
    expect(getChild(c.id)?.startPoint).toBe('2上');
    expect(() => updateChild('999', { name: 'x' })).toThrow();
    expect(() => updateChild(c.id, { avatar: '💀' })).toThrow();
  });

  it('removeChild：激活指向被删档时清除指针（回退缺省链）；末档可删', () => {
    const c1 = addChild(DRAFT);
    const c2 = addChild({ ...DRAFT, name: '小蓝' });
    setActiveChild(c1.id);
    removeChild(c1.id);
    expect(listChildren().map((x) => x.id)).toEqual([c2.id]);
    expect(window.localStorage.getItem('ke.activeChild')).toBeNull();
    expect(getActiveChild()).toBeNull();
    removeChild(c2.id);
    expect(listChildren()).toHaveLength(0);
  });

  it('setActiveChild：未知 id 抛错且不改指针', () => {
    addChild(DRAFT);
    expect(() => setActiveChild('999')).toThrow();
    expect(getActiveChild()?.id).toBe('1');
  });
});

describe('resolveChildId 解析链（票 34）', () => {
  it('无档案无开关＝缺省 1（既有单孩数据续接）', () => {
    expect(resolveChildId()).toBe('1');
  });

  it('激活档案优先于旧 dev 开关与缺省', () => {
    window.localStorage.setItem('ke.child', '9');
    addChild(DRAFT); // 自动激活 → ke.activeChild='1'
    expect(resolveChildId()).toBe('1');
  });

  it('URL ?child= 是最高优先（dev/探针覆盖）', () => {
    addChild(DRAFT);
    window.history.replaceState(null, '', '/?child=7');
    expect(resolveChildId()).toBe('7');
    window.history.replaceState(null, '', '/');
    expect(resolveChildId()).toBe('1');
  });
});

describe('updateDailyNewWords（票 48/R17 分孩目标）', () => {
  it('写入前先 clamp（3-10）：越界值收敛到边界', () => {
    const c = addChild(DRAFT);
    expect(updateDailyNewWords(c.id, 1).dailyNewWords).toBe(3);
    expect(updateDailyNewWords(c.id, 99).dailyNewWords).toBe(10);
    expect(updateDailyNewWords(c.id, 7).dailyNewWords).toBe(7);
  });

  it('未知 id 抛错；他孩字段不受影响', () => {
    const c1 = addChild(DRAFT);
    const c2 = addChild({ ...DRAFT, name: '小蓝' });
    updateDailyNewWords(c1.id, 4);
    expect(() => updateDailyNewWords('999', 5)).toThrow();
    expect(getChild(c2.id)?.dailyNewWords).toBeUndefined(); // 缺省语义＝未写即缺省档
  });
});

describe('resolveDailyNewWordsCeiling 解析链（票 48）', () => {
  it('无任何设定＝引擎缺省档', () => {
    expect(resolveDailyNewWordsCeiling()).toBe(5);
  });

  it('激活孩子档案字段优先于旧全局 ke.daily', () => {
    const c = addChild(DRAFT);
    window.localStorage.setItem('ke.daily', '6');
    updateDailyNewWords(c.id, 3);
    expect(resolveDailyNewWordsCeiling()).toBe(3);
  });

  it('无档案字段时回退旧全局 ke.daily；再无＝缺省', () => {
    addChild(DRAFT); // 未设字段
    window.localStorage.setItem('ke.daily', '8');
    expect(resolveDailyNewWordsCeiling()).toBe(8);
    window.localStorage.removeItem('ke.daily');
    expect(resolveDailyNewWordsCeiling()).toBe(5);
  });

  it('URL ?daily 仍为最高优先（dev/探针链不破坏）', () => {
    const c = addChild(DRAFT);
    updateDailyNewWords(c.id, 3);
    window.history.replaceState(null, '', '/?daily=9');
    expect(resolveDailyNewWordsCeiling()).toBe(9);
    window.history.replaceState(null, '', '/');
    expect(resolveDailyNewWordsCeiling()).toBe(3);
  });

  it('多孩隔离：切激活档案即切目标', () => {
    const c1 = addChild(DRAFT);
    const c2 = addChild({ ...DRAFT, name: '小蓝' });
    updateDailyNewWords(c1.id, 4);
    updateDailyNewWords(c2.id, 9);
    setActiveChild(c1.id);
    expect(resolveDailyNewWordsCeiling()).toBe(4);
    setActiveChild(c2.id);
    expect(resolveDailyNewWordsCeiling()).toBe(9);
  });
});

describe('updateDailyMinutes（票 50/R17 时长控制）', () => {
  it('写入前 clamp（5-30）：越界值收敛到边界', () => {
    const c = addChild(DRAFT);
    expect(updateDailyMinutes(c.id, 1).dailyMinutes).toBe(5);
    expect(updateDailyMinutes(c.id, 99).dailyMinutes).toBe(30);
    expect(updateDailyMinutes(c.id, 15).dailyMinutes).toBe(15);
  });

  it('未知 id 抛错；缺省常量＝10', () => {
    const c = addChild(DRAFT);
    expect(() => updateDailyMinutes('999', 10)).toThrow();
    expect(DAILY_MINUTES_DEFAULT).toBe(10);
    expect(getChild(c.id)?.dailyMinutes).toBeUndefined();
  });
});

describe('resolveSegmentTimeboxMs 解析链（票 50）', () => {
  it('无档案字段＝null（视图回退既有常量）', () => {
    addChild(DRAFT);
    expect(resolveSegmentTimeboxMs()).toBeNull();
  });

  it('档案字段＝分钟×60000；多孩隔离走 resolveChildId 同源（URL ?child 即切）', () => {
    addChild(DRAFT); // id 1
    const c2 = addChild({ ...DRAFT, name: '小蓝' }); // id 2，自动激活
    updateDailyMinutes('1', 5);
    updateDailyMinutes(c2.id, 20);
    expect(resolveSegmentTimeboxMs()).toBe(20 * 60_000); // 激活＝2
    window.history.replaceState(null, '', '/?child=1');
    expect(resolveSegmentTimeboxMs()).toBe(5 * 60_000); // URL ?child 同源切换（L33）
    window.history.replaceState(null, '', '/');
  });
});
