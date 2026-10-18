import React, { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import TranslatePage from './pages/TranslatePage'
import TranscribePage from './pages/TranscribePage'
import AlignPage from './pages/AlignPage'
import SettingsPage from './pages/SettingsPage'
import { installFileDropGuard } from './components/InputFilePicker'
import { APP_VERSION } from './lib/appVersion'

type Tab = 'translate' | 'transcribe' | 'align' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'translate', label: 'Translate' },
  { id: 'transcribe', label: 'Transcribe' },
  { id: 'align', label: 'Align' },
  { id: 'settings', label: 'Settings' }
]

function applyTheme(theme: string): void {
  const root = document.documentElement
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = theme === 'dark' || (theme === 'auto' && sysDark)
  root.classList.toggle('dark', dark)
}

export default function App(): React.JSX.Element {
  const load = useStore((s) => s.load)
  const loaded = useStore((s) => s.loaded)
  const setModels = useStore((s) => s.setModels)
  const theme = useStore((s) => s.settings?.theme ?? 'auto')
  const [tab, setTab] = useState<Tab>('translate')

  useEffect(() => {
    void load().then(async () => {
      const cached = await window.api.getCachedModels()
      if (cached.models?.length) setModels(cached.models, cached.updatedAt)
    })
  }, [load, setModels])

  // A file dropped outside a source field would otherwise replace the whole app with that file.
  useEffect(() => installFileDropGuard(window), [])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => applyTheme('auto')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  return (
    <div className="flex h-full flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">SRT AI Translator NG</h1>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">(New Generation)</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Powered by Google Gemini AI · v{APP_VERSION}
          </p>
        </div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'text-brand'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {t.label}
              {tab === t.id && (
                <span className="absolute inset-x-2 -bottom-[13px] h-0.5 rounded-full bg-brand" />
              )}
            </button>
          ))}
        </nav>
      </header>

      {/* Body */}
      <main className="thin-scroll flex-1 overflow-y-auto p-6">
        {!loaded ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
        ) : (
          // Keep every page mounted and just toggle visibility so each tab's
          // inputs (loaded SRT, TMDB selection, languages, etc.) persist when
          // the user switches tabs and comes back.
          <>
            <div className={tab === 'translate' ? '' : 'hidden'}>
              <TranslatePage />
            </div>
            <div className={tab === 'transcribe' ? '' : 'hidden'}>
              <TranscribePage />
            </div>
            <div className={tab === 'align' ? '' : 'hidden'}>
              <AlignPage />
            </div>
            <div className={tab === 'settings' ? '' : 'hidden'}>
              <SettingsPage />
            </div>
          </>
        )}
      </main>
    </div>
  )
}
