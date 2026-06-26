import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const runtimeTest = process.env.SYNERGY_DESKTOP_RUNTIME_TEST === "1" ? test : test.skip
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url))
const ELECTRON_BIN =
  process.platform === "darwin"
    ? path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
    : path.join(
        DESKTOP_DIR,
        "node_modules",
        "electron",
        "dist",
        process.platform === "win32" ? "electron.exe" : "electron",
      )

interface SmokeServerState {
  httpRequests: string[]
  signalingMessages: string[]
  mediaLogs: string[]
  controlUpgradeAttempts: number
  signalingUpgradeAttempts: number
  viewerSignalingOpened: boolean
  controlOpened: boolean
  signalingOpened: boolean
  mediaReady: boolean
  dataInputSent: boolean
  ready: boolean
  navigated: boolean
  evaluatedTitle: string | null
  cdpValue: number | null
  evaluatedInput: string | null
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function smokePage(serverUrl: string) {
  return `<!doctype html>
<html>
<head><title>Synergy Native Smoke Shell</title></head>
<body>
<script>
async function waitForDesktopBridge() {
  for (let i = 0; i < 100; i++) {
    if (window.synergyDesktop?.browserNative) return window.synergyDesktop.browserNative
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Missing Synergy desktop bridge")
}
waitForDesktopBridge().then((browserNative) => {
  return browserNative.attachView({
    serverUrl: ${JSON.stringify(serverUrl)},
    sessionID: "native-smoke-session",
    routeDirectory: "aG9tZQ",
    tabId: "native-smoke-tab",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    url: "about:blank"
  })
}).catch((error) => {
  document.body.textContent = String(error?.message || error)
})
</script>
</body>
</html>`
}

function smokeDocument(title: string) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<title>${title}</title>
<style>
  body { margin: 0; font: 16px system-ui; min-height: 1200px; }
  input { position: fixed; left: 8px; top: 8px; width: 260px; height: 32px; }
  main { padding: 64px 16px; }
</style>
<input id="webrtc-input" autofocus />
<main>${title}</main>`)}`
}

async function withSmokeServer(
  mode: "native" | "webrtc",
  run: (input: { serverUrl: string; state: SmokeServerState; done: Promise<void> }) => Promise<void>,
  options: { requireViewer?: boolean; requireMedia?: boolean; requireDataInput?: boolean } = {},
) {
  const done = deferred<void>()
  const title = mode === "native" ? "Native Browser Host Smoke" : "WebRTC Browser Host Smoke"
  const state: SmokeServerState = {
    httpRequests: [],
    signalingMessages: [],
    mediaLogs: [],
    controlUpgradeAttempts: 0,
    signalingUpgradeAttempts: 0,
    viewerSignalingOpened: false,
    controlOpened: false,
    signalingOpened: false,
    mediaReady: false,
    dataInputSent: false,
    ready: false,
    navigated: false,
    evaluatedTitle: null,
    cdpValue: null,
    evaluatedInput: null,
  }
  let appPage = ""
  let commandSeq = 0
  let navigateId: string | null = null
  let evaluateId: string | null = null
  let cdpEvaluateId: string | null = null
  let inputEvaluateId: string | null = null
  let controlSocket: ServerWebSocket<{ kind: "control" | "host-signaling" | "viewer-signaling" }> | null = null
  let hostSignal: ServerWebSocket<{ kind: "control" | "host-signaling" | "viewer-signaling" }> | null = null
  let viewerSignal: ServerWebSocket<{ kind: "control" | "host-signaling" | "viewer-signaling" }> | null = null

  const server = Bun.serve<{ kind: "control" | "host-signaling" | "viewer-signaling" }>({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      state.httpRequests.push(`${req.method} ${url.pathname}`)
      if (url.pathname === "/native-page") {
        return new Response(appPage, { headers: { "content-type": "text/html" } })
      }
      if (url.pathname === "/media-ready") {
        state.mediaReady = true
        checkComplete()
        return new Response("ok")
      }
      if (url.pathname === "/data-input-sent") {
        state.dataInputSent = true
        setTimeout(requestInputEvaluation, 100)
        checkComplete()
        return new Response("ok")
      }
      if (url.pathname === "/media-log") {
        void req
          .text()
          .then((text) => {
            state.mediaLogs.push(text.slice(0, 500))
          })
          .catch(() => {})
        return new Response("ok")
      }
      if (url.pathname.endsWith("/browser/host/control")) {
        state.controlUpgradeAttempts++
        return server.upgrade(req, { data: { kind: "control" } })
          ? undefined
          : new Response("control upgrade failed", { status: 400 })
      }
      if (url.pathname.endsWith("/browser/webrtc/host")) {
        state.signalingUpgradeAttempts++
        return server.upgrade(req, { data: { kind: "host-signaling" } })
          ? undefined
          : new Response("signaling upgrade failed", { status: 400 })
      }
      if (url.pathname.endsWith("/browser/webrtc/connect")) {
        state.signalingUpgradeAttempts++
        return server.upgrade(req, { data: { kind: "viewer-signaling" } })
          ? undefined
          : new Response("signaling upgrade failed", { status: 400 })
      }
      return new Response("ok")
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "host-signaling") {
          hostSignal = ws
          state.signalingOpened = true
          if (viewerSignal) sendSignal(viewerSignal, { type: "webrtc.host.ready", tabId: "webrtc-smoke-tab" })
          checkComplete()
          return
        }
        if (ws.data.kind === "viewer-signaling") {
          viewerSignal = ws
          state.viewerSignalingOpened = true
          if (hostSignal) sendSignal(ws, { type: "webrtc.host.ready", tabId: "webrtc-smoke-tab" })
          else sendSignal(ws, { type: "webrtc.host.pending", tabId: "webrtc-smoke-tab" })
          checkComplete()
          return
        }
        controlSocket = ws
        state.controlOpened = true
      },
      message(ws, raw) {
        if (ws.data.kind === "host-signaling") {
          state.signalingMessages.push(`host:${signalType(raw)}`)
          if (viewerSignal) sendRawSignal(viewerSignal, String(raw))
          return
        }
        if (ws.data.kind === "viewer-signaling") {
          state.signalingMessages.push(`viewer:${signalType(raw)}`)
          if (hostSignal) sendRawSignal(hostSignal, String(raw))
          else sendSignal(ws, { type: "webrtc.host.pending", tabId: "webrtc-smoke-tab" })
          return
        }
        if (ws.data.kind !== "control") return
        let message: Record<string, unknown>
        try {
          message = JSON.parse(String(raw))
        } catch (error) {
          done.reject(error instanceof Error ? error : new Error(String(error)))
          return
        }

        if (message.type === "browser.host.ready") {
          state.ready = true
          navigateId = sendCommand(ws, {
            type: "navigate",
            tabId: mode === "native" ? "native-smoke-tab" : "webrtc-smoke-tab",
            url: smokeDocument(title),
          })
          return
        }

        if (message.type !== "browser.host.result") return
        if (message.error) {
          done.reject(new Error(JSON.stringify(message.error)))
          return
        }
        if (message.id === navigateId) {
          state.navigated = true
          evaluateId = sendCommand(ws, {
            type: "evaluate",
            tabId: mode === "native" ? "native-smoke-tab" : "webrtc-smoke-tab",
            expression: "document.title",
          })
          return
        }
        if (message.id === evaluateId) {
          const result = message.result as { value?: unknown } | undefined
          state.evaluatedTitle = typeof result?.value === "string" ? result.value : null
          cdpEvaluateId = sendCommand(ws, {
            type: "cdp",
            tabId: mode === "native" ? "native-smoke-tab" : "webrtc-smoke-tab",
            method: "Runtime.evaluate",
            params: { expression: "40 + 2", returnByValue: true },
          })
          requestInputEvaluation()
          checkComplete()
        }
        if (message.id === cdpEvaluateId) {
          const result = message.result as { value?: { result?: { value?: unknown } } } | undefined
          state.cdpValue = typeof result?.value?.result?.value === "number" ? result.value.result.value : null
          checkComplete()
        }
        if (message.id === inputEvaluateId) {
          const result = message.result as { value?: unknown } | undefined
          state.evaluatedInput = typeof result?.value === "string" ? result.value : null
          checkComplete()
        }
      },
      close(ws) {
        if (ws.data.kind === "control" && controlSocket === ws) controlSocket = null
        if (ws.data.kind === "host-signaling" && hostSignal === ws) hostSignal = null
        if (ws.data.kind === "viewer-signaling" && viewerSignal === ws) viewerSignal = null
      },
    },
  })

  const serverUrl = `http://127.0.0.1:${server.port}`
  appPage = smokePage(serverUrl)

  function sendCommand(
    ws: ServerWebSocket<{ kind: "control" | "host-signaling" | "viewer-signaling" }>,
    command: Record<string, unknown>,
  ) {
    const id = `${mode}-command-${++commandSeq}`
    ws.send(JSON.stringify({ type: "browser.host.command", id, command }))
    return id
  }

  function sendSignal(
    ws: ServerWebSocket<{ kind: "control" | "host-signaling" | "viewer-signaling" }>,
    message: Record<string, unknown>,
  ) {
    sendRawSignal(ws, JSON.stringify(message))
  }

  function sendRawSignal(
    ws: ServerWebSocket<{ kind: "control" | "host-signaling" | "viewer-signaling" }>,
    message: string,
  ) {
    try {
      ws.send(message)
    } catch {}
  }

  function signalType(raw: string | Buffer) {
    try {
      const parsed = JSON.parse(String(raw))
      if (parsed?.type === "webrtc.error") return `webrtc.error:${String(parsed.message ?? "")}`
      return typeof parsed?.type === "string" ? parsed.type : "unknown"
    } catch {
      return "invalid"
    }
  }

  function checkComplete() {
    if (!state.controlOpened || !state.ready || !state.navigated || state.evaluatedTitle !== title) return
    if (state.cdpValue !== 42) return
    if (mode === "webrtc" && !state.signalingOpened) return
    if (options.requireViewer && !state.viewerSignalingOpened) return
    if (options.requireMedia && !state.mediaReady) return
    if (options.requireDataInput && state.evaluatedInput !== "remote-data-channel") return
    done.resolve()
  }

  function requestInputEvaluation() {
    if (!options.requireDataInput || inputEvaluateId || !controlSocket || !state.dataInputSent || !state.evaluatedTitle)
      return
    inputEvaluateId = sendCommand(controlSocket, {
      type: "evaluate",
      tabId: mode === "native" ? "native-smoke-tab" : "webrtc-smoke-tab",
      expression: "document.querySelector('#webrtc-input')?.value ?? ''",
    })
  }

  try {
    await run({ serverUrl, state, done: done.promise })
  } finally {
    try {
      server.stop(true)
    } catch {}
  }
}

async function waitForExit(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, ms: number): Promise<boolean> {
  return await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

async function stopDesktop(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
  proc.kill("SIGTERM")
  if (await waitForExit(proc, 3_000)) return
  proc.kill("SIGKILL")
  await waitForExit(proc, 3_000)
}

async function readPipe(pipe: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!pipe) return ""
  return await Promise.race([
    new Response(pipe).text(),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 1_000)),
  ])
}

async function runDesktop(env: Record<string, string | undefined>, done: Promise<void>, state: SmokeServerState) {
  const proc = Bun.spawn([ELECTRON_BIN, "dist/main.js"], {
    cwd: DESKTOP_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      ...env,
    },
  })
  try {
    await withTimeout(
      Promise.race([
        done,
        proc.exited.then((code) => {
          throw new Error(`Electron desktop process exited before smoke completed: ${code}`)
        }),
      ]),
      30_000,
      "Electron Browser Host smoke",
    )
  } catch (error) {
    await stopDesktop(proc)
    const logs = [await readPipe(proc.stdout), await readPipe(proc.stderr)].filter(Boolean).join("\n")
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstate=${JSON.stringify(state)}\n${logs}`,
    )
  } finally {
    await stopDesktop(proc)
  }
}

function viewerScript(signalingUrl: string, mediaReadyUrl: string, mediaLogUrl: string, dataInputUrl: string): string {
  const html = `<!doctype html>
<html>
<body style="margin:0;background:#111">
<video id="video" autoplay playsinline muted style="width:320px;height:240px"></video>
<script>
const signalingUrl = ${JSON.stringify(signalingUrl)}
const mediaReadyUrl = ${JSON.stringify(mediaReadyUrl)}
const mediaLogUrl = ${JSON.stringify(mediaLogUrl)}
const dataInputUrl = ${JSON.stringify(dataInputUrl)}
const video = document.getElementById("video")
let ws
let pc
let inputChannel

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function reportReady() {
  fetch(mediaReadyUrl, { method: "POST", body: JSON.stringify({ width: video.videoWidth, height: video.videoHeight }) }).catch(() => {})
}

function reportLog(message, detail) {
  fetch(mediaLogUrl, { method: "POST", body: JSON.stringify({ message, detail }) }).catch(() => {})
}

function reportInputSent() {
  fetch(dataInputUrl, { method: "POST" }).catch(() => {})
}

function sendInput(message) {
  if (inputChannel?.readyState === "open") inputChannel.send(JSON.stringify(message))
}

function watchVideo() {
  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(() => reportReady())
    return
  }
  const timer = setInterval(() => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      clearInterval(timer)
      reportReady()
    }
  }, 100)
}

async function negotiate() {
  if (pc) pc.close()
  pc = new RTCPeerConnection()
  pc.addTransceiver("video", { direction: "recvonly" })
  pc.addTransceiver("audio", { direction: "recvonly" })
  inputChannel = pc.createDataChannel("browser-input", { ordered: true })
  inputChannel.onopen = () => {
    sendInput({ type: "input.resize", width: 360, height: 260 })
    sendInput({ type: "input.mouse", action: "down", x: 32, y: 24, button: "left", clickCount: 1 })
    sendInput({ type: "input.mouse", action: "up", x: 32, y: 24, button: "left", clickCount: 1 })
    sendInput({ type: "input.text", text: "remote-data-channel" })
    setTimeout(reportInputSent, 100)
  }
  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track])
    if (event.track.kind === "video") {
    video.srcObject = stream
      reportLog("track", { kind: event.track.kind, streams: event.streams.length })
      video.onloadedmetadata = () => {
        reportLog("metadata", { width: video.videoWidth, height: video.videoHeight })
        void video.play().catch(() => {})
        watchVideo()
      }
    }
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: "webrtc.ice", tabId: "webrtc-smoke-tab", candidate: event.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => reportLog("connection", pc.connectionState)
  pc.oniceconnectionstatechange = () => reportLog("ice", pc.iceConnectionState)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  send({ type: "webrtc.offer", tabId: "webrtc-smoke-tab", sdp: offer.sdp || "" })
}

async function handle(message) {
  if (message.type === "webrtc.host.ready") {
    await negotiate()
    return
  }
  if (message.type === "webrtc.answer" && pc) {
    reportLog("answer", { length: String(message.sdp || "").length })
    await pc.setRemoteDescription({ type: "answer", sdp: message.sdp })
    return
  }
  if (message.type === "webrtc.ice" && pc && message.candidate) {
    await pc.addIceCandidate(message.candidate)
  }
}

ws = new WebSocket(signalingUrl)
ws.onmessage = (event) => {
  try {
    void handle(JSON.parse(event.data))
  } catch {}
}
</script>
</body>
</html>`

  return `import { app, BrowserWindow } from "electron"

const html = ${JSON.stringify(html)}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 360,
    height: 280,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  })
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html))
})
`
}

async function runViewer(
  signalingUrl: string,
  mediaReadyUrl: string,
  mediaLogUrl: string,
  dataInputUrl: string,
  done: Promise<void>,
  state: SmokeServerState,
) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "synergy-webrtc-viewer-"))
  const entry = path.join(tmp, "main.mjs")
  await Bun.write(entry, viewerScript(signalingUrl, mediaReadyUrl, mediaLogUrl, dataInputUrl))
  const proc = Bun.spawn([ELECTRON_BIN, entry], {
    cwd: DESKTOP_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ELECTRON_ENABLE_LOGGING: "1",
    },
  })
  try {
    await withTimeout(
      Promise.race([
        done,
        proc.exited.then((code) => {
          throw new Error(`Electron WebRTC viewer process exited before smoke completed: ${code}`)
        }),
      ]),
      30_000,
      "Electron WebRTC viewer smoke",
    )
  } catch (error) {
    await stopDesktop(proc)
    const logs = [await readPipe(proc.stdout), await readPipe(proc.stderr)].filter(Boolean).join("\n")
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstate=${JSON.stringify(state)}\n${logs}`,
    )
  } finally {
    await stopDesktop(proc)
    await rm(tmp, { recursive: true, force: true })
  }
}

describe("Electron browser runtime smoke", () => {
  runtimeTest(
    "native WebContentsView host accepts control commands",
    async () => {
      await withSmokeServer("native", async ({ serverUrl, state, done }) => {
        await runDesktop(
          {
            SYNERGY_DESKTOP_SHOW: "0",
            SYNERGY_DESKTOP_APP_URL: `${serverUrl}/native-page`,
          },
          done,
          state,
        )
        expect(state).toMatchObject({
          controlOpened: true,
          ready: true,
          navigated: true,
          evaluatedTitle: "Native Browser Host Smoke",
          cdpValue: 42,
        })
      })
    },
    90_000,
  )

  runtimeTest(
    "WebRTC Browser Host accepts control commands and opens signaling",
    async () => {
      await withSmokeServer("webrtc", async ({ serverUrl, state, done }) => {
        await runDesktop(
          {
            SYNERGY_DESKTOP_MODE: "browser-host",
            SYNERGY_BROWSER_HOST_SHOW: "0",
            SYNERGY_BROWSER_HOST_SERVER_URL: serverUrl,
            SYNERGY_BROWSER_HOST_SESSION_ID: "webrtc-smoke-session",
            SYNERGY_BROWSER_HOST_TAB_ID: "webrtc-smoke-tab",
            SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY: "aG9tZQ",
            SYNERGY_BROWSER_HOST_URL: "about:blank",
          },
          done,
          state,
        )
        expect(state).toMatchObject({
          controlOpened: true,
          signalingOpened: true,
          ready: true,
          navigated: true,
          evaluatedTitle: "WebRTC Browser Host Smoke",
          cdpValue: 42,
        })
      })
    },
    90_000,
  )

  runtimeTest(
    "WebRTC Browser Host negotiates a media stream to a viewer",
    async () => {
      await withSmokeServer(
        "webrtc",
        async ({ serverUrl, state, done }) => {
          const signalingUrl =
            serverUrl.replace(/^http/, "ws") +
            "/aG9tZQ/browser/webrtc/connect?mode=session&sessionID=webrtc-smoke-session&presentation=webrtc&client=web&tabId=webrtc-smoke-tab"
          await Promise.all([
            runDesktop(
              {
                SYNERGY_DESKTOP_MODE: "browser-host",
                SYNERGY_BROWSER_HOST_SHOW: process.env.SYNERGY_DESKTOP_RUNTIME_SHOW === "1" ? "1" : "0",
                SYNERGY_BROWSER_HOST_SERVER_URL: serverUrl,
                SYNERGY_BROWSER_HOST_SESSION_ID: "webrtc-smoke-session",
                SYNERGY_BROWSER_HOST_TAB_ID: "webrtc-smoke-tab",
                SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY: "aG9tZQ",
                SYNERGY_BROWSER_HOST_URL: "about:blank",
                SYNERGY_BROWSER_HOST_WIDTH: "320",
                SYNERGY_BROWSER_HOST_HEIGHT: "240",
              },
              done,
              state,
            ),
            runViewer(
              signalingUrl,
              `${serverUrl}/media-ready`,
              `${serverUrl}/media-log`,
              `${serverUrl}/data-input-sent`,
              done,
              state,
            ),
          ])
          expect(state).toMatchObject({
            controlOpened: true,
            signalingOpened: true,
            viewerSignalingOpened: true,
            mediaReady: true,
            dataInputSent: true,
            evaluatedTitle: "WebRTC Browser Host Smoke",
            cdpValue: 42,
            evaluatedInput: "remote-data-channel",
          })
        },
        { requireViewer: true, requireMedia: true, requireDataInput: true },
      )
    },
    90_000,
  )
})
