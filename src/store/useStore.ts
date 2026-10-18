import { create } from 'zustand'
import type { AppSettings, ModelInfo } from '../../electron/shared/types'
import type { QuotaGroupMutation, QuotaGroupMutationResult } from '../../electron/shared/quotaGroups'

interface StoreState {
  loaded: boolean
  settings: AppSettings | null
  modelsUpdatedAt: string | null
  load: () => Promise<void>
  patch: (p: Partial<AppSettings>) => Promise<void>
  /** A Quota Group edit, applied by main; a refused edit leaves Settings as they were. */
  mutateQuotaGroup: (m: QuotaGroupMutation) => Promise<QuotaGroupMutationResult>
  setModels: (models: ModelInfo[], updatedAt: string | null) => void
}

export const useStore = create<StoreState>((set, get) => ({
  loaded: false,
  settings: null,
  modelsUpdatedAt: null,

  load: async () => {
    const settings = await window.api.getSettings()
    set({ settings, modelsUpdatedAt: settings.modelsUpdatedAt, loaded: true })
  },

  patch: async (p) => {
    const updated = await window.api.setSettings(p)
    set({ settings: updated })
  },

  mutateQuotaGroup: async (m) => {
    const result = await window.api.mutateQuotaGroup(m)
    if (result.ok) set({ settings: result.settings })
    return result
  },

  setModels: (models, updatedAt) => {
    const s = get().settings
    if (!s) return
    set({ settings: { ...s, cachedModels: models, modelsUpdatedAt: updatedAt }, modelsUpdatedAt: updatedAt })
  }
}))
