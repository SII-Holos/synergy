import { app, BrowserWindow, ipcMain } from "electron"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import {
  BROWSER_PROTOCOL_VERSION,
  normalizeBrowserURL,
  BrowserRemoteInputSchema,
  type BrowserBackendCommand,
  type BrowserBackendResult,
  type BrowserHostPageEvent,
} from "@ericsanchezok/synergy-browser"
import { BrowserHostDiagnostics } from "./browser-host-diagnostics.js"
import { BrowserWebContentsControl } from "./browser-webcontents-control.js"
import { browserProfilePartition } from "./browser-profile.js"
import { desktopThemeBackground, type DesktopThemeSnapshot } from "./theme.js"

export interface BrowserWebRTCHostOptions {
  ownerKey: string
  serverUrl: string
  ownerMode: "session" | "scope"
  sessionID?: string
  pageId: string
  routeDirectory: string
  url?: string
  theme: DesktopThemeSnapshot
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>
  networkProxy?: { server: string; username: string; password: string }
  signalingTicket?: string
  emitBrokerEvent: (event: BrowserHostPageEvent) => void
  downloadDir?: string
}

interface BrowserHostPageState {
  id: string
  url: string
  title: string
  isLoading: boolean
  lastActiveAt: number | null
}

function browserHostPageHash(ownerKey: string, pageId: string): string {
  return createHash("sha256").update(ownerKey).update("\0").update(pageId).digest("hex")
}

function createHostSignalingUrl(options: BrowserWebRTCHostOptions) {
  const params = new URLSearchParams({
    mode: options.ownerMode,
    presentation: "webrtc",
    pageId: options.pageId,
    protocolVersion: String(BROWSER_PROTOCOL_VERSION),
  })
  if (options.ownerMode === "session") {
    if (!options.sessionID) throw new Error("Session Browser Host signaling requires sessionID.")
    params.set("sessionID", options.sessionID)
  }
  if (options.signalingTicket) params.set("ticket", options.signalingTicket)

  return (
    options.serverUrl.replace(/^http/, "ws") +
    `/${encodeURIComponent(options.routeDirectory)}/browser/webrtc/host?${params.toString()}`
  )
}

export class BrowserWebRTCHost {
  private browserWindow: BrowserWindow | null = null
  private rtcWindow: BrowserWindow | null = null
  private inputChannel: string
  private readonly browserWindowTitle: string
  private diagnostics: BrowserHostDiagnostics | null = null
  private control: BrowserWebContentsControl | null = null
  private controllerDir: string | null = null
  private inputWindowStartedAt = Date.now()
  private inputCount = 0
  private readonly onLogin = (
    event: Electron.Event,
    webContents: Electron.WebContents,
    _details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => {
    if (!authInfo.isProxy || webContents !== this.browserWindow?.webContents || !this.options.networkProxy) return
    event.preventDefault()
    callback(this.options.networkProxy.username, this.options.networkProxy.password)
  }

  constructor(private options: BrowserWebRTCHostOptions) {
    this.inputChannel = `browser-host:${browserHostPageHash(options.ownerKey, options.pageId)}:input`
    this.browserWindowTitle = `Synergy Browser Host ${options.pageId}`
  }

  setTheme(theme: DesktopThemeSnapshot): void {
    this.options = { ...this.options, theme }
    if (this.browserWindow) this.browserWindow.setBackgroundColor(desktopThemeBackground(theme.effective))
  }

  async start(): Promise<void> {
    const width = 1280
    const height = 720
    const signalingUrl = createHostSignalingUrl(this.options)

    this.browserWindow = new BrowserWindow({
      show: process.env.SYNERGY_BROWSER_HOST_SHOW === "1",
      width,
      height,
      title: this.browserWindowTitle,
      skipTaskbar: true,
      backgroundColor: desktopThemeBackground(this.options.theme.effective),
      webPreferences: {
        partition: browserProfilePartition(this.options.ownerKey),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.browserWindow.setMenuBarVisibility(false)
    if (this.options.networkProxy) {
      app.on("login", this.onLogin)
      await this.browserWindow.webContents.session.setProxy({ proxyRules: this.options.networkProxy.server })
    }
    await this.browserWindow.loadURL("about:blank")
    this.browserWindow.webContents.on("page-title-updated", (event) => {
      event.preventDefault()
      this.browserWindow?.setTitle(this.browserWindowTitle)
    })
    this.installBrowserEvents()
    this.diagnostics = new BrowserHostDiagnostics({
      pageId: this.options.pageId,
      contents: this.browserWindow.webContents,
      downloadDir: this.options.downloadDir,
      emitHostEvent: (event) => this.emitHostEvent(event),
    })
    await this.diagnostics.start()
    this.control = new BrowserWebContentsControl({
      pageId: this.options.pageId,
      contents: () => this.browserWindow?.webContents,
      diagnostics: () => this.diagnostics ?? undefined,
      resize: (nextWidth, nextHeight) => {
        this.browserWindow?.setSize(nextWidth, nextHeight)
        this.rtcWindow?.setSize(nextWidth, nextHeight)
      },
      pageState: () => this.pageState(),
      onNavigationBlocked: (url, reason) =>
        this.emitHostEvent({ type: "page.error", pageId: this.options.pageId, url, message: reason }),
    })

    this.rtcWindow = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: {
        partition: `browser-rtc-${browserHostPageHash(this.options.ownerKey, this.options.pageId)}`,
        backgroundThrottling: false,
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
        audio: undefined,
        enableLocalEcho: false,
      })
    })
    ipcMain.on(this.inputChannel, (event, payload) => {
      if (event.sender !== this.rtcWindow?.webContents) return
      const now = Date.now()
      if (now - this.inputWindowStartedAt >= 1_000) {
        this.inputWindowStartedAt = now
        this.inputCount = 0
      }
      if (++this.inputCount > 1_000) return
      const parsed = BrowserRemoteInputSchema.safeParse(payload)
      if (!parsed.success || parsed.data.pageId !== this.options.pageId) return
      this.dispatchInput(parsed.data)
    })

    const controllerPath = await this.writeControllerHtml(signalingUrl)
    const controllerURL = pathToFileURL(controllerPath).toString()
    this.rtcWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    this.rtcWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== controllerURL) event.preventDefault()
    })
    await this.rtcWindow.loadFile(controllerPath)
    const initialURL = this.initialURL()
    if (initialURL !== "about:blank") {
      await this.control.execute({ type: "navigate", url: initialURL, source: "user" })
    }
  }

  async execute(command: BrowserBackendCommand): Promise<BrowserBackendResult> {
    if (!this.control) throw new Error("Browser Host control is unavailable")
    return this.control.execute(command)
  }

  state(): BrowserHostPageState {
    return this.pageState()
  }

  async destroy(): Promise<void> {
    const failures: unknown[] = []
    app.off("login", this.onLogin)
    ipcMain.removeAllListeners(this.inputChannel)
    if (this.control) {
      try {
        await this.control.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.control = null
    if (this.diagnostics) {
      try {
        await this.diagnostics.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    this.diagnostics = null
    const browserWindow = this.browserWindow
    const rtcWindow = this.rtcWindow
    browserWindow?.destroy()
    rtcWindow?.destroy()
    if (browserWindow && !browserWindow.isDestroyed())
      failures.push(new Error("Browser Host page window did not close."))
    if (rtcWindow && !rtcWindow.isDestroyed()) failures.push(new Error("Browser Host controller window did not close."))
    this.browserWindow = null
    this.rtcWindow = null
    if (this.controllerDir) {
      try {
        await fs.rm(this.controllerDir, { recursive: true, force: true })
      } catch (error) {
        failures.push(error)
      }
      this.controllerDir = null
    }
    if (failures.length) throw new AggregateError(failures, "Browser Host page did not close cleanly.")
  }

  private dispatchInput(payload: Record<string, unknown>): void {
    this.control?.dispatchInput(payload)
  }

  private isControllerMediaPermission(permission: string): boolean {
    return permission === "display-capture"
  }

  private installBrowserEvents(): void {
    const contents = this.browserWindow?.webContents
    if (!contents) return
    contents.on("did-start-loading", () => {
      this.emitHostEvent({ type: "page.loading", pageId: this.options.pageId, url: contents.getURL() })
    })
    contents.on("did-stop-loading", () => {
      this.emitHostEvent({ type: "page.loaded", page: this.pageState() })
    })
    contents.on("did-navigate", () => {
      this.emitHostEvent({ type: "page.updated", page: this.pageState() })
    })
    contents.on("did-navigate-in-page", () => {
      this.emitHostEvent({ type: "page.updated", page: this.pageState() })
    })
    contents.on("did-fail-load", (_event, _code, message, url) => {
      this.emitHostEvent({
        type: "page.error",
        pageId: this.options.pageId,
        url: url.slice(0, 20_000),
        message: message.slice(0, 100_000),
      })
    })
  }

  private pageState(): BrowserHostPageState {
    const contents = this.browserWindow?.webContents
    return this.createPageState(
      this.options.pageId,
      (contents?.getURL() ?? this.initialURL()).slice(0, 20_000),
      (contents?.getTitle() ?? "").slice(0, 20_000),
      contents?.isLoading() ?? false,
    )
  }

  private createPageState(pageId: string, url: string, title: string, isLoading: boolean): BrowserHostPageState {
    return {
      id: pageId,
      url,
      title,
      isLoading,
      lastActiveAt: null,
    }
  }

  private initialURL(): string {
    return this.options.url ? normalizeBrowserURL(this.options.url) : "about:blank"
  }

  private emitHostEvent(event: BrowserHostPageEvent): void {
    this.options.emitBrokerEvent(event)
  }

  private controllerHtml(signalingUrl: string): string {
    return `<!doctype html>
<html>
<body style="margin:0;overflow:hidden;background:#111">
<video id="preview" autoplay muted playsinline style="width:1px;height:1px;opacity:0;position:fixed;left:-10px;top:-10px"></video>
<script>
const { ipcRenderer } = require("electron")
const signalingUrl = ${JSON.stringify(signalingUrl)}
const pageId = ${JSON.stringify(this.options.pageId)}
const inputChannel = ${JSON.stringify(this.inputChannel)}
const protocolVersion = ${BROWSER_PROTOCOL_VERSION}
const iceServers = ${JSON.stringify(this.options.iceServers ?? [])}
const preview = document.getElementById("preview")
let pc = null
let ws = null
let streamPromise = null
let stream = null
let connectionId = null
let generation = -1
let iceSequence = 0

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

async function startCapture() {
  if (stream) return stream
  if (streamPromise) return streamPromise
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Browser Host mediaDevices.getDisplayMedia is unavailable")
  }
  streamPromise = navigator.mediaDevices.getDisplayMedia({ audio: false, video: true }).then((nextStream) => {
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
  pc = new RTCPeerConnection({ iceServers })
  for (const track of mediaStream.getTracks()) pc.addTrack(track, mediaStream)
  pc.onicecandidate = (event) => {
    if (event.candidate && connectionId) send({ type: "webrtc.ice", protocolVersion, pageId, connectionId, generation, sequence: iceSequence++, candidate: event.candidate.toJSON() })
  }
  pc.ondatachannel = (event) => {
    event.channel.onmessage = (message) => {
      try {
        if (typeof message.data !== "string" || message.data.length > 8 * 1024 * 1024) return
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
      connectionId = message.connectionId
      generation = message.generation
      iceSequence = 0
      const peer = await ensurePeer()
      await peer.setRemoteDescription({ type: "offer", sdp: message.sdp })
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      send({ type: "webrtc.answer", protocolVersion, pageId, connectionId, generation, sdp: answer.sdp })
    } catch (error) {
      if (connectionId) send({ type: "webrtc.error", protocolVersion, pageId, connectionId, generation, message: String(error?.message || error) })
    }
    return
  }
  if (message.type === "webrtc.ice" && message.connectionId === connectionId && message.generation === generation && message.candidate && pc) {
    await pc.addIceCandidate(message.candidate)
    return
  }
  if (message.type === "webrtc.close" && message.connectionId === connectionId && message.generation === generation) {
    closePeer({ stopStream: true })
    connectionId = null
  }
}

function connect() {
  ws = new WebSocket(signalingUrl)
  ws.onmessage = (event) => {
    try {
      void handleSignal(JSON.parse(event.data)).catch((error) => {
        if (connectionId) send({ type: "webrtc.error", protocolVersion, pageId, connectionId, generation, message: String(error?.message || error) })
      })
    } catch (error) {
      if (connectionId) send({ type: "webrtc.error", protocolVersion, pageId, connectionId, generation, message: String(error?.message || error) })
    }
  }
  ws.onclose = () => closePeer({ stopStream: true })
}

connect()
</script>
</body>
</html>`
  }

  private async writeControllerHtml(signalingUrl: string): Promise<string> {
    this.controllerDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-host-"))
    const file = path.join(this.controllerDir, "controller.html")
    await fs.writeFile(file, this.controllerHtml(signalingUrl), { encoding: "utf8", mode: 0o600 })
    return file
  }
}
