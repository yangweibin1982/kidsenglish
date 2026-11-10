/**
 * 开工硬门：@capacitor-community/sqlite ON CONFLICT/UPSERT＋批量事务冒烟向量
 * （G4 移交，04 票选型定案的前置验证；票 14 第 1 条）。
 *
 * 向量组（语义对照 SQLite 官方语义，任何 StorageDriver 实现上跑同一组）：
 * 1. ON CONFLICT DO NOTHING：重复主键投递**保首行**（同步幂等语义——同 event_id
 *    重放零改写）；
 * 2. ON CONFLICT DO UPDATE：游标 UPSERT 语义（只前进覆盖）；
 * 3. INSERT OR REPLACE 语义对照：REPLACE＝删旧插新（值被覆盖）——两语法解析与
 *    执行均正确，且语义确有差别（04 票担忧的解析 bug 若存在即在此暴露）；
 * 4. 批量事务全有全无：事务内含违规语句 → 整体回滚，零残留；
 * 5. 批量事务批量写入：200 行事务提交后全部在位。
 *
 * 跑法：Web 面＝sql.js 内存库（vitest 单测，即本文件消费）；原生面＝模拟器实装
 * 后由 LearningStore.open 的首启门对同一向量组实跑（结果落 meta 冒烟标记＋日志）。
 * 不过关＝按 04 票降级序呈报（禁自行换插件）。
 */

import type { StorageDriver } from './driver';

export interface SmokeVectorResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SmokeReport {
  pass: boolean;
  driver: string;
  vectors: SmokeVectorResult[];
}

const V = (name: string, pass: boolean, detail: string): SmokeVectorResult => ({
  name,
  pass,
  detail,
});

/** 对给定驱动跑全量冒烟向量（smoke_* 临时表，跑完即清）。 */
export async function runSqliteSmokeVectors(driver: StorageDriver): Promise<SmokeReport> {
  const vectors: SmokeVectorResult[] = [];
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS smoke_upsert (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL
    );
    DELETE FROM smoke_upsert;
  `);

  // 1. ON CONFLICT DO NOTHING：同主键重投保首行（幂等）
  try {
    await driver.run('INSERT INTO smoke_upsert (k, v) VALUES (?, ?)', ['a', 1]);
    await driver.run(
      'INSERT INTO smoke_upsert (k, v) VALUES (?, ?) ON CONFLICT (k) DO NOTHING',
      ['a', 2],
    );
    const rows = await driver.select<{ v: number }>('SELECT v FROM smoke_upsert WHERE k = ?', ['a']);
    const count = await driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM smoke_upsert');
    const ok = rows.length === 1 && Number(rows[0].v) === 1 && Number(count[0].n) === 1;
    vectors.push(
      V(
        'upsert_do_nothing_preserves_row',
        ok,
        ok ? '重投未改写首行（v=1），行数=1' : `got v=${rows[0]?.v} rows=${count[0]?.n}`,
      ),
    );
  } catch (err) {
    vectors.push(V('upsert_do_nothing_preserves_row', false, String(err)));
  }

  // 2. ON CONFLICT DO UPDATE：游标 UPSERT（只前进覆盖）
  try {
    await driver.run(
      'INSERT INTO smoke_upsert (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
      ['a', 7],
    );
    const rows = await driver.select<{ v: number }>('SELECT v FROM smoke_upsert WHERE k = ?', ['a']);
    const ok = rows.length === 1 && Number(rows[0].v) === 7;
    vectors.push(V('upsert_do_update_advances_value', ok, ok ? 'v=7' : `got v=${rows[0]?.v}`));
  } catch (err) {
    vectors.push(V('upsert_do_update_advances_value', false, String(err)));
  }

  // 3. INSERT OR REPLACE 语义对照：删旧插新（值被覆盖）
  try {
    await driver.run('INSERT OR REPLACE INTO smoke_upsert (k, v) VALUES (?, ?)', ['a', 9]);
    const rows = await driver.select<{ v: number }>('SELECT v FROM smoke_upsert WHERE k = ?', ['a']);
    const count = await driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM smoke_upsert');
    const ok = rows.length === 1 && Number(rows[0].v) === 9 && Number(count[0].n) === 1;
    vectors.push(
      V(
        'insert_or_replace_contrast',
        ok,
        ok ? 'REPLACE 覆盖为 v=9（与 DO NOTHING 语义分野成立）' : `got v=${rows[0]?.v}`,
      ),
    );
  } catch (err) {
    vectors.push(V('insert_or_replace_contrast', false, String(err)));
  }

  // 4. 批量事务全有全无（含违规语句整体回滚）
  try {
    await driver.exec('BEGIN');
    await driver.run('INSERT INTO smoke_upsert (k, v) VALUES (?, ?)', ['b1', 1]);
    await driver.run('INSERT INTO smoke_upsert (k, v) VALUES (?, ?)', ['b2', 2]);
    let violated = false;
    try {
      await driver.run('INSERT INTO smoke_upsert (k, v) VALUES (?, ?)', ['b1', 3]); // PK 冲突
    } catch {
      violated = true;
    }
    await driver.exec('ROLLBACK');
    const count = await driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM smoke_upsert');
    const ok = violated && Number(count[0].n) === 1; // 只剩向量 3 留下的 a 行
    vectors.push(
      V(
        'batch_transaction_all_or_nothing',
        ok,
        ok
          ? '违规语句触发整体回滚，零残留'
          : `violated=${violated} residual=${count[0]?.n}（期望 1）`,
      ),
    );
  } catch (err) {
    vectors.push(V('batch_transaction_all_or_nothing', false, String(err)));
  }

  // 5. 批量事务批量写入（200 行事务提交）
  try {
    await driver.exec('BEGIN');
    for (let i = 0; i < 200; i += 1) {
      await driver.run('INSERT INTO smoke_upsert (k, v) VALUES (?, ?)', [`bulk_${i}`, i]);
    }
    await driver.exec('COMMIT');
    const count = await driver.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM smoke_upsert WHERE k LIKE 'bulk_%'",
    );
    const ok = Number(count[0].n) === 200;
    vectors.push(V('batch_transaction_bulk_200', ok, `提交后行数=${count[0]?.n}（期望 200）`));
  } catch (err) {
    vectors.push(V('batch_transaction_bulk_200', false, String(err)));
  }

  await driver.exec('DROP TABLE IF EXISTS smoke_upsert');

  return {
    pass: vectors.every((v) => v.pass),
    driver: driver.name,
    vectors,
  };
}
