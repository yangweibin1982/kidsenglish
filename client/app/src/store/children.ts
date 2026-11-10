/**
 * 多孩档案（票 34；R10/R11 落地 v1，本地优先）。
 *
 * 职责：孩子档案 CRUD（localStorage 持久；ke.children）＋激活指针
 * （ke.activeChild）＋首档 id='1' 与既有单孩数据无缝续接。
 * - server children 表（S7）与 /children API 已 stub，同步契约走 M3；
 *   本表本地优先，不阻塞学习主路径（离线优先纪律）。
 * - id 数字串自增（空表首档='1'，历史事件天然归属）。
 * - startPoint（R11 起点册次）本票只存字段；词包按绑定生效＝票 35。
 * - 跨孩子进度零暴露：本表只持名字/头像/册次，不触任何学习数据。
 */

import { clampDailyNewWords } from '@kidsenglish/engine';

/** 孩子档案（本地 v1；字段对齐 server Child 模型的客户端子集）。 */
export interface ChildProfile {
  /** 数字串（sync 契约 child_id int＝Number(id)）；空表首档='1'。 */
  id: string;
  /** 显示名（trim 后 1-12 字）。 */
  name: string;
  /** emoji 头像（AVATAR_POOL 内取值）。 */
  avatar: string;
  /** 起点册次（R11：'0起步'/'1上'/'1下'/…/'6下'）。 */
  startPoint: string;
  /** 每日新词目标（票 48/R17；引擎 spec S9 硬天花板入参，3-10；缺省＝引擎缺省档）。 */
  dailyNewWords?: number;
  /** 每段学习时长目标（票 50/R17 时长控制；段级时间盒分钟 5-30；缺省＝既有 10 分钟常量）。 */
  dailyMinutes?: number;
  /** 创建时刻（ISO）。 */
  createdAt: string;
}

/** 新建输入（id/createdAt 服务端生成）。 */
export type ChildDraft = Pick<ChildProfile, 'name' | 'avatar' | 'startPoint'>;

/** emoji 头像池（儿童友好动物系）＋票 60 图片头像位（特殊值 'freddy'）。
 * 版权留痕：形象原为用户提供的《Five Nights at Freddy's》角色图（家庭自用）；
 * 2026-11-11 开源化（票 62）替换为**原创蜡笔小熊**（生成脚本留档
 * .squad/tmp 同款参数），内部 id 沿用 'freddy' 保存量档头像选择连续性，
 * 形象已零第三方版权。 */
import freddyUrl from '../assets/avatars/freddy.png';

export const AVATAR_POOL = ['🦊', '🐰', '🐼', '🦁', '🐸', '🐵', '🐯', '🐨', '🐷', '🐙', 'freddy'] as const;

/** 图片头像映射（池内特殊值 → 打包资产 URL；emoji 值不在表中）。 */
const AVATAR_IMAGE_URLS: Record<string, string> = { freddy: freddyUrl };

/** 头像值 → 图片 URL；emoji 值返回 null（调用方文本直出）。 */
export function avatarImageUrl(a: string): string | null {
  return AVATAR_IMAGE_URLS[a] ?? null;
}

/**
 * 起点册次全集（R11；票 42 P-15 全学段扩围：0 起步＋小学 12 册＋初中 6 册＋高中 7 本）。
 * 高中按人教 2019 教材本命名（必修一~三/选必一~四）——「高一~高三」6 学期与 7 本
 * 非一一对应（各校进度不一），册次即课本册次。
 */
export const START_POINTS = [
  '0起步',
  '1上', '1下', '2上', '2下', '3上', '3下', '4上', '4下', '5上', '5下', '6上', '6下',
  '7上', '7下', '8上', '8下', '9上', '9下',
  '必修一', '必修二', '必修三', '选必一', '选必二', '选必三', '选必四',
] as const;

/** 册次分组（票 42 档案页选择面：三学段分组渲染；value 同 START_POINTS 成员）。 */
export const START_POINT_GROUPS: { label: string; points: readonly string[] }[] = [
  { label: '小学', points: ['0起步', '1上', '1下', '2上', '2下', '3上', '3下', '4上', '4下', '5上', '5下', '6上', '6下'] },
  { label: '初中', points: ['7上', '7下', '8上', '8下', '9上', '9下'] },
  { label: '高中', points: ['必修一', '必修二', '必修三', '选必一', '选必二', '选必三', '选必四'] },
];

const LS_CHILDREN = 'ke.children';
const LS_ACTIVE = 'ke.activeChild';

function readAll(): ChildProfile[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(LS_CHILDREN);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ChildProfile =>
        typeof c === 'object' && c !== null &&
        typeof (c as ChildProfile).id === 'string' &&
        typeof (c as ChildProfile).name === 'string',
    );
  } catch {
    return [];
  }
}

function writeAll(children: ChildProfile[]): void {
  window.localStorage.setItem(LS_CHILDREN, JSON.stringify(children));
}

function validateDraft(draft: ChildDraft): void {
  const name = draft.name.trim();
  if (name.length === 0 || name.length > 12) {
    throw new Error(`孩子名字须为 1-12 字，收到 ${name.length} 字`);
  }
  if (!(AVATAR_POOL as readonly string[]).includes(draft.avatar)) {
    throw new Error(`头像须取自头像池：${draft.avatar}`);
  }
  if (!(START_POINTS as readonly string[]).includes(draft.startPoint)) {
    throw new Error(`起点册次非法：${draft.startPoint}`);
  }
}

/** 档案列表（创建序）。 */
export function listChildren(): ChildProfile[] {
  return readAll();
}

/** 按 id 取档案；不存在返回 null。 */
export function getChild(id: string): ChildProfile | null {
  return readAll().find((c) => c.id === id) ?? null;
}

/** 新建档案：id 自增（空表首档='1'），并激活为新档案（孩子建完即学的自然流）。 */
export function addChild(draft: ChildDraft): ChildProfile {
  validateDraft(draft);
  const children = readAll();
  const nextId = children.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0) + 1;
  const child: ChildProfile = {
    id: String(nextId),
    name: draft.name.trim(),
    avatar: draft.avatar,
    startPoint: draft.startPoint,
    createdAt: new Date().toISOString(),
  };
  children.push(child);
  writeAll(children);
  window.localStorage.setItem(LS_ACTIVE, child.id);
  return child;
}

/** 更新档案（名字/头像/册次；id 不可变）。 */
export function updateChild(id: string, patch: Partial<ChildDraft>): ChildProfile {
  const children = readAll();
  const idx = children.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error(`档案不存在：${id}`);
  const merged: ChildDraft = {
    name: patch.name ?? children[idx].name,
    avatar: patch.avatar ?? children[idx].avatar,
    startPoint: patch.startPoint ?? children[idx].startPoint,
  };
  validateDraft(merged);
  children[idx] = { ...children[idx], ...merged };
  writeAll(children);
  return children[idx];
}

/**
 * 更新每日新词目标（票 48/R17；引擎 clampDailyNewWords 夹 3-10 后落档案）。
 * 消费链＝resolveDailyNewWordsCeiling 激活孩子分支 → buildDailyPlan 硬天花板。
 */
export function updateDailyNewWords(id: string, n: number): ChildProfile {
  const children = readAll();
  const idx = children.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error(`档案不存在：${id}`);
  children[idx] = { ...children[idx], dailyNewWords: clampDailyNewWords(n) };
  writeAll(children);
  return children[idx];
}

/** 每段时长目标边界（票 50；5-30 分钟，缺省＝既有 10 分钟时间盒常量）。 */
export const DAILY_MINUTES_MIN = 5;
export const DAILY_MINUTES_MAX = 30;
export const DAILY_MINUTES_DEFAULT = 10;

/**
 * 更新每段学习时长目标（票 50/R17 时长控制；本地 clamp 5-30 分钟）。
 * 消费链＝resolveSegmentTimeboxMs 当前孩子分支 → 视图时间盒（completedOnTime 语义随之）。
 */
export function updateDailyMinutes(id: string, n: number): ChildProfile {
  const children = readAll();
  const idx = children.findIndex((c) => c.id === id);
  if (idx < 0) throw new Error(`档案不存在：${id}`);
  const clamped = Math.min(DAILY_MINUTES_MAX, Math.max(DAILY_MINUTES_MIN, Math.round(n)));
  children[idx] = { ...children[idx], dailyMinutes: clamped };
  writeAll(children);
  return children[idx];
}

/** 删除档案：激活指针指向它时一并清除（回退解析链缺省）；允许删末档（回单孩缺省态）。 */
export function removeChild(id: string): void {
  const children = readAll().filter((c) => c.id !== id);
  writeAll(children);
  if (window.localStorage.getItem(LS_ACTIVE) === id) {
    window.localStorage.removeItem(LS_ACTIVE);
  }
}

/** 激活档案（切换孩子）；id 不存在即抛错（防静默串号）。 */
export function setActiveChild(id: string): void {
  if (!getChild(id)) throw new Error(`档案不存在：${id}`);
  window.localStorage.setItem(LS_ACTIVE, id);
}

/** 当前激活档案；无激活或缺省 id 无档案记录时返回 null（单孩遗留态）。 */
export function getActiveChild(): ChildProfile | null {
  const active = window.localStorage.getItem(LS_ACTIVE);
  if (!active) return null;
  return getChild(active);
}
