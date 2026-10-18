import { app, BrowserWindow } from 'electron'
import path from 'path'
import { alignService, registerIpc, setMainWindow, openApprovedExternal } from './ipc'
import { sweepTempDir } from './tempFiles'
import { isRunning, shutdownJob } from '../engine/runner'
import { installTextEditing } from './textEditing'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'SRT AI Translator NG',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  setMainWindow(win)
  installTextEditing(win)

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    void openApprovedExternal(details.url).catch(() => {})
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Before any window exists, so nothing on screen can be referring to what it removes. Only
  // files older than a week, and only in our own scratch directory (SOL-07).
  const swept = sweepTempDir()
  if (swept) console.log(`[temp] removed ${swept} expired scratch file(s)`)
  alignService.resumeCleanup()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Take the engine down with the application.
 *
 * Closing the window used to quit outright, which on Windows leaves the spawned tree running:
 * a parent's exit does not terminate its children, and nothing here owns them. So a run that was
 * in progress kept going invisibly — spending quota against the user's key, writing to files
 * nobody would look at again, holding its temp media (validator finding SOL-04).
 *
 * `before-quit` rather than `window-all-closed`, because it is the one hook that also covers
 * Cmd-Q, a menu Quit and a shutdown-initiated quit. Quitting is vetoed exactly once, for as long
 * as it takes to stop the job; `shutdownJob()` is bounded, so an engine that refuses to die
 * delays the close briefly instead of preventing it.
 */
let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !isRunning()) return
  e.preventDefault()
  quitting = true
  void shutdownJob().then(() => app.quit())
})

// After `before-quit` has stopped any job: an Align transcription offer's folder (which can hold a
// stopped run's partial transcript) is in the OS temp folder, outside `sweepTempDir`'s reach. What
// cannot be removed now stays in this process's session folder, which `resumeCleanup` at a later
// start removes once this process is gone.
app.on('will-quit', () => alignService.dispose())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
