/**
 * 学习档案与连接配置（票 14；S4 令牌装机手工配置）。
 *
 * 全部取值带 dev 开关（优先级：URL 查询参数 > localStorage > 构建期环境变量 >
 * 缺省），供开发/验收注入，生产缺省即用：
 * - childId：孩子档案 id（S7 children.id；当前服务端单孩部署缺省 '1'）。
 * - serverBase：同步服务地址。Capacitor 原生 WebView 里 localhost 指设备自身，
 *   实走用 `adb reverse tcp:8000 tcp:8000` 把设备 8000 转回宿主机 server。
 * - familyToken：家庭令牌（S4；X-Family-Token 头）。缺省从构建期
 *   VITE_FAMILY_TOKEN 注入（client/app/.env.local，已被 .gitignore 的 *.local
 *   覆盖不入库）。
 * - dailyNewWords：家长每日新词天花板（S9；家长域票未建，暂取引擎缺省档）。
 * - mockMode：开发模式开关（?mock=1）——mockPlan/dayPlan 的退役夹具仍可经此
 *   启用供 UI 开发（报告「开关设计」节）。
 */

import { DAILY_NEW_WORDS_DEFAULT, DAILY_NEW_WORDS_MAX, DAILY_NEW_WORDS_MIN } from '@kidsenglish/engine';
import { getChild } from './children';

/** 本地存储键前缀（localStorage dev 开关）。 */
const LS_PREFIX = 'ke.';

function queryParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const fromSearch = new URLSearchParams(window.location.search).get(name);
  if (fromSearch !== null) return fromSearch;
  // hash 路由（Capacitor）下查询串在 #/path?x=1
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(name);
}

function localStorageGet(key: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(LS_PREFIX + key);
  } catch {
    return null;
  }
}

/**
 * 孩子档案 id（数字串；sync 契约 child_id int＝Number(childId)）。
 * 解析链（票 34）：URL ?child=（dev/探针覆盖）> 激活档案（ke.activeChild，
 * children.ts 写面）> 旧 dev 开关（ke.child）> 缺省 '1'（既有单孩数据续接）。
 */
export function resolveChildId(): string {
  return (
    queryParam('child') ??
    localStorageGet('activeChild') ??
    localStorageGet('child') ??
    '1'
  );
}

/** 同步服务基址。 */
export function resolveServerBase(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  return queryParam('server') ?? localStorageGet('server') ?? fromEnv ?? 'http://localhost:8000';
}

/** 家庭令牌（S4）。 */
export function resolveFamilyToken(): string {
  const fromEnv = import.meta.env.VITE_FAMILY_TOKEN as string | undefined;
  return queryParam('token') ?? localStorageGet('token') ?? fromEnv ?? '';
}

/**
 * 家长每日新词天花板（S9 硬上限；票 48/R17 分孩目标）。
 * 解析链：URL ?daily（dev/探针覆盖，最高）> 当前孩子档案 dailyNewWords
 * （孩子身份与 resolveChildId 同源——URL ?child 与激活指针一致，票 48 探针实证
 * 分叉会串目标）> 旧全局 ke.daily（向后兼容）> 引擎缺省档。
 */
export function resolveDailyNewWordsCeiling(): number {
  const fromQuery = queryParam('daily');
  const fromChild = getChild(resolveChildId())?.dailyNewWords;
  const raw = fromQuery ?? (fromChild !== undefined ? String(fromChild) : null) ?? localStorageGet('daily');
  if (raw === null) return DAILY_NEW_WORDS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DAILY_NEW_WORDS_DEFAULT;
  return Math.min(DAILY_NEW_WORDS_MAX, Math.max(DAILY_NEW_WORDS_MIN, Math.round(n)));
}

/**
 * 每段时间盒毫秒解析（票 50/R17 时长控制；时间盒常量在客户端视图层）。
 * 链：URL 无覆盖面（?box 是毫秒级演示钩子，视图层保持最高优先）→ 当前孩子档案
 * dailyMinutes（身份与 resolveChildId 同源，L33 纪律）→ null（视图用既有常量）。
 */
export function resolveSegmentTimeboxMs(): number | null {
  const minutes = getChild(resolveChildId())?.dailyMinutes;
  return minutes === undefined ? null : minutes * 60_000;
}

/** 开发模式开关：?mock=1 启用退役 mock 夹具（UI 开发/无数据演示）。 */
export function isMockMode(): boolean {
  return queryParam('mock') === '1';
}
