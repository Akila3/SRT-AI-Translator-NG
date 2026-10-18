/**
 * The provider transport, and the response-body ceiling it enforces (D14-5, implementation_plan.md
 * §14 row D14.3).
 *
 * AUTHORED-BY: opus-5.5-high
 *
 * The SDK sends every request through `httpOptions.fetch`; this module is that fetch. It is a
 * `node:http(s)` request rather than the global fetch because undici decodes `Content-Encoding`
 * inside itself, so the bytes on the wire would be invisible to any counter wrapped around it.
 * Here all three counts are ours: the declared `Content-Length`, the entity bytes as they arrive,
 * and the bytes this module's own decoder produces. Each is checked BEFORE the chunk is kept, so at
 * most `limitBytes` is ever buffered, and the SDK receives a `Response` only after the whole body has
 * been counted. An oversize body never reaches a parser, the SDK or a caller.
 *
 * Non-streaming `generateContent` only (D4): nothing here yields a partial body.
 *
 * An https request goes through the proxy and trust store the shipping engine would use on this
 * computer (`proxy.ts`): through a proxy it is a CONNECT tunnel with TLS to Google inside it, so the
 * proxy sees the destination and never the key or the body.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { PassThrough, type Transform } from 'node:stream'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { resolveNetworkRoute, systemNetworkSources, type NetworkRoute, type NetworkSources, type ProxyRoute } from './proxy'

// ── the frozen envelope (gate_ledger.md §5.16 records the measurement) ──────

/**
 * Largest official `outputTokenLimit` among the generateContent models the key could list on
 * 2026-10-05. A later model with a larger limit is held to the absolute ceiling below, never above it.
 */
export const MAX_OFFICIAL_OUTPUT_TOKENS = 65_536

/**
 * Response bytes allowed per output token (visible plus thinking: both spend the same budget, and a
 * thought signature grows with the thinking). Worst measured 14.5 — long runs of one punctuation
 * character — so 64 is ~4.4× that and 2× a 31-space whitespace token, the one shape the service
 * would not answer (503). See §5.16.
 */
export const RESPONSE_BYTES_PER_OUTPUT_TOKEN = 64

/** The body around the generated text — usage metadata, the candidate wrapper, model version. Measured 738 B. */
export const RESPONSE_FIXED_OVERHEAD_BYTES = 64 * 1024

/** No single Gemini response may exceed this, whatever the model or request. */
export const RESPONSE_ABSOLUTE_CEILING_BYTES =
  MAX_OFFICIAL_OUTPUT_TOKENS * RESPONSE_BYTES_PER_OUTPUT_TOKEN + RESPONSE_FIXED_OVERHEAD_BYTES

/** A non-generation call (model list, model metadata) has no output-token budget to size it by. */
export const METADATA_RESPONSE_LIMIT_BYTES = 1024 * 1024

export interface ResponseEnvelopeInput {
  /** The selected model's official `outputTokenLimit`; null when it was not fetched. */
  outputTokenLimit: number | null
  /**
   * The most output the request can legitimately need (a cue batch's schema), INCLUDING any thinking
   * it allows, when the caller knows it. `maxOutputTokens` is deliberately not an input: whether
   * every model counts thinking against it is measured only for gemini-3.5-flash.
   */
  needTokens?: number
}

function positive(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * The normal envelope for one request: the smaller of the model's official output capacity and the
 * request's stated need, converted at the frozen byte factor plus overhead. It can never exceed the
 * absolute ceiling.
 */
export function responseLimitBytes(input: ResponseEnvelopeInput): number {
  const tokens = Math.min(
    positive(input.outputTokenLimit) ?? MAX_OFFICIAL_OUTPUT_TOKENS,
    positive(input.needTokens) ?? Number.POSITIVE_INFINITY
  )
  return Math.min(tokens * RESPONSE_BYTES_PER_OUTPUT_TOKEN + RESPONSE_FIXED_OVERHEAD_BYTES, RESPONSE_ABSOLUTE_CEILING_BYTES)
}

// ── the counted transport ───────────────────────────────────────────────────

export interface BodyCount {
  /** `Content-Length` as sent; null when absent or not a number. A hint, never trusted. */
  declaredBytes: number | null
  /** Entity bytes as received (after chunked framing, before content decoding). */
  receivedBytes: number
  /** Bytes after content decoding. Equal to received for an unencoded body. */
  decodedBytes: number
  /** The most this transport held in memory for the body. Never above the limit. */
  peakBufferedBytes: number
}

export type LimitStage = 'declared' | 'received' | 'decoded'

export class ResponseTooLargeError extends Error {
  readonly limitBytes: number
  readonly stage: LimitStage
  readonly count: BodyCount
  constructor(limitBytes: number, stage: LimitStage, count: BodyCount) {
    super(`Response body exceeds the ${limitBytes}-byte limit (${stage}).`)
    this.name = 'ResponseTooLargeError'
    this.limitBytes = limitBytes
    this.stage = stage
    this.count = count
  }
}

/** A refusal raised before anything left the process. */
export class TransportRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportRequestError'
  }
}

export interface CapturedResponse {
  status: number
  /** Lower-cased names; repeated headers joined with `, `. */
  headers: Readonly<Record<string, string>>
  /** The decoded body, exactly as counted. */
  body: Buffer
  count: BodyCount
}

export type TransportFailure =
  | { kind: 'too-large'; error: ResponseTooLargeError }
  | { kind: 'aborted' }
  | { kind: 'refused'; error: TransportRequestError }
  | { kind: 'error'; error: unknown }

export interface TransportState {
  /** Requests that left the process. A deadline before the first is `pre-dispatch`. */
  dispatched: number
  /** Responses handed to the SDK. Zero after any refusal. */
  handedOver: number
  /** The last complete response, captured before the SDK saw it. */
  captured: CapturedResponse | null
  /** The last call's failure, if it failed. */
  failure: TransportFailure | null
}

export interface BoundedTransport {
  readonly limitBytes: number
  readonly fetch: typeof fetch
  state(): TransportState
}

export interface BoundedTransportOptions {
  limitBytes: number
  /** Gates point the SDK at a loopback server; plain http is refused for any other host. */
  allowLoopbackHttp?: boolean
  /** Gates only: the proxy settings and certificate files to route by, instead of this computer's. */
  network?: NetworkSources
}

/** The proxy's answer to CONNECT was not 200. The message carries the status, never the address. */
export class ProxyTunnelError extends Error {
  readonly code: 'ERR_NG_PROXY_AUTH' | 'ERR_NG_PROXY_TUNNEL'
  readonly status: number
  constructor(status: number) {
    super(`The proxy answered ${status} to the tunnel request.`)
    this.name = 'ProxyTunnelError'
    this.status = status
    this.code = status === 407 ? 'ERR_NG_PROXY_AUTH' : 'ERR_NG_PROXY_TUNNEL'
  }
}

/**
 * A `createConnection` for `https.request` that opens the TLS session to `target` inside a CONNECT
 * tunnel. `track` receives the tunnel request and socket so the caller's teardown can end them.
 */
function tunnelConnection(
  proxy: ProxyRoute,
  target: URL,
  ca: string[] | undefined,
  track: (tunnel: http.ClientRequest | net.Socket) => void
): (options: unknown, callback: (error: Error | null, socket?: net.Socket) => void) => undefined {
  return (_options, callback) => {
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const port = target.port ? Number(target.port) : 443
    const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
    const headers: Record<string, string> = { host: authority }
    if (proxy.authorization) headers['proxy-authorization'] = proxy.authorization
    const connectOptions = { host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, headers, agent: false as const }
    const tunnelReq = proxy.secure ? https.request({ ...connectOptions, servername: sniName(proxy.host) }) : http.request(connectOptions)
    track(tunnelReq)
    let done = false
    const finish = (error: Error | null, socket?: net.Socket): void => {
      if (done) return
      done = true
      callback(error, socket)
    }
    tunnelReq.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return finish(new ProxyTunnelError(res.statusCode ?? 0))
      }
      if (head.length > 0) socket.unshift(head)
      const secure = tls.connect({ socket, servername: sniName(host), host, ca, ALPNProtocols: ['http/1.1'] })
      track(secure)
      finish(null, secure)
    })
    tunnelReq.once('error', (error) => finish(error))
    tunnelReq.end()
    return undefined
  }
}

/** SNI may not name an IP address; the certificate check then uses `host` alone. */
function sniName(host: string): string | undefined {
  return net.isIP(host) ? undefined : host
}

const minted = new WeakSet<object>()

/** True only for a fetch this module created; `gemini.ts` refuses any other. */
export function isBoundedFetch(f: unknown): boolean {
  return typeof f === 'function' && minted.has(f)
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive'
])
export const ACCEPTED_ENCODINGS = 'gzip, deflate, br'

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError')
}

function decoderFor(encoding: string): Transform | null {
  switch (encoding.trim().toLowerCase()) {
    case '':
    case 'identity':
      return new PassThrough()
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'deflate':
      return zlib.createInflate()
    case 'br':
      return zlib.createBrotliDecompress()
    default:
      return null
  }
}

function headerRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    out[name] = value
  })
  if (!('accept-encoding' in out)) out['accept-encoding'] = ACCEPTED_ENCODINGS
  return out
}

function requestBody(body: RequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new TransportRequestError('The provider transport accepts only a string or byte request body.')
}

/**
 * A fetch for the SDK that refuses any response body over `limitBytes` before buffering it. Create
 * one per provider call: its state describes that call.
 */
export function createBoundedTransport(options: BoundedTransportOptions): BoundedTransport {
  const limitBytes = Math.floor(options.limitBytes)
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    throw new RangeError('A bounded transport needs a positive byte limit.')
  }
  const state: TransportState = { dispatched: 0, handedOver: 0, captured: null, failure: null }

  const boundedFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    state.failure = null
    const fail = (failure: TransportFailure, error: unknown): never => {
      state.failure = failure
      throw error
    }
    if (typeof input !== 'string' && !(input instanceof URL)) {
      const error = new TransportRequestError('The provider transport accepts only a URL.')
      return fail({ kind: 'refused', error }, error)
    }
    const url = new URL(String(input))
    const secure = url.protocol === 'https:'
    if (!secure && !(url.protocol === 'http:' && options.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname))) {
      const error = new TransportRequestError(`The provider transport refuses ${url.protocol} to this host.`)
      return fail({ kind: 'refused', error }, error)
    }
    let body: Buffer | null
    try {
      body = requestBody(init?.body)
    } catch (e) {
      const error = e as TransportRequestError
      return fail({ kind: 'refused', error }, error)
    }
    const signal = init?.signal ?? null
    if (signal?.aborted) return fail({ kind: 'aborted' }, abortError())

    const headers = requestHeaders(init)
    if (body) headers['content-length'] = String(body.length)

    let route: NetworkRoute = { proxy: null, ca: undefined }
    if (secure) {
      try {
        route = await resolveNetworkRoute(url, options.network ?? systemNetworkSources)
      } catch (error) {
        // A proxy or certificate setting that cannot be used: nothing was sent.
        return fail({ kind: 'error', error }, error)
      }
      if (signal?.aborted) return fail({ kind: 'aborted' }, abortError())
    }

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      let req: http.ClientRequest | null = null
      let res: http.IncomingMessage | null = null
      let decoder: Transform | null = null
      const tunnel: Array<http.ClientRequest | net.Socket> = []
      const chunks: Buffer[] = []
      const count: BodyCount = { declaredBytes: null, receivedBytes: 0, decodedBytes: 0, peakBufferedBytes: 0 }
      let buffered = 0

      const teardown = (): void => {
        signal?.removeEventListener('abort', onAbort)
        decoder?.destroy()
        res?.destroy()
        req?.destroy()
        for (const t of tunnel) t.destroy()
      }
      const settleError = (failure: TransportFailure, error: unknown): void => {
        if (settled) return
        settled = true
        state.failure = failure
        chunks.length = 0
        teardown()
        reject(error)
      }
      const tooLarge = (stage: LimitStage): void => {
        const error = new ResponseTooLargeError(limitBytes, stage, { ...count })
        settleError({ kind: 'too-large', error }, error)
      }
      function onAbort(): void {
        settleError({ kind: 'aborted' }, abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const requestOptions: https.RequestOptions = { method: init?.method ?? 'GET', headers }
      if (route.ca) requestOptions.ca = route.ca
      if (route.proxy) {
        requestOptions.createConnection = tunnelConnection(route.proxy, url, route.ca, (t) => tunnel.push(t)) as unknown as https.RequestOptions['createConnection']
      }
      req = (secure ? https : http).request(url, requestOptions)
      state.dispatched++
      req.on('error', (error) => settleError({ kind: 'error', error }, error))
      req.on('response', (incoming) => {
        res = incoming
        const status = incoming.statusCode ?? 0
        const declared = Number(incoming.headers['content-length'])
        if (incoming.headers['content-length'] !== undefined && Number.isFinite(declared) && declared >= 0) {
          count.declaredBytes = declared
          if (declared > limitBytes) return tooLarge('declared')
        }
        const encoding = String(incoming.headers['content-encoding'] ?? '')
        decoder = decoderFor(encoding)
        if (!decoder) {
          const error = new TransportRequestError(`Unsupported response Content-Encoding "${encoding}".`)
          return settleError({ kind: 'error', error }, error)
        }
        const decode = decoder
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return
          count.receivedBytes += chunk.length
          if (count.receivedBytes > limitBytes) return tooLarge('received')
          if (!decode.write(chunk)) {
            incoming.pause()
            decode.once('drain', () => incoming.resume())
          }
        })
        incoming.on('end', () => {
          if (!settled) decode.end()
        })
        incoming.on('error', (error) => settleError({ kind: 'error', error }, error))
        incoming.on('close', () => {
          if (incoming.complete) return
          const error = Object.assign(new Error('The response ended before its body was complete.'), { code: 'ECONNRESET' })
          settleError({ kind: 'error', error }, error)
        })
        decode.on('data', (chunk: Buffer) => {
          if (settled) return
          count.decodedBytes += chunk.length
          if (count.decodedBytes > limitBytes) return tooLarge('decoded')
          chunks.push(chunk)
          buffered += chunk.length
          count.peakBufferedBytes = Math.max(count.peakBufferedBytes, buffered)
        })
        decode.on('error', (error) => settleError({ kind: 'error', error }, error))
        decode.on('end', () => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          const bytes = Buffer.concat(chunks)
          const captured: CapturedResponse = { status, headers: headerRecord(incoming.headers), body: bytes, count: { ...count } }
          state.captured = captured
          const outHeaders = new Headers()
          for (const [name, value] of Object.entries(captured.headers)) {
            if (!DROPPED_RESPONSE_HEADERS.has(name)) outHeaders.append(name, value)
          }
          let response: Response
          try {
            response = new Response(NULL_BODY_STATUSES.has(status) ? null : new Uint8Array(bytes), {
              status,
              statusText: incoming.statusMessage ?? '',
              headers: outHeaders
            })
          } catch (error) {
            state.failure = { kind: 'error', error }
            reject(error)
            return
          }
          state.handedOver++
          resolve(response)
        })
      })
      req.end(body ?? undefined)
    })
  }) as typeof fetch

  minted.add(boundedFetch)
  return { limitBytes, fetch: boundedFetch, state: () => ({ ...state }) }
}
