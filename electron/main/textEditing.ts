import { Menu, type BrowserWindow, type ContextMenuParams } from 'electron'

/**
 * The four text-field kinds that get the native Cut / Copy / Paste menu (Feature 7, D7-1/D7-2).
 *
 * `formControlType` is the field Electron 31.7.7 documents on the `context-menu` event. Numeric,
 * select, checkbox and button controls are outside the feature, so they stay menu-less as before.
 */
const TEXT_FIELDS: ReadonlySet<ContextMenuParams['formControlType']> = new Set([
  'input-password',
  'input-search',
  'input-text',
  'text-area'
])

/**
 * Give one window a native right-click edit menu on its text fields.
 *
 * Role items act on the field and selection that opened the menu, through Chromium's own edit
 * commands, so the text never passes through this code, the renderer's JavaScript or IPC; React sees
 * the same input event a keystroke produces. Enablement is Chromium's `editFlags`: a disabled field
 * reports nothing to do, and a hidden password reports no Copy or Cut (measured at Round 12 entry).
 *
 * Ctrl+C/X/V stay with Electron's default Edit application menu. These items must not register
 * their accelerators: a second owner of the same shortcut can run the command twice.
 */
export function installTextEditing(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (!TEXT_FIELDS.has(params.formControlType)) return
    const { canCut, canCopy, canPaste } = params.editFlags
    // A read-only field (a Settings path) is worth a menu only when there is something to copy.
    if (!params.isEditable && !canCopy) return
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.isEditable && canCut, registerAccelerator: false },
      { role: 'copy', enabled: canCopy, registerAccelerator: false },
      { role: 'paste', enabled: params.isEditable && canPaste, registerAccelerator: false }
    ])
    menu.popup({ window, sourceType: params.menuSourceType })
  })
}
