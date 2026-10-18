/**
 * Open an HTTPS URL through the main-process allowlist, and say if the OS refused.
 *
 * `window.api.openExternal` rejects on a launch failure (SOL-24). Callers that `void` that
 * promise turn the failure into an unhandled rejection and show the user nothing. This
 * helper is the one place that converts the rejection into a sentence the panel can print.
 * An empty string means the link opened.
 */
export async function openExternalLink(url: string): Promise<string> {
  try {
    await window.api.openExternal(url)
    return ''
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).trim()
    return detail ? `Could not open the link (${detail}).` : 'Could not open the link.'
  }
}
