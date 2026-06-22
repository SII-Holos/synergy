export namespace BrowserClipboard {
  export interface ClipboardResult {
    text: string | null
    ok: boolean
  }

  const DEFAULT_MAX_BYTES = 1_048_576 // 1 MB

  // ── CDP expression builders ──────────────────────────────────────

  /** Build a JS expression that reads text from the navigator clipboard. */
  export function buildReadClipboardExpr(): string {
    return `(async()=>{try{return await navigator.clipboard.readText()}catch{return null}})()`
  }

  /** Build a JS expression that writes text to the navigator clipboard. */
  export function buildWriteClipboardExpr(text: string): string {
    const escaped = JSON.stringify(text)
    return `(async()=>{try{await navigator.clipboard.writeText(${escaped});return true}catch{return false}})()`
  }

  /**
   * Build a JS expression that triggers the browser clipboard permission
   * flow by attempting a clipboard read.
   */
  export function buildGrantClipboardPermExpr(): string {
    return `(async()=>{try{await navigator.clipboard.readText();return true}catch{return false}})()`
  }

  // ── text sanitization ────────────────────────────────────────────

  /**
   * Sanitize clipboard text for safe CDP transfer.
   * Strips null bytes and truncates to maxBytes (UTF-8 aware, default 1 MB).
   */
  export function sanitizeClipboardText(text: string, maxBytes?: number): string {
    const limit = maxBytes ?? DEFAULT_MAX_BYTES
    let result = text.replace(/\0/g, "")
    const encoder = new TextEncoder()
    while (encoder.encode(result).byteLength > limit && result.length > 0) {
      result = result.slice(0, -1)
    }
    return result
  }
}
