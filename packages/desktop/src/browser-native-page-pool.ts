import { app, WebContentsView, type BrowserWindow, type WebContents } from "electron"
import {
  BrowserProtocolError,
  browserNativeRecoveryFailureMessage,
  isSafeBrowserObservation,
  withCdpCommandTimeout,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostPageEvent,
  type BrowserPage,
} from "@ericsanchezok/synergy-browser"
import { BrowserHostDiagnostics } from "./browser-host-diagnostics.js"
import { BrowserWebContentsControl } from "./browser-webcontents-control.js"
import { browserProfilePartition } from "./browser-profile.js"

export interface BrowserNativePageInput {
  ownerKey: string
  page: BrowserPage
  networkProxy: { server: string; username: string; password: string }
  downloadDir: string
  emit(event: BrowserHostPageEvent): void
}

export interface BrowserNativePageHandle {
  state(): BrowserPage
  execute(command: BrowserBackendCommand): Promise<BrowserBackendResult>
  destroy(): Promise<void>
  isAlive(): boolean
}

interface Generation {
  id: number
  view: WebContentsView
  control: BrowserWebContentsControl
  diagnostics: BrowserHostDiagnostics
  onLogin: (
    event: Electron.Event,
    webContents: Electron.WebContents,
    details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => void
  cleanupEvents: () => void
  state(): BrowserPage
  navigationTimer: ReturnType<typeof setTimeout> | null
  navigationRetries: number
  unresponsiveTimer: ReturnType<typeof setTimeout> | null
}

interface Entry extends BrowserNativePageHandle {
  ownerKey: string
  input: BrowserNativePageInput
  generation: Generation
  generationSequence: number
  recovery: Promise<void> | null
  failed: boolean
  closing: boolean
  recoveryBudget: number
  lastResumeRecoveryAt: number | null
  replacementListeners: Set<(view: WebContentsView, previous: WebContentsView) => void>
}

const INITIAL_NATIVE_PAGE_VIEWPORT = { width: 1280, height: 720 }
const DEFAULT_RECOVERY_DELAYS_MS = [0, 500, 2_000] as const
const MAX_RECOVERY_ROUNDS = 3
export const MAX_RECOVERY_BUDGET = 5
// Agent-driven resume retries are rate-limited: a page that keeps failing must
// not be recovered in a tight loop through the Agent path. The native Retry
// control is a deliberate human action and is not subject to this cooldown.
const RESUME_RECOVERY_COOLDOWN_MS = 15_000
const DEFAULT_UNRESPONSIVE_GRACE_MS = 5_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

export class BrowserNativePagePool {
  private entries = new Map<string, Entry>()
  private creating = new Set<string>()
  private destroying = new Map<string, Promise<void>>()

  constructor(
    private readonly options: {
      recoveryDelaysMs?: readonly number[]
      unresponsiveGraceMs?: number
      navigationTimeoutMs?: number
      resumeRecoveryCooldownMs?: number
    } = {},
  ) {}

  async create(input: BrowserNativePageInput): Promise<BrowserNativePageHandle> {
    if (this.entries.has(input.ownerKey) || this.creating.has(input.ownerKey) || this.destroying.has(input.ownerKey)) {
      throw new Error("Browser owner already has a native page.")
    }
    this.creating.add(input.ownerKey)
    try {
      const generation = await this.createGeneration(input, 1, input.page.url)
      const entry = {} as Entry
      Object.assign(entry, {
        ownerKey: input.ownerKey,
        input,
        generation,
        generationSequence: 1,
        recovery: null,
        failed: false,
        closing: false,
        recoveryBudget: MAX_RECOVERY_BUDGET,
        lastResumeRecoveryAt: null,
        replacementListeners: new Set<(view: WebContentsView, previous: WebContentsView) => void>(),
        state: () => entry.generation.state(),
        execute: (command: BrowserBackendCommand) => this.execute(entry, command),
        destroy: () => this.destroyEntry(input.ownerKey),
        isAlive: () => !entry.closing,
      } satisfies Partial<Entry>)
      this.entries.set(input.ownerKey, entry)
      this.bindRecoveryEvents(entry, generation)
      return entry
    } finally {
      this.creating.delete(input.ownerKey)
    }
  }

  find(ownerKey: string, pageId: string): Entry | undefined {
    const entry = this.entries.get(ownerKey)
    return entry?.state().id === pageId ? entry : undefined
  }

  attach(window: BrowserWindow, ownerKey: string, pageId: string): WebContentsView {
    const entry = this.find(ownerKey, pageId)
    if (!entry || entry.failed) throw restartingError(pageId, entry?.failed ? "failed" : "restarting")
    window.contentView.addChildView(entry.generation.view)
    return entry.generation.view
  }

  detach(window: BrowserWindow, ownerKey: string, pageId: string): void {
    const entry = this.find(ownerKey, pageId)
    if (entry) window.contentView.removeChildView(entry.generation.view)
  }

  onGeneration(
    ownerKey: string,
    pageId: string,
    listener: (view: WebContentsView, previous: WebContentsView) => void,
  ): () => void {
    const entry = this.find(ownerKey, pageId)
    if (!entry) return () => undefined
    entry.replacementListeners.add(listener)
    return () => entry.replacementListeners.delete(listener)
  }

  async retry(ownerKey: string, pageId: string): Promise<void> {
    const entry = this.find(ownerKey, pageId)
    if (!entry) throw new Error("Native Browser page was not found.")
    await this.beginRecovery(entry, "manual-retry")
  }

  async destroy(): Promise<void> {
    this.creating.clear()
    const results = await Promise.allSettled(Array.from(this.entries.keys(), (key) => this.destroyEntry(key)))
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "One or more native Browser pages could not be closed.")
  }

  private async execute(entry: Entry, command: BrowserBackendCommand): Promise<BrowserBackendResult> {
    if (command.type === "resume") {
      if (entry.recovery) await entry.recovery
      else if (entry.failed) await this.beginRecovery(entry, "resume-retry")
      return { type: "page", page: entry.state() }
    }
    if (entry.recovery || entry.failed) {
      if (command.type !== "close" && !isSafeBrowserObservation(command)) {
        throw restartingError(entry.state().id, entry.failed ? "failed" : "restarting")
      }
    }
    try {
      return await entry.generation.control.execute(command)
    } catch (error) {
      if (isRecoverableWebContentsError(error, entry.generation.view.webContents)) {
        void this.recover(entry, isCdpTimeout(error) ? "cdp-timeout" : "command-failure").catch(() => undefined)
        throw restartingError(entry.state().id, "restarting", error)
      }
      throw error
    }
  }

  private async createGeneration(
    input: BrowserNativePageInput,
    id: number,
    restoreURL: string,
    bounds = { x: 0, y: 0, ...INITIAL_NATIVE_PAGE_VIEWPORT },
  ): Promise<Generation> {
    const view = new WebContentsView({
      webPreferences: {
        partition: browserProfilePartition(input.ownerKey),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    view.setBounds(bounds)
    const contents = view.webContents
    const onLogin: Generation["onLogin"] = (event, webContents, _details, authInfo, callback) => {
      if (!authInfo.isProxy || webContents !== contents) return
      event.preventDefault()
      callback(input.networkProxy.username, input.networkProxy.password)
    }
    app.on("login", onLogin)
    let diagnostics: BrowserHostDiagnostics | undefined
    let control: BrowserWebContentsControl | undefined
    let cleanupEvents: (() => void) | undefined
    try {
      await contents.session.setProxy({ proxyRules: input.networkProxy.server })
      await contents.loadURL("about:blank")
      diagnostics = new BrowserHostDiagnostics({
        pageId: input.page.id,
        contents,
        downloadDir: input.downloadDir,
        emitHostEvent: input.emit,
      })
      await diagnostics.start()
      const state = (): BrowserPage => ({
        id: input.page.id,
        url: (contents.getURL() || restoreURL || input.page.url).slice(0, 20_000),
        title: contents.getTitle().slice(0, 20_000),
        isLoading: contents.isLoading(),
        lastActiveAt: null,
      })
      control = new BrowserWebContentsControl({
        pageId: input.page.id,
        contents: () => contents,
        diagnostics: () => diagnostics,
        pageState: state,
        resize: (width, height) => {
          const current = view.getBounds()
          view.setBounds({ x: current.x, y: current.y, width, height })
        },
        onNavigationBlocked: (url, reason) =>
          input.emit({ type: "page.error", pageId: input.page.id, url, message: reason }),
      })
      await control.execute({ type: "setViewport", width: bounds.width, height: bounds.height })
      const generation: Generation = {
        id,
        view,
        control,
        diagnostics,
        onLogin,
        cleanupEvents: () => undefined,
        state,
        navigationTimer: null,
        navigationRetries: 0,
        unresponsiveTimer: null,
      }
      cleanupEvents = this.bindPageEvents(input, generation)
      generation.cleanupEvents = cleanupEvents
      if (restoreURL && restoreURL !== "about:blank") {
        await control.execute({ type: "navigate", url: restoreURL, source: "user" })
      }
      return generation
    } catch (error) {
      cleanupEvents?.()
      app.off("login", onLogin)
      const cleanup = await Promise.allSettled([control?.dispose(), diagnostics?.dispose()].filter(Boolean))
      if (!contents.isDestroyed()) contents.close()
      const failures = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Native Browser page creation and cleanup both failed.")
      }
      throw error
    }
  }

  private bindPageEvents(input: BrowserNativePageInput, generation: Generation): () => void {
    const contents = generation.view.webContents
    const loading = () => {
      input.emit({ type: "page.loading", pageId: input.page.id, url: contents.getURL().slice(0, 20_000) })
      this.armNavigationWatchdog(input, generation)
    }
    const loaded = () => {
      this.clearNavigationWatchdog(generation)
      // A completed navigation (or terminal failure) ends one navigation
      // attempt. Loading events fired mid-navigation — including redirects —
      // must never reset this counter, or a redirect loop would bypass the
      // single automatic retry and reload forever.
      generation.navigationRetries = 0
      input.emit({ type: "page.loaded", page: generation.state() })
    }
    const updated = () => input.emit({ type: "page.updated", page: generation.state() })
    const failed = (_event: Electron.Event, _code: number, message: string, url: string) => {
      this.clearNavigationWatchdog(generation)
      generation.navigationRetries = 0
      input.emit({
        type: "page.error",
        pageId: input.page.id,
        url: url.slice(0, 20_000),
        message: message.slice(0, 100_000),
      })
    }
    contents.on("did-start-loading", loading)
    contents.on("did-stop-loading", loaded)
    contents.on("did-navigate", updated)
    contents.on("did-navigate-in-page", updated)
    contents.on("did-fail-load", failed)
    return () => {
      contents.off("did-start-loading", loading)
      contents.off("did-stop-loading", loaded)
      contents.off("did-navigate", updated)
      contents.off("did-navigate-in-page", updated)
      contents.off("did-fail-load", failed)
      this.clearGenerationTimers(generation)
    }
  }

  private bindRecoveryEvents(entry: Entry, generation: Generation): void {
    const contents = generation.view.webContents
    contents.once("render-process-gone", () => {
      if (!entry.closing && entry.generation === generation) {
        void this.recover(entry, "renderer-gone").catch(() => undefined)
      }
    })
    contents.once("destroyed", () => {
      if (!entry.closing && entry.generation === generation) {
        void this.recover(entry, "unexpected-destroyed").catch(() => undefined)
      }
    })
    contents.on("unresponsive", () => {
      if (entry.closing || entry.generation !== generation || generation.unresponsiveTimer) return
      generation.unresponsiveTimer = setTimeout(() => {
        generation.unresponsiveTimer = null
        void this.handleUnresponsive(entry, generation).catch(() => undefined)
      }, this.options.unresponsiveGraceMs ?? DEFAULT_UNRESPONSIVE_GRACE_MS)
    })
    contents.on("responsive", () => {
      if (!generation.unresponsiveTimer) return
      clearTimeout(generation.unresponsiveTimer)
      generation.unresponsiveTimer = null
    })
  }

  private async handleUnresponsive(entry: Entry, generation: Generation): Promise<void> {
    if (entry.closing || entry.generation !== generation) return
    if (!(await probeWebContents(generation.view.webContents))) {
      await this.recover(entry, "unresponsive")
      return
    }
    // A live CDP channel does not prove the main thread is healthy: a wedged
    // page can answer probes forever. Bound the healthy-reload path with the
    // shared recovery budget so it cannot reload indefinitely.
    if (!this.consumeRecoveryBudget(entry)) {
      this.markFailed(entry, browserNativeRecoveryFailureMessage("unresponsive"))
      return
    }
    entry.input.emit({ type: "host.status", pageId: entry.state().id, status: "restarting" })
    generation.view.webContents.stop()
    generation.view.webContents.reload()
    entry.input.emit({ type: "host.status", pageId: entry.state().id, status: "ready" })
  }

  private armNavigationWatchdog(input: BrowserNativePageInput, generation: Generation): void {
    this.clearNavigationWatchdog(generation)
    generation.navigationTimer = setTimeout(() => {
      generation.navigationTimer = null
      void this.handleNavigationTimeout(input, generation).catch(() => undefined)
    }, this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS)
  }

  private async handleNavigationTimeout(input: BrowserNativePageInput, generation: Generation): Promise<void> {
    const entry = this.entries.get(input.ownerKey)
    if (!entry || entry.closing || entry.generation !== generation) return
    const contents = generation.view.webContents
    contents.stop()
    if (!(await probeWebContents(contents))) {
      await this.recover(entry, "navigation-liveness")
      return
    }
    if (generation.navigationRetries === 0) {
      // The single automatic retry is also bounded by the shared recovery
      // budget so a navigation loop can never reload the page forever.
      if (!this.consumeRecoveryBudget(entry)) {
        this.markFailed(entry, browserNativeRecoveryFailureMessage("budget"))
        return
      }
      generation.navigationRetries++
      contents.reload()
      this.armNavigationWatchdog(input, generation)
      return
    }
    input.emit({
      type: "page.error",
      pageId: input.page.id,
      url: contents.getURL().slice(0, 20_000),
      message: "The main document did not finish loading after one automatic retry.",
    })
  }

  private recover(entry: Entry, reason: string): Promise<void> {
    if (entry.closing) return Promise.resolve()
    if (entry.recovery) return entry.recovery
    const operation = this.recoverEntry(entry, reason)
      .then(() => {
        if (entry.recovery === operation) entry.recovery = null
        if (entry.closing) return
        // Signal readiness only after the recovery guard clears so a consumer
        // reacting to host.status "ready" can immediately issue CDP commands
        // without racing the restarting guard.
        entry.input.emit({ type: "host.status", pageId: entry.state().id, status: "ready" })
      })
      .catch((error) => {
        if (entry.recovery === operation) entry.recovery = null
        throw error
      })
    entry.recovery = operation
    return operation
  }

  private async recoverEntry(entry: Entry, reason: string): Promise<void> {
    const pageId = entry.state().id
    // Explicit recovery (native Retry or agent resume) resets the transient
    // budget in beginRecovery and is not itself metered; only automatic
    // recovery flights consume the shared budget so a failing page cannot
    // rebuild forever on its own.
    const explicit = reason === "manual-retry" || reason === "resume-retry"
    if (!explicit && !this.consumeRecoveryBudget(entry)) {
      this.markFailed(entry, browserNativeRecoveryFailureMessage("budget"))
      throw new BrowserProtocolError({
        code: "browser_native_recovery_failed",
        message: `${browserNativeRecoveryFailureMessage("budget")}; retry manually.`,
        retryable: true,
        pageId,
        suggestedAction: "Retry native Browser recovery.",
      })
    }
    entry.input.emit({ type: "host.status", pageId, status: "restarting" })
    const delays = this.options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS
    let lastError: unknown
    for (let round = 0; round < MAX_RECOVERY_ROUNDS; round++) {
      for (const delay of delays) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        if (entry.closing) return
        const previous = entry.generation
        const bounds = previous.view.getBounds()
        const restoreURL = previous.state().url || entry.input.page.url
        try {
          const next = await this.createGeneration(entry.input, ++entry.generationSequence, restoreURL, bounds)
          entry.generation = next
          entry.failed = false
          this.bindRecoveryEvents(entry, next)
          for (const listener of entry.replacementListeners) listener(next.view, previous.view)
          // Closing the replaced generation is best-effort: a wedged old
          // renderer must not roll back a recovery that already succeeded, or
          // every retry round would leak a WebContentsView and login listener.
          await this.closeGeneration(previous).catch((error) => {
            console.error("Native Browser previous generation cleanup failed.", error)
          })
          return
        } catch (error) {
          lastError = error
        }
      }
    }
    this.markFailed(entry, browserNativeRecoveryFailureMessage("repeated"))
    throw new BrowserProtocolError(
      {
        code: "browser_native_recovery_failed",
        message: browserNativeRecoveryFailureMessage("repeated"),
        retryable: true,
        pageId,
        suggestedAction: "Retry native Browser recovery.",
      },
      { cause: lastError },
    )
  }

  private consumeRecoveryBudget(entry: Entry): boolean {
    if (entry.recoveryBudget <= 0) return false
    entry.recoveryBudget--
    return true
  }

  /**
   * Starts one explicit recovery flight. Resume-driven recovery is rate-limited
   * so a page that cannot recover cannot be retried in a tight loop through the
   * Agent path; the native Retry control remains an unlimited human action.
   */
  private async beginRecovery(entry: Entry, reason: "manual-retry" | "resume-retry"): Promise<void> {
    if (reason === "resume-retry") {
      const cooldownMs = this.options.resumeRecoveryCooldownMs ?? RESUME_RECOVERY_COOLDOWN_MS
      const now = Date.now()
      if (entry.lastResumeRecoveryAt !== null && now - entry.lastResumeRecoveryAt < cooldownMs) {
        const remainingMs = cooldownMs - (now - entry.lastResumeRecoveryAt)
        throw new BrowserProtocolError({
          code: "browser_native_recovery_failed",
          message: `Native Browser recovery was attempted too recently; resume again in about ${Math.ceil(remainingMs / 1_000)}s.`,
          retryable: true,
          pageId: entry.state().id,
          suggestedAction: "Wait for the recovery cooldown, then resume again or use the native Retry control.",
        })
      }
      entry.lastResumeRecoveryAt = now
    }
    entry.failed = false
    entry.recoveryBudget = MAX_RECOVERY_BUDGET
    return this.recover(entry, reason)
  }

  private markFailed(entry: Entry, message: string): void {
    entry.failed = true
    const pageId = entry.state().id
    // page.error first so session-level failure recording can reuse the
    // concrete recovery reason when host.status "failed" arrives next.
    entry.input.emit({ type: "page.error", pageId, url: entry.state().url, message })
    entry.input.emit({ type: "host.status", pageId, status: "failed" })
  }

  private clearNavigationWatchdog(generation: Generation): void {
    if (!generation.navigationTimer) return
    clearTimeout(generation.navigationTimer)
    generation.navigationTimer = null
  }

  private clearGenerationTimers(generation: Generation): void {
    this.clearNavigationWatchdog(generation)
    if (generation.unresponsiveTimer) clearTimeout(generation.unresponsiveTimer)
    generation.unresponsiveTimer = null
  }

  private async destroyEntry(ownerKey: string): Promise<void> {
    const active = this.destroying.get(ownerKey)
    if (active) return active
    const entry = this.entries.get(ownerKey)
    if (!entry) return
    entry.closing = true
    const operation = (async () => {
      try {
        await entry.recovery?.catch(() => undefined)
        await this.closeGeneration(entry.generation)
      } finally {
        this.entries.delete(ownerKey)
        this.destroying.delete(ownerKey)
      }
    })()
    this.destroying.set(ownerKey, operation)
    return operation
  }

  private async closeGeneration(generation: Generation): Promise<void> {
    generation.cleanupEvents()
    app.off("login", generation.onLogin)
    const results = await Promise.allSettled([generation.control.dispose(), generation.diagnostics.dispose()])
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    try {
      await closeWebContents(generation.view.webContents)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Native Browser page resources were not fully released.")
  }
}

async function probeWebContents(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return false
  let attached = false
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3")
      attached = true
    }
    await withCdpCommandTimeout(
      contents.debugger.sendCommand("Runtime.evaluate", { expression: "1", returnByValue: true }),
      "Runtime.evaluate",
      5_000,
    )
    return true
  } catch {
    return false
  } finally {
    // Detach only when this probe performed the attach; a transport-owned
    // attachment (control transport) must be left untouched.
    if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
  }
}

function isCdpTimeout(error: unknown): boolean {
  return error instanceof Error && /CDP command .* timed out/i.test(error.message)
}

function isRecoverableWebContentsError(error: unknown, contents: WebContents): boolean {
  return (
    contents.isDestroyed() ||
    isCdpTimeout(error) ||
    (error instanceof Error && /webcontents is unavailable/i.test(error.message))
  )
}

function restartingError(pageId: string, state: "restarting" | "failed", cause?: unknown): BrowserProtocolError {
  return new BrowserProtocolError(
    {
      code: state === "failed" ? "browser_native_recovery_failed" : "browser_native_restarting",
      message:
        state === "failed"
          ? "The Desktop native Browser is waiting for an explicit recovery retry."
          : "The Desktop native Browser is restarting.",
      retryable: true,
      pageId,
      suggestedAction: "Retry after native Browser recovery is ready.",
    },
    { cause },
  )
}

function closeWebContents(contents: WebContents, timeoutMs = 5_000): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    let crashTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (crashTimer) clearTimeout(crashTimer)
      contents.off("destroyed", destroyed)
      if (error) reject(error)
      else resolve()
    }
    const destroyed = () => finish()
    const timer = setTimeout(() => {
      if (contents.isDestroyed()) {
        finish()
        return
      }
      // A wedged renderer may never acknowledge close(); force-crash it so the
      // generation is released instead of leaking a WebContentsView.
      try {
        contents.forcefullyCrashRenderer()
      } catch {}
      crashTimer = setTimeout(
        () => finish(new Error(`Native Browser page did not close within ${timeoutMs}ms.`)),
        2_000,
      )
    }, timeoutMs)
    contents.once("destroyed", destroyed)
    try {
      contents.close({ waitForBeforeUnload: false })
      if (contents.isDestroyed()) finish()
    } catch (error) {
      finish(error)
    }
  })
}
