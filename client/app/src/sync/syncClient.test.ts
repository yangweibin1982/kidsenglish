/**
 * 同步客户端契约单测（票 14）：请求/响应形状＝票 13 POST /api/sync 契约
 * （mock transport 断言，不依赖网络）；上行 ack 出队／下行幂等入库／游标前进／
 * 失败静默保队列（离线优先）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningEvent } from '@kidsenglish/engine';
import type { SyncRequest, SyncTransport } from './syncClient';
import { SyncClient } from './syncClient';
import { createSqlJsDriver } from '../store/driver';
import { LearningStore } from '../store/learningStore';

let NOW = 1_730_000_000_000;
const tickNow = (): number => (NOW += 1);

const CHILD_ID = '1';
const DEVICE_ID = 'dev-a';

/** 事件信封夹具（票 12 形状）。 */
function mkEvent(eventId: string, deviceSeq: number): LearningEvent {
  return {
    event_id: eventId,
    child_id: CHILD_ID,
    device_id: DEVICE_ID,
    device_seq: deviceSeq,
    hlc: { physicalMs: 1_729_900_000_000 + deviceSeq, counter: 0 },
    occurred_at: '2026-10-25T09:00:00.000Z',
    type: 'answer',
    payload: {
      lexical_entry_id: 'w_pencil',
      question_type: 'word_pick_meaning',
      correct: true,
      reaction_ms: 8000,
      answered_on: '2026-10-25',
    },
  };
}

interface RecordedCall {
  url: string;
  body: SyncRequest;
  headers: Record<string, string>;
}

/** 可编排响应的 mock transport。 */
function mkTransport(handler: (call: SyncRequest) => { status: number; json: unknown }) {
  const calls: RecordedCall[] = [];
  const transport: SyncTransport = {
    async post(url, body, headers) {
      const req = body as SyncRequest;
      calls.push({ url, body: req, headers });
      return handler(req);
    },
  };
  return { calls, transport };
}

async function openStore() {
  const driver = await createSqlJsDriver();
  const clock = {
    restore: () => undefined,
    tick: (nowMs: number) => ({ physicalMs: nowMs, counter: 0 }),
    recv: () => ({ physicalMs: NOW, counter: 0 }),
    snapshot: () => ({ physicalMs: NOW, counter: 0 }),
  };
  const { store } = await LearningStore.open(driver, clock, DEVICE_ID);
  return store;
}

let store: LearningStore;

beforeEach(async () => {
  store = await openStore();
});

function mkClient(transport: SyncTransport): SyncClient {
  return new SyncClient(store, tickNow, {
    childId: CHILD_ID,
    deviceId: DEVICE_ID,
    serverBase: 'http://localhost:8000',
    familyToken: 'test-token',
    transport,
  });
}

/** 合法 answer 载荷（fold 契约：lexical_entry_id 非空——probe 夹具会被 fold 拒收）。 */
const ANSWER_PAYLOAD = {
  lexical_entry_id: 'w_pencil',
  question_type: 'word_pick_meaning',
  correct: true,
  reaction_ms: 8000,
  answered_on: '2026-10-25',
};

describe('SyncClient：票 13 契约面（mock transport）', () => {
  it('请求形状：URL/头/child_id int/device_id/cursor null 首拉/事件信封原样上行', async () => {
    const e = await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, NOW);
    const { calls, transport } = mkTransport(() => ({
      status: 200,
      json: { events: [], cursor: '1', server_hlc_upper: { physicalMs: 1_729_900_000_000, counter: 0 } },
    }));
    const outcome = await mkClient(transport).syncNow();
    expect(outcome.ok).toBe(true);
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.url).toBe('http://localhost:8000/api/sync');
    expect(call.headers['X-Family-Token']).toBe('test-token');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body.child_id).toBe(1); // int（票 13：请求顶层 child_id int）
    expect(call.body.device_id).toBe(DEVICE_ID);
    expect(call.body.cursor).toBe('0'); // 首拉：'0'≡null＝从头（服务端 rowid>0 语义，票 13）
    expect(call.body.events).toHaveLength(1);
    expect(call.body.events[0].event_id).toBe(e.event_id); // 信封不转换直传（fold 同形）
    expect(call.body.events[0].hlc).toEqual(e.hlc);
  });

  it('上行 ack：离线队列出队＋游标前进＋下行事件幂等入库', async () => {
    await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, NOW);
    const remote: LearningEvent = { ...mkEvent('ev-remote-1', 0), device_id: 'dev-b' };
    const { transport } = mkTransport(() => ({
      status: 200,
      json: { events: [remote], cursor: '7', server_hlc_upper: { physicalMs: 1_729_900_000_002, counter: 1 } },
    }));
    const outcome = await mkClient(transport).syncNow();
    expect(outcome).toMatchObject({ ok: true, uploaded: 1, downloaded: 1 });
    expect(await store.pendingCount()).toBe(0); // ack 出队
    const cursor = await store.getCursor();
    expect(cursor.cursor).toBe('7'); // 游标前进（服务端插入序位）
    expect(cursor.serverHlcUpper).toEqual({ physicalMs: 1_729_900_000_002, counter: 1 });
    const state = await store.foldedState('1');
    expect(state.counters.answered).toBe(2); // 本地 1＋下行 1（他源 dev-b）
    expect(state.poolStates.map((s) => s.lexicalEntryId)).toContain('w_pencil');
    // 二次同步：cursor 非空且上行空集
    const { calls, transport: t2 } = mkTransport(() => ({ status: 200, json: { events: [], cursor: '7', server_hlc_upper: null } }));
    await mkClient(t2).syncNow();
    expect(calls[0].body.cursor).toBe('7');
    expect(calls[0].body.events).toEqual([]);
  });

  it('下行重复投递幂等（同 event_id 回声不重复计数）', async () => {
    await store.appendLocal('1', 'answer', ANSWER_PAYLOAD, NOW);
    const echo = (await store.pendingEvents())[0];
    const { transport } = mkTransport(() => ({
      status: 200,
      json: { events: [echo, echo], cursor: '3', server_hlc_upper: null },
    }));
    const outcome = await mkClient(transport).syncNow();
    expect(outcome.ok).toBe(true);
    const state = await store.foldedState('1');
    expect(state.counters.answered).toBe(1); // 回声不重复
  });

  it('失败静默：网络错误/HTTP 4xx 不抛出，离线队列保全，待重试', async () => {
    await store.appendLocal('1', 'answer', { probe: 1 }, NOW);
    const networkFail = mkTransport(() => {
      throw new TypeError('fetch failed');
    });
    const outcome1 = await mkClient(networkFail.transport).syncNow();
    expect(outcome1).toMatchObject({ ok: false, uploaded: 0 });
    expect(outcome1.error).toContain('网络不可达');
    expect(await store.pendingCount()).toBe(1); // 队列保全

    const http401 = mkTransport(() => ({ status: 401, json: { detail: 'family token required' } }));
    const outcome2 = await mkClient(http401.transport).syncNow();
    expect(outcome2.ok).toBe(false);
    expect(outcome2.error).toBe('HTTP 401 family token required');
    expect(await store.pendingCount()).toBe(1);

    // 422 串孩守卫面：契约违约事件不会被无声吞掉（报错留痕）
    const http422 = mkTransport(() => ({ status: 422, json: { detail: 'event ... child_id mismatch' } }));
    const outcome3 = await mkClient(http422.transport).syncNow();
    expect(outcome3.error).toContain('422');
  });

  it('缺令牌：快速失败不发起请求（S4 装机配置面）', async () => {
    const post = vi.fn();
    const client = new SyncClient(store, tickNow, {
      childId: CHILD_ID,
      deviceId: DEVICE_ID,
      serverBase: 'http://localhost:8000',
      familyToken: '',
      transport: { post },
    });
    const outcome = await client.syncNow();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('家庭令牌');
    expect(post).not.toHaveBeenCalled();
  });

  it('start 注册触发面：visibilitychange/online 监听（S1 前台恢复/网络恢复）', () => {
    // node 测试环境无 DOM：stub 最小 window/document 面验证注册行为
    const docAdd = vi.fn();
    const winAdd = vi.fn();
    vi.stubGlobal('document', { addEventListener: docAdd, visibilityState: 'visible' });
    vi.stubGlobal('window', { addEventListener: winAdd });
    const client = mkClient(mkTransport(() => ({ status: 200, json: { events: [], cursor: '0', server_hlc_upper: null } })).transport);
    client.start();
    expect(docAdd).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(winAdd).toHaveBeenCalledWith('online', expect.any(Function));
    client.stop();
    vi.unstubAllGlobals();
  });
});
