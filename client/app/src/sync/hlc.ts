/**
 * HLC 混合逻辑时钟（spec S1；设备本地生成，sync 下行携带服务器 HLC 上界供
 * 偏移校正）。标准 HLC 语义（Kulkarni 2014）：
 * - tick（本地发事件）：物理＝max(墙钟, 上次物理)；物理不动则计数 +1，动则清零；
 * - recv（互见远端事件/服务器上界）：物理＝max(墙钟, 上次, 远端物理)，三者并列
 *   决定计数取 max+1——保证本地后续事件严格晚于已见远端事件（因果不倒置）。
 * 持久化由调用方承担（LearningStore 与 meta/事件行同事务落盘）。
 */

import type { Hlc } from '@kidsenglish/engine';

export class HlcClock {
  private lastPhysicalMs = 0;
  private lastCounter = 0;

  /** 从持久化快照恢复（store 打开时取 meta 与既有事件 max 的较大者）。 */
  restore(hlc: Hlc | null): void {
    if (!hlc) return;
    if (hlc.physicalMs > this.lastPhysicalMs) {
      this.lastPhysicalMs = hlc.physicalMs;
      this.lastCounter = hlc.counter;
    } else if (hlc.physicalMs === this.lastPhysicalMs) {
      this.lastCounter = Math.max(this.lastCounter, hlc.counter);
    }
  }

  snapshot(): Hlc {
    return { physicalMs: this.lastPhysicalMs, counter: this.lastCounter };
  }

  /** 本地事件时钟推进。 */
  tick(nowMs: number): Hlc {
    if (nowMs > this.lastPhysicalMs) {
      this.lastPhysicalMs = nowMs;
      this.lastCounter = 0;
    } else {
      this.lastCounter += 1;
    }
    return this.snapshot();
  }

  /** 互见远端事件/上界后的时钟推进（返回是否前进，供日志）。 */
  recv(remote: Hlc, nowMs: number): Hlc {
    const physical = Math.max(nowMs, this.lastPhysicalMs, remote.physicalMs);
    if (physical === this.lastPhysicalMs && physical === remote.physicalMs) {
      this.lastCounter = Math.max(this.lastCounter, remote.counter) + 1;
    } else if (physical === this.lastPhysicalMs) {
      this.lastCounter += 1;
    } else if (physical === remote.physicalMs) {
      this.lastCounter = remote.counter + 1;
    } else {
      this.lastCounter = 0;
    }
    this.lastPhysicalMs = physical;
    return this.snapshot();
  }
}
