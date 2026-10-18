import React, { useRef, useState } from 'react'
import { Button, TextInput } from './ui'
import { checkSourcePath, refusalMessage, type SourceCheck, type SourceFilter } from '../lib/inputFiles'

/** The parts of a `DataTransferItem` the drop chain reads; a real item satisfies it. */
export interface DroppedItem {
  readonly kind: string
  webkitGetAsEntry(): { readonly isFile: boolean; readonly isDirectory: boolean } | null
  getAsFile(): File | null
}

/**
 * Turn one drop into a path, or a refusal, without touching any page state.
 *
 * Every link must hold, in this order: exactly one item; a file item; an entry that is a file and not
 * a folder (a folder also reports `kind === 'file'`, and a suffix proves nothing); a `File`; a
 * non-empty OS path from the preload bridge, whose failure is caught here as well as there; and
 * finally the same extension check Browse uses. It has to run inside the drop event, while the
 * items are still readable.
 */
export function resolveDroppedPath(
  items: ArrayLike<DroppedItem> | null | undefined,
  pathFor: (file: File) => string,
  filters: readonly SourceFilter[]
): SourceCheck {
  if (!items || items.length === 0) return { ok: false, refusal: 'no-path' }
  if (items.length > 1) return { ok: false, refusal: 'multiple' }
  const item = items[0]
  if (!item || item.kind !== 'file') return { ok: false, refusal: 'no-path' }
  let entry: ReturnType<DroppedItem['webkitGetAsEntry']>
  try {
    entry = item.webkitGetAsEntry()
  } catch {
    entry = null
  }
  if (!entry) return { ok: false, refusal: 'no-path' }
  if (entry.isDirectory) return { ok: false, refusal: 'directory' }
  if (!entry.isFile) return { ok: false, refusal: 'no-path' }
  let file: File | null
  try {
    file = item.getAsFile()
  } catch {
    file = null
  }
  if (!file) return { ok: false, refusal: 'no-path' }
  let resolved: unknown
  try {
    resolved = pathFor(file)
  } catch {
    resolved = ''
  }
  if (typeof resolved !== 'string' || resolved === '') return { ok: false, refusal: 'no-path' }
  return checkSourcePath(resolved, filters)
}

/**
 * Stop a file dropped anywhere outside a source field from navigating the window to it.
 *
 * A source field handles its own drag events and stops them there, so this sees only drags over the
 * rest of the app: a drag carrying files is shown as not droppable and its drop is swallowed. Any other
 * drag (text moved between editable fields) keeps its native behaviour. It changes no state. Hidden
 * tabs are not rendered, so they can never be the target. Returns the removal.
 */
export function installFileDropGuard(target: EventTarget): () => void {
  const carriesFiles = (e: Event): boolean => Array.from((e as DragEvent).dataTransfer?.types ?? []).includes('Files')
  const onDragOver = (e: Event): void => {
    if (!carriesFiles(e)) return
    e.preventDefault()
    const dt = (e as DragEvent).dataTransfer
    if (dt) dt.dropEffect = 'none'
  }
  const onDrop = (e: Event): void => {
    if (!carriesFiles(e)) return
    e.preventDefault()
  }
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}

/** The one place a checked pick leaves the field: a refusal shows its message and calls nothing. */
export function settleSourcePick(
  result: SourceCheck,
  filters: readonly SourceFilter[],
  onSelect: (path: string) => void,
  showRefusal: (message: string) => void
): void {
  if (!result.ok) {
    showRefusal(refusalMessage(result.refusal, filters))
    return
  }
  showRefusal('')
  onSelect(result.path)
}

export const DROP_HINT = 'or drop one file here'

/**
 * A source-file field: Browse, or drop one file onto it.
 *
 * Both routes end in the same `onSelect(path)`, and only after the path passes this field's own
 * filter, so the page's one accepted-path transition is the only thing that changes its state. A
 * refused drop or Browse shows a fixed message and calls nothing. Destinations and settings keep the
 * plain `FilePicker`.
 */
export function InputFilePicker({
  value,
  placeholder,
  filters,
  onSelect,
  onClear
}: {
  value: string
  placeholder: string
  filters: readonly SourceFilter[]
  onSelect: (path: string) => void
  onClear?: () => void
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  const [refusal, setRefusal] = useState('')
  // Entering a child fires enter on it before leave on the parent; counting keeps the highlight steady.
  const depth = useRef(0)

  function settle(result: SourceCheck): void {
    settleSourcePick(result, filters, onSelect, setRefusal)
  }

  async function browse(): Promise<void> {
    const p = await window.api.openFile([...filters])
    if (!p) return
    settle(checkSourcePath(p, filters))
  }

  function onDragEnter(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    depth.current += 1
    setOver(true)
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    depth.current = 0
    setOver(false)
    settle(resolveDroppedPath(e.dataTransfer?.items, (f) => window.api.pathForDroppedFile(f), filters))
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-drop-zone=""
      className={`-m-[7px] rounded-md border p-1.5 transition-colors ${
        over ? 'border-brand bg-blue-50/70 dark:bg-blue-950/40' : 'border-transparent'
      }`}
    >
      <div className="flex items-center gap-2">
        <TextInput readOnly value={value} placeholder={placeholder} className="flex-1" />
        <Button variant="secondary" onClick={browse}>
          Browse
        </Button>
        {value && onClear && (
          <button
            title="Clear"
            onClick={onClear}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            ✕
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{DROP_HINT}</p>
      {refusal && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {refusal}
        </p>
      )}
    </div>
  )
}
