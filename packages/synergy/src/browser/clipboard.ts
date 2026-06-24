import type { Page } from "playwright"

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

  // ── Playwright page-based clipboard operations ───────────────────

  /**
   * Grant clipboard read/write permissions on the Playwright browser context.
   * Call before readViaPage or writeViaPage to ensure navigator.clipboard is available.
   */
  export async function grantPermissions(page: Page): Promise<void> {
    try {
      const ctx = page.context()
      await ctx.grantPermissions(["clipboard-read", "clipboard-write"])
    } catch {
      // grantPermissions may not be available in some headless/context configurations.
    }
  }

  /**
   * Read clipboard text via page.evaluate after granting permissions.
   * Uses Playwright's page.evaluate with the readClipboard expression.
   */
  export async function readViaPage(page: Page): Promise<ClipboardResult> {
    await grantPermissions(page)
    try {
      const raw = (await page.evaluate(buildReadClipboardExpr())) as string | null
      const text = raw !== null && raw !== undefined ? sanitizeClipboardText(raw) : null
      return { text, ok: text !== null }
    } catch {
      return { text: null, ok: false }
    }
  }

  /**
   * Write text to clipboard via page.evaluate after granting permissions.
   * Uses Playwright's page.evaluate with the writeClipboard expression.
   */
  export async function writeViaPage(page: Page, text: string): Promise<ClipboardResult> {
    await grantPermissions(page)
    try {
      const ok = (await page.evaluate(buildWriteClipboardExpr(text))) as boolean
      return { text: ok ? text : null, ok: ok === true }
    } catch {
      return { text: null, ok: false }
    }
  }
}
