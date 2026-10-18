/**
 * R13.7 media fixtures: synthetic audio for ALASS's own speech detector (WebRTC VAD), and the subtitle
 * each case pairs with. AUTHORED-BY: opus-5.5-high
 *
 * Nothing here is a recording or a subtitle from anywhere. "Speech" is a voiced pulse train (a 120–160 Hz
 * pitch shaped by three formants, modulated at syllable rate); WebRTC VAD finds every burst of it at its
 * exact start (gate_ledger.md §5g.7). Ground truth is the burst list this file writes — never anything
 * ALASS or NG reports — so a case can check where a line *should* land.
 *
 * The cases are the synthetic analogues of E67/E68's detector matrix (`verification_ledger.md` §1.54–1.55):
 * a plain offset, a two-part cut, a five-minute silent opening, loud non-speech over part of the film,
 * centre-channel speech under loud left/right music in a 7.1 layout, silence, a different film's timing,
 * and inputs that are not usable media at all.
 */

export const MEDIA_SAMPLE_RATE = 16_000

export type Span = readonly [startMs: number, endMs: number]

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` bursts of 600–2400 ms with 800–3000 ms gaps, from `firstMs`. Deterministic per seed. */
export function bursts(count: number, firstMs: number, seed = 31): Span[] {
  const n = rng(seed)
  const out: Span[] = []
  let t = firstMs
  for (let i = 0; i < count; i++) {
    const len = 600 + Math.floor(n() * 37) * 50
    out.push([t, t + len])
    t += len + 800 + Math.floor(n() * 45) * 50
  }
  return out
}

const TAU = 2 * Math.PI
function voiced(i: number): number {
  const t = i / MEDIA_SAMPLE_RATE
  const f0 = 140 + 20 * Math.sin(TAU * 3 * t)
  let s = 0
  for (let k = 1; k <= 25; k++) {
    const f = k * f0
    const g = Math.exp(-((f - 700) ** 2) / (2 * 150 ** 2)) + 0.6 * Math.exp(-((f - 1200) ** 2) / (2 * 200 ** 2)) + 0.3 * Math.exp(-((f - 2500) ** 2) / (2 * 300 ** 2))
    s += g * Math.sin(TAU * f * t)
  }
  return 0.08 * s * (0.6 + 0.4 * Math.sin(TAU * 4 * t))
}
/** An A-minor triad with eight harmonics each: music, not speech. */
function chord(i: number): number {
  const t = i / MEDIA_SAMPLE_RATE
  let s = 0
  for (const f of [220, 277.18, 329.63]) for (let k = 1; k <= 8; k++) s += Math.sin(TAU * f * k * t) / k
  return 0.06 * s
}

const within = (ms: number, spans: readonly Span[]): boolean => spans.some(([a, z]) => ms >= a && ms < z)

interface Layer {
  /** Voiced speech in these spans. */
  speech?: readonly Span[]
  /** Loud music in these spans, at this gain. */
  music?: { spans: readonly Span[]; gain: number }
}

function channel(durationMs: number, layer: Layer, seed: number): Float64Array {
  const n = Math.round((durationMs * MEDIA_SAMPLE_RATE) / 1000)
  const out = new Float64Array(n)
  const hiss = rng(seed)
  for (let i = 0; i < n; i++) {
    const ms = (i * 1000) / MEDIA_SAMPLE_RATE
    let v = 0.0003 * (hiss() * 2 - 1)
    if (layer.speech && within(ms, layer.speech)) v += voiced(i)
    if (layer.music && within(ms, layer.music.spans)) v += layer.music.gain * chord(i)
    out[i] = v
  }
  return out
}

/** 16-bit PCM WAV. More than two channels are written as WAVE_FORMAT_EXTENSIBLE with the given speaker mask. */
export function wavBytes(channels: readonly Float64Array[], channelMask = 0): Buffer {
  const ch = channels.length
  const n = channels[0].length
  const pcm = Buffer.alloc(n * ch * 2)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))), (i * ch + c) * 2)
  }
  const ext = ch > 2
  const fmtLen = ext ? 40 : 16
  const h = Buffer.alloc(20 + fmtLen + 8)
  h.write('RIFF', 0)
  h.writeUInt32LE(12 + fmtLen + 8 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(fmtLen, 16)
  h.writeUInt16LE(ext ? 0xfffe : 1, 20)
  h.writeUInt16LE(ch, 22)
  h.writeUInt32LE(MEDIA_SAMPLE_RATE, 24)
  h.writeUInt32LE(MEDIA_SAMPLE_RATE * ch * 2, 28)
  h.writeUInt16LE(ch * 2, 32)
  h.writeUInt16LE(16, 34)
  if (ext) {
    h.writeUInt16LE(22, 36)
    h.writeUInt16LE(16, 38)
    h.writeUInt32LE(channelMask, 40)
    // KSDATAFORMAT_SUBTYPE_PCM {00000001-0000-0010-8000-00aa00389b71}
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(h, 44)
  }
  h.write('data', 20 + fmtLen)
  h.writeUInt32LE(pcm.length, 24 + fmtLen)
  return Buffer.concat([h, pcm])
}

/** FL FR FC LFE BL BR SL SR. */
const MASK_7_1 = 0x63f

const pad2 = (n: number): string => String(n).padStart(2, '0')
const stamp = (ms: number): string =>
  `${pad2(Math.floor(ms / 3_600_000))}:${pad2(Math.floor(ms / 60_000) % 60)}:${pad2(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`

/** The subtitle a case aligns: one numbered neutral line per span. */
export function subRip(spans: readonly Span[]): string {
  return spans.map(([s, e], i) => `${i + 1}\n${stamp(s)} --> ${stamp(e)}\nLine ${i + 1}\n`).join('\n')
}

/**
 * A subtitle line never starts on the millisecond its speech does; timers sit tens to hundreds of ms
 * either side. Each line here is placed `lead(i)` from its burst, fixed per line. Without it every
 * line lands exactly on ALASS's 10 ms detector grid — the `exact_onsets` case (gate_ledger.md §5g.7).
 */
const LEAD_MS = 180
const leads = ((): number[] => {
  const n = rng(5)
  return Array.from({ length: 200 }, () => Math.round((n() * 2 - 1) * LEAD_MS))
})()
const lead = (i: number): number => leads[i % leads.length]

export type MediaCaseName = 'offset' | 'two_part' | 'silent_opening' | 'exact_onsets' | 'loud_nonspeech' | 'center_7_1' | 'silence' | 'unrelated'

export interface MediaCase {
  name: MediaCaseName
  /** Cases with the same key have byte-identical audio, so a caller may write it once. */
  audioKey: string
  /** The WAV the case's reference is. */
  wav(): Buffer
  /** The subtitle to align, as SubRip text. */
  source: string
  /** Where each source line truly belongs (start ms), or `null` where the audio holds no speech for it. */
  truthStartMs: readonly (number | null)[]
  /** Spans of loud non-speech, for cases that have one. */
  nonSpeech: readonly Span[]
}

const SPEECH = bursts(80, 4000)
const end = (spans: readonly Span[]): number => spans[spans.length - 1][1] + 4000
const shifted = (spans: readonly Span[], by: (i: number) => number): Span[] => spans.map(([s, e], i) => [s + by(i), e + by(i)])
/** The synced subtitle for these bursts: each line `lead(i)` from its speech. */
const timed = (spans: readonly Span[]): Span[] => shifted(spans, lead)
const starts = (spans: readonly Span[]): number[] => spans.map(([s]) => s)

const AUDIO_KEY: Readonly<Record<MediaCaseName, string>> = {
  offset: 'speech',
  two_part: 'speech',
  unrelated: 'speech',
  silent_opening: 'late',
  exact_onsets: 'late',
  loud_nonspeech: 'loud_nonspeech',
  center_7_1: 'center_7_1',
  silence: 'silence'
}

export function mediaCase(name: MediaCaseName): MediaCase {
  return { ...build(name), audioKey: AUDIO_KEY[name] }
}

function build(name: MediaCaseName): Omit<MediaCase, 'audioKey'> {
  switch (name) {
    case 'offset': {
      const synced = timed(SPEECH)
      return { name, wav: () => wavBytes([channel(end(SPEECH), { speech: SPEECH }, 7)]), source: subRip(shifted(synced, () => 3000)), truthStartMs: starts(synced), nonSpeech: [] }
    }
    case 'two_part': {
      // The release the subtitle was timed to has 8 s more before line 41: a scene added.
      const synced = timed(SPEECH)
      return {
        name,
        wav: () => wavBytes([channel(end(SPEECH), { speech: SPEECH }, 7)]),
        source: subRip(shifted(synced, (i) => (i < 40 ? 0 : 8000))),
        truthStartMs: starts(synced),
        nonSpeech: []
      }
    }
    case 'silent_opening': {
      // Five minutes of studio logo and silence before the first line (the tester's case, E20a).
      const late = shifted(SPEECH, () => 296_000)
      const synced = timed(late)
      return { name, wav: () => wavBytes([channel(end(late), { speech: late }, 7)]), source: subRip(shifted(synced, () => 2500)), truthStartMs: starts(synced), nonSpeech: [] }
    }
    case 'exact_onsets': {
      // silent_opening with every line on its burst's exact millisecond: a fixture artefact, kept as a known limit.
      const late = shifted(SPEECH, () => 296_000)
      return { name, wav: () => wavBytes([channel(end(late), { speech: late }, 7)]), source: subRip(shifted(late, () => 2500)), truthStartMs: starts(late), nonSpeech: [] }
    }
    case 'loud_nonspeech': {
      // Lines 31–51 are spoken over silence in the subtitle's release; in this audio that stretch is loud music.
      const music: Span[] = [[SPEECH[30][0] - 500, SPEECH[50][1] + 500]]
      const kept = SPEECH.filter(([s]) => !within(s, music))
      const synced = timed(SPEECH)
      return {
        name,
        wav: () => wavBytes([channel(end(SPEECH), { speech: kept, music: { spans: music, gain: 4 } }, 7)]),
        source: subRip(shifted(synced, () => 2000)),
        truthStartMs: synced.map(([s], i) => (within(SPEECH[i][0], music) ? null : s)),
        nonSpeech: music
      }
    }
    case 'center_7_1': {
      // Dialogue only in the centre channel; loud music in front left/right for the whole film.
      const d = end(SPEECH)
      const all: Span[] = [[0, d]]
      const silent = channel(d, {}, 11)
      const front = channel(d, { music: { spans: all, gain: 3 } }, 13)
      const centre = channel(d, { speech: SPEECH }, 7)
      const synced = timed(SPEECH)
      return {
        name,
        wav: () => wavBytes([front, front, centre, silent, silent, silent, silent, silent], MASK_7_1),
        source: subRip(shifted(synced, () => 3000)),
        truthStartMs: starts(synced),
        nonSpeech: all
      }
    }
    case 'silence':
      return { name, wav: () => wavBytes([channel(60_000, {}, 7)]), source: subRip(timed(SPEECH.slice(0, 20))), truthStartMs: SPEECH.slice(0, 20).map(() => null), nonSpeech: [] }
    case 'unrelated': {
      // The subtitle is another film's: its own rhythm of lines, unrelated to this audio.
      const other = bursts(80, 4000, 99)
      return { name, wav: () => wavBytes([channel(end(SPEECH), { speech: SPEECH }, 7)]), source: subRip(other), truthStartMs: other.map(() => null), nonSpeech: [] }
    }
  }
}

export const MEDIA_CASES: readonly MediaCaseName[] = Object.freeze(['offset', 'two_part', 'silent_opening', 'exact_onsets', 'loud_nonspeech', 'center_7_1', 'silence', 'unrelated'])
