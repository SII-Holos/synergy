import type { BrowserTab } from "./tab.js"
import { BrowserLocator } from "./locator.js"

type LocatorInput = BrowserLocator.LocatorInput
type ResolvedElement = BrowserLocator.ResolvedElement

export namespace BrowserWait {
  export interface WaitOptions {
    timeoutMs?: number
    pollMs?: number
    signal?: AbortSignal
  }

  const DEFAULT_TIMEOUT = 30_000
  const DEFAULT_POLL = 100
  const NETWORK_IDLE_DEBOUNCE = 500

  // ── helpers ──────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  function checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Aborted")
  }

  // ── public API ───────────────────────────────────────────────────

  /**
   * Wait for a locator to appear in the page.
   * Delegates to BrowserLocator.resolve for polling.
   */
  export async function waitForLocator(
    tab: BrowserTab,
    locator: LocatorInput,
    opts?: WaitOptions,
  ): Promise<ResolvedElement> {
    const validation = BrowserLocator.validateLocator(locator)
    if (!validation.ok) throw new Error(`Invalid locator: ${validation.message}`)

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
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
    const pollMs = opts?.pollMs ?? DEFAULT_POLL

    const matches = (): boolean => {
      if (matcher instanceof RegExp) return matcher.test(tab.url)
      return tab.url.includes(matcher)
    }

    if (matches()) return

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let eventUnsub: (() => void) | null = null

      const deadline = Date.now() + timeoutMs

      const done = () => {
        if (settled) return
        settled = true
        eventUnsub?.()
        resolve()
      }

      const fail = (msg: string) => {
        if (settled) return
        settled = true
        eventUnsub?.()
        reject(new Error(msg))
      }

      const cdp = tab.cdp
      if (cdp) {
        const handler = () => {
          if (matches()) done()
        }
        cdp.on("Page.frameNavigated", handler)
        eventUnsub = () => cdp.off("Page.frameNavigated", handler)
      }

      if (opts?.signal) {
        if (opts.signal.aborted) {
          fail("Aborted")
          return
        }
        opts.signal.addEventListener("abort", () => fail("Aborted"), { once: true })
      }

      const poll = async () => {
        while (!settled) {
          if (Date.now() >= deadline) {
            fail(`waitForURL timed out after ${timeoutMs / 1000}s`)
            return
          }
          await sleep(pollMs)
          if (!settled && matches()) done()
        }
      }
      poll()
    })
  }

  // ── waitForLoadState ─────────────────────────────────────────────

  /** Wait for page load state. */
  export async function waitForLoadState(
    tab: BrowserTab,
    state: "load" | "domcontentloaded" | "networkidle",
    opts?: WaitOptions,
  ): Promise<void> {
    switch (state) {
      case "load":
        return waitForLoad(tab, opts)
      case "domcontentloaded":
        return waitForDOMContentLoaded(tab, opts)
      case "networkidle":
        return waitForNetworkIdle(tab, opts)
    }
  }

  async function waitForLoad(tab: BrowserTab, opts?: WaitOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
    const pollMs = opts?.pollMs ?? DEFAULT_POLL

    if (!tab.loading) return

    const resolved = await raceEvent(tab, "Page.loadEventFired", opts?.signal, timeoutMs, pollMs, () => !tab.loading)

    if (resolved) return

    throw new Error(`waitForLoadState(load) timed out after ${timeoutMs / 1000}s`)
  }

  async function waitForDOMContentLoaded(tab: BrowserTab, opts?: WaitOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
    const pollMs = opts?.pollMs ?? DEFAULT_POLL

    const resolved = await raceEvent(tab, "Page.domContentEventFired", opts?.signal, timeoutMs, pollMs, undefined)

    if (resolved) return

    throw new Error(`waitForLoadState(domcontentloaded) timed out after ${timeoutMs / 1000}s`)
  }

  /**
   * Race a CDP event against timeout/signal, with an optional polling predicate.
   * Returns true if the event fired (or predicate satisfied), false on timeout.
   */
  async function raceEvent(
    tab: BrowserTab,
    event: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    pollMs: number,
    pollPredicate?: () => boolean,
  ): Promise<boolean> {
    const cdp = tab.cdp
    if (!cdp) {
      if (!pollPredicate) return false
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        checkSignal(signal)
        if (pollPredicate()) return true
        await sleep(pollMs)
      }
      return false
    }

    let fired = false
    const handler = () => {
      fired = true
    }
    cdp.on(event, handler)

    try {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        checkSignal(signal)
        if (fired) return true
        if (pollPredicate?.()) return true
        await sleep(pollMs)
      }
      return false
    } finally {
      cdp.off(event, handler)
    }
  }

  // ── waitForNetworkIdle ───────────────────────────────────────────

  /** Wait for network idle — no pending requests for a debounce period. */
  export async function waitForNetworkIdle(tab: BrowserTab, opts?: WaitOptions): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT
    const cdp = tab.cdp

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let pending = 0
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      let pollInterval: ReturnType<typeof setInterval> | null = null
      let onAbort: (() => void) | null = null

      const cleanup = () => {
        clearIdleTimer()
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (pollInterval) clearInterval(pollInterval)
        if (onAbort && opts?.signal) opts.signal.removeEventListener("abort", onAbort)
        unregEvents()
      }

      const done = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }

      const fail = (msg: string) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(msg))
      }

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      const scheduleIdle = () => {
        clearIdleTimer()
        if (pending === 0) {
          idleTimer = setTimeout(done, NETWORK_IDLE_DEBOUNCE)
        }
      }

      const unregFns: Array<() => void> = []
      const unregEvents = () => {
        for (const fn of unregFns) fn()
        unregFns.length = 0
      }

      const regEvent = (eventName: string, handler: (params: Record<string, unknown>) => void) => {
        if (cdp) {
          cdp.on(eventName, handler)
          unregFns.push(() => cdp.off(eventName, handler))
        }
      }

      const onRequestWillBeSent = () => {
        pending++
        clearIdleTimer()
      }

      const onRequestFinished = () => {
        pending = Math.max(0, pending - 1)
        scheduleIdle()
      }

      regEvent("Network.requestWillBeSent", onRequestWillBeSent)
      regEvent("Network.loadingFinished", onRequestFinished)
      regEvent("Network.loadingFailed", onRequestFinished)

      timeoutTimer = setTimeout(() => fail(`waitForNetworkIdle timed out after ${timeoutMs / 1000}s`), timeoutMs)

      if (opts?.signal) {
        if (opts.signal.aborted) {
          fail("Aborted")
          return
        }
        onAbort = () => fail("Aborted")
        opts.signal.addEventListener("abort", onAbort, { once: true })
      }

      if (!cdp) {
        const pollMs = opts?.pollMs ?? DEFAULT_POLL
        let pollCount = 0
        const maxPolls = Math.ceil(timeoutMs / pollMs)
        pollInterval = setInterval(() => {
          pollCount++
          if (pollCount >= maxPolls) {
            fail(`waitForNetworkIdle timed out after ${timeoutMs / 1000}s`)
          }
        }, pollMs)
      }

      scheduleIdle()
    })
  }
}
