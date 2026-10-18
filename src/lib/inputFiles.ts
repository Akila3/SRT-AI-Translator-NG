/**
 * Which files a source field accepts, decided from that field's own Browse filter.
 *
 * Browse and drop both pass through `checkSourcePath`, so a dropped file can never be one the
 * field's Open dialog would not offer. Each field derives its allow-list from its own filters:
 * the four source fields deliberately accept different sets, so there is no shared media list.
 * Only the final suffix counts, compared without regard to case.
 */

export type SourceFilter = Electron.FileFilter

export type SourceRefusal = 'no-path' | 'directory' | 'multiple' | 'unsupported'

export type SourceCheck = { ok: true; path: string } | { ok: false; refusal: SourceRefusal }

const NO_PATH = 'That item cannot be used here. Drop one file from a folder on this computer, or use Browse.'
const DIRECTORY = 'That is a folder. Drop one file instead.'
const MULTIPLE = 'Drop one file at a time.'

/** Lower-case extensions the filters offer, without dots; `*` means any file. */
export function acceptedExtensions(filters: readonly SourceFilter[]): string[] {
  const out: string[] = []
  for (const f of filters) {
    for (const e of f.extensions) {
      const ext = e.replace(/^\.+/, '').toLowerCase()
      if (ext && !out.includes(ext)) out.push(ext)
    }
  }
  return out
}

/** The text after the last dot of the file's own name, lower-cased; '' when there is none. */
export function finalSuffix(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function checkSourcePath(filePath: string, filters: readonly SourceFilter[]): SourceCheck {
  if (typeof filePath !== 'string' || filePath.trim() === '') return { ok: false, refusal: 'no-path' }
  const allowed = acceptedExtensions(filters)
  if (allowed.includes('*')) return { ok: true, path: filePath }
  const suffix = finalSuffix(filePath)
  return suffix && allowed.includes(suffix) ? { ok: true, path: filePath } : { ok: false, refusal: 'unsupported' }
}

export function refusalMessage(refusal: SourceRefusal, filters: readonly SourceFilter[]): string {
  switch (refusal) {
    case 'no-path':
      return NO_PATH
    case 'directory':
      return DIRECTORY
    case 'multiple':
      return MULTIPLE
    case 'unsupported':
      return `This file type is not accepted here. Choose one of: ${acceptedExtensions(filters)
        .map((e) => `.${e}`)
        .join(', ')}.`
  }
}
