/**
 * golden 向量集断言（spec S1「共享事件向量 golden 测试」；Ticket 12 落盘，
 * Ticket 13 Py 投影读同一目录同一文件——路径即契约，禁静默改名）。
 *
 * 覆盖：spec 钉死四类必含（升×降×时钟偏斜×并发升降）＋三类性质向量
 * （计数单调/幂等重放/乱序到达）＋扩展向量（S9 daily_plan_adjusted 投影＋
 * 未知类型前向兼容）。每向量 {name, events, expected}，expected 为完整
 * FoldedState 快照，人工可读可审计。
 *
 * 除逐向量断言外，对全部向量跑三类机器性质：乱序打乱恒等、重复投递恒等、
 * 墙钟（occurred_at）改写恒等——排序键不含墙钟、不依赖到达顺序的直接证明。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fold } from '../src/index.js';
import type { FoldedState, LearningEvent } from '../src/index.js';
import { mulberry32 } from './helpers.js';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), 'golden');

/** 向量清单＝票面四类必含＋三类性质＋S9/前向兼容扩展；增删须同步 TS/Py 两端。 */
const MANIFEST: ReadonlyArray<{ file: string; category: string }> = [
  { file: 'promote.json', category: '四类必含·升' },
  { file: 'demote.json', category: '四类必含·降' },
  { file: 'clock-skew.json', category: '四类必含·时钟偏斜' },
  { file: 'concurrent-promote-demote.json', category: '四类必含·并发升降' },
  { file: 'counters-monotonic.json', category: '性质·计数单调' },
  { file: 'idempotent-replay.json', category: '性质·幂等重放' },
  { file: 'out-of-order-arrival.json', category: '性质·乱序到达' },
  { file: 'plan-adjusted-unknown.json', category: '扩展·S9 调整投影＋未知类型前向兼容' },
];

interface GoldenVector {
  name: string;
  events: LearningEvent[];
  expected: FoldedState;
}

function loadVector(file: string): GoldenVector {
  const raw: unknown = JSON.parse(readFileSync(join(goldenDir, file), 'utf8'));
  expect(raw).toBeTypeOf('object');
  const rec = raw as Record<string, unknown>;
  expect(rec['name']).toBeTypeOf('string');
  expect(rec['name']).not.toBe('');
  expect(Array.isArray(rec['events'])).toBe(true);
  expect(rec['events'].length).toBeGreaterThan(0);
  expect(rec['expected']).toBeTypeOf('object');
  return raw as GoldenVector;
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

describe('golden 向量集（TS 侧断言；票 13 Py 侧读同一文件）', () => {
  it('目录文件清单与 MANIFEST 全等（增删向量须同步两端，禁静默漂移）', () => {
    const files = readdirSync(goldenDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files).toEqual([...MANIFEST.map((m) => m.file)].sort());
  });

  it('spec 钉死四类必含全部在档：升×降×时钟偏斜×并发升降', () => {
    const categories = MANIFEST.map((m) => m.category).join('｜');
    for (const required of ['·升', '·降', '·时钟偏斜', '·并发升降']) {
      expect(categories).toContain(required);
    }
  });

  it('三类性质向量全部在档：计数单调/幂等重放/乱序到达', () => {
    const categories = MANIFEST.map((m) => m.category).join('｜');
    for (const required of ['计数单调', '幂等重放', '乱序到达']) {
      expect(categories).toContain(required);
    }
  });

  it('每向量 name 唯一且非空（人工可读可审计）', () => {
    const names = MANIFEST.map((m) => loadVector(m.file).name);
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const { file, category } of MANIFEST) {
    it(`[${category}] ${file}：fold(events) 深等于 expected 快照`, () => {
      const v = loadVector(file);
      expect(fold(v.events)).toEqual(v.expected);
    });
  }

  it('乱序到达性质：每向量 20 种子打乱 → fold 恒等 expected', () => {
    for (const { file } of MANIFEST) {
      const v = loadVector(file);
      const rnd = mulberry32(42);
      for (let k = 0; k < 20; k++) {
        expect(fold(shuffled(v.events, rnd))).toEqual(v.expected);
      }
    }
  });

  it('幂等重放性质：每向量事件集整体重复 2 遍/3 遍 → fold 恒等 expected', () => {
    for (const { file } of MANIFEST) {
      const v = loadVector(file);
      expect(fold([...v.events, ...v.events])).toEqual(v.expected);
      expect(fold([...v.events, ...v.events, ...v.events])).toEqual(v.expected);
    }
  });

  it('墙钟不可感：occurred_at 全部改写 → fold 恒等 expected（排序键不含墙钟）', () => {
    for (const { file } of MANIFEST) {
      const v = loadVector(file);
      const rewritten = v.events.map((e, i) => ({
        ...e,
        occurred_at: i % 2 === 0 ? '1970-01-01T00:00:00Z' : '2099-12-31T23:59:59Z',
      }));
      expect(fold(rewritten)).toEqual(v.expected);
    }
  });
});
