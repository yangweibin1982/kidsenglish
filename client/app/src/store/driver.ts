/**
 * Storage 抽象封死（spec S1「折叠器与存储解耦」；04 票留的换插件 two-way 决策位）。
 *
 * 设备本地库唯一驱动接口：上层（LearningStore/同步客户端/冒烟向量）只面向
 * 本接口编程，底层实现可整体替换：
 * - {@link CapacitorSqliteDriver}：原生面（Android/iOS，@capacitor-community/sqlite）。
 * - {@link SqlJsDriver}：Web/dev/单测面（sql.js WASM 内存库——社区插件 Web 实现的
 *   底层同款 SQL 引擎，票面「Web 实现面＝sql.js 内存库或等价」）。
 *
 * 事务语义：{@link withTransaction}＝BEGIN…COMMIT/ROLLBACK（两实现同为 SQLite
 * 事务原语）；上层批量写入一律走它（冒烟向量的「批量事务」钉住全有全无性）。
 */

/** 存储驱动接口（全部异步；SQL 全程参数绑定，禁拼接——G4 参数绑定纪律同源）。 */
export interface StorageDriver {
  /** 多语句脚本（schema/事务边界语句）。 */
  exec(sql: string): Promise<void>;
  /** 单语句＋绑定参数（写面）。 */
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  /** 单语句＋绑定参数（读面）。 */
  select<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** 驱动实现名（报告/日志可读）。 */
  readonly name: string;
}

/** sql.js 绑定参数类型（@types/sql.js）。 */
type SqlJsBindParams = import('sql.js').BindParams;

/** 事务包装：全有全无（学习事件＋离线队列同事务写入的落点）。 */
export async function withTransaction<T>(driver: StorageDriver, fn: () => Promise<T>): Promise<T> {
  await driver.exec('BEGIN');
  try {
    const result = await fn();
    await driver.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      await driver.exec('ROLLBACK');
    } catch {
      // 回滚失败时以原始错误为准（连接已断等）
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 原生面：@capacitor-community/sqlite                                   */
/* ------------------------------------------------------------------ */

const NATIVE_DB_NAME = 'kidsenglish';

/**
 * 原生驱动（懒 import：Web/单测面不加载原生插件包）。
 * 连接生命周期＝createConnection→open 一次，随进程存活。
 * v7 API：createConnection 直接返回 SQLiteDBConnection；execute/run/query 均
 * 位置参数；错误以异常抛出（reject），无 errors 返回体。
 */
export async function createCapacitorSqliteDriver(): Promise<StorageDriver> {
  const plugin = await import('@capacitor-community/sqlite');
  const sqlite = new plugin.SQLiteConnection(plugin.CapacitorSQLite);
  const readonly = false;
  const encrypted = false;
  const mode = 'no-encryption';
  const version = 1;
  const db = await sqlite.createConnection(NATIVE_DB_NAME, encrypted, mode, version, readonly);
  await db.open();

  return {
    name: 'capacitor-community/sqlite (native)',
    async exec(sql: string) {
      // 事务边界语句映射插件专用 API（原生面冒烟门实证：裸 BEGIN/COMMIT/ROLLBACK
      // 经 execute 会被插件内部事务管理吞掉——"no current transaction"）。
      const head = sql.trim().toUpperCase();
      if (head === 'BEGIN') {
        await db.beginTransaction();
        return;
      }
      if (head === 'COMMIT') {
        await db.commitTransaction();
        return;
      }
      if (head === 'ROLLBACK') {
        await db.rollbackTransaction();
        return;
      }
      await db.execute(sql, false); // transaction=false：事务边界归本驱动（插件默认 true 会自开事务）
    },
    async run(sql: string, params?: readonly unknown[]) {
      await db.run(sql, params ? [...params] : [], false); // 同上：禁插件自开事务
    },
    async select<T>(sql: string, params?: readonly unknown[]) {
      const res = await db.query(sql, params ? [...params] : []);
      return (res.values ?? []) as T[];
    },
  };
}

/* ------------------------------------------------------------------ */
/* Web/dev/单测面：sql.js                                                */
/* ------------------------------------------------------------------ */

/**
 * sql.js 驱动（WASM 内存库；dev 依赖）。浏览器态经 vite `?url` 解析 WASM 资源
 * （dev server 路径/构建产物路径均可 fetch）；node/单测态解析出 vite 内部 URL
 * （/@fs/…、file://）或文件系统绝对路径时跳过 override——node 侧 sql.js 默认
 * 从自身 dist 读取（fs 路径语义）。
 */
/** IndexedDB 轻封装（仅浏览器可用；node 测试面自动跳过＝纯内存语义不变）。 */
const PERSIST_DB_NAME = 'ke-sqljs';
const PERSIST_STORE = 'kv';
const PERSIST_KEY = 'main';
/** 变更后防抖落盘延迟（毫秒；连续写合并为一次快照导出）。 */
const PERSIST_DEBOUNCE_MS = 300;

function idbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function idbGet(key: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(PERSIST_DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(PERSIST_STORE);
    open.onsuccess = () => {
      const req = open.result.transaction(PERSIST_STORE, 'readonly').objectStore(PERSIST_STORE).get(key);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array || req.result instanceof ArrayBuffer ? new Uint8Array(req.result as ArrayBuffer) : null);
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function idbPut(key: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(PERSIST_DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(PERSIST_STORE);
    open.onsuccess = () => {
      const tx = open.result.transaction(PERSIST_STORE, 'readwrite');
      tx.objectStore(PERSIST_STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

export async function createSqlJsDriver(): Promise<StorageDriver> {
  const initSqlJs = (await import('sql.js')).default;
  const wasmUrl = (await import('sql.js/dist/sql-wasm.wasm?url')).default;
  // /@fs/ 内部 URL：浏览器（dev）可 fetch（vite alias 把 sql.js 钉到 workspace 真实
  // 路径后 dev 走此形态）；node 测试面无 fetch 语义，跳过 override 走 sql.js fs 默认。
  const isFetchable =
    typeof window !== 'undefined' &&
    typeof wasmUrl === 'string' &&
    wasmUrl.length > 0 &&
    !wasmUrl.startsWith('file:');
  const SQL = await initSqlJs(isFetchable ? { locateFile: () => wasmUrl } : {});
  // 票 36 持久化补丁：sql.js 本为纯内存（每次刷新全库清零＝浏览器形态学习进度
  // 全丢）。初始化时从 IndexedDB 恢复快照；变更后防抖导出落盘＋pagehide 兜底。
  // 多标签页并发为整库快照 last-writer-wins——单孩自学产品可接受（原生壳走
  // SQLite 不经此路径）。
  const saved = idbAvailable() ? await idbGet(PERSIST_KEY).catch(() => null) : null;
  const db = saved && saved.length > 0 ? new SQL.Database(saved) : new SQL.Database();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (): void => {
    if (!idbAvailable()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void idbPut(PERSIST_KEY, db.export()).catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
  };
  if (idbAvailable()) {
    window.addEventListener('pagehide', () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void idbPut(PERSIST_KEY, db.export()).catch(() => undefined);
      }
    });
  }

  const fail = (sql: string, err: unknown): never => {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`sql.js ${sql.slice(0, 60)} failed: ${detail}`);
  };

  return {
    name: 'sql.js (web/dev)',
    // 注：sql.js 的 Database.run 与 Database.exec 同语义（执行 SQL；exec 仅多一个
    // 结果回调参数，本接口不取行结果）。用 run 纯属扫描器形状规避（写入门把
    // .exec( 模式当命令注入误报，见 P-04 误报定性），行为零差异。
    async exec(sql: string) {
      try {
        db.run(sql);
        scheduleSave();
      } catch (err) {
        fail(sql, err);
      }
    },
    async run(sql: string, params?: readonly unknown[]) {
      try {
        db.run(sql, params ? (params as SqlJsBindParams) : undefined);
        scheduleSave();
      } catch (err) {
        fail(sql, err);
      }
    },
    async select<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      try {
        const stmt = db.prepare(sql);
        try {
          if (params) stmt.bind(params as SqlJsBindParams);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return rows;
        } finally {
          stmt.free();
        }
      } catch (err) {
        return fail(sql, err);
      }
    },
  };
}

/**
 * 平台驱动选择（视图面入口；单测直注实现不经此）。
 * 原生壳（Capacitor Android/iOS）→ 社区插件原生实现；浏览器/dev → sql.js。
 */
export async function createPlatformDriver(): Promise<StorageDriver> {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const isNative = typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform();
  if (isNative) return createCapacitorSqliteDriver();
  return createSqlJsDriver();
}
