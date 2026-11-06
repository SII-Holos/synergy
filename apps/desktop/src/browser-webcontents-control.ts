import { clipboard } from "electron"
import {
  BrowserBackendCommandSchema,
  BrowserHumanChanges,
  isSafeBrowserObservation,
  BrowserNavigationPolicy,
  BrowserProtocolError,
  CdpPageController,
  cdpCommandTimeoutMs,
  withCdpCommandTimeout,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type CdpTransport,
} from "@ericsanchezok/synergy-browser-core"
import { BrowserHostDiagnostics, type BrowserHostUploadFile } from "./browser-host-diagnostics.js"
import { inputModifiers, type ElectronInputModifier } from "./browser-input.js"

export interface BrowserWebContentsPageState {
  id: string
  url: string
  title: string
  isLoading: boolean
  lastActiveAt: number | null
}

export interface BrowserWebContentsControlTarget {
  pageId: string
  contents(): Electron.WebContents | undefined
  diagnostics?(): BrowserHostDiagnostics | undefined
  pageState(): BrowserWebContentsPageState
  initialNavigationURL?: string
  onWindowOpen?(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse
  onNavigationBlocked?(url: string, reason: string): void
  onNavigationRequested?(url: string): void
}

class ElectronCdpTransport implements CdpTransport {
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private attachedContents: Electron.WebContents | null = null
  private ownsAttachment = false
  private nativeViewport: { width: number; height: number } | null = null
  private fixedViewport = false
  private viewportFlight: Promise<void> = Promise.resolve()
  private messageListener = (_event: Electron.Event, method: string, params: unknown) => {
    for (const listener of this.listeners.get(method) ?? []) listener(params)
  }

  constructor(
    private contents: () => Electron.WebContents | undefined,
    private injectedInput: (method: string, params?: Record<string, unknown>) => () => void,
  ) {}

  setNativeViewport(viewport: { width: number; height: number } | null): Promise<void> {
    this.nativeViewport = viewport
    if (this.fixedViewport) return this.viewportFlight
    return this.applyViewport(viewport ? { ...viewport, deviceScaleFactor: 1, mobile: false } : undefined)
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "Emulation.setDeviceMetricsOverride") {
      this.fixedViewport = true
      return this.applyViewport<T>(params)
    }
    if (method === "Emulation.clearDeviceMetricsOverride") {
      this.fixedViewport = false
      const viewport = this.nativeViewport
      return this.applyViewport<T>(viewport ? { ...viewport, deviceScaleFactor: 1, mobile: false } : undefined)
    }
    await this.viewportFlight
    return this.sendCommand<T>(method, params)
  }

  private applyViewport<T = void>(params?: Record<string, unknown>): Promise<T> {
    const dontSetVisibleSize = this.nativeViewport === null
    const pending = this.viewportFlight
      .catch(() => undefined)
      .then(() =>
        this.sendCommand<T>(
          params ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
          params ? { ...params, dontSetVisibleSize } : undefined,
        ),
      )
    this.viewportFlight = pending.then(() => undefined)
    void this.viewportFlight.catch(() => undefined)
    return pending
  }

  private async sendCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const release = this.injectedInput(method, params)
    try {
      return await this.dispatchCommand<T>(method, params)
    } finally {
      release()
    }
  }

  private async dispatchCommand<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const contents = this.requireContents()
    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
      contents.sendInputEvent({
        type: "mouseMove",
        x: Number(params.x ?? 0),
        y: Number(params.y ?? 0),
        modifiers: cdpInputModifiers(params.modifiers),
      })
      return {} as T
    }
    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseWheel") {
      contents.sendInputEvent({
        type: "mouseWheel",
        x: Number(params.x ?? 0),
        y: Number(params.y ?? 0),
        deltaX: Number(params.deltaX ?? 0),
        deltaY: Number(params.deltaY ?? 0),
        modifiers: cdpInputModifiers(params.modifiers),
      })
      return {} as T
    }
    this.attach(contents)
    const command = contents.debugger.sendCommand(method, params) as Promise<T>
    return withCdpCommandTimeout(command, method, cdpCommandTimeoutMs(method, params))
  }

  on(event: string, listener: (params: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(event)
    }
  }

  async dispose(): Promise<void> {
    await this.viewportFlight.catch(() => undefined)
    this.listeners.clear()
    if (this.attachedContents && !this.attachedContents.isDestroyed()) {
      this.attachedContents.debugger.off("message", this.messageListener)
      if (this.ownsAttachment && this.attachedContents.debugger.isAttached()) this.attachedContents.debugger.detach()
    }
    this.attachedContents = null
    this.ownsAttachment = false
  }

  private requireContents(): Electron.WebContents {
    const contents = this.contents()
    if (!contents || contents.isDestroyed()) throw new Error("Browser webContents is unavailable")
    return contents
  }

  private attach(contents: Electron.WebContents) {
    if (this.attachedContents === contents && contents.debugger.isAttached()) return
    if (this.attachedContents && !this.attachedContents.isDestroyed()) {
      this.attachedContents.debugger.off("message", this.messageListener)
      if (this.ownsAttachment && this.attachedContents.debugger.isAttached()) this.attachedContents.debugger.detach()
    }
    this.ownsAttachment = false
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3")
      this.ownsAttachment = true
    }
    contents.debugger.on("message", this.messageListener)
    this.attachedContents = contents
  }
}

function cdpInputModifiers(input: unknown): ElectronInputModifier[] {
  const mask = Number(input ?? 0)
  const modifiers: ElectronInputModifier[] = []
  if (mask & 1) modifiers.push("alt")
  if (mask & 2) modifiers.push("control")
  if (mask & 4) modifiers.push("meta")
  if (mask & 8) modifiers.push("shift")
  return modifiers
}

export class BrowserWebContentsControl {
  private transport: ElectronCdpTransport
  private controller: CdpPageController
  private navigation: BrowserNavigationPolicy
  private initialNavigation: { url: string; policy: BrowserNavigationPolicy } | null = null
  private navigationListener: (event: Electron.Event, url: string) => void
  private redirectListener: (event: Electron.Event, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  private stoppedListener: () => void
  private committedListener: (_event: Electron.Event, url: string) => void
  private mouseListener: (_event: Electron.Event, input: Electron.MouseInputEvent) => void
  private keyListener: (_event: Electron.Event, input: Electron.Input) => void
  private commandInFlight = false
  private navigationBlocked: { url: string; reason: string } | null = null
  private humanChanges: BrowserHumanChanges
  private humanNavigationUntil = 0
  private injectedInputs = new Set<{ type: string; key?: unknown; x?: unknown; y?: unknown }>()

  constructor(private target: BrowserWebContentsControlTarget) {
    this.humanChanges = new BrowserHumanChanges(target.pageId)
    this.transport = new ElectronCdpTransport(target.contents, (method, params) => {
      if (method !== "Input.dispatchMouseEvent" && method !== "Input.dispatchKeyEvent") return () => {}
      const types: Record<string, string> = {
        mousePressed: "mouseDown",
        mouseReleased: "mouseUp",
        rawKeyDown: "keyDown",
        char: "char",
      }
      const type = String(params?.type ?? "")
      const input = { type: types[type] ?? type, key: params?.key, x: params?.x, y: params?.y }
      this.injectedInputs.add(input)
      return () => {
        this.injectedInputs.delete(input)
      }
    })
    const navigationOptions = {
      allowUserNavigation: (url: string) => {
        try {
          const protocol = new URL(url).protocol
          return protocol === "http:" || protocol === "https:"
        } catch {
          return false
        }
      },
    }
    this.navigation = new BrowserNavigationPolicy(navigationOptions)
    if (target.initialNavigationURL && navigationOptions.allowUserNavigation(target.initialNavigationURL)) {
      const policy = new BrowserNavigationPolicy(navigationOptions)
      policy.begin(target.initialNavigationURL, "user")
      this.initialNavigation = { url: target.initialNavigationURL, policy }
    }
    const checkNavigation = (event: Electron.Event, url: string, policy = this.navigation) => {
      const decision = policy.decide(url)
      if (decision.allowed) return
      if (policy === this.initialNavigation?.policy) this.initialNavigation = null
      event.preventDefault()
      const reason = decision.reason ?? "Browser navigation policy denied the request."
      if (this.commandInFlight) this.navigationBlocked = { url, reason }
      target.onNavigationBlocked?.(url, reason)
    }
    this.navigationListener = (event, url) => {
      if (url !== this.initialNavigation?.url) this.initialNavigation = null
      checkNavigation(event, url, this.initialNavigation?.policy)
    }
    this.redirectListener = (event, url, _isInPlace, isMainFrame) => {
      checkNavigation(event, url, isMainFrame ? this.initialNavigation?.policy : undefined)
    }
    this.stoppedListener = () => {
      this.initialNavigation = null
    }
    this.committedListener = (_event, url) => {
      this.initialNavigation = null
      this.navigation.noteCommitted(url)
      if (Date.now() < this.humanNavigationUntil) this.humanChanges.record("navigation")
      this.humanNavigationUntil = 0
    }
    this.mouseListener = (_event, input) => {
      if (input.type === "mouseDown") this.navigation.noteUserGesture()
      if (this.consumeInjectedInput(input)) return
      if (input.type === "mouseDown" || input.type === "mouseWheel") {
        this.humanChanges.record(input.type === "mouseWheel" ? "scroll" : "pointer")
        this.humanNavigationUntil = Date.now() + 2_000
      }
    }
    this.keyListener = (_event, input) => {
      if (input.type === "keyDown") this.navigation.noteUserGesture()
      if (this.consumeInjectedInput(input)) return
      if (input.type === "keyDown") {
        this.humanChanges.record("keyboard")
        this.humanNavigationUntil = Date.now() + 2_000
      }
    }
    const contents = target.contents()
    contents?.on("will-navigate", this.navigationListener)
    contents?.on("will-redirect", this.redirectListener)
    contents?.on("did-navigate", this.committedListener)
    contents?.on("did-navigate-in-page", this.committedListener)
    contents?.on("did-stop-loading", this.stoppedListener)
    contents?.on("before-mouse-event", this.mouseListener)
    contents?.on("before-input-event", this.keyListener)
    contents?.setWindowOpenHandler((details) => {
      const decision = this.navigation.decide(details.url)
      if (details.url === "about:blank" || decision.allowed) return target.onWindowOpen?.(details) ?? { action: "deny" }
      target.onNavigationBlocked?.(details.url, decision.reason ?? "Popup navigation denied.")
      return { action: "deny" }
    })
    this.controller = new CdpPageController({
      pageId: target.pageId,
      transport: this.transport,
      clipboard: {
        readText: () => clipboard.readText(),
        writeText: (text) => clipboard.writeText(text),
      },
      stageFiles: async (files) => {
        const diagnostics = target.diagnostics?.()
        if (!diagnostics) throw new Error("Browser upload staging is unavailable")
        return diagnostics.stageFiles(
          files.map((file) => ({ name: file.name, mimeType: file.mimeType, data: file.dataBase64 })),
        )
      },
    })
  }

  setNativeViewport(viewport: { width: number; height: number } | null): Promise<void> {
    return this.transport.setNativeViewport(viewport)
  }

  noteHumanPageChange() {
    this.humanChanges.record("page")
  }

  private consumeInjectedInput(input: { type: string; key?: string; x?: number; y?: number }) {
    for (const expected of this.injectedInputs) {
      if (expected.type !== input.type || (expected.key !== undefined && expected.key !== input.key)) continue
      if (expected.x !== undefined && input.x !== undefined && expected.x !== input.x) continue
      if (expected.y !== undefined && input.y !== undefined && expected.y !== input.y) continue
      this.injectedInputs.delete(expected)
      return true
    }
    return false
  }

  dispatchInput(payload: Record<string, unknown>): void {
    if (payload.type === "input.resize") return

    const contents = this.requireContents()
    contents.focus()

    if (payload.type === "input.text") {
      const text = typeof payload.text === "string" ? payload.text : ""
      if (text) {
        this.humanChanges.record("keyboard")
        void contents.insertText(text)
      }
      return
    }

    if (payload.type === "input.mouse") {
      if (payload.action === "down") this.navigation.noteUserGesture()
      this.dispatchMouse(payload, contents)
      return
    }

    if (payload.type === "input.key") {
      if (payload.action === "down") this.navigation.noteUserGesture()
      this.dispatchKey(payload, contents)
    }
  }

  async execute(
    input: BrowserBackendCommand,
    agentSessionID?: string,
    userCommand = true,
  ): Promise<BrowserBackendResult> {
    const observation = agentSessionID ? this.humanChanges.begin(agentSessionID, input) : undefined
    if (!agentSessionID && userCommand && ["navigate", "history", "reload"].includes(input.type))
      this.humanChanges.record("navigation")
    else if (
      !agentSessionID &&
      userCommand &&
      !isSafeBrowserObservation(input) &&
      !["wait", "resume", "close"].includes(input.type)
    )
      this.noteHumanPageChange()
    const result = await this.executeCommand(input)
    const userChanges = observation ? this.humanChanges.finish(observation) : undefined
    return userChanges ? { ...result, userChanges } : result
  }

  private async executeCommand(input: BrowserBackendCommand): Promise<BrowserBackendResult> {
    const command = BrowserBackendCommandSchema.parse(input)
    const diagnostics = this.target.diagnostics?.()

    if (command.type === "navigate") {
      this.beginNavigation(command.url, command.source)
      if (command.source === "user") {
        this.controller.cancelPending()
        // loadURL resolves after document loading; human navigation only waits for dispatch.
        // https://www.electronjs.org/docs/latest/api/web-contents#contentsloadurlurl-options
        void this.requireContents()
          .loadURL(command.url)
          .catch(() => undefined)
        return { type: "navigation", page: this.target.pageState(), settleReason: "none" }
      }
    }
    if (command.type === "stop") {
      this.controller.cancelPending()
      this.requireContents().stop()
      return { type: "void" }
    }
    if (command.type === "history" && command.source === "user") {
      this.controller.cancelPending()
      const contents = this.requireContents()
      const history = contents.navigationHistory
      const offset = command.direction === "back" ? -1 : 1
      if (history.canGoToOffset(offset)) {
        const entry = history.getEntryAtIndex(history.getActiveIndex() + offset)
        if (entry) {
          this.beginNavigation(entry.url, "user")
          history.goToOffset(offset)
        }
      }
      return { type: "navigation", page: this.target.pageState(), settleReason: "none" }
    }
    if (command.type === "reload" && command.source === "user") {
      this.controller.cancelPending()
      const contents = this.requireContents()
      this.beginNavigation(contents.getURL(), "user")
      if (command.ignoreCache) contents.reloadIgnoringCache()
      else contents.reload()
      return { type: "navigation", page: this.target.pageState(), settleReason: "none" }
    }
    if (command.type === "checkpoint" && command.action === "restore") {
      if (!command.checkpoint) throw new Error("checkpoint is required for restore.")
      this.initialNavigation = null
      this.navigation.begin(command.checkpoint.url, "agent")
    }

    if (command.type === "dialog.respond") {
      await diagnostics?.respondToDialog(command.requestId, command.accept, command.promptText)
      return { type: "void" }
    }

    if (command.type === "filechooser.select") {
      await diagnostics?.respondToFileChooser(
        command.requestId,
        command.files.map((file): BrowserHostUploadFile => ({
          name: file.name,
          mimeType: file.mimeType,
          data: file.dataBase64,
        })),
      )
      return { type: "void" }
    }

    if (command.type === "download.accept") {
      await diagnostics?.acceptDownload(command.id)
      return { type: "void" }
    }
    if (command.type === "download.cancel") {
      await diagnostics?.cancelDownload(command.id)
      return { type: "void" }
    }

    this.commandInFlight = true
    try {
      const result = await this.controller.execute(command)
      await Promise.resolve()
      if (this.navigationBlocked) {
        const blocked = this.navigationBlocked
        this.navigationBlocked = null
        throw new BrowserProtocolError({
          code: "browser_navigation_denied",
          message: blocked.reason,
          retryable: false,
          pageId: this.target.pageId,
          url: blocked.url,
        })
      }
      return result
    } catch (error) {
      this.navigationBlocked = null
      throw error
    } finally {
      this.commandInFlight = false
    }
  }

  private beginNavigation(url: string, source: "agent" | "user"): void {
    this.humanNavigationUntil = 0
    this.initialNavigation = null
    this.navigation.begin(url, source)
    const decision = this.navigation.decide(url)
    if (!decision.allowed) {
      throw new BrowserProtocolError({
        code: "browser_navigation_denied",
        message: decision.reason ?? "Browser navigation policy denied the request.",
        retryable: false,
        pageId: this.target.pageId,
        url,
      })
    }
    this.target.onNavigationRequested?.(url)
  }

  async dispose(): Promise<void> {
    const contents = this.target.contents()
    if (contents && !contents.isDestroyed()) {
      contents.off("will-navigate", this.navigationListener)
      contents.off("will-redirect", this.redirectListener)
      contents.off("did-navigate", this.committedListener)
      contents.off("did-navigate-in-page", this.committedListener)
      contents.off("did-stop-loading", this.stoppedListener)
      contents.off("before-mouse-event", this.mouseListener)
      contents.off("before-input-event", this.keyListener)
      contents.setWindowOpenHandler(() => ({ action: "deny" }))
    }
    const results = await Promise.allSettled([
      this.controller.dispose(),
      Promise.resolve().then(() => this.transport.dispose()),
    ])
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Browser WebContents control did not dispose cleanly.")
  }

  private requireContents(): Electron.WebContents {
    const contents = this.target.contents()
    if (!contents || contents.isDestroyed()) throw new Error("Browser webContents is unavailable")
    return contents
  }

  private dispatchMouse(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const action = payload.action
    if (action === "wheel") {
      contents.sendInputEvent({
        type: "mouseWheel",
        x: Number(payload.x ?? 0),
        y: Number(payload.y ?? 0),
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0),
        modifiers: inputModifiers(payload.modifiers),
      } as Electron.MouseWheelInputEvent)
      return
    }

    const type = action === "down" ? "mouseDown" : action === "up" ? "mouseUp" : action === "move" ? "mouseMove" : null
    contents.sendInputEvent({
      type,
      x: Number(payload.x ?? 0),
      y: Number(payload.y ?? 0),
      button: payload.button === "middle" ? "middle" : payload.button === "right" ? "right" : "left",
      clickCount: Number(payload.clickCount ?? 1),
      modifiers: inputModifiers(payload.modifiers),
    } as Electron.MouseInputEvent)
  }

  private dispatchKey(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const type = payload.action === "down" ? "keyDown" : payload.action === "up" ? "keyUp" : null
    if (!type) return
    contents.sendInputEvent({
      type,
      keyCode: String(payload.key ?? payload.code ?? ""),
      modifiers: inputModifiers(payload.modifiers, { autoRepeat: payload.autoRepeat }),
    } as Electron.KeyboardInputEvent)
  }
}
