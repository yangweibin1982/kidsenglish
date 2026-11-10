/**
 * 设备本地库存取层（spec S1「设备库＝追加事件＋重放重建」；票 14）。
 *
 * - **事件表只追加**：appendLocal/appendRemote 是仅有的两条写入路径，全部
 *   INSERT … ON CONFLICT DO NOTHING（幂等）；本类不暴露任何事件 UPDATE/DELETE
 *   （离线队列 sync_outbox 的删行＝出队，不触碰事件本体）。
 * - **离线队列**：本地事件与 outbox 行同事务写入；上行 ack 后出队
 *   （at-least-once，服务端 event_id 幂等兜底）。
 * - **重放重建**：foldedState()＝全量事件 → 票 12 fold()（import 消费，禁改
 *   engine 包）→ FoldedState（票 09 buildDailyPlan 直喂形状）。
 * - **首启冒烟门**：open() 时对当前驱动跑 ON CONFLICT/UPSERT＋批量事务向量
 *   （04 票选型前置验证），结果落 meta 冒烟标记；不过关即抛错（禁带病落库）。
 */

import { fold, sortEvents, type FoldedState, type Hlc, type LearningEvent } from '@kidsenglish/engine';
import type { StorageDriver } from './driver';
import { withTransaction } from './driver';
import { SCHEMA_DDL } from './schema';
import { runSqliteSmokeVectors, type SmokeReport } from './smoke';

/** 本地事件行（learning_events 表投影）。 */
interface EventRow {
  event_id: string;
  child_id: string;
  device_id: string;
  device_seq: number;
  hlc_physical: number;
  hlc_counter: number;
  occurred_at: string;
  type: string;
  payload: string;
}

/** HLC 时钟结构面（sync/hlc.ts HlcClock 的最小接口；测试可注入替身）。 */
export interface HlcClockLike {
  /** 从持久化快照恢复（open 时取事件 max 与 meta 快照的较大者）。 */
  restore(hlc: Hlc | null): void;
  tick(nowMs: number): Hlc;
  recv(remote: Hlc, nowMs: number): Hlc;
  snapshot(): Hlc;
}

/** 同步游标行。 */
export interface SyncCursorState {
  cursor: string;
  serverHlcUpper: Hlc | null;
  lastSyncedAt: string | null;
}

function rowToEvent(row: EventRow): LearningEvent {
  return {
    event_id: row.event_id,
    child_id: row.child_id,
    device_id: row.device_id,
    device_seq: Number(row.device_seq),
    hlc: { physicalMs: Number(row.hlc_physical), counter: Number(row.hlc_counter) },
    occurred_at: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
  };
}

export class LearningStore {
  private constructor(
    readonly driver: StorageDriver,
    private clock: HlcClockLike,
  ) {}

  /** 打开存储：schema＋首启冒烟门＋时钟恢复（幂等，可重复调用）。 */
  static async open(
    driver: StorageDriver,
    clock: HlcClockLike,
    deviceId: string,
  ): Promise<{ store: LearningStore; smoke: SmokeReport }> {
    await driver.exec(SCHEMA_DDL);

    // 首启冒烟门（每安装一次；结果落 meta，失败即拒开）
    const smokeFlag = await LearningStore.getMetaStatic(driver, 'smoke_passed');
    let smoke: SmokeReport;
    if (smokeFlag === '1') {
      smoke = { pass: true, driver: driver.name, vectors: [] };
    } else {
      smoke = await runSqliteSmokeVectors(driver);
      if (!smoke.pass) {
        const failed = smoke.vectors.filter((v) => !v.pass).map((v) => `${v.name}: ${v.detail}`);
        throw new Error(
          `[storage] sqlite 冒烟门未通过（${driver.name}）——按 04 票降级序呈报，禁带病落库：${failed.join('；')}`,
        );
      }
      await LearningStore.setMetaStatic(driver, 'smoke_passed', '1');
      console.info(`[storage] sqlite 冒烟门通过：${driver.name}（5 向量全绿）`);
    }

    // 时钟恢复：持久快照与既有事件 max（HLC 字典序前先按数值比较）取大者
    const maxRow = await driver.select<{ hlc_physical: number; hlc_counter: number }>(
      'SELECT hlc_physical, hlc_counter FROM learning_events ORDER BY hlc_physical DESC, hlc_counter DESC LIMIT 1',
    );
    if (maxRow.length > 0) {
      clock.restore({
        physicalMs: Number(maxRow[0].hlc_physical),
        counter: Number(maxRow[0].hlc_counter),
      });
    }
    const saved = await LearningStore.getMetaStatic(driver, 'hlc_last');
    if (saved) {
      try {
        clock.restore(JSON.parse(saved) as Hlc);
      } catch {
        // 快照损坏以事件面为准（上面已 restore）
      }
    }

    await LearningStore.setMetaStatic(driver, 'device_id', deviceId);
    return { store: new LearningStore(driver, clock), smoke };
  }

  /* ---------------- meta（设备态） ---------------- */

  private static async getMetaStatic(driver: StorageDriver, key: string): Promise<string | null> {
    const rows = await driver.select<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return rows.length > 0 ? rows[0].value : null;
  }

  private static async setMetaStatic(driver: StorageDriver, key: string, value: string): Promise<void> {
    await driver.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  async getMeta(key: string): Promise<string | null> {
    return LearningStore.getMetaStatic(this.driver, key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    return LearningStore.setMetaStatic(this.driver, key, value);
  }

  /* ---------------- 设备序号（device_seq 递增） ---------------- */

  async nextDeviceSeq(): Promise<number> {
    const rows = await this.driver.select<{ n: number | null }>(
      'SELECT MAX(device_seq) AS n FROM learning_events WHERE device_id = ?',
      [await this.getMeta('device_id')],
    );
    return Number(rows[0]?.n ?? -1) + 1;
  }

  /* ---------------- 事件写入（只追加两条路径） ---------------- */

  /**
   * 追加本地事件：HLC 推进＋device_seq 递增＋事件与离线队列行同事务落盘。
   * payload 必须可 JSON 序列化（调用方保证；序列化失败即整体不入库）。
   */
  async appendLocal(childId: string, type: string, payload: unknown, nowMs: number): Promise<LearningEvent> {
    const hlc = this.clock.tick(nowMs);
    const deviceId = (await this.getMeta('device_id')) ?? 'unknown-device';
    const seq = await this.nextDeviceSeq();
    const event: LearningEvent = {
      event_id: crypto.randomUUID(),
      child_id: childId,
      device_id: deviceId,
      device_seq: seq,
      hlc,
      occurred_at: new Date(nowMs).toISOString(),
      type,
      payload,
    };
    const json = JSON.stringify(payload);
    await withTransaction(this.driver, async () => {
      await this.driver.run(
        `INSERT INTO learning_events
           (event_id, child_id, device_id, device_seq, hlc_physical, hlc_counter, occurred_at, type, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.event_id,
          event.child_id,
          event.device_id,
          event.device_seq,
          event.hlc.physicalMs,
          event.hlc.counter,
          event.occurred_at,
          event.type,
          json,
        ],
      );
      await this.driver.run('INSERT OR IGNORE INTO sync_outbox (event_id) VALUES (?)', [event.event_id]);
      await this.setMeta('hlc_last', JSON.stringify(hlc));
      await this.setMeta('device_seq_last', String(seq));
    });
    return event;
  }

  /**
   * 追加下行（他源）事件：幂等入库＋HLC 时钟互见推进；**不进离线队列**。
   * 先 sortEvents 全序去重再逐条插入（同 id 冲突 DO NOTHING＝首写保全）。
   */
  async appendRemote(events: readonly LearningEvent[], nowMs: number): Promise<number> {
    if (events.length === 0) return 0;
    const ordered = sortEvents(events);
    await withTransaction(this.driver, async () => {
      for (const ev of ordered) {
        await this.driver.run(
          `INSERT INTO learning_events
             (event_id, child_id, device_id, device_seq, hlc_physical, hlc_counter, occurred_at, type, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            ev.event_id,
            ev.child_id,
            ev.device_id,
            ev.device_seq,
            ev.hlc.physicalMs,
            ev.hlc.counter,
            ev.occurred_at,
            ev.type,
            JSON.stringify(ev.payload ?? null),
          ],
        );
        this.clock.recv(ev.hlc, nowMs);
      }
      await this.setMeta('hlc_last', JSON.stringify(this.clock.snapshot()));
    });
    return ordered.length;
  }

  /* ---------------- 读取与重放 ---------------- */

  /**
   * 服务器 HLC 上界互见（S1 偏移校正；同步客户端收到 server_hlc_upper 时调）。
   * 只推进时钟与持久快照，不落事件。
   */
  async observeHlc(hlc: Hlc, nowMs: number): Promise<void> {
    this.clock.recv(hlc, nowMs);
    await this.setMeta('hlc_last', JSON.stringify(this.clock.snapshot()));
  }

  async allEvents(childId: string): Promise<LearningEvent[]> {
    const rows = await this.driver.select<EventRow>(
      'SELECT * FROM learning_events WHERE child_id = ? ORDER BY hlc_physical ASC, hlc_counter ASC, device_id ASC, event_id ASC',
      [childId],
    );
    return rows.map(rowToEvent);
  }

  /** 全量事件 → fold 重建物化状态（同事件集必同终态，票 12 契约）。 */
  async foldedState(childId: string): Promise<FoldedState> {
    return fold(await this.allEvents(childId));
  }

  /* ---------------- 离线队列 ---------------- */

  /** 待上行事件（device_seq 序＝本设备因果序）。 */
  async pendingEvents(): Promise<LearningEvent[]> {
    const deviceId = await this.getMeta('device_id');
    const rows = await this.driver.select<EventRow>(
      `SELECT e.* FROM sync_outbox o
         JOIN learning_events e ON e.event_id = o.event_id
        WHERE e.device_id = ?
        ORDER BY e.device_seq ASC`,
      [deviceId],
    );
    return rows.map(rowToEvent);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox');
    return Number(rows[0]?.n ?? 0);
  }

  /** 上行 ack 后出队（只删队列行；事件本体不动）。 */
  async clearPending(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await withTransaction(this.driver, async () => {
      for (const id of eventIds) {
        await this.driver.run('DELETE FROM sync_outbox WHERE event_id = ?', [id]);
      }
    });
  }

  /* ---------------- 同步游标 ---------------- */

  async getCursor(): Promise<SyncCursorState> {
    const rows = await this.driver.select<{
      cursor: string;
      server_hlc_physical: number | null;
      server_hlc_counter: number | null;
      last_synced_at: string | null;
    }>('SELECT cursor, server_hlc_physical, server_hlc_counter, last_synced_at FROM sync_cursor WHERE id = 1');
    if (rows.length === 0) return { cursor: '0', serverHlcUpper: null, lastSyncedAt: null };
    const r = rows[0];
    return {
      cursor: r.cursor,
      serverHlcUpper:
        r.server_hlc_physical === null || r.server_hlc_counter === null
          ? null
          : { physicalMs: Number(r.server_hlc_physical), counter: Number(r.server_hlc_counter) },
      lastSyncedAt: r.last_synced_at,
    };
  }

  async setCursor(cursor: string, serverHlcUpper: Hlc | null, syncedAtIso: string): Promise<void> {
    await this.driver.run(
      `INSERT INTO sync_cursor (id, cursor, server_hlc_physical, server_hlc_counter, last_synced_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         cursor = excluded.cursor,
         server_hlc_physical = excluded.server_hlc_physical,
         server_hlc_counter = excluded.server_hlc_counter,
         last_synced_at = excluded.last_synced_at`,
      [cursor, serverHlcUpper?.physicalMs ?? null, serverHlcUpper?.counter ?? null, syncedAtIso],
    );
  }
}
