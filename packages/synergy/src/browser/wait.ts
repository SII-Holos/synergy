import type { Page } from "playwright"
import type { BrowserTab } from "./tab.js"
import { BrowserLocator } from "./locator.js"
import type { Locator } from "playwright"
import { ToolTimeout } from "@/tool/timeout"

type LocatorInput = BrowserLocator.LocatorInput
type ResolvedElement = BrowserLocator.ResolvedElement

export namespace BrowserWait {
  export interface WaitOptions {
    timeoutMs?: number
    pollMs?: number
    signal?: AbortSignal
  }

  const DEFAULT_TIMEOUT = ToolTimeout.DEFAULTS.browserHelperWaitMs
  const DEFAULT_POLL = 100

  // ── helpers ──────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  function checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Aborted")
  }

  function pageOrThrow(tab: BrowserTab): Page {
    const page = tab.page
    if (!page) throw new Error("No Playwright page available for wait operations")
    return page
  }

  // ── public API ───────────────────────────────────────────────────

  /**
   * Wait for a locator to appear in the page.
   * Uses Playwright locator.waitFor when a page is available, falling back
   * to BrowserLocator.resolve polling on snapshot-based tabs.
   */
  export async function waitForLocator(
    tab: BrowserTab,
    locator: LocatorInput,
    opts?: WaitOptions,
  ): Promise<ResolvedElement> {
    const validation = BrowserLocator.validateLocator(locator)
    if (!validation.ok) throw new Error(`Invalid locator: ${validation.message}`)

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT

    const page = tab.page
    if (page) {
      // Playwright path: use locator.waitFor
      try {
        const pwLocator = BrowserLocator.toPlaywrightLocator(page, locator)
        if (opts?.signal) {
          checkSignal(opts.signal)
        }
        await pwLocator.waitFor({ timeout: timeoutMs, state: "attached" })

        // After wait, resolve via existing path to get the ResolvedElement shape
        const result = await BrowserLocator.resolve(tab, locator)
        if (result) return result

        // Fallback: build a synthetic result
        try {
          const box = await pwLocator.boundingBox()
          if (box) {
            return {
              visible: true,
              enabled: true,
              editable: false,
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            }
          }
        } catch {
          /* synthetic box failed */
        }
      } catch (err) {
        if (opts?.signal?.aborted) throw new Error("Aborted")
        throw err
      }
    }

    // Fallback: poll using BrowserLocator.resolve
    const pollMs = opts?.pollMs ?? DEFAULT_POLL
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      checkSignal(opts?.signal)

      const result = await BrowserLocator.resolve(tab, locator)
      if (result) return result

      await sleep(pollMs)
    }

    throw new Error(
      `waitForLocator timed out after ${timeoutMs / 1000}s (kind=${locator.kind}, value=${String(locator.value)})`,
    )
  }

  // ── waitForText ──────────────────────────────────────────────────

  /** Wait for text to appear in the page body. */
  export async function waitForText(tab: BrowserTab, text: string, opts?: WaitOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
    const page = tab.page

    if (page) {
      // Playwright path: getByText + waitFor
      try {
        const loc = page.getByText(text).first()
        await loc.waitFor({ timeout: timeoutMs, state: "attached" })
        return
      } catch {
        // Fall through to fallback polling
      }
    }

    // Fallback: poll via evaluate
    const pollMs = opts?.pollMs ?? DEFAULT_POLL
    const check = async (): Promise<boolean> => {
      try {
        const result = await tab.evaluate("document.body ? document.body.innerText : ''")
        return typeof result === "string" && result.includes(text)
      } catch {
        return false
      }
    }

    if (await check()) return

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      checkSignal(opts?.signal)
      await sleep(pollMs)
      if (await check()) return
    }

    throw new Error(`waitForText timed out after ${timeoutMs / 1000}s`)
  }

  // ── waitForURL ───────────────────────────────────────────────────

  /** Wait for the tab URL to contain a string or match a regex. */
  export async function waitForURL(tab: BrowserTab, matcher: string | RegExp, opts?: WaitOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
    const page = tab.page

    if (page) {
      // Playwright path: page.waitForURL
      try {
        if (matcher instanceof RegExp) {
          await page.waitForURL(matcher, { timeout: timeoutMs })
        } else {
          await page.waitForURL((url) => url.toString().includes(matcher), { timeout: timeoutMs })
        }
        return
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback: polling
    const pollMs = opts?.pollMs ?? DEFAULT_POLL

    const matches = (): boolean => {
      if (matcher instanceof RegExp) return matcher.test(tab.url)
      return tab.url.includes(matcher)
    }

    if (matches()) return

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      checkSignal(opts?.signal)
      await sleep(pollMs)
      if (matches()) return
    }

    throw new Error(`waitForURL timed out after ${timeoutMs / 1000}s`)
  }

  // ── waitForLoadState ─────────────────────────────────────────────

  /** Wait for page load state. */
  export async function waitForLoadState(
    tab: BrowserTab,
    state: "load" | "domcontentloaded" | "networkidle",
    opts?: WaitOptions,
  ): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
    const page = tab.page

    if (page) {
      // Playwright path: page.waitForLoadState
      try {
        await page.waitForLoadState(state, { timeout: timeoutMs })
        return
      } catch {
        // Fall through
      }
    }

    // Fallback: polling
    const pollMs = opts?.pollMs ?? DEFAULT_POLL
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      checkSignal(opts?.signal)
      if (state === "load" && !tab.loading) return
      if (state === "networkidle" && !tab.loading) return
      await sleep(pollMs)
    }

    throw new Error(`waitForLoadState(${state}) timed out after ${timeoutMs / 1000}s`)
  }
}
