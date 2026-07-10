import { clipboard } from "electron"
import {
  BrowserBackendCommandSchema,
  BrowserNavigationPolicy,
  BrowserProtocolError,
  CdpPageController,
  cdpCommandTimeoutMs,
  withCdpCommandTimeout,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type CdpTransport,
} from "@ericsanchezok/synergy-browser"
import { BrowserHostDiagnostics, type BrowserHostUploadFile } from "./browser-host-diagnostics.js"
import { inputModifiers } from "./browser-input.js"

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
  resize?(width: number, height: number): void
  pageState(): BrowserWebContentsPageState
  onNavigationBlocked?(url: string, reason: string): void
}

class ElectronCdpTransport implements CdpTransport {
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private attachedContents: Electron.WebContents | null = null
  private ownsAttachment = false
  private messageListener = (_event: Electron.Event, method: string, params: unknown) => {
    for (const listener of this.listeners.get(method) ?? []) listener(params)
  }

  constructor(private contents: () => Electron.WebContents | undefined) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const contents = this.requireContents()
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

export class BrowserWebContentsControl {
  private transport: ElectronCdpTransport
  private controller: CdpPageController
  private navigation: BrowserNavigationPolicy
  private navigationListener: (event: Electron.Event, url: string) => void
  private committedListener: (_event: Electron.Event, url: string) => void
  private mouseListener: (_event: Electron.Event, input: Electron.MouseInputEvent) => void
  private keyListener: (_event: Electron.Event, input: Electron.Input) => void
  private commandInFlight = false
  private navigationBlocked: { url: string; reason: string } | null = null

  constructor(private target: BrowserWebContentsControlTarget) {
    this.transport = new ElectronCdpTransport(target.contents)
    this.navigation = new BrowserNavigationPolicy({
      allowUserNavigation: (url) => {
        try {
          const protocol = new URL(url).protocol
          return protocol === "http:" || protocol === "https:"
        } catch {
          return false
        }
      },
    })
    this.navigationListener = (event, url) => {
      const decision = this.navigation.decide(url)
      if (decision.allowed) return
      event.preventDefault()
      const reason = decision.reason ?? "Browser navigation policy denied the request."
      if (this.commandInFlight) this.navigationBlocked = { url, reason }
      target.onNavigationBlocked?.(url, reason)
    }
    this.committedListener = (_event, url) => this.navigation.noteCommitted(url)
    this.mouseListener = (_event, input) => {
      if (!this.commandInFlight && input.type === "mouseDown") this.navigation.noteUserGesture()
    }
    this.keyListener = (_event, input) => {
      if (!this.commandInFlight && input.type === "keyDown") this.navigation.noteUserGesture()
    }
    const contents = target.contents()
    contents?.on("will-navigate", this.navigationListener)
    contents?.on("will-redirect", this.navigationListener)
    contents?.on("did-navigate", this.committedListener)
    contents?.on("before-mouse-event", this.mouseListener)
    contents?.on("before-input-event", this.keyListener)
    contents?.setWindowOpenHandler(({ url }) => {
      const decision = this.navigation.decide(url)
      if (decision.allowed) {
        void contents
          .loadURL(url)
          .catch((error) =>
            target.onNavigationBlocked?.(
              url,
              error instanceof Error ? error.message : "Browser popup navigation failed.",
            ),
          )
      } else target.onNavigationBlocked?.(url, decision.reason ?? "Browser popup navigation was denied.")
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

  dispatchInput(payload: Record<string, unknown>): void {
    if (payload.type === "input.resize") {
      this.resize(payload.width, payload.height)
      return
    }

    const contents = this.requireContents()
    contents.focus()

    if (payload.type === "input.text") {
      const text = typeof payload.text === "string" ? payload.text : ""
      if (text) void contents.insertText(text)
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

  async execute(input: BrowserBackendCommand): Promise<BrowserBackendResult> {
    const command = BrowserBackendCommandSchema.parse(input)
    const diagnostics = this.target.diagnostics?.()

    if (command.type === "navigate") this.navigation.begin(command.url, command.source)
    if (command.type === "checkpoint" && command.action === "restore") {
      if (!command.checkpoint) throw new Error("checkpoint is required for restore.")
      this.navigation.begin(command.checkpoint.url, "agent")
    }

    if (command.type === "setViewport") this.resize(command.width, command.height)

    if (command.type === "dialog.respond") {
      await diagnostics?.respondToDialog(command.requestId, command.accept, command.promptText)
      return { type: "void" }
    }

    if (command.type === "filechooser.select") {
      await diagnostics?.respondToFileChooser(
        command.requestId,
        command.files.map(
          (file): BrowserHostUploadFile => ({
            name: file.name,
            mimeType: file.mimeType,
            data: file.dataBase64,
          }),
        ),
      )
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

  async dispose(): Promise<void> {
    const contents = this.target.contents()
    if (contents && !contents.isDestroyed()) {
      contents.off("will-navigate", this.navigationListener)
      contents.off("will-redirect", this.navigationListener)
      contents.off("did-navigate", this.committedListener)
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

  private resize(widthInput: unknown, heightInput: unknown): void {
    if (!this.target.resize) return
    const width = Math.max(1, Math.round(Number(widthInput ?? 1280)))
    const height = Math.max(1, Math.round(Number(heightInput ?? 720)))
    this.target.resize(width, height)
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
