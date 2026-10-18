/**
 * Minimal `electron` stand-in for the gate suite.
 *
 * The gates exercise the REAL modules (`migrations`, `modelsList`, `pythonBridge`, `ipc`)
 * rather than copies of them, so nothing can pass here while the shipped code differs.
 * Those modules import `electron` for a handful of paths and for `ipcMain.handle`, none of
 * which is reachable from the pure functions under test — so a stub is enough, and it
 * keeps the suite runnable under plain `node`.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-gate-'))

export const app = {
  isPackaged: false,
  getPath: (_name: string): string => userData,
  getAppPath: (): string => process.cwd(),
  getVersion: (): string => '0.0.0-gates',
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (): void => {},
  quit: (): void => {}
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
const ipcHandlers = new Map<string, IpcHandler>()

export const ipcMain = {
  handle: (channel: string, handler: IpcHandler): void => {
    ipcHandlers.set(channel, handler)
  },
  on: (): void => {}
}

/**
 * Test-only: call a registered handler the way Electron would.
 *
 * Handlers are closures, and a closure can be wrong in ways the function it calls is not —
 * REG-1 was a temporal-dead-zone read inside `translate:start`'s `onDone`, invisible to any
 * test that called `startTranslate` directly. Reaching the real handler is the only way to
 * cover that.
 */
export function __invokeIpc(channel: string, ...args: unknown[]): unknown {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No IPC handler registered for "${channel}"`)
  return handler({}, ...args)
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath: string }> => ({
    canceled: true,
    filePath: ''
  })
}

export const shell = {
  showItemInFolder: (): void => {},
  openExternal: async (): Promise<void> => {}
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}

/** No gate reaches the network: provider gates inject their own transport, and this refuses every call. */
export const net = {
  fetch: (): Promise<Response> => Promise.reject(new Error('net.fetch is not available in the gate suite')),
  resolveHost: (): Promise<{ endpoints: { address: string; family: string }[] }> => Promise.reject(new Error('net.resolveHost is not available in the gate suite'))
}

export const session = {
  defaultSession: {
    resolveProxy: (): Promise<string> => Promise.reject(new Error('session.resolveProxy is not available in the gate suite'))
  },
  fromPartition: (): never => {
    throw new Error('session.fromPartition is not available in the gate suite')
  }
}

export default { app, ipcMain, dialog, shell, BrowserWindow, net, session }
