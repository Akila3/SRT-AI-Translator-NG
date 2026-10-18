/**
 * REP-17 / FP-1b: prove a model fetch cannot hang the app.
 *
 * Retargeted at the SDK call in Step 4.1. The fetch no longer starts a process; it lists models
 * through `providers/gemini.ts`. This probe points that real call at a loopback server which accepts
 * the request and never answers, and proves the request is abandoned rather than waited on forever,
 * that the answer does not blame the key, and that the abandoned connection is actually closed.
 *
 * Only the destination is replaced (`baseUrl`, the gates' loopback seam); the call, the transport
 * and the 60-second budget are the shipped ones.
 *
 * Takes about a minute, because it waits out the real production timeout rather than a shortened
 * test-only one — a knob that existed only for tests would not be proving the shipped behaviour.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import { refreshModels } from '../../electron/main/modelsList'

function pass(label: string, detail = ''): void {
  console.log(`  PASS  ${label}${detail ? `\n        ${detail}` : ''}`)
}

function fail(label: string, detail: string): never {
  console.log(`  FAIL  ${label}\n        ${detail}`)
  process.exit(1)
}

async function main(): Promise<void> {
  let requests = 0
  let closedAt = 0
  const server = http.createServer((req) => {
    requests++
    // Read the request, never answer it.
    req.resume()
    req.socket.on('close', () => {
      closedAt = Date.now()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  console.log(`Silent server: http://127.0.0.1:${port}`)
  console.log('It accepts the request and never answers.\n')
  console.log('Waiting out the real 60s production timeout...\n')

  const started = Date.now()
  const result = await refreshModels('placeholder-key-never-used', undefined, { provider: { baseUrl: `http://127.0.0.1:${port}` } })
  const settledAt = Date.now()
  const elapsedMs = settledAt - started
  const elapsed = Math.round(elapsedMs / 1000)

  if (result.keyValid) fail('a fetch that never answered must not be reported valid', String(result.ids))
  pass('the fetch ended by itself instead of hanging', `after ${elapsed}s, ${requests} request(s) reached the server`)

  if (!/gave up after 60 seconds/i.test(result.error)) {
    fail('the message names the timeout', `got: ${result.error}`)
  }
  pass('the message names the timeout', result.error)

  if (!/does not mean the key is invalid/i.test(result.error)) {
    fail('the message does not blame the key', `got: ${result.error}`)
  }
  pass('the message does not blame the key')

  // Bounds, not an exact value: the request still has to be made and abandoned around the budget.
  if (elapsedMs < 50_000) fail('it waited the budget rather than giving up early', `${elapsed}s`)
  if (elapsedMs > 100_000) fail('it gave up near the budget rather than long after', `${elapsed}s`)
  pass('it waited the configured budget, and no longer', `${elapsed}s, budget 60s`)

  // The client's abort closes the socket; the server sees it go.
  for (let attempt = 0; attempt < 40 && !closedAt; attempt++) await new Promise((r) => setTimeout(r, 250))
  server.close()
  if (requests === 0 || !closedAt || closedAt - settledAt > 10_000) {
    fail(
      'the abandoned request was closed, not left open',
      requests === 0 ? 'no request reached the server' : 'the connection was still open 10s after the fetch gave up'
    )
  }
  pass('the abandoned request was closed, not left open')

  console.log('\nPASS  a model fetch cannot hang the app')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
