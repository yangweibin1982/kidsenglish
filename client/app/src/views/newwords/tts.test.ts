/**
 * tts.ts 单测（票 27「点击单词没有声音」＋票 28 复核补强）：voice 挑选回落序＋
 * Online Natural 排除＋voices 分批派发稳定窗。
 * 本机定责探针事实（2026-11-01）：Edge Online (Natural) 声音合成挂死（Sonia/Ryan 零事件），
 * 本地 David(en-US)/Zira(en-US)/Huihui(zh-CN) 正常——挑选器必须避开 Online 并按
 * en-GB → en-US → 任意英语 → 任意本地回落。
 * 票 28 复核探针补证：本机实有本地 en-GB（Hazel/Susan/George，localService=true），
 * voiceschanged 分批派发（0→330 两批，本地批晚一拍）——ensureVoices 必须复采。
 */
import { describe, expect, it } from 'vitest';
import {
  __setWordAudioForTest,
  ensureVoices,
  isSingleWordShape,
  pickLocalVoice,
  TTS_LANG,
  UTTERANCE_TIMEOUT_MS,
  VOICES_SETTLE_MS,
  wordAudioAvailable,
  wordAudioRoutable,
  WORD_AUDIO_TIMEOUT_MS,
} from './tts';
import { spellChain } from './fill';

function voice(name: string, lang: string): SpeechSynthesisVoice {
  return { name, lang } as unknown as SpeechSynthesisVoice;
}

/** 本机真实环境声音子集（探针 4 实测） */
const LOCAL_MACHINE = [
  voice('Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN'),
  voice('Microsoft Mark - English (United States)', 'en-US'),
  voice('Microsoft Zira - English (United States)', 'en-US'),
  voice('Microsoft David - English (United States)', 'en-US'),
  voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
  voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'),
  voice('Microsoft Libby Online (Natural) - English (United Kingdom)', 'en-GB'),
];

describe('pickLocalVoice（票 27：无声根因修复——避开 Online Natural、本地回落序）', () => {
  it('本机形状（en-GB 仅 Online 挂死声音）：回落列表序首个本地 en-US', () => {
    const picked = pickLocalVoice(LOCAL_MACHINE);
    expect(picked?.name).toBe('Microsoft Mark - English (United States)');
    expect(picked?.lang).toBe('en-US');
  });

  it('有 en-GB 本地声音时优先英式（R13 默认口音）', () => {
    const voices = [
      voice('Microsoft David - English (United States)', 'en-US'),
      voice('Microsoft Hazel - English (United Kingdom)', 'en-GB'),
      voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
    ];
    expect(pickLocalVoice(voices)?.name).toBe('Microsoft Hazel - English (United Kingdom)');
  });

  it('Online Natural 一律排除：即使它是列表里唯一 en-GB（探针 4 实测其合成挂死）', () => {
    const voices = [
      voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
      voice('Microsoft David - English (United States)', 'en-US'),
    ];
    expect(pickLocalVoice(voices)?.lang).toBe('en-US');
  });

  it('无 en-US 时回落任意英语本地声音', () => {
    const voices = [
      voice('Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN'),
      voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
      voice('Some English Voice', 'en-AU'),
    ];
    expect(pickLocalVoice(voices)?.lang).toBe('en-AU');
  });

  it('无任何英语本地声音时回落首个本地声音', () => {
    const voices = [
      voice('Microsoft Huihui - Chinese (Simplified, PRC)', 'zh-CN'),
      voice('Microsoft Hanhan - Chinese (Simplified, PRC)', 'zh-CN'),
    ];
    expect(pickLocalVoice(voices)?.lang).toBe('zh-CN');
  });

  it('全部为 Online Natural：undefined（speak 走引擎 default 声音，探针 3 实测可发声）', () => {
    const voices = [
      voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
      voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
    ];
    expect(pickLocalVoice(voices)).toBeUndefined();
  });

  it('lang 下划线写法（Windows 某些引擎 en_GB）同样匹配', () => {
    const voices = [voice('Legacy GB Voice', 'en_GB')];
    expect(pickLocalVoice(voices)?.name).toBe('Legacy GB Voice');
  });

  it('TTS_LANG 常量保持英式意图（spec S6/R13 语义不漂）', () => {
    expect(TTS_LANG).toBe('en-GB');
  });
});

describe('票 28：spellChain 纯函数（speakSeq 朗读链的输入形状；utterance 管线不单测——CDP 实走覆盖）', () => {
  it('整词链＝逐字母字母名（大写，票 52 防冠词读音）＋整词发音（进卡自动播）', () => {
    expect(spellChain('hello')).toEqual(['H', 'E', 'L', 'L', 'O', 'hello']);
  });

  it('块链＝块内逐字母（大写）＋块音（点块播，与整词链同构）', () => {
    expect(spellChain('mor')).toEqual(['M', 'O', 'R', 'mor']);
  });

  it('空串返回空链（speakSeq([])＝零播报防御）', () => {
    expect(spellChain('')).toEqual([]);
  });

  it('超时保护常量在合理量级（字母/单词远小于 10s，防个别引擎不派事件挂死）', () => {
    expect(UTTERANCE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(UTTERANCE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

/** ensureVoices 的 fake synth：getVoices 快照可编程、voiceschanged 手动派发 */
function fakeSynth(batches: SpeechSynthesisVoice[][]) {
  let stage = 0;
  const listeners = new Set<() => void>();
  return {
    getVoices: () => batches[Math.min(stage, batches.length - 1)] ?? [],
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    /** 模拟引擎派发下一批（本地批晚一拍） */
    nextBatch: () => {
      stage += 1;
      listeners.forEach((fn) => fn());
    },
  } as unknown as SpeechSynthesis & { nextBatch: () => void };
}

describe('票 28 复核：ensureVoices 分批派发稳定窗（探针实测 0→330 两批、本地批晚一拍）', () => {
  it('首查为空：等 voiceschanged 拿到全量（票 27 语义保持）', async () => {
    const synth = fakeSynth([[], LOCAL_MACHINE]);
    const p = ensureVoices(synth);
    await new Promise((r) => setTimeout(r, 20));
    (synth as unknown as { nextBatch: () => void }).nextBatch();
    expect(await p).toHaveLength(LOCAL_MACHINE.length);
  });

  it('首查非空但分批未到齐：稳定窗内后续批到达→返回更全的列表（复核探针实锤的误判根因）', async () => {
    const onlineOnly = LOCAL_MACHINE.filter((v) => v.name.includes('Online'));
    const synth = fakeSynth([onlineOnly, LOCAL_MACHINE]);
    const p = ensureVoices(synth);
    await new Promise((r) => setTimeout(r, 20));
    (synth as unknown as { nextBatch: () => void }).nextBatch();
    const voices = await p;
    expect(voices).toHaveLength(LOCAL_MACHINE.length);
    expect(pickLocalVoice(voices)?.lang).toBe('en-US'); // 本地批吸收后不再误判
  });

  it('首查非空且无后续批：稳定窗超时返回首查列表（不拖慢链路，VOICES_SETTLE_MS 量级）', async () => {
    const synth = fakeSynth([LOCAL_MACHINE, LOCAL_MACHINE]);
    const start = Date.now();
    const voices = await ensureVoices(synth);
    expect(voices).toHaveLength(LOCAL_MACHINE.length);
    expect(Date.now() - start).toBeGreaterThanOrEqual(VOICES_SETTLE_MS - 10);
  });
});


describe('票 57：词级预生成音频路由（词典音优先/TTS 兜底）', () => {
  it('isSingleWordShape：纯字母词 true；例句/词组/符号词/单音链外文本 false', () => {
    expect(isSingleWordShape('grandma')).toBe(true);
    expect(isSingleWordShape('  exchange ')).toBe(true);
    expect(isSingleWordShape('How many')).toBe(false); // 词组
    expect(isSingleWordShape('good-bye')).toBe(false); // 含符号
    expect(isSingleWordShape("Hello! Hello, I'm Li Ming.")).toBe(false); // 例句
    expect(isSingleWordShape('')).toBe(false);
  });

  it('manifest 注入后命中判定＋未加载完＝不可用', () => {
    __setWordAudioForTest(['grandma', 'exchange']);
    expect(wordAudioAvailable('grandma')).toBe(true);
    expect(wordAudioAvailable('Grandma ')).toBe(true); // 归一化
    expect(wordAudioAvailable('lecture')).toBe(false); // 未命中
    expect(wordAudioAvailable('how many')).toBe(false);
  });

  it('wordAudioRoutable：单字母项禁路由（票 52 不变式——a.mp3 是冠词音 /ə/ 非字母名 /eɪ/）', () => {
    __setWordAudioForTest(['a', 'grandma', 'grand', 'ma', 'i']);
    // 单字母即使 manifest 命中也禁路由（拼写链字母项读字母名）
    expect(wordAudioRoutable('a')).toBe(false);
    expect(wordAudioRoutable('A')).toBe(false);
    expect(wordAudioRoutable('i')).toBe(false);
    expect(wordAudioRoutable('I')).toBe(false);
    // 多字符词/音节命中即路由
    expect(wordAudioRoutable('grandma')).toBe(true);
    expect(wordAudioRoutable('Grandma')).toBe(true); // 归一化
    expect(wordAudioRoutable('grand')).toBe(true); // 拼读音节（≥2 字符）
    expect(wordAudioRoutable('ma')).toBe(true);
    // 未命中不路由
    expect(wordAudioRoutable('zzz')).toBe(false);
    // 例句/词组形状不路由
    expect(wordAudioRoutable('How many')).toBe(false);
  });

  it('音频超时保护常量在合理量级', () => {
    expect(WORD_AUDIO_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(WORD_AUDIO_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
