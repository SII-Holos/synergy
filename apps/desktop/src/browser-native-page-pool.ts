import { fileURLToPath } from "node:url"
import { app, WebContentsView, type BrowserWindow, type WebContents } from "electron"
import {
  BrowserProtocolError,
  browserNativeRecoveryFailureMessage,
  isSafeBrowserObservation,
  withCdpCommandTimeout,
  BROWSER_NATIVE_INIT_TIMEOUT_MS,
  type BrowserNavigation,
  type BrowserNavigationStage,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostPageEvent,
  type BrowserPage,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserHostDiagnostics } from "./browser-host-diagnostics.js"
import { BrowserWebContentsControl } from "./browser-webcontents-control.js"

export interface BrowserNativePageInput {
  ownerKey: string
  requestId?: string
  profile: { id: string; partition: string; revision: number }
  onPopup?(input: { page: BrowserPage; openerId: string }, page: BrowserNativePageHandle): void
  page: BrowserPage
  networkProxy: { server: string; username: string; password: string }
  downloadDir: string
  emit(event: BrowserHostPageEvent): void
}

export interface BrowserNativePageHandle {
  state(): BrowserPage
  execute(command: BrowserBackendCommand, agentSessionID?: string): Promise<BrowserBackendResult>
  destroy(): Promise<void>
  isAlive(): boolean
}

interface Generation {
  id: number
  requestId: string
  startedAt: number
  view: WebContentsView
  contents: WebContents
  control: BrowserWebContentsControl
  diagnostics: BrowserHostDiagnostics
  releaseLogin(): void
  session: Electron.Session
  cleanupEvents: () => void
  state(): BrowserPage
  navigationTimer: ReturnType<typeof setTimeout> | null
  navigation: BrowserNavigation
  navigationURLs: Set<string>
  unresponsiveTimer: ReturnType<typeof setTimeout> | null
  capture?: { window: BrowserWindow; users: number; visible: boolean }
}

interface Entry extends BrowserNativePageHandle {
  ownerKey: string
  input: BrowserNativePageInput
  generation: Generation
  generationSequence: number
  recovery: Promise<void> | null
  failed: boolean
  closing: boolean
  attached: boolean
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
      backgroundColor?(): string
      recoveryDelaysMs?: readonly number[]
      unresponsiveGraceMs?: number
      navigationTimeoutMs?: number
      resumeRecoveryCooldownMs?: number
      captureWindow?(): BrowserWindow | null | undefined
      onVisit?(partition: string, url: string, title: string): Promise<void>
    } = {},
  ) {}

  refreshTheme(): void {
    const color = this.options.backgroundColor?.()
    if (!color) return
    for (const entry of this.entries.values()) entry.generation.view.setBackgroundColor(color)
  }

  private recordStage(
    input: BrowserNativePageInput,
    generation: Pick<Generation, "id" | "requestId" | "startedAt" | "navigation">,
    stage: BrowserNavigationStage,
    errorCode?: string,
    failurePhase?: BrowserNavigationStage,
  ): void {
    input.emit({
      type: "page.stage",
      pageId: input.page.id,
      requestId: generation.requestId,
      navigationId: generation.navigation.id,
      generation: generation.id,
      stage,
      elapsedMs: Math.max(0, performance.now() - generation.startedAt),
      ...(errorCode ? { errorCode } : {}),
      ...(failurePhase ? { failurePhase } : {}),
    })
  }

  async create(input: BrowserNativePageInput, existingView?: WebContentsView): Promise<BrowserNativePageHandle> {
    const key = `${input.ownerKey}:${input.page.id}`
    if (this.entries.has(key) || this.creating.has(key) || this.destroying.has(key)) {
      throw new Error("Browser page already exists.")
    }
    this.creating.add(key)
    try {
      const generation = await this.createGeneration(input, 1, input.page.url, undefined, existingView)
      const entry = {} as Entry
      Object.assign(entry, {
        ownerKey: input.ownerKey,
        input,
        generation,
        generationSequence: 1,
        recovery: null,
        failed: false,
        closing: false,
        attached: false,
        recoveryBudget: MAX_RECOVERY_BUDGET,
        lastResumeRecoveryAt: null,
        replacementListeners: new Set<(view: WebContentsView, previous: WebContentsView) => void>(),
        state: () => entry.generation.state(),
        execute: (command: BrowserBackendCommand, agentSessionID?: string) =>
          this.execute(entry, command, agentSessionID),
        destroy: () => this.destroyEntry(key),
        isAlive: () => !entry.closing,
      } satisfies Partial<Entry>)
      this.entries.set(key, entry)
      this.bindRecoveryEvents(entry, generation)
      return entry
    } finally {
      this.creating.delete(key)
    }
  }

  find(ownerKey: string, pageId: string): Entry | undefined {
    const entry = this.entries.get(`${ownerKey}:${pageId}`)
    return entry?.state().id === pageId ? entry : undefined
  }

  attach(window: BrowserWindow, ownerKey: string, pageId: string): WebContentsView {
    const entry = this.find(ownerKey, pageId)
    if (!entry || entry.failed) throw restartingError(pageId, entry?.failed ? "failed" : "restarting")
    window.contentView.addChildView(entry.generation.view)
    if (!entry.attached) {
      entry.attached = true
      this.recordStage(entry.input, entry.generation, "mounted")
      this.updateNativeViewport(entry)
    }
    return entry.generation.view
  }

  detach(window: BrowserWindow, ownerKey: string, pageId: string): void {
    const entry = this.find(ownerKey, pageId)
    if (!entry || !entry.attached) return
    if (entry.generation.capture) entry.generation.view.setVisible(false)
    else window.contentView.removeChildView(entry.generation.view)
    entry.attached = false
    this.updateNativeViewport(entry)
  }

  private updateNativeViewport(entry: Entry): void {
    const generation = entry.generation
    const { width, height } = generation.view.getBounds()
    void generation.control.setNativeViewport(entry.attached ? null : { width, height }).catch((error) => {
      if (entry.closing || entry.generation !== generation) return
      entry.input.emit({
        type: "page.error",
        pageId: entry.input.page.id,
        message: error instanceof Error ? error.message : String(error),
      })
    })
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

  private async execute(
    entry: Entry,
    command: BrowserBackendCommand,
    agentSessionID?: string,
  ): Promise<BrowserBackendResult> {
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
    const releaseCapture = command.type === "screenshot" ? this.retainCapture(entry) : undefined
    try {
      const result = await entry.generation.control.execute(command, agentSessionID)
      return result.type === "page" || result.type === "navigation" ? { ...result, page: entry.state() } : result
    } catch (error) {
      if (isRecoverableWebContentsError(error, entry.generation.view.webContents)) {
        void this.recover(entry, "command-failure").catch(() => undefined)
        throw restartingError(entry.state().id, "restarting", error)
      }
      throw error
    } finally {
      releaseCapture?.()
    }
  }

  private retainCapture(entry: Entry): () => void {
    const generation = entry.generation
    if (!generation.capture) {
      const window = this.options.captureWindow?.()
      if (!window || window.isDestroyed()) {
        throw new BrowserProtocolError({
          code: "browser_native_window_unavailable",
          message: "The Desktop window is unavailable for Browser capture.",
          retryable: true,
          pageId: entry.input.page.id,
          suggestedAction: "Open the Desktop window and retry the screenshot.",
        })
      }
      const visible = generation.view.getVisible()
      if (!entry.attached) {
        generation.view.setVisible(false)
        window.contentView.addChildView(generation.view)
      }
      generation.capture = { window, users: 0, visible }
    }
    const capture = generation.capture
    capture.users++
    return () => {
      if (--capture.users) return
      generation.capture = undefined
      if (entry.generation === generation && entry.attached) return
      if (!capture.window.isDestroyed()) capture.window.contentView.removeChildView(generation.view)
      if (!generation.contents.isDestroyed()) generation.view.setVisible(capture.visible)
    }
  }

  private async createGeneration(
    input: BrowserNativePageInput,
    id: number,
    restoreURL: string,
    bounds = { x: 0, y: 0, ...INITIAL_NATIVE_PAGE_VIEWPORT },
    existingView?: WebContentsView,
  ): Promise<Generation> {
    const view =
      existingView ??
      new WebContentsView({
        webPreferences: {
          partition: input.profile.partition,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: fileURLToPath(new URL("./browser-page-preload.cjs", import.meta.url)),
        },
      })
    view.setBounds(bounds)
    const color = this.options.backgroundColor?.()
    if (color) view.setBackgroundColor(color)
    const contents = view.webContents
    const releaseLogin = registerProxyLogin(contents, input.networkProxy)
    let diagnostics: BrowserHostDiagnostics | undefined
    let control: BrowserWebContentsControl | undefined
    let cleanupEvents: (() => void) | undefined
    const initialNavigation: BrowserNavigation = {
      id: crypto.randomUUID(),
      generation: id,
      revision: 0,
      requestedURL: restoreURL || input.page.url,
      phase: existingView && contents.isLoading() ? "loading" : "completed",
      slow: false,
    }
    const context = {
      id,
      requestId: input.requestId ?? crypto.randomUUID(),
      startedAt: performance.now(),
      navigation: initialNavigation,
    }
    this.recordStage(input, context, "received")
    const deadline = Date.now() + BROWSER_NATIVE_INIT_TIMEOUT_MS
    const initialize = async <T>(operation: Promise<T>, phase: BrowserNavigationStage): Promise<T> => {
      try {
        const result = await withCdpCommandTimeout(operation, phase, Math.max(1, deadline - Date.now()))
        this.recordStage(input, context, phase)
        return result
      } catch (cause) {
        this.recordStage(input, context, "failed", "browser_native_init_failed", phase)
        throw new BrowserProtocolError(
          {
            code: "browser_native_init_failed",
            message: "The browser page could not be prepared.",
            retryable: true,
            pageId: input.page.id,
            suggestedAction: "Retry opening the page.",
          },
          { cause },
        )
      }
    }
    try {
      let generation: Generation | undefined
      let lastState = input.page
      const state = (): BrowserPage =>
        contents.isDestroyed()
          ? lastState
          : (lastState = {
              id: input.page.id,
              url: (contents.getURL() || restoreURL || input.page.url).slice(0, 20_000),
              title: contents.getTitle().slice(0, 20_000),
              isLoading: ["loading", "committed"].includes((generation?.navigation ?? initialNavigation).phase),
              navigation: { ...(generation?.navigation ?? initialNavigation) },
              lastActiveAt: null,
            })
      const createControl = () =>
        new BrowserWebContentsControl({
          pageId: input.page.id,
          contents: () => contents,
          diagnostics: () => diagnostics,
          pageState: state,
          initialNavigationURL: existingView ? restoreURL : undefined,
          onWindowOpen: (details) => this.openPopup(input, details),
          onNavigationRequested: (url) => {
            if (generation) this.beginNavigation(input, generation, url)
          },
          onNavigationBlocked: (url, reason) =>
            input.emit({ type: "page.error", pageId: input.page.id, url, message: reason }),
        })
      if (existingView) control = createControl()
      await initialize(configureProfileProxy(contents.session, input.networkProxy), "native.proxy")
      if (!existingView) await initialize(contents.loadURL("about:blank"), "native.bootstrap")
      diagnostics = new BrowserHostDiagnostics({
        pageId: input.page.id,
        contents,
        downloadDir: input.downloadDir,
        emitHostEvent: input.emit,
      })
      await initialize(diagnostics.start(), "native.guards")
      control ??= createControl()
      await initialize(control.setNativeViewport({ width: bounds.width, height: bounds.height }), "native.viewport")
      generation = {
        ...context,
        id,
        view,
        contents,
        control,
        diagnostics,
        releaseLogin,
        session: contents.session,
        cleanupEvents: () => undefined,
        state,
        navigationTimer: null,
        navigation: initialNavigation,
        navigationURLs: new Set([initialNavigation.requestedURL]),
        unresponsiveTimer: null,
      }
      cleanupEvents = this.bindPageEvents(input, generation)
      generation.cleanupEvents = cleanupEvents
      this.recordStage(input, generation, "ready")
      if (!existingView && restoreURL && restoreURL !== "about:blank") {
        await control.execute({ type: "navigate", url: restoreURL, source: "user" }, undefined, false)
      }
      return generation
    } catch (error) {
      cleanupEvents?.()
      releaseLogin()
      const cleanup = await Promise.allSettled([
        control?.dispose(),
        diagnostics?.dispose(),
        closeWebContents(contents, 1_000),
      ])
      const failures = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Native Browser page creation and cleanup both failed.")
      }
      throw error
    }
  }

  private openPopup(
    parent: BrowserNativePageInput,
    details: Electron.HandlerDetails,
  ): Electron.WindowOpenHandlerResponse {
    const ownerPages =
      [...this.entries.values()].filter((entry) => entry.ownerKey === parent.ownerKey).length +
      [...this.creating].filter((key) => key.startsWith(`${parent.ownerKey}:`)).length
    if (!parent.onPopup || ownerPages >= 16 || this.entries.size + this.creating.size >= 64) return { action: "deny" }
    return {
      action: "allow",
      outlivesOpener: true,
      createWindow: (options) => {
        const page: BrowserPage = {
          id: crypto.randomUUID(),
          url: details.url || "about:blank",
          title: "",
          isLoading: true,
          lastActiveAt: null,
        }
        // Preserve Electron's supplied child WebContents (opener, POST and renderer handshake).
        // https://www.electronjs.org/docs/latest/api/structures/window-open-handler-response
        const view = new WebContentsView({
          ...options,
          webPreferences: {
            ...options.webPreferences,
            partition: parent.profile.partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            preload: fileURLToPath(new URL("./browser-page-preload.cjs", import.meta.url)),
          },
        })
        const pending: BrowserHostPageEvent[] = []
        let ready = false
        const input = {
          ...parent,
          requestId: crypto.randomUUID(),
          page,
          emit: (event: BrowserHostPageEvent) => (ready ? parent.emit(event) : pending.push(event)),
        }
        void this.create(input, view)
          .then((handle) => {
            parent.onPopup!({ page: handle.state(), openerId: parent.page.id }, handle)
            ready = true
            for (const event of pending) parent.emit(event)
          })
          .catch((error) => {
            if (!view.webContents.isDestroyed()) view.webContents.close()
            parent.emit({
              type: "page.error",
              pageId: parent.page.id,
              message: `Popup could not open: ${error instanceof Error ? error.message : String(error)}`,
            })
          })
        return view.webContents
      },
    }
  }

  private beginNavigation(input: BrowserNativePageInput, generation: Generation, url: string): void {
    this.clearNavigationWatchdog(generation)
    generation.navigationURLs = new Set([url])
    generation.navigation = {
      id: crypto.randomUUID(),
      generation: generation.id,
      revision: generation.navigation.revision + 1,
      requestedURL: url.slice(0, 20_000),
      phase: "loading",
      slow: false,
    }
    this.recordStage(input, generation, "dispatched")
    input.emit({ type: "page.updated", page: generation.state() })
    this.armNavigationWatchdog(input, generation)
  }

  private updateNavigation(
    input: BrowserNativePageInput,
    generation: Generation,
    patch: Partial<BrowserNavigation>,
  ): void {
    generation.navigation = { ...generation.navigation, ...patch, revision: generation.navigation.revision + 1 }
    input.emit({ type: "page.updated", page: generation.state() })
  }

  private bindPageEvents(input: BrowserNativePageInput, generation: Generation): () => void {
    const contents = generation.contents
    const navigating = (_event: Electron.Event, url: string, inPage: boolean, mainFrame: boolean) => {
      if (!mainFrame || inPage) return
      if (generation.navigation.phase !== "loading" || generation.navigation.requestedURL !== url)
        this.beginNavigation(input, generation, url)
    }
    const loading = () => {
      if (!["loading", "committed"].includes(generation.navigation.phase))
        this.beginNavigation(input, generation, contents.getURL() || input.page.url)
      else this.armNavigationWatchdog(input, generation)
    }
    const redirected = (_event: Electron.Event, url: string, _inPage: boolean, mainFrame: boolean) => {
      if (mainFrame) generation.navigationURLs.add(url)
    }
    const committed = (_event: Electron.Event, url: string) => {
      generation.navigationURLs.add(url)
      this.recordStage(input, generation, "committed")
      this.updateNavigation(input, generation, { phase: "committed" })
    }
    const inPage = (_event: Electron.Event, _url: string, mainFrame: boolean) => {
      if (!mainFrame) return
      this.clearNavigationWatchdog(generation)
      this.updateNavigation(input, generation, { phase: "completed", slow: false })
    }
    const finished = () => {
      if (!generation.navigationURLs.has(contents.getURL())) return
      this.clearNavigationWatchdog(generation)
      if (generation.navigation.phase === "failed") return
      this.updateNavigation(input, generation, { phase: "completed", slow: false })
      this.recordStage(input, generation, "completed")
      input.emit({ type: "page.loaded", page: generation.state() })
      void this.options.onVisit?.(input.profile.partition, contents.getURL(), contents.getTitle()).catch(() => {
        console.warn("Recent browser history could not be saved.")
      })
    }
    const stopped = () => {
      if (contents.isLoading()) return
      this.clearNavigationWatchdog(generation)
      if (["loading", "committed"].includes(generation.navigation.phase)) this.recordStage(input, generation, "stopped")
      if (["loading", "committed"].includes(generation.navigation.phase))
        this.updateNavigation(input, generation, { phase: "stopped", slow: false })
    }
    const updated = () => this.updateNavigation(input, generation, {})
    const failed = (_event: Electron.Event, code: number, message: string, url: string, mainFrame: boolean) => {
      if (!mainFrame || code === -3 || (url && !generation.navigationURLs.has(url))) return
      this.clearNavigationWatchdog(generation)
      this.recordStage(input, generation, "failed", `browser_load_${code}`)
      this.updateNavigation(input, generation, {
        phase: "failed",
        slow: false,
        error: { code: `browser_load_${code}`, message: message.slice(0, 100_000) },
      })
      input.emit({
        type: "page.error",
        pageId: input.page.id,
        url: url.slice(0, 20_000),
        message: message.slice(0, 100_000),
        navigation: { ...generation.navigation },
      })
    }
    const domReady = () => this.recordStage(input, generation, "dom-ready")
    contents.on("dom-ready", domReady)
    contents.on("did-start-navigation", navigating)
    contents.on("did-start-loading", loading)
    contents.on("did-finish-load", finished)
    contents.on("did-stop-loading", stopped)
    contents.on("did-redirect-navigation", redirected)
    contents.on("did-navigate", committed)
    contents.on("did-navigate-in-page", inPage)
    contents.on("page-title-updated", updated)
    contents.on("did-fail-load", failed)
    return () => {
      contents.off("dom-ready", domReady)
      contents.off("did-start-navigation", navigating)
      contents.off("did-start-loading", loading)
      contents.off("did-finish-load", finished)
      contents.off("did-stop-loading", stopped)
      contents.off("did-redirect-navigation", redirected)
      contents.off("did-navigate", committed)
      contents.off("did-navigate-in-page", inPage)
      contents.off("page-title-updated", updated)
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
        void this.destroyEntry(`${entry.ownerKey}:${entry.input.page.id}`)
          .then(() => {
            entry.input.emit({ type: "page.closed", pageId: entry.input.page.id })
          })
          .catch((error) => {
            console.error("Popup close cleanup", error)
            entry.input.emit({ type: "page.error", pageId: entry.input.page.id, message: String(error) })
          })
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
      if (generation.unresponsiveTimer) clearTimeout(generation.unresponsiveTimer)
      generation.unresponsiveTimer = null
      if (entry.closing || entry.generation !== generation) return
      const stillLoading = ["loading", "committed"].includes(generation.navigation.phase)
      if (generation.navigation.slow && (!stillLoading || generation.navigationTimer))
        this.updateNavigation(entry.input, generation, { slow: false })
    })
  }

  private async handleUnresponsive(entry: Entry, generation: Generation): Promise<void> {
    if (entry.closing || entry.generation !== generation) return
    this.updateNavigation(entry.input, generation, { slow: true })
  }

  private armNavigationWatchdog(input: BrowserNativePageInput, generation: Generation): void {
    if (generation.navigationTimer) return
    generation.navigationTimer = setTimeout(() => {
      generation.navigationTimer = null
      void this.handleNavigationTimeout(input, generation).catch(() => undefined)
    }, this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS)
  }

  private async handleNavigationTimeout(input: BrowserNativePageInput, generation: Generation): Promise<void> {
    const entry = this.entries.get(`${input.ownerKey}:${input.page.id}`)
    if (!entry || entry.closing || entry.generation !== generation) return
    this.updateNavigation(input, generation, { slow: true })
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
        const restoreURL =
          previous.navigation.phase === "failed" || previous.navigation.phase === "loading"
            ? previous.navigation.requestedURL
            : previous.state().url || entry.input.page.url
        try {
          const next = await this.createGeneration(entry.input, ++entry.generationSequence, restoreURL, bounds)
          entry.generation = next
          entry.failed = false
          this.bindRecoveryEvents(entry, next)
          if (entry.attached) this.updateNativeViewport(entry)
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
        const profileSession = entry.generation.session
        await this.closeGeneration(entry.generation)
        this.entries.delete(ownerKey)
        if (
          !entry.input.profile.partition.startsWith("persist:") &&
          ![...this.entries.values()].some((other) => other.input.profile.id === entry.input.profile.id)
        ) {
          await profileSession.clearStorageData()
        }
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
    generation.releaseLogin()
    const results = await Promise.allSettled([generation.control.dispose(), generation.diagnostics.dispose()])
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    try {
      await closeWebContents(generation.contents)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Native Browser page resources were not fully released.")
  }
}

function isRecoverableWebContentsError(error: unknown, contents: WebContents): boolean {
  return contents.isDestroyed() || (error instanceof Error && /webcontents is unavailable/i.test(error.message))
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

const profileProxies = new WeakMap<Electron.Session, { key: string; ready: Promise<void> }>()
function configureProfileProxy(
  session: Electron.Session,
  proxy: BrowserNativePageInput["networkProxy"],
): Promise<void> {
  const key = `${proxy.server}:${proxy.username}`
  const previous = profileProxies.get(session)
  if (previous?.key === key) return previous.ready
  const ready = (previous?.ready ?? Promise.resolve()).then(() => session.setProxy({ proxyRules: proxy.server }))
  profileProxies.set(session, { key, ready })
  return ready
}

const proxyLogins = new Map<WebContents, { username: string; password: string }>()
const onProxyLogin: (
  event: Electron.Event,
  contents: WebContents | null,
  details: Electron.AuthenticationResponseDetails,
  authInfo: Electron.AuthInfo,
  callback: (username?: string, password?: string) => void,
) => void = (event, contents, _details, authInfo, callback) => {
  const credentials = contents ? proxyLogins.get(contents) : undefined
  if (!credentials || !authInfo.isProxy) return
  event.preventDefault()
  callback(credentials.username, credentials.password)
}
function registerProxyLogin(contents: WebContents, credentials: { username: string; password: string }) {
  if (!proxyLogins.size) app.on("login", onProxyLogin)
  proxyLogins.set(contents, credentials)
  return () => {
    proxyLogins.delete(contents)
    if (!proxyLogins.size) app.off("login", onProxyLogin)
  }
}
