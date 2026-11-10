/**
 * 设备本地库 schema（spec S1/S7；票 14）。
 *
 * 表面四张：
 * - learning_events：学习事件（**只追加**——本 schema 无任何 UPDATE/DELETE 路径，
 *   WRONG 条款「事件可改写」由存储层 API 面封死：不提供改/删事件方法）。
 * - sync_outbox：离线队列（未上行事件指针；**上行 ack 后删队列行不是改写事件**，
 *   事件本体在 learning_events 永不触碰）。
 * - sync_cursor：同步游标（S1 单行；服务端插入序位＋HLC 上界快照）。
 * - meta：设备态（device_id / device_seq / hlc 时钟 / 冒烟门通过标记）。
 */

/** 事件表（只追加；列与票 12 信封对齐，hlc 拆两列整型便于比较）。 */
export const DDL_LEARNING_EVENTS = `
CREATE TABLE IF NOT EXISTS learning_events (
  event_id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_seq INTEGER NOT NULL,
  hlc_physical INTEGER NOT NULL,
  hlc_counter INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_events_child ON learning_events(child_id, device_seq);
`;

/** 离线队列（未上行事件；PRIMARY KEY 防重复入队）。 */
export const DDL_SYNC_OUTBOX = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  event_id TEXT PRIMARY KEY
);
`;

/** 同步游标（S1：设备×child 单轨；本 app 单孩单轨，单行钉死 id=1）。 */
export const DDL_SYNC_CURSOR = `
CREATE TABLE IF NOT EXISTS sync_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT NOT NULL DEFAULT '0',
  server_hlc_physical INTEGER,
  server_hlc_counter INTEGER,
  last_synced_at TEXT
);
INSERT OR IGNORE INTO sync_cursor (id, cursor) VALUES (1, '0');
`;

/** 设备态键值（device_id/device_seq/hlc/冒烟标记）。 */
export const DDL_META = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const SCHEMA_DDL = [DDL_LEARNING_EVENTS, DDL_SYNC_OUTBOX, DDL_SYNC_CURSOR, DDL_META].join(
  '\n',
);
