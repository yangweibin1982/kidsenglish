/**
 * TTS 服务封装（spec S6 ①系统英文 TTS 慢速档，默认英式；05 尽调结论落地）。
 *
 * 插件：@capacitor-community/text-to-speech 6.1.0（Capacitor 7 兼容线；
 * MIT、无广告、无遥测；Android setSpeechRate 直传／iOS adjustRate 归一，
 * 与 05 报告 v8.0.2 源码结论同语义——已对本仓 node_modules 实源复核）。
 *
 * R13 慢速档：rate=0.7（≈正常速 65–70%，尾音完整；实听后在 0.5–0.8 扫档微调）。
 * 口音：意图 en-GB；但浏览器分支在无 en-GB 本地声音时回落本地 en-US/其他（2026-11-01
 * 定责：Edge Online Natural 全系声音本机合成挂死＝无声死状态，有声优先于口音——
 * spec 默认英式语义保持，真机原生壳（系统 TTS）仍直连 en-GB；口音偏好变更回呈用户拍板。
 *
 * 票 28（spec v1.2 字母名朗读链）：Speaker 增 speakSeq——串行逐条 await 前一条
 * 结束再发下一条（字母链 h-e-l-l-o→hello 的表达底座）；世代计数器使新
 * speak/stop/speakSeq 让旧链静默作废（防连发吞声与跨卡串音）；浏览器分支
 * speak 改为 await utterance onend/onerror（带超时保护，防个别引擎不派事件挂死）。
 * 票 28 指挥官复核（2026-11-01 真实手势探针）两处竞态修复：
 * ①voices 分批派发——voiceschanged 两批 0→330，本地批（Hazel/Susan/George en-GB）
 *   晚于 Online 批，早期快照误判「无 en-GB 本地声音」→ensureVoices 非空也复采；
 * ②cancel→speak 紧邻吞声——链内第 2 条 utterance 零事件 → cancel 后留 60ms 再发。
 */
import { TextToSpeech } from '@capacitor-community/text-to-speech';

/** 朗读语速（票 28 用户实测裁定「正常语速即可」——0.7 慢速档单字母实长 1.3-1.6s，链拖沓被否） */
export const TTS_RATE = 1.0;
/** R13 默认英式 */
export const TTS_LANG = 'en-GB';

/**
 * 单条 utterance 等待超时（毫秒）。字母/单词量级 10s 已远超正常语速实听时长；
 * 个别引擎 cancel/异常时不派 end/error 事件——超时即放行，链不断、界面不卡。
 */
export const UTTERANCE_TIMEOUT_MS = 10_000;

export type TtsEngineKind = 'capacitor' | 'browser' | 'none';

export type TtsStatus = {
  /** speak 是否可用 */
  available: boolean;
  engine: TtsEngineKind;
  /** en-GB **本地**声音可得性：true/false；null＝无法判定（Online Natural 不计入——本机合成挂死） */
  enGbSupported: boolean | null;
  /** 引擎可用声音总数（展示用证据行） */
  voiceCount: number | null;
  /** 一句话状态（TTS 证据行展示） */
  detail: string;
};

/**
 * Edge「Online (Natural)」声音在本机合成挂死（2026-11-01 定责探针实测：Sonia/Ryan
 * utterance 零事件 3.5s，本地 David/Zira/Huihui 均正常发声；u.lang='en-GB' 会被引擎
 * 自动引到挂死的 Online en-GB 声音＝「点击单词没有声音」根因）。一律避开。
 */
function isOnlineNatural(v: SpeechSynthesisVoice): boolean {
  return v.name.includes('Online (Natural)');
}

/**
 * voices 是异步加载且 Edge 分批派发（2026-11-01 票 28 复核探针实测：voiceschanged
 * 两次轨迹 0→330，本地批（Hazel/Susan/George en-GB＋David/Mark/Zira en-US…）晚于
 * Online 批到达；早期快照里个别 voice 的 lang 可能还是空串）。
 * 策略＝空等 voiceschanged；非空也再等一个稳定窗复采一次（吸收分批），谁多用谁。
 */
/** 稳定窗时长：吸收 Edge 分批派发的复采等待（探针实测本地批晚于 Online 批一拍） */
export const VOICES_SETTLE_MS = 250;

export async function ensureVoices(synth: SpeechSynthesis, timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
  const settle = (ms: number): Promise<SpeechSynthesisVoice[]> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        synth.removeEventListener('voiceschanged', finish);
        resolve(synth.getVoices());
      };
      synth.addEventListener('voiceschanged', finish);
      setTimeout(finish, ms);
    });
  const first = synth.getVoices();
  if (first.length === 0) return settle(timeoutMs);
  const second = await settle(VOICES_SETTLE_MS); // 稳定窗复采：吸收分批（本地批晚一拍）
  return second.length > first.length ? second : first;
}

/** 挑本地可发声声音：en-GB → en-US → 任意英语 → 任意本地；全无则 undefined（走引擎 default）。导出供单测 */
export function pickLocalVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const local = voices.filter((v) => !isOnlineNatural(v));
  const lang = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-').toLowerCase();
  const target = TTS_LANG.toLowerCase();
  return (
    local.find((v) => lang(v) === target) ??
    local.find((v) => lang(v) === 'en-us') ??
    local.find((v) => lang(v).startsWith('en')) ??
    local[0]
  );
}

/**
 * 探测 + 播报；失败不抛出（儿童界面不弹错误），状态照实记录。
 * speakSeq＝串行链：逐条 await 前一条真正结束；任一新 speak/speakSeq/stop
 * 都使旧链作废（世代计数），被作废的链在下一个间隔点静默退出。
 */
export type Speaker = {
  speak(text: string): Promise<void>;
  /** 串行播报链（朗读链底座）：逐条等待结束，中途被作废即静默退出 */
  speakSeq(parts: readonly string[]): Promise<void>;
  stop(): void;
  status(): Promise<TtsStatus>;
};

function isCapacitorNative(): boolean {
  // Capacitor 7 官方判别式：原生壳内为 true（浏览器 dev server 为 false）
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

/** cancel→speak 吞声竞态的让位间隔（票 28 复核探针定值；链内每条 +60ms） */
export const SPEAK_AFTER_CANCEL_MS = 60;

// ---------------------------------------------------------------------------
// 词级预生成音频（票 57；wordsfunny 方向吸收＝词典音优于设备 TTS，但本仓儿童
// 零外链红线→构建期预生成＋离线打包＋运行时音频优先/TTS 兜底）。词表抓取源
// 为有道 dictvoice 接口（type=1 英音）——接口无公开许可：家庭自用定位可接受，
// 商用分发前须换源（票 57 留痕）。
// ---------------------------------------------------------------------------

const wordAudio: { ready: boolean; words: Set<string> } = { ready: false, words: new Set() };

/** 音频等待超时（播放中挂死保护；与 UTTERANCE_TIMEOUT_MS 同量级语义） */
export const WORD_AUDIO_TIMEOUT_MS = 10_000;

async function loadWordAudioManifest(): Promise<void> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}audio/manifest.json`);
    if (!r.ok) return;
    const data = (await r.json()) as { words?: string[] };
    for (const w of data.words ?? []) wordAudio.words.add(w);
  } catch {
    // 无 manifest（干净构建/缺资产）＝静默全走 TTS
  } finally {
    wordAudio.ready = true;
  }
}

/** 单词形状（词级音频只路由纯字母词；例句/词组不路由）。导出供单测。 */
export function isSingleWordShape(text: string): boolean {
  return /^[a-z]+$/.test(text.toLowerCase().trim());
}

function normWord(text: string): string {
  return text.toLowerCase().trim();
}

/** 词级音频可用性（manifest 未加载完＝不可用，静默回退 TTS）。导出供单测。 */
export function wordAudioAvailable(text: string): boolean {
  return wordAudio.words.has(normWord(text));
}

/**
 * 词级音频最终路由判定：单词形状＋多字符＋manifest 命中。
 * 单字符一律排除＝票 52 全字母读音不变式的音频面延伸——字母项（'a'/'A'）若路由
 * 到 a.mp3 会读回冠词音 /ə/ 而非字母名 /eɪ/（diag58 探针实测；票 52 修的正是
 * 这个音，禁走音频绕回）。拼读音节项（grand/ma 等 ≥2 字符）不排除：词典音
 * 比合成音节更接近自然拼读，未命中词表的音节照旧走 synth。导出供单测。
 */
export function wordAudioRoutable(text: string): boolean {
  return isSingleWordShape(text) && normWord(text).length > 1 && wordAudioAvailable(text);
}

/**
 * 词级音频播放：路由判定通过才播 mp3；播完 resolve(true)。
 * 未命中/播放失败 resolve(false)＝调用方走原 TTS 路（静默兜底，零错误弹窗）。
 */
async function playWordAudio(
  text: string,
  isStale: () => boolean,
): Promise<boolean> {
  if (!wordAudio.ready || !wordAudioRoutable(text)) return false;
  return new Promise((resolve) => {
    const audio = new Audio(`${import.meta.env.BASE_URL}audio/${normWord(text)}.mp3`);
    let settled = false;
    const finish = (played: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onErr);
      resolve(played);
    };
    const onEnd = (): void => finish(true);
    const onErr = (): void => finish(false);
    const guard = setTimeout(() => finish(false), WORD_AUDIO_TIMEOUT_MS);
    if (isStale()) {
      finish(false);
      return;
    }
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onErr);
    audio.play().catch(() => finish(false));
  });
}

/** 测试注入口（仅单测使用）：直填词形集并标记 ready。 */
export function __setWordAudioForTest(words: string[]): void {
  wordAudio.words = new Set(words);
  wordAudio.ready = true;
}

/** 浏览器兜底（dev server 三视口自检用）：speechSynthesis，正常语速＋本地声音优先 */
function createBrowserSpeaker(): Speaker {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  /** 世代计数器：新播报/停止使旧链作废（防连发吞声与跨卡串音） */
  let generation = 0;

  /** 单条播报（不推进世代；世代失效即静默退出）——await utterance 真正结束 */
  const speakPart = async (text: string, gen: number): Promise<void> => {
    if (!synth || gen !== generation) return;
    // voices 先行（可能等 voiceschanged＋稳定窗复采）；空列表时 cancel 有吞声风险，故等完再 cancel
    const voices = await ensureVoices(synth);
    if (gen !== generation) return; // 等 voices 期间被新播报作废
    synth.cancel();
    // cancel→speak 紧邻有吞声竞态（2026-11-01 票 28 复核探针实测：块链第 2 条
    // utterance 进队列后零事件——cancel 的异步清理落地前 speak 被静默丢弃）。
    // 留一拍再发，链内间隔 +60ms 可接受；世代失效即免等。
    await new Promise((r) => setTimeout(r, SPEAK_AFTER_CANCEL_MS));
    if (gen !== generation) return;
    // 词级音频优先（票 57）：命中预生成 mp3＝播音频跳过 synth；未命中走原 TTS 路
    if (await playWordAudio(text, () => gen !== generation)) return;
    if (gen !== generation) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = TTS_RATE;
    const voice = pickLocalVoice(voices);
    if (voice) {
      u.voice = voice;
    }
    // 不设 voice 也不设 lang（极环境）：引擎 default 声音兜底——设 lang=en-GB 会被
    // 引到挂死的 Online Natural 声音（探针 3 实测 default 声音可正常发声）
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        u.removeEventListener('end', finish);
        u.removeEventListener('error', finish);
        resolve();
      };
      // 超时保护：个别引擎不派 end/error 时放行，链与界面不被挂死
      const guard = setTimeout(finish, UTTERANCE_TIMEOUT_MS);
      u.addEventListener('end', finish);
      u.addEventListener('error', finish);
      if (gen !== generation) {
        finish();
        return;
      }
      synth.speak(u);
    });
  };

  return {
    async speak(text: string) {
      const gen = ++generation;
      try {
        await speakPart(text, gen);
      } catch {
        // 儿童界面零错误弹窗：TTS 失败静默（状态行如实）
      }
    },
    async speakSeq(parts: readonly string[]) {
      const gen = ++generation;
      for (const part of parts) {
        if (gen !== generation) return; // 链被新播报/stop 作废：静默退出
        try {
          await speakPart(part, gen);
        } catch {
          // 单条失败不弹错；链继续下一条（每条独立，快速失败不阻塞）
        }
      }
    },
    stop() {
      generation += 1;
      synth?.cancel();
    },
    async status(): Promise<TtsStatus> {
      if (!synth) {
        return { available: false, engine: 'none', enGbSupported: null, voiceCount: null, detail: '浏览器不支持语音合成' };
      }
      const voices = await ensureVoices(synth);
      // 谓词两侧都小写化（票 28 复核探针定责：右边漏 toLowerCase 使 en-GB 本地声音
      // 恒判 false，状态行谎报「无 en-GB 本地声音」——实发 Hazel 英式音）
      const gbLocal = voices.find((v) => !isOnlineNatural(v) && v.lang.replace('_', '-').toLowerCase() === TTS_LANG.toLowerCase());
      const picked = pickLocalVoice(voices);
      const detail = picked
        ? gbLocal
          ? `浏览器 TTS · en-GB 本地＝${picked.name}（正常语速）`
          : `浏览器 TTS · 本地＝${picked.name}（无 en-GB 本地声音，已兜底；正常语速）`
        : voices.length > 0
          ? `浏览器 TTS · 仅有在线声音（本机不可用），将用系统默认声音尝试`
          : '浏览器 TTS · 无任何声音';
      return {
        available: voices.length > 0,
        engine: 'browser',
        enGbSupported: Boolean(gbLocal),
        voiceCount: voices.length,
        detail,
      };
    },
  };
}

/** 原生壳（Android/iOS）：Capacitor 插件直连 */
function createCapacitorSpeaker(): Speaker {
  /** 世代计数器（同浏览器分支语义：新播报使旧链作废） */
  let generation = 0;

  const speakPart = async (text: string, gen: number): Promise<void> => {
    if (gen !== generation) return;
    // 词级音频优先（票 57）：原生壳 WebView 内同样先查预生成 mp3
    if (await playWordAudio(text, () => gen !== generation)) return;
    if (gen !== generation) return;
    await TextToSpeech.speak({
      text,
      lang: TTS_LANG,
      rate: TTS_RATE,
      pitch: 1.0,
      volume: 1.0,
      category: 'ambient',
    });
  };

  return {
    async speak(text: string) {
      const gen = ++generation;
      try {
        await speakPart(text, gen);
      } catch {
        // 儿童界面零错误弹窗：TTS 失败静默（状态行如实）
      }
    },
    async speakSeq(parts: readonly string[]) {
      const gen = ++generation;
      for (const part of parts) {
        if (gen !== generation) return; // 链被新播报/stop 作废：静默退出
        try {
          await speakPart(part, gen);
        } catch {
          // 单条失败不弹错；链继续下一条
        }
      }
    },
    stop() {
      generation += 1;
      void TextToSpeech.stop();
    },
    async status(): Promise<TtsStatus> {
      try {
        const { supported } = await TextToSpeech.isLanguageSupported({ lang: TTS_LANG });
        let voiceCount: number | null = null;
        try {
          const { voices } = await TextToSpeech.getSupportedVoices();
          voiceCount = voices.length;
        } catch {
          // 个别引擎枚举失败不阻断主判定
        }
        return {
          available: true,
          engine: 'capacitor',
          enGbSupported: supported,
          voiceCount,
          detail: supported
            ? `系统 TTS · en-GB 可用（声音 ${voiceCount ?? '?'} 个，正常语速）`
            : '系统 TTS · en-GB 语音数据缺失（如实上报，未擅自切美音）',
        };
      } catch (e) {
        return {
          available: false,
          engine: 'capacitor',
          enGbSupported: null,
          voiceCount: null,
          detail: `系统 TTS 探测失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

let cached: Speaker | null = null;

/** 会话级单例：原生壳走插件，浏览器走 speechSynthesis 兜底 */
export function getSpeaker(): Speaker {
  if (cached) return cached;
  cached = typeof window !== 'undefined' && isCapacitorNative() ? createCapacitorSpeaker() : createBrowserSpeaker();
  void loadWordAudioManifest(); // 词级音频清单惰性加载一次（失败静默全 TTS）
  return cached;
}
