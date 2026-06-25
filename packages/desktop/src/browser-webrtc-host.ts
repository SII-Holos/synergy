import { BrowserWindow, desktopCapturer, ipcMain } from "electron"

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

  return (
    options.serverUrl.replace(/^http/, "ws") +
    `/${encodeURIComponent(pathDirectory)}/browser/webrtc/host?${params.toString()}`
  )
}

export class BrowserWebRTCHost {
  private browserWindow: BrowserWindow | null = null
  private rtcWindow: BrowserWindow | null = null
  private inputChannel: string
  private readonly browserWindowTitle: string

  constructor(private options: BrowserWebRTCHostOptions) {
    this.inputChannel = `browser-host:${options.tabId}:input`
    this.browserWindowTitle = `Synergy Browser Host ${options.sessionID} ${options.tabId}`
  }

  async start(): Promise<void> {
    const width = this.options.width ?? 1280
    const height = this.options.height ?? 720
    const signalingUrl = createHostSignalingUrl(this.options)

    this.browserWindow = new BrowserWindow({
      show: process.env.SYNERGY_BROWSER_HOST_SHOW !== "0",
      width,
      height,
      title: this.browserWindowTitle,
      skipTaskbar: true,
      backgroundColor: "#111214",
      webPreferences: {
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
    this.rtcWindow.webContents.session.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
          .then((sources) => {
            const source =
              sources.find((item) => item.name === this.browserWindowTitle) ??
              sources.find((item) => item.name.includes(this.options.tabId))
            if (!source) {
              callback({})
              return
            }
            callback({ video: source })
          })
          .catch(() => callback({}))
      },
      { useSystemPicker: false },
    )

    ipcMain.on(this.inputChannel, (_event, payload) => {
      this.dispatchInput(payload as Record<string, unknown>)
    })

    await this.rtcWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(this.controllerHtml(signalingUrl))}`,
    )
    await this.browserWindow.loadURL(this.options.url || "about:blank")
  }

  destroy(): void {
    ipcMain.removeAllListeners(this.inputChannel)
    this.browserWindow?.destroy()
    this.rtcWindow?.destroy()
    this.browserWindow = null
    this.rtcWindow = null
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

  private dispatchMouse(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const action = payload.action
    if (action === "wheel") {
      contents.sendInputEvent({
        type: "mouseWheel",
        x: Number(payload.x ?? 0),
        y: Number(payload.y ?? 0),
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0),
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
    } as Electron.MouseInputEvent)
  }

  private dispatchKey(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const action = payload.action
    const type = action === "down" ? "keyDown" : action === "up" ? "keyUp" : null
    if (!type) return
    contents.sendInputEvent({
      type,
      keyCode: String(payload.key ?? payload.code ?? ""),
    } as Electron.KeyboardInputEvent)
  }

  private mouseButton(button: unknown): "left" | "middle" | "right" {
    if (button === "middle") return "middle"
    if (button === "right") return "right"
    return "left"
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
  streamPromise = navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      width: { ideal: ${this.options.width ?? 1280} },
      height: { ideal: ${this.options.height ?? 720} },
      frameRate: { ideal: 60, max: 60 }
    }
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

async function handleSignal(message) {
  if (message.type === "webrtc.offer") {
    const peer = await ensurePeer()
    await peer.setRemoteDescription({ type: "offer", sdp: message.sdp })
    const answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    send({ type: "webrtc.answer", tabId, sdp: answer.sdp })
    return
  }
  if (message.type === "webrtc.ice" && message.candidate && pc) {
    await pc.addIceCandidate(message.candidate)
    return
  }
  if (message.type === "webrtc.close" && pc) {
    pc.close()
    pc = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
  }
}

function connect() {
  ws = new WebSocket(signalingUrl)
  ws.onmessage = (event) => {
    try {
      void handleSignal(JSON.parse(event.data))
    } catch {}
  }
  ws.onclose = () => setTimeout(connect, 1000)
}

connect()
</script>
</body>
</html>`
  }
}
