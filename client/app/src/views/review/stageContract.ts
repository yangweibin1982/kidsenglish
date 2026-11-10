/**
 * S5 演出域三向事件契约 v3（spec v1.4 S9「雷霆战机」仿真度重制，Ticket 30；
 * 取代票 29 v2：新增 letter-fire 字母级弹幕指令、fire 增 combo/武器/得分载荷）。
 *
 * 三向形状（票面：三向形状不得少）：
 *   ① Vue → Pixi 指令（sendCommand）：battle-start / load-word / letter-fire /
 *      fire / clear；
 *   ② Pixi → Vue 完成回报（performance-complete 事件，hit=扣血未破 /
 *      defeat=击破；letter-fire 不产生回报、不扣血）；
 *   ③ Pixi → Vue 错误上报（stage-error 事件）。
 *
 * 解耦铁律（spec S5）：
 *   - 本模块不 import 题库/引擎/同步任何模块（演出侧与考核侧共同依赖的
 *     只有本契约文件）；pixiStage.ts 只允许 import pixi 与本模块；
 *   - Vue 考核层与 Pixi 演出层互不持有对方引用，只经本总线收发消息
 *     （兄弟 DOM 节点 #stage-canvas-root 承载 canvas，非内嵌于题型组件）。
 *
 * 考核边界（票 29 WRONG 保持）：词形与判定都在 Vue 考核层；演出层只见
 * targetId（opaque 字符串）与 meaning（展示用中文义），不做任何判定。
 * 得分/连击纯游戏内展示（P-11 决策 3）：fire 载荷只驱动浮字/火力形态，
 * 不回流考核层。
 *
 * 纯模块：无 DOM、无 Pixi 依赖，可在 node 环境单测三向往返。
 */

/** Boss 出词周期：每第 6 个词出一次 Boss（票 30 设计锁定；舞台调度用）。 */
export const REVIEW_WORDS_PER_BOSS = 6;

/** Vue → Pixi 指令（考核层唯一出向通道）。 */
export type StageCommand =
  | {
      /** 开战：重置战场并放出场第一波敌机（会话开始时一次）。 */
      kind: 'battle-start';
      /** 本会话卡数（Boss 调度＝每 6 词一次、末 Boss 血量=min(6, 剩余) 参考）。 */
      total: number;
    }
  | {
      /** 装载当前词：更新目标怪头顶中文义气泡（词形永不进演出层——听写式检索）。 */
      kind: 'load-word';
      /** 稳定词 id（演出层只当 opaque 字符串回传，不解释语义）。 */
      targetId: string;
      /** 词义（首义项 gloss；怪兽气泡展示，非考核面）。 */
      meaning: string;
    }
  | {
      /** 字母级弹幕：每拼对一个字母一发（不扣血、无回报——纯反馈密度）。 */
      kind: 'letter-fire';
      targetId: string;
    }
  | {
      /** 拼完开火：一串子弹飞向目标怪，串尾落点扣 1 格血（每词恰一次、恰一次回报）。 */
      kind: 'fire';
      /** 一次开火的唯一标识（防重复回报对账用）。 */
      shotId: string;
      targetId: string;
      /** 本词连击数（≥2 时演出「xN 连击」浮字；纯展示）。 */
      combo: number;
      /** 武器等级 1-3（连击驱动：单发→双发→三散射；纯展示）。 */
      weaponLevel: number;
      /** 本词得分（词长×10×combo；击破浮字展示用）。 */
      score: number;
    }
  | {
      /** 清场：移除场上所有演出元素并停渲染（收尾/时间盒到点/卸载）。 */
      kind: 'clear';
    };

/** 演出结局：hit＝血条未空（本词伤害生效）、defeat＝击破（血条扣完坠落）。 */
export type StageOutcome = 'hit' | 'defeat';

/** Pixi → Vue 事件（完成回报 ② ＋ 错误上报 ③，考核层唯一入向通道）。 */
export type StageEvent =
  | {
      kind: 'performance-complete';
      targetId: string;
      outcome: StageOutcome;
    }
  | {
      kind: 'stage-error';
      /** 人类可读错误信息（展示在调试证据行，不弹儿童可见错误）。 */
      message: string;
    };

/** 演出驱动对指令的处理入口（Pixi 侧唯一入向实现点）。 */
export type StageCommandHandler = (cmd: StageCommand) => void;

/** attachDriver 的返回句柄：驱动用它回报事件与卸载自身。 */
export type StageDriverHandle = {
  /** Pixi → Vue：回报完成/错误事件（detach 后调用为 no-op）。 */
  emit(evt: StageEvent): void;
  /** 卸载驱动：之后 sendCommand 重新进入缓冲，emit 不再投递。 */
  detach(): void;
};

/** 三向契约总线（Vue 与 Pixi 各持同一实例的两端）。 */
export interface StageBus {
  /** ① Vue → Pixi：下发指令。驱动未挂载时进入缓冲（≤32 条），挂载后按序补投。 */
  sendCommand(cmd: StageCommand): void;
  /** ②③ Vue 侧订阅 Pixi 事件；返回退订函数。 */
  onEvent(handler: (evt: StageEvent) => void): () => void;
  /** Pixi 侧挂载驱动；同刻至多一个驱动（新挂载自动顶替旧驱动）。 */
  attachDriver(handler: StageCommandHandler): StageDriverHandle;
}

/** 缓冲上限：正常流（battle-start/load-word/letter-fire×N/fire/clear 逐卡数条）远达不到；防泄漏兜底。 */
const COMMAND_BUFFER_CAP = 64;

/** 创建契约总线（每会话一个；无全局状态）。 */
export function createStageBus(): StageBus {
  let driver: StageCommandHandler | null = null;
  let driverDetached = false;
  const buffer: StageCommand[] = [];
  const listeners = new Set<(evt: StageEvent) => void>();

  function deliver(cmd: StageCommand): void {
    // clear 兼有弃单语义：未投递的旧卡指令随清场一起丢弃（防旧卡指令串场）
    if (cmd.kind === 'clear') {
      buffer.length = 0;
    }
    if (driver) {
      driver(cmd);
    } else {
      buffer.push(cmd);
      if (buffer.length > COMMAND_BUFFER_CAP) buffer.shift();
    }
  }

  return {
    sendCommand(cmd: StageCommand): void {
      deliver(cmd);
    },

    onEvent(handler: (evt: StageEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    attachDriver(handler: StageCommandHandler): StageDriverHandle {
      driver = handler;
      driverDetached = false;
      // 挂载即补投缓冲（保持发出顺序；末次 clear 之前的旧卡指令随弃）
      const pending = buffer.splice(0, buffer.length);
      let start = 0;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].kind === 'clear') {
          start = i;
          break;
        }
      }
      for (let i = start; i < pending.length; i++) {
        handler(pending[i]);
      }
      return {
        emit(evt: StageEvent): void {
          if (driverDetached) return;
          for (const l of listeners) l(evt);
        },
        detach(): void {
          driverDetached = true;
          if (driver === handler) driver = null;
        },
      };
    },
  };
}
