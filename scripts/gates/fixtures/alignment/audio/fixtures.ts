/**
 * Bundle C, C.1 — alignment audio fixtures (`implementation_plan.md` §10.3).
 *
 * §10.3 names the media shapes both in-process audio callers must handle: 5.1 with voice isolation on
 * and off, 7.1, stereo, mono, a source whose audio stream is not the first, and a variable-frame-rate
 * container. Each is the `ffprobe -select_streams a` JSON such a file returns, written by hand from the
 * shape the bundled ffprobe prints (`ffmpeg.ts` `probeAudioProps`); the streams were checked against
 * `resources/bin/ffprobe.exe` on the tester's own MKVs (7.1 default + 5.1(side) + stereo). No media
 * is stored.
 *
 * The PCM side is synthetic and seeded: tone bursts at known millisecond positions over a quiet
 * noise floor. Ground truth is the list of bursts that built the audio, never what a detector reported
 * (AGENTS §4b check 11). The drift fixture is alignment-only (§10.3).
 */

export const SAMPLE_RATE = 16_000

export interface ProbeFixture {
  name: string
  json: string
  isolateVoice: boolean
  /** What both callers must map and how many channels they pan from. */
  streamIndex: number
  channels: number
}

function probe(streams: Array<Record<string, unknown>>, duration: string, extraFormat: Record<string, unknown> = {}): string {
  return JSON.stringify({ streams, format: { duration, ...extraFormat } })
}

export const PROBE_FIXTURES: readonly ProbeFixture[] = [
  {
    name: '5.1 isolate on',
    json: probe([{ index: 1, codec_type: 'audio', channels: 6, channel_layout: '5.1(side)', disposition: { default: 1 } }], '5400.250'),
    isolateVoice: true,
    streamIndex: 1,
    channels: 6
  },
  {
    name: '5.1 isolate off',
    json: probe([{ index: 1, codec_type: 'audio', channels: 6, channel_layout: '5.1(side)', disposition: { default: 1 } }], '5400.250'),
    isolateVoice: false,
    streamIndex: 1,
    channels: 6
  },
  {
    name: '7.1',
    json: probe(
      [
        { index: 1, codec_type: 'audio', channels: 8, channel_layout: '7.1', disposition: { default: 1 } },
        { index: 2, codec_type: 'audio', channels: 6, channel_layout: '5.1(side)', disposition: { default: 0 } },
        { index: 3, codec_type: 'audio', channels: 2, channel_layout: 'stereo', disposition: { default: 0 } }
      ],
      '7322.104'
    ),
    isolateVoice: true,
    streamIndex: 1,
    channels: 8
  },
  {
    name: 'stereo',
    json: probe([{ index: 0, codec_type: 'audio', channels: 2, channel_layout: 'stereo', disposition: { default: 1 } }], '1610.880'),
    isolateVoice: true,
    streamIndex: 0,
    channels: 2
  },
  {
    name: 'mono',
    json: probe([{ index: 0, codec_type: 'audio', channels: 1, channel_layout: 'mono', disposition: { default: 0 } }], '62.000'),
    isolateVoice: true,
    streamIndex: 0,
    channels: 1
  },
  {
    // Video 0, two subtitle streams 1–2, then the audio the user hears: default on the second track.
    name: 'audio stream not first',
    json: probe(
      [
        { index: 3, codec_type: 'audio', channels: 2, channel_layout: 'stereo', disposition: { default: 0 } },
        { index: 4, codec_type: 'audio', channels: 6, channel_layout: '5.1', disposition: { default: 1 } }
      ],
      '2700.000'
    ),
    isolateVoice: true,
    streamIndex: 4,
    channels: 6
  },
  {
    // A phone recording: variable video frame rate, so only the audio's own sample clock is a timeline.
    name: 'variable-frame-rate container',
    json: probe(
      [{ index: 1, codec_type: 'audio', channels: 2, channel_layout: 'stereo', disposition: { default: 1 }, start_time: '0.021333' }],
      '183.457',
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
    ),
    isolateVoice: true,
    streamIndex: 1,
    channels: 2
  }
]

export interface Burst {
  startMs: number
  endMs: number
}

/** A small deterministic PRNG (mulberry32) so every run builds the same samples. */
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

/**
 * 16 kHz mono s16le: a 2 kHz tone at `toneAmplitude` (of full scale) inside each burst, uniform noise
 * of `noiseAmplitude` everywhere else. With the defaults a burst window reads ≈ −23 dBFS and the floor
 * ≈ −75 dBFS, so every sweep threshold from −60 to −25 dBFS separates them.
 */
export function burstPcm(bursts: readonly Burst[], durationMs: number, opts: { toneAmplitude?: number; noiseAmplitude?: number; seed?: number } = {}): Buffer {
  const tone = opts.toneAmplitude ?? 0.1
  const noise = opts.noiseAmplitude ?? 0.0003
  const next = rng(opts.seed ?? 7)
  const total = Math.round((durationMs * SAMPLE_RATE) / 1000)
  const buf = Buffer.alloc(total * 2)
  let b = 0
  for (let i = 0; i < total; i++) {
    const ms = (i * 1000) / SAMPLE_RATE
    while (b < bursts.length && ms >= bursts[b].endMs) b++
    const inBurst = b < bursts.length && ms >= bursts[b].startMs
    const v = inBurst ? tone * Math.sin((2 * Math.PI * 2000 * i) / SAMPLE_RATE) : noise * (next() * 2 - 1)
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2)
  }
  return buf
}

/** Forty spoken stretches on the 50 ms grid, 0.6–2.4 s long, with 0.8–3.0 s gaps. */
export function speechBursts(count = 40, firstMs = 4000): Burst[] {
  const next = rng(31)
  const out: Burst[] = []
  let t = firstMs
  for (let i = 0; i < count; i++) {
    const len = 600 + Math.floor(next() * 37) * 50
    out.push({ startMs: t, endMs: t + len })
    t += len + 800 + Math.floor(next() * 45) * 50
  }
  return out
}

/** PAL speed-up drift (25 / 23.976) plus a 2.34 s offset, snapped back onto the 50 ms grid. */
export const DRIFT = { scale: 1.042708, offsetMs: 2340 } as const

export function driftedBursts(base: readonly Burst[]): Burst[] {
  const snap = (ms: number): number => Math.round(ms / 50) * 50
  return base.map((b) => ({ startMs: snap(b.startMs * DRIFT.scale + DRIFT.offsetMs), endMs: snap(b.endMs * DRIFT.scale + DRIFT.offsetMs) }))
}
