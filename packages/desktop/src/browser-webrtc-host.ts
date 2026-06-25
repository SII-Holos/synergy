import { BrowserWindow, ipcMain } from "electron"

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

  constructor(private options: BrowserWebRTCHostOptions) {
    this.inputChannel = `browser-host:${options.tabId}:input`
  }

  async start(): Promise<void> {
    const width = this.options.width ?? 1280
    const height = this.options.height ?? 720
    const signalingUrl = createHostSignalingUrl(this.options)

    this.browserWindow = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.browserWindow.webContents.setFrameRate(60)

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

    this.browserWindow.webContents.on("paint", (_event, _dirty, image) => {
      const target = this.rtcWindow?.webContents
      if (!target || target.isDestroyed()) return
      const size = image.getSize()
      target.send("browser-host:frame", {
        width: size.width,
        height: size.height,
        png: image.toPNG(),
      })
    })

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
<canvas id="browser" width="${this.options.width ?? 1280}" height="${this.options.height ?? 720}"></canvas>
<script>
const { ipcRenderer } = require("electron")
const signalingUrl = ${JSON.stringify(signalingUrl)}
const tabId = ${JSON.stringify(this.options.tabId)}
const inputChannel = ${JSON.stringify(this.inputChannel)}
const canvas = document.getElementById("browser")
const ctx = canvas.getContext("2d", { alpha: false })
let pc = null
let ws = null
let stream = canvas.captureStream(60)

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function ensurePeer() {
  if (pc) return pc
  pc = new RTCPeerConnection()
  for (const track of stream.getTracks()) pc.addTrack(track, stream)
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
    const peer = ensurePeer()
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
  }
}

ipcRenderer.on("browser-host:frame", async (_event, frame) => {
  const blob = new Blob([frame.png], { type: "image/png" })
  const bitmap = await createImageBitmap(blob)
  if (canvas.width !== frame.width) canvas.width = frame.width
  if (canvas.height !== frame.height) canvas.height = frame.height
  ctx.drawImage(bitmap, 0, 0, frame.width, frame.height)
  if (typeof bitmap.close === "function") bitmap.close()
})

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
