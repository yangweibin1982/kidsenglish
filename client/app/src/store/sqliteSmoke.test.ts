/**
 * 开工硬门（票 14 第 1 条）：@capacitor-community/sqlite ON CONFLICT/UPSERT＋
 * 批量事务冒烟——**Web 实现面**（票面「sql.js 内存库或等价」：sql.js 即社区插件
 * Web 实现的底层同款 SQL 引擎）。原生面向同一向量组在模拟器实装实跑
 * （LearningStore.open 首启门，logcat 留痕），两faces结果均落票报告。
 */

import { describe, expect, it } from 'vitest';
import { createSqlJsDriver, type StorageDriver } from './driver';
import { runSqliteSmokeVectors } from './smoke';

async function withDriver(fn: (driver: StorageDriver) => Promise<void>): Promise<void> {
  const driver = await createSqlJsDriver();
  try {
    await fn(driver);
  } finally {
    // sql.js 内存库随进程回收，无显式关闭面
  }
}

describe('开工硬门：sqlite ON CONFLICT/UPSERT＋批量事务冒烟（Web 面＝sql.js）', () => {
  it('五向量全绿（DO NOTHING 保首行 / DO UPDATE 前进 / REPLACE 对照 / 事务回滚 / 批量 200）', async () => {
    await withDriver(async (driver) => {
      const report = await runSqliteSmokeVectors(driver);
      expect(report.driver).toContain('sql.js');
      const failed = report.vectors.filter((v) => !v.pass);
      expect(failed, `未过向量: ${failed.map((v) => `${v.name}(${v.detail})`).join('；')}`).toEqual([]);
      expect(report.pass).toBe(true);
      expect(report.vectors.map((v) => v.name)).toEqual([
        'upsert_do_nothing_preserves_row',
        'upsert_do_update_advances_value',
        'insert_or_replace_contrast',
        'batch_transaction_all_or_nothing',
        'batch_transaction_bulk_200',
      ]);
    });
  });

  it('向量语义抽查：DO NOTHING 与 REPLACE 的语义分野直接断言', async () => {
    await withDriver(async (driver) => {
      await driver.exec('CREATE TABLE smoke_probe (k TEXT PRIMARY KEY, v TEXT)');
      await driver.run('INSERT INTO smoke_probe (k, v) VALUES (?, ?)', ['x', 'first']);
      await driver.run(
        'INSERT INTO smoke_probe (k, v) VALUES (?, ?) ON CONFLICT (k) DO NOTHING',
        ['x', 'second'],
      );
      const rows = await driver.select<{ v: string }>('SELECT v FROM smoke_probe WHERE k = ?', ['x']);
      expect(rows[0].v).toBe('first'); // 幂等语义：重投不改写
    });
  });
});
