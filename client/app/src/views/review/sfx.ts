/**
 * 复习段演出音效（Ticket 30）：WebAudio 振荡器合成，零音频资产、零版权面。
 *
 * 设计约束：
 *   - 全部函数 try/catch 兜底 no-op：AudioContext 缺失（node 测试/极端 WebView）
 *     不抛错，演出层绝不因音效失败卡死（fail-open 与演出层同款纪律）；
 *   - 首次调用才建 AudioContext（浏览器自动播放策略：复习段首响是字母点击
 *     手势之后，天然满足用户手势要求）；
 *   - 音量低（≤0.12）：TTS 朗读是主声道，音效只作点缀不抢听写锚。
 */

let ctx: AudioContext | null = null;

function acquire(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** 短促单音（oscillator＋增益包络；type/起止频率/时长可变）。 */
function blip(
  type: OscillatorType,
  fromHz: number,
  toHz: number,
  durationMs: number,
  volume: number,
): void {
  const ac = acquire();
  if (!ac) return;
  try {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const t0 = ac.currentTime;
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), t0 + durationMs / 1000);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.02);
  } catch {
    /* 音效失败静默：演出不依赖音效 */
  }
}

/** 噪声爆裂（爆炸用：白噪声 buffer＋低通下滑）。 */
function boom(durationMs: number, volume: number): void {
  const ac = acquire();
  if (!ac) return;
  try {
    const frames = Math.floor(ac.sampleRate * (durationMs / 1000));
    const buffer = ac.createBuffer(1, frames, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames); // 衰减白噪声（演出随机无业务语义）
    }
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    const t0 = ac.currentTime;
    filter.frequency.setValueAtTime(900, t0);
    filter.frequency.exponentialRampToValueAtTime(120, t0 + durationMs / 1000);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start(t0);
  } catch {
    /* 音效失败静默 */
  }
}

/** 字母子弹出膛：短促高频哔。 */
export function sfxShoot(): void {
  blip('square', 920, 500, 60, 0.05);
}

/** 词串命中：中频点。 */
export function sfxHit(): void {
  blip('triangle', 420, 210, 110, 0.08);
}

/** 击破爆炸：噪声爆裂＋低音坠落。 */
export function sfxBoom(): void {
  boom(360, 0.12);
  blip('sine', 220, 45, 320, 0.1);
}

/** 光波蓄力（票 59）：锯齿波升频扫升＋音量抬升，胸灯亮起同步。 */
export function sfxCharge(): void {
  blip('sawtooth', 160, 980, 360, 0.06);
}

/** 光波发射（票 59）：低频轰底＋短噪声脉冲，命中砸重感。 */
export function sfxBeam(): void {
  blip('sine', 110, 38, 420, 0.11);
  boom(180, 0.07);
}

/** 武器升级：三连上行琶音。 */
export function sfxPowerUp(): void {
  try {
    blip('square', 520, 520, 90, 0.06);
    setTimeout(() => blip('square', 660, 660, 90, 0.06), 90);
    setTimeout(() => blip('square', 880, 880, 140, 0.07), 180);
  } catch {
    /* 音效失败静默 */
  }
}

/** Boss 来袭警告：两声低鸣。 */
export function sfxBossWarn(): void {
  try {
    blip('sawtooth', 150, 150, 200, 0.09);
    setTimeout(() => blip('sawtooth', 130, 130, 260, 0.09), 260);
  } catch {
    /* 音效失败静默 */
  }
}

/* ---------------- 芯片音乐（票 32；五声音阶 16 步循环） ----------------
 * 浏览器自动播放策略：AudioContext 需用户手势后 resume——startMusic 在
 * battle-start 即尝试，挂起态由首个手势后的重试（letterFire/pointerdown
 * 调 ensureMusic）自然接通。无 AudioContext 环境（测试桩）全 no-op。 */

let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicStep = 0;

/** C 大调五声音阶（ cheerful pentatonic）：旋律 16 步（0＝休止）＋低音 4 步循环。 */
const MELODY_HZ: readonly number[] = [
  523, 0, 659, 0, 784, 659, 0, 523, 587, 0, 659, 784, 0, 659, 523, 0,
];
const BASS_HZ: readonly number[] = [131, 98, 110, 131];
const MUSIC_STEP_MS = 190;

function musicNote(type: OscillatorType, hz: number, durationMs: number, volume: number): void {
  const ac = acquire();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') { void ac.resume().catch(() => undefined); }
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const t0 = ac.currentTime;
    osc.type = type;
    osc.frequency.setValueAtTime(hz, t0);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.02);
  } catch {
    /* 静默 */
  }
}

/** 启动背景音乐（已在放则忽略；音频不可用则静默）。 */
export function startMusic(): void {
  try {
    if (musicTimer) return;
    if (!acquire()) return;
    musicStep = 0;
    musicTimer = setInterval(() => {
      const melody = MELODY_HZ[musicStep % MELODY_HZ.length]!;
      if (melody > 0) musicNote('triangle', melody, 170, 0.038);
      if (musicStep % 4 === 0) {
        musicNote('square', BASS_HZ[Math.floor(musicStep / 4) % BASS_HZ.length]!, 300, 0.028);
      }
      musicStep += 1;
    }, MUSIC_STEP_MS);
  } catch {
    /* 静默 */
  }
}

/** 停止背景音乐（卸载/清场调用；幂等）。 */
export function stopMusic(): void {
  if (musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}
