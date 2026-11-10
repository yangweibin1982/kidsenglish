/**
 * 同步客户端（spec S1 单次双向往返；票 13 POST /api/sync 契约即票面类型）。
 *
 * - 契约：上行 {child_id:int, device_id, cursor:str|null, events:[信封]} →
 *   下行 {events:[信封], cursor:str, server_hlc_upper:Hlc|null}。事件信封与
 *   票 12 fold 同形；请求 child_id int 与事件 child_id str(child_id) 必须一致
 *   （服务端 422 串孩守卫）。
 * - **离线优先**：失败静默退避重试（5s/15s/60s/300s 封顶），学习主路径零阻塞；
 *   2xx 即 ack＝出队＋游标前进＋HLC 互见。
 * - 触发（S1）：前台恢复（visibilitychange）/网络恢复（online）/学习单元结束
 *   （facade 调 trigger）；调度器单飞（in-flight 互斥）。
 */

import type { Hlc, LearningEvent } from '@kidsenglish/engine';
import type { LearningStore } from '../store/learningStore';

/** 请求信封（票 13 SyncRequest）。 */
export interface SyncRequest {
  child_id: number;
  device_id: string;
  cursor: string | null;
  events: LearningEvent[];
}

/** 响应信封（票 13 SyncResponse）。 */
export interface SyncResponse {
  events: LearningEvent[];
  cursor: string;
  server_hlc_upper: Hlc | null;
}

/** HTTP 传输面（可注入 mock fetch 做契约单测）。 */
export interface SyncTransport {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: unknown }>;
}

/** fetch 默认实现（10s 超时）。 */
export function createFetchTransport(timeoutMs = 10_000): SyncTransport {
  return {
    async post(url, body, headers) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        return { status: res.status, json };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 单次同步结果（视图/日志可读）。 */export interface SyncOutcome {
  ok: boolean;
  uploaded: number;
  downloaded: number;
  /** 失败时的可读原因（HTTP 状态/网络错误；静默重试用，不抛出）。 */
  error?: string;
}

export interface SyncClientOptions {
  childId: string;
  deviceId: string;
  serverBase: string;
  familyToken: string;
  transport?: SyncTransport;
  /** 退避序列（毫秒；缺省 5s/15s/60s/300s 封顶）。 */
  backoffMs?: number[];
}

const DEFAULT_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

export class SyncClient {
  private readonly opts: Required<Pick<SyncClientOptions, 'childId' | 'deviceId' | 'serverBase' | 'familyToken'>> &
    SyncClientOptions;
  private readonly transport: SyncTransport;
  private readonly backoff: number[];
  private retryIndex = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<SyncOutcome> | null = null;
  private started = false;
  private lastOutcome: SyncOutcome | null = null;

  constructor(private readonly store: LearningStore, private readonly now: () => number, options: SyncClientOptions) {
    this.opts = options;
    this.transport = options.transport ?? createFetchTransport();
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /** 最近一次同步结果（视图展示）。 */
  get last(): SyncOutcome | null {
    return this.lastOutcome;
  }

  /** 注册 S1 触发面（幂等；前台恢复/网络恢复监听）。 */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.syncNow();
    });
    window.addEventListener('online', () => void this.syncNow());
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.started = false;
  }

  /** 学习单元结束/手动触发入口。 */
  trigger(): void {
    void this.syncNow();
  }

  /**
   * 单次双向往返。并发调用合并为单飞；失败静默（返回 outcome 不抛）并按退避重试。
   */
  syncNow(): Promise<SyncOutcome> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doSync()
      .then((outcome) => {
        this.lastOutcome = outcome;
        if (outcome.ok) {
          this.retryIndex = 0;
        } else {
          this.scheduleRetry();
        }
        return outcome;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return;
    const delay = this.backoff[Math.min(this.retryIndex, this.backoff.length - 1)];
    this.retryIndex += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, delay);
  }

  private async doSync(): Promise<SyncOutcome> {
    if (!this.opts.familyToken) {
      return { ok: false, uploaded: 0, downloaded: 0, error: '缺少家庭令牌（S4 装机配置）' };
    }
    const events = await this.store.pendingEvents();
    const cursorState = await this.store.getCursor();
    const childIdNum = Number(this.opts.childId);
    if (!Number.isInteger(childIdNum) || childIdNum < 1) {
      return { ok: false, uploaded: 0, downloaded: 0, error: `childId 非法: ${this.opts.childId}` };
    }
    const request: SyncRequest = {
      child_id: childIdNum,
      device_id: this.opts.deviceId,
      // null ≡ '0'（服务端均自 rowid 0 起拉）；持久游标原样上报（设备对自身位次权威）
      cursor: cursorState.cursor,
      events,
    };

    let res: { status: number; json: unknown };
    try {
      res = await this.transport.post(
        `${this.opts.serverBase.replace(/\/$/, '')}/api/sync`,
        request,
        { 'Content-Type': 'application/json', 'X-Family-Token': this.opts.familyToken },
      );
    } catch (err) {
      // TypeError = fetch 网络层失败（server 未起/断网等），不暴露浏览器原文（票 26 儿童可读面）
      const detail =
        err instanceof TypeError
          ? '稍后将自动重试'
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, uploaded: 0, downloaded: 0, error: `网络不可达：${detail}` };
    }

    if (res.status < 200 || res.status >= 300) {
      const detail = res.json && typeof res.json === 'object' && 'detail' in res.json ? String((res.json as { detail: unknown }).detail) : '';
      return { ok: false, uploaded: 0, downloaded: 0, error: `HTTP ${res.status}${detail ? ` ${detail}` : ''}` };
    }

    const body = res.json as Partial<SyncResponse> | null;
    if (!body || !Array.isArray(body.events) || typeof body.cursor !== 'string') {
      return { ok: false, uploaded: 0, downloaded: 0, error: '响应形状违约（缺 events/cursor）' };
    }

    // 1. ack：本次上行事件出队（服务端已幂等落库）
    await this.store.clearPending(events.map((e) => e.event_id));
    // 2. 下行他源事件幂等入库（本地已有者 DO NOTHING；HLC 逐件互见）
    const downloaded = await this.store.appendRemote(body.events as LearningEvent[], this.now());
    // 3. 游标前进＋服务器 HLC 上界互见（S1 偏移校正）
    const upper = body.server_hlc_upper ?? null;
    await this.store.setCursor(body.cursor, upper, new Date(this.now()).toISOString());
    if (upper) await this.store.observeHlc(upper, this.now());

    return { ok: true, uploaded: events.length, downloaded };
  }
}
