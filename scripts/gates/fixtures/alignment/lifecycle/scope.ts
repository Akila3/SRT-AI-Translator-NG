/**
 * Bundle M's scope fixture (implementation_plan.md §16.0.7 M-J). One fixed set of analyses over every
 * chain the media arbitration must not touch — a subtitle reference (accept, check, weak, wrong title,
 * kept identity), the audio arm (accept, and a refusal carrying an offer), the consented transcript, and
 * Advanced (Global's refusal of a two-part film, then its piecewise result) — with Preview and Apply's
 * written bytes. The same function runs against any `createAlignService`, so the outcome of Round 7's
 * service and of this one can be compared field by field. Cues are synthetic; nothing private enters git.
 *
 * AUTHORED-BY: opus-5.5-high
 */
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { defaultAlassDeps } from '../../../../../electron/engine/alassSidecar'
import { audioMatching, audioUnrelated, fallbackSource, transcriptNear } from '../fallback/fixtures'
import { asCues, retimed, speech } from '../global/fixtures'
import { outputsSpawn, outputsTrust } from '../ipc/advanced'
import { fixture, srtBytes, writeFile } from '../ipc/fixtures'
import { syntheticPair } from '../reports/fixtures'

/** What the scope run needs of a service; Round 7's and this round's both have it. */
export interface ScopeService {
  analyze(req: unknown): Promise<Record<string, unknown> & { status: string }>
  preview(req: unknown): unknown
  apply(req: unknown): Promise<Record<string, unknown> & { ok: boolean }>
  settled(): Promise<void>
}
export type ScopeFactory = (deps: Record<string, unknown>) => ScopeService

/** Fields that are per run by design (§16.0.7 M-J): the id is asserted on its own; the offer's token and folder are minted. */
const PER_RUN = new Set(['resultId', 'diagnosticExportable', 'token', 'outputPath'])

export interface ScopeRun {
  /** Every analysis, preview page and Apply, in order, with the per-run fields dropped and `root` replaced. */
  normalized: string
  /** Per analysis, the result id (or null), for the separate id assertions. */
  ids: Array<string | null>
  /** Per analysis, whether it carries any Bundle M evidence field. */
  bundleMFields: boolean[]
}

/**
 * Run the fixed set under `root` (an empty folder). Every service gets its own scratch folder and a
 * dialog that saves into `root/out`.
 */
export async function scopeRun(factory: ScopeFactory, root: string): Promise<ScopeRun> {
  const out: unknown[] = []
  const ids: Array<string | null> = []
  const bundleMFields: boolean[] = []
  const outDir = path.join(root, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  let saved = 0
  const saveTo = (): string => path.join(outDir, `saved-${++saved}.srt`)
  let nextSave: string | null = null
  const scratchRoot = path.join(root, 'scratch')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const MODEL = 'gemini-3.7-flash'
  const base = (audio: unknown): Record<string, unknown> => ({
    tempRoot: () => scratchRoot,
    ffmpegPath: () => undefined,
    probeTracks: async () => [],
    extractTrack: async () => {
      throw new Error('scope: no track is ever extracted')
    },
    extractTextTracks: async () => {
      throw new Error('scope: no track is ever extracted')
    },
    audioForAlignment: async () => audio,
    transcriptionModel: () => ({ model: MODEL, supported: true }),
    jobRunning: () => false,
    saveDialog: async () => nextSave,
    progress: () => {},
    alassTrust: () => outputsTrust(),
    alassDeps: () => ({ ...defaultAlassDeps(), spawn: outputsSpawn('follow') })
  })
  const note = async (s: ScopeService, a: Record<string, unknown> & { status: string }, apply: boolean): Promise<void> => {
    ids.push(typeof a.resultId === 'string' ? a.resultId : null)
    const ev = a.evidence as Record<string, unknown> | null | undefined
    bundleMFields.push(!!ev && ('tracks' in ev || 'arbitration' in ev))
    out.push(a)
    if (a.status !== 'result') return
    out.push(s.preview({ generation: a.generation, resultId: a.resultId, from: 0, count: 5 }))
    if (!apply) return
    nextSave = saveTo()
    const applied = await s.apply({ generation: a.generation, resultId: a.resultId })
    out.push(applied)
    out.push(applied.ok ? createHash('sha256').update(fs.readFileSync(nextSave)).digest('hex') : null)
  }

  // A subtitle reference: the four landed verdicts, then a kept-identity file.
  {
    const s = factory(base({ ok: false, error: 'no audio (scope stub)' }))
    let generation = 1
    for (const name of ['outliers-planted', 'coverage-84.5', 'coverage-59.5', 'wrong-title-sparse']) {
      const f = fixture(name)
      const src = writeFile(root, `s-${name}.srt`, srtBytes(f.source, 'utf-8', '\n'))
      const ref = writeFile(root, `s-${name}-ref.srt`, srtBytes(f.reference, 'utf-8', '\n'))
      await note(s, await s.analyze({ generation: generation++, sourcePath: src, reference: { kind: 'subtitle', path: ref } }), name === 'outliers-planted')
    }
    const plain = speech(300, 4242, 'Line')
    const jit = plain.map((q, i) => {
      const d = i < plain.length / 2 ? 150 : -150
      return { ...q, start: q.start + d, end: q.end + d }
    })
    const kSrc = writeFile(root, 'kept.srt', srtBytes(asCues(plain), 'utf-8', '\n'))
    const kRef = writeFile(root, 'kept-ref.srt', srtBytes(asCues(retimed(jit, 1, 0, 'Reference line')), 'utf-8', '\n'))
    await note(s, await s.analyze({ generation: generation++, sourcePath: kSrc, reference: { kind: 'subtitle', path: kRef } }), true)
    await s.settled()
  }

  // The audio arm and the consented transcript: a media file with no subtitle track.
  const source = fallbackSource()
  const src = writeFile(root, 'film.en.srt', srtBytes(source, 'utf-8', '\r\n'))
  const film = writeFile(root, 'film.mkv', Buffer.from('container bytes the stubs never parse'))
  {
    const s = factory(base(audioMatching()))
    await note(s, await s.analyze({ generation: 1, sourcePath: src, reference: { kind: 'media', path: film } }), true)
    await s.settled()
  }
  {
    const s = factory(base(audioUnrelated()))
    const r = await s.analyze({ generation: 1, sourcePath: src, reference: { kind: 'media', path: film } })
    await note(s, r, false)
    const offer = r.transcriptionOffer as { token: string; outputPath: string } | undefined
    if (offer) {
      fs.writeFileSync(offer.outputPath, srtBytes(transcriptNear(200), 'utf-8', '\n'))
      await note(s, await s.analyze({ generation: 2, sourcePath: src, reference: { kind: 'media', path: film }, transcriptionToken: offer.token }), true)
    } else out.push('no offer')
    await s.settled()
  }

  // Advanced: Global refuses a two-part film; the piecewise run gives a result that applies.
  {
    const pair = syntheticPair('two_part')
    const tpSrc = writeFile(root, 'two-part.srt', Buffer.from(pair.input, 'utf8'))
    const tpRef = writeFile(root, 'two-part-ref.srt', Buffer.from(pair.reference, 'utf8'))
    const s = factory(base({ ok: false, error: 'no audio (scope stub)' }))
    await note(s, await s.analyze({ generation: 1, sourcePath: tpSrc, reference: { kind: 'subtitle', path: tpRef } }), false)
    await note(s, await s.analyze({ generation: 2, sourcePath: tpSrc, reference: { kind: 'subtitle', path: tpRef }, mode: 'piecewise' }), true)
    await s.settled()
  }

  const json = JSON.stringify(out, (k, v) => (PER_RUN.has(k) ? undefined : v))
  const escaped = JSON.stringify(root).slice(1, -1)
  return { normalized: json.split(escaped).join('<root>'), ids, bundleMFields }
}
