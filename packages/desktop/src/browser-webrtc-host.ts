import { BrowserWindow, ipcMain } from "electron"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { normalizeBrowserURL } from "@ericsanchezok/synergy-util/browser-protocol"
import { BrowserHostDiagnostics, type BrowserHostUploadFile } from "./browser-host-diagnostics.js"
import { inputModifiers } from "./browser-input.js"
import { browserProfilePartition } from "./browser-profile.js"

export interface BrowserWebRTCHostOptions {
  serverUrl: string
  sessionID: string
  tabId: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  url?: string
  width?: number
  height?: number
  traceId?: string
}

interface BrowserHostTabState {
  id: string
  url: string
  title: string
  isLoading: boolean
  pinned: boolean
  kept: boolean
  lastActiveAt: number | null
}

function createHostSignalingUrl(options: BrowserWebRTCHostOptions) {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) throw new Error("Missing Browser Host route directory")

  const params = new URLSearchParams({
    mode: "session",
    sessionID: options.sessionID,
    presentation: "webrtc",
    client: "desktop",
    sameHost: "1",
    tabId: options.tabId,
  })
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.traceId) params.set("traceId", options.traceId)

  return (
    options.serverUrl.replace(/^http/, "ws") +
    `/${encodeURIComponent(pathDirectory)}/browser/webrtc/host?${params.toString()}`
  )
}

function createHostControlUrl(options: BrowserWebRTCHostOptions) {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) throw new Error("Missing Browser Host route directory")

  const params = new URLSearchParams({
    mode: "session",
    sessionID: options.sessionID,
    presentation: "webrtc",
    client: "desktop",
    sameHost: "1",
    tabId: options.tabId,
  })
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.traceId) params.set("traceId", options.traceId)

  return (
    options.serverUrl.replace(/^http/, "ws") +
    `/${encodeURIComponent(pathDirectory)}/browser/host/control?${params.toString()}`
  )
}

export class BrowserWebRTCHost {
  private browserWindow: BrowserWindow | null = null
  private rtcWindow: BrowserWindow | null = null
  private controlWs: WebSocket | null = null
  private controlReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private inputChannel: string
  private readonly browserWindowTitle: string
  private diagnostics: BrowserHostDiagnostics | null = null
  private refMap = new Map<string, { backendNodeId: number; x: number; y: number; width: number; height: number }>()
  private controllerDir: string | null = null

  constructor(private options: BrowserWebRTCHostOptions) {
    this.inputChannel = `browser-host:${options.tabId}:input`
    this.browserWindowTitle = `Synergy Browser Host ${options.sessionID} ${options.tabId}`
  }

  async start(): Promise<void> {
    this.closed = false
    const width = this.options.width ?? 1280
    const height = this.options.height ?? 720
    const signalingUrl = createHostSignalingUrl(this.options)

    this.browserWindow = new BrowserWindow({
      show: process.env.SYNERGY_BROWSER_HOST_SHOW === "1",
      width,
      height,
      title: this.browserWindowTitle,
      skipTaskbar: true,
      backgroundColor: "#111214",
      webPreferences: {
        partition: browserProfilePartition(this.options),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.browserWindow.setMenuBarVisibility(false)
    this.browserWindow.webContents.on("page-title-updated", (event) => {
      event.preventDefault()
      this.browserWindow?.setTitle(this.browserWindowTitle)
    })
    this.installBrowserEvents()
    this.diagnostics = new BrowserHostDiagnostics({
      tabId: this.options.tabId,
      contents: this.browserWindow.webContents,
      emitHostEvent: (event) => this.emitHostEvent(event),
    })
    this.diagnostics.start()

    this.rtcWindow = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    })
    this.rtcWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
      const requestedPermission = String(permission)
      return webContents === this.rtcWindow?.webContents && this.isControllerMediaPermission(requestedPermission)
    })
    this.rtcWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(webContents === this.rtcWindow?.webContents && this.isControllerMediaPermission(String(permission)))
    })
    this.rtcWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const frame = this.browserWindow?.webContents.mainFrame
      if (!frame) {
        callback({})
        return
      }
      callback({
        video: request.videoRequested ? frame : undefined,
        audio: request.audioRequested ? frame : undefined,
        enableLocalEcho: true,
      })
    })
    ipcMain.on(this.inputChannel, (_event, payload) => {
      this.dispatchInput(payload as Record<string, unknown>)
    })

    const controllerPath = await this.writeControllerHtml(signalingUrl)
    await this.rtcWindow.loadFile(controllerPath)
    await this.browserWindow.loadURL(this.initialURL())
    this.connectControl()
  }

  destroy(): void {
    this.closed = true
    ipcMain.removeAllListeners(this.inputChannel)
    if (this.controlReconnectTimer) clearTimeout(this.controlReconnectTimer)
    this.controlWs?.close()
    this.controlWs = null
    this.diagnostics?.dispose()
    this.diagnostics = null
    this.browserWindow?.destroy()
    this.rtcWindow?.destroy()
    this.browserWindow = null
    this.rtcWindow = null
    if (this.controllerDir) {
      void fs.rm(this.controllerDir, { recursive: true, force: true }).catch(() => {})
      this.controllerDir = null
    }
  }

  private dispatchInput(payload: Record<string, unknown>): void {
    const contents = this.browserWindow?.webContents
    if (!contents || contents.isDestroyed()) return

    if (payload.type === "input.resize") {
      const width = Math.max(1, Math.round(Number(payload.width ?? this.options.width ?? 1280)))
      const height = Math.max(1, Math.round(Number(payload.height ?? this.options.height ?? 720)))
      this.browserWindow?.setSize(width, height)
      this.rtcWindow?.setSize(width, height)
      return
    }

    contents.focus()

    if (payload.type === "input.text") {
      const text = typeof payload.text === "string" ? payload.text : ""
      if (text) void contents.insertText(text)
      return
    }

    if (payload.type === "input.mouse") {
      this.dispatchMouse(payload, contents)
      return
    }

    if (payload.type === "input.key") {
      this.dispatchKey(payload, contents)
    }
  }

  private isControllerMediaPermission(permission: string): boolean {
    return permission === "media" || permission === "display-capture"
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
    if (!type) return

    contents.sendInputEvent({
      type,
      x: Number(payload.x ?? 0),
      y: Number(payload.y ?? 0),
      button: this.mouseButton(payload.button),
      clickCount: Number(payload.clickCount ?? 1),
      modifiers: inputModifiers(payload.modifiers),
    } as Electron.MouseInputEvent)
  }

  private dispatchKey(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const action = payload.action
    const type = action === "down" ? "keyDown" : action === "up" ? "keyUp" : null
    if (!type) return
    contents.sendInputEvent({
      type,
      keyCode: String(payload.key ?? payload.code ?? ""),
      modifiers: inputModifiers(payload.modifiers, { autoRepeat: payload.autoRepeat }),
    } as Electron.KeyboardInputEvent)
  }

  private mouseButton(button: unknown): "left" | "middle" | "right" {
    if (button === "middle") return "middle"
    if (button === "right") return "right"
    return "left"
  }

  private async sendCDP(
    contents: Electron.WebContents,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!method) throw new Error("Missing CDP method")
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
    return contents.debugger.sendCommand(method, params)
  }

  private installBrowserEvents(): void {
    const contents = this.browserWindow?.webContents
    if (!contents) return
    contents.on("did-start-loading", () => {
      this.emitHostEvent({ type: "page.loading", tabId: this.options.tabId, url: contents.getURL() })
    })
    contents.on("did-stop-loading", () => {
      this.emitHostEvent({
        type: "page.loaded",
        tabId: this.options.tabId,
        url: contents.getURL(),
        title: contents.getTitle(),
      })
      this.sendHostSession()
    })
    contents.on("did-navigate", () => {
      this.emitHostEvent({ type: "tab.updated", tab: this.tabState() })
      this.sendHostSession()
    })
    contents.on("did-navigate-in-page", () => {
      this.emitHostEvent({ type: "tab.updated", tab: this.tabState() })
      this.sendHostSession()
    })
    contents.on("did-fail-load", (_event, _code, message, url) => {
      this.emitHostEvent({
        type: "page.error",
        tabId: this.options.tabId,
        url,
        message,
      })
    })
  }

  private connectControl(): void {
    const ws = new WebSocket(createHostControlUrl(this.options))
    this.controlWs = ws
    ws.addEventListener("open", () => {
      this.sendControl({ type: "browser.host.ready", session: this.sessionState() })
    })
    ws.addEventListener("message", (event) => {
      this.handleControlMessage(event.data).catch((error) => {
        this.emitHostEvent({
          type: "error",
          severity: "warning",
          code: "browser_webrtc_host_command_failed",
          message: error instanceof Error ? error.message : String(error),
        })
      })
    })
    ws.addEventListener("close", () => {
      if (this.controlWs === ws) this.controlWs = null
      if (!this.closed) this.controlReconnectTimer = setTimeout(() => this.connectControl(), 1000)
    })
  }

  private async handleControlMessage(data: unknown): Promise<void> {
    const msg = JSON.parse(String(data)) as { id?: string; type?: string; command?: Record<string, unknown> }
    if (msg.type !== "browser.host.command" || !msg.id || !msg.command) return
    try {
      const result = await this.executeControlCommand(msg.command)
      this.sendControl({ type: "browser.host.result", id: msg.id, result })
    } catch (error) {
      this.sendControl({
        type: "browser.host.result",
        id: msg.id,
        error: {
          code: error instanceof UnsupportedHostCommandError ? "unsupported" : "failed",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async executeControlCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const contents = this.browserWindow?.webContents
    if (!contents || contents.isDestroyed()) throw new Error("Browser Host webContents is unavailable")
    switch (command.type) {
      case "createTab": {
        throw new UnsupportedHostCommandError(String(command.type))
      }
      case "closeTab": {
        const tabId = String(command.tabId ?? "")
        if (tabId !== this.options.tabId) throw new UnsupportedHostCommandError(String(command.type))
        setTimeout(() => this.destroy(), 0)
        return { type: "session", session: { tabs: [], activeTabId: null } }
      }
      case "switchTab": {
        const tabId = String(command.tabId ?? "")
        if (tabId !== this.options.tabId) throw new UnsupportedHostCommandError(String(command.type))
        return { type: "tab", tab: this.tabState() }
      }
      case "navigate": {
        if (typeof command.tabId === "string" && command.tabId !== this.options.tabId) {
          throw new UnsupportedHostCommandError(String(command.type))
        }
        const url = normalizeBrowserURL(String(command.url ?? "about:blank"))
        await contents.loadURL(url)
        return { type: "navigation", tab: this.tabState(), url: contents.getURL(), title: contents.getTitle() }
      }
      case "reload":
        contents.reload()
        return { type: "void" }
      case "stop":
        contents.stop()
        return { type: "void" }
      case "history":
        if (command.direction === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        if (command.direction === "forward" && contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward()
        }
        return { type: "void" }
      case "setViewport": {
        const width = Math.max(1, Math.round(Number(command.width ?? this.options.width ?? 1280)))
        const height = Math.max(1, Math.round(Number(command.height ?? this.options.height ?? 720)))
        this.browserWindow?.setSize(width, height)
        this.rtcWindow?.setSize(width, height)
        return { type: "tab", tab: this.tabState() }
      }
      case "click":
        contents.focus()
        this.dispatchMouse({ action: "down", x: command.x, y: command.y, button: "left" }, contents)
        this.dispatchMouse({ action: "up", x: command.x, y: command.y, button: "left" }, contents)
        return { type: "void" }
      case "typeText":
        contents.focus()
        await contents.insertText(String(command.text ?? ""))
        return { type: "void" }
      case "scroll":
        contents.focus()
        this.dispatchMouse({ action: "wheel", deltaX: command.deltaX, deltaY: command.deltaY }, contents)
        return { type: "void" }
      case "mouse":
        contents.focus()
        this.dispatchMouse((command.input as Record<string, unknown>) ?? command, contents)
        return { type: "void" }
      case "key":
        contents.focus()
        this.dispatchKey((command.input as Record<string, unknown>) ?? command, contents)
        return { type: "void" }
      case "insertText":
        contents.focus()
        await contents.insertText(String(command.text ?? ""))
        return { type: "void" }
      case "evaluate":
        return {
          type: "evaluation",
          tabId: this.options.tabId,
          value: await contents.executeJavaScript(String(command.expression ?? ""), true),
        }
      case "cdp":
        return {
          type: "cdp",
          tabId: this.options.tabId,
          value: await this.sendCDP(contents, String(command.method ?? ""), command.params as Record<string, unknown>),
        }
      case "snapshot": {
        const snapshot = await this.snapshot(contents)
        return {
          type: "snapshot",
          tabId: this.options.tabId,
          elements: snapshot.elements,
          truncated: snapshot.truncated,
        }
      }
      case "resolveRef": {
        const ref = String(command.ref ?? "")
        return { type: "resolvedRef", tabId: this.options.tabId, ref, box: this.refMap.get(ref) ?? null }
      }
      case "console":
        return {
          type: "console",
          tabId: this.options.tabId,
          entries: this.diagnostics?.consoleEntries(Number(command.maxEntries ?? 50)) ?? [],
        }
      case "network":
        return {
          type: "network",
          tabId: this.options.tabId,
          requests: this.diagnostics?.networkRequests(Number(command.maxEntries ?? 100)) ?? [],
        }
      case "assets":
        return {
          type: "assets",
          tabId: this.options.tabId,
          assets: this.diagnostics?.pageAssets(this.options.tabId, Number(command.maxEntries ?? 100)) ?? [],
        }
      case "filechooser.select":
        await this.diagnostics?.respondToFileChooser(
          String(command.requestId ?? ""),
          (command.files as BrowserHostUploadFile[]) ?? [],
        )
        return { type: "void" }
      case "dialog.respond":
        await this.diagnostics?.respondToDialog(
          String(command.requestId ?? ""),
          Boolean(command.accept),
          typeof command.promptText === "string" ? command.promptText : undefined,
        )
        return { type: "void" }
      case "screenshot": {
        const image = await contents.capturePage()
        const size = image.getSize()
        return {
          type: "screenshot",
          tabId: this.options.tabId,
          dataUrl: image.toDataURL(),
          width: size.width,
          height: size.height,
        }
      }
      case "clearDiagnostics":
        this.diagnostics?.clear()
        return { type: "diagnostics.cleared", tabId: this.options.tabId }
      default:
        throw new UnsupportedHostCommandError(String(command.type ?? "unknown"))
    }
  }

  private async snapshot(contents: Electron.WebContents): Promise<{
    elements: { ref: string; role: string; name: string; value?: string; children: never[] }[]
    truncated: boolean
  }> {
    const result = (await contents.executeJavaScript(
      `(() => {
        const selector = [
          "a[href]",
          "button",
          "input",
          "textarea",
          "select",
          "[role]",
          "[contenteditable='true']",
          "[tabindex]:not([tabindex='-1'])"
        ].join(",")
        const roleFor = (element) => {
          const explicit = element.getAttribute("role")
          if (explicit) return explicit
          const tag = element.tagName.toLowerCase()
          if (tag === "a") return "link"
          if (tag === "button") return "button"
          if (tag === "textarea") return "textbox"
          if (tag === "select") return "combobox"
          if (tag === "input") {
            const type = (element.getAttribute("type") || "text").toLowerCase()
            if (type === "checkbox") return "checkbox"
            if (type === "radio") return "radio"
            if (type === "search") return "searchbox"
            if (type === "range") return "slider"
            return "textbox"
          }
          return "generic"
        }
        const nameFor = (element) => {
          return element.getAttribute("aria-label")
            || element.getAttribute("title")
            || element.getAttribute("placeholder")
            || element.innerText
            || element.value
            || element.textContent
            || ""
        }
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 300)
        return nodes.map((element, index) => {
          const rect = element.getBoundingClientRect()
          return {
            ref: "@n" + (index + 1),
            role: roleFor(element),
            name: String(nameFor(element)).replace(/\\s+/g, " ").trim().slice(0, 200),
            value: "value" in element && typeof element.value === "string" ? element.value : undefined,
            box: {
              backendNodeId: index + 1,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          }
        }).filter((item) => item.box.width > 0 && item.box.height > 0 && item.name)
      })()`,
      true,
    )) as {
      ref: string
      role: string
      name: string
      value?: string
      box: { backendNodeId: number; x: number; y: number; width: number; height: number }
    }[]

    this.refMap.clear()
    const elements = result.map((item) => {
      this.refMap.set(item.ref, item.box)
      return {
        ref: item.ref,
        role: item.role,
        name: item.name,
        value: item.value,
        children: [],
      }
    })
    return { elements, truncated: result.length >= 300 }
  }

  private tabState(): BrowserHostTabState {
    const contents = this.browserWindow?.webContents
    return this.createTabState(
      this.options.tabId,
      contents?.getURL() ?? this.initialURL(),
      contents?.getTitle() ?? "",
      contents?.isLoading() ?? false,
    )
  }

  private createTabState(tabId: string, url: string, title: string, isLoading: boolean): BrowserHostTabState {
    return {
      id: tabId,
      url,
      title,
      isLoading,
      pinned: false,
      kept: false,
      lastActiveAt: null,
    }
  }

  private initialURL(): string {
    return this.options.url ? normalizeBrowserURL(this.options.url) : "about:blank"
  }

  private sessionState() {
    return { tabs: [this.tabState()], activeTabId: this.options.tabId }
  }

  private sendHostSession(): void {
    this.sendControl({ type: "browser.host.session", session: this.sessionState() })
  }

  private emitHostEvent(event: Record<string, unknown>): void {
    this.sendControl({ type: "browser.host.event", event })
  }

  private sendControl(payload: Record<string, unknown>): void {
    if (this.controlWs?.readyState !== WebSocket.OPEN) return
    this.controlWs.send(JSON.stringify(payload))
  }

  private controllerHtml(signalingUrl: string): string {
    return `<!doctype html>
<html>
<body style="margin:0;overflow:hidden;background:#111">
<video id="preview" autoplay muted playsinline style="width:1px;height:1px;opacity:0;position:fixed;left:-10px;top:-10px"></video>
<script>
const { ipcRenderer } = require("electron")
const signalingUrl = ${JSON.stringify(signalingUrl)}
const tabId = ${JSON.stringify(this.options.tabId)}
const inputChannel = ${JSON.stringify(this.inputChannel)}
const preview = document.getElementById("preview")
let pc = null
let ws = null
let streamPromise = null
let stream = null

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

async function startCapture() {
  if (stream) return stream
  if (streamPromise) return streamPromise
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Browser Host mediaDevices.getDisplayMedia is unavailable")
  }
  streamPromise = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).catch(() => {
    return navigator.mediaDevices.getDisplayMedia({ audio: false, video: true })
  }).then((nextStream) => {
    stream = nextStream
    preview.srcObject = stream
    void preview.play().catch(() => {})
    return stream
  }).finally(() => {
    streamPromise = null
  })
  return streamPromise
}

async function ensurePeer() {
  if (pc) return pc
  const mediaStream = await startCapture()
  pc = new RTCPeerConnection()
  for (const track of mediaStream.getTracks()) pc.addTrack(track, mediaStream)
  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: "webrtc.ice", tabId, candidate: event.candidate.toJSON() })
  }
  pc.ondatachannel = (event) => {
    event.channel.onmessage = (message) => {
      try {
        ipcRenderer.send(inputChannel, JSON.parse(message.data))
      } catch {}
    }
  }
  return pc
}

function closePeer(options = {}) {
  if (pc) {
    pc.close()
    pc = null
  }
  if (options.stopStream && stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
}

async function handleSignal(message) {
  if (message.type === "webrtc.offer") {
    try {
      closePeer()
      const peer = await ensurePeer()
      await peer.setRemoteDescription({ type: "offer", sdp: message.sdp })
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      send({ type: "webrtc.answer", tabId, sdp: answer.sdp })
    } catch (error) {
      send({ type: "webrtc.error", tabId, message: String(error?.message || error) })
    }
    return
  }
  if (message.type === "webrtc.ice" && message.candidate && pc) {
    await pc.addIceCandidate(message.candidate)
    return
  }
  if (message.type === "webrtc.close") {
    closePeer({ stopStream: true })
  }
}

function connect() {
  ws = new WebSocket(signalingUrl)
  ws.onmessage = (event) => {
    try {
      void handleSignal(JSON.parse(event.data)).catch((error) => {
        send({ type: "webrtc.error", tabId, message: String(error?.message || error) })
      })
    } catch (error) {
      send({ type: "webrtc.error", tabId, message: String(error?.message || error) })
    }
  }
  ws.onclose = () => setTimeout(connect, 1000)
}

connect()
</script>
</body>
</html>`
  }

  private async writeControllerHtml(signalingUrl: string): Promise<string> {
    this.controllerDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-host-"))
    const file = path.join(this.controllerDir, "controller.html")
    await fs.writeFile(file, this.controllerHtml(signalingUrl), "utf8")
    return file
  }
}

class UnsupportedHostCommandError extends Error {
  constructor(command: string) {
    super(command)
    this.name = "UnsupportedHostCommandError"
  }
}
