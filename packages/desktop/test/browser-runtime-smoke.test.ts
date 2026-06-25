import { describe, expect, test } from "bun:test"
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
  controlUpgradeAttempts: number
  signalingUpgradeAttempts: number
  controlOpened: boolean
  signalingOpened: boolean
  ready: boolean
  navigated: boolean
  evaluatedTitle: string | null
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
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>${title}</title><main>${title}</main>`)}`
}

async function withSmokeServer(
  mode: "native" | "webrtc",
  run: (input: { serverUrl: string; state: SmokeServerState; done: Promise<void> }) => Promise<void>,
) {
  const done = deferred<void>()
  const title = mode === "native" ? "Native Browser Host Smoke" : "WebRTC Browser Host Smoke"
  const state: SmokeServerState = {
    httpRequests: [],
    controlUpgradeAttempts: 0,
    signalingUpgradeAttempts: 0,
    controlOpened: false,
    signalingOpened: false,
    ready: false,
    navigated: false,
    evaluatedTitle: null,
  }
  let appPage = ""
  let commandSeq = 0
  let navigateId: string | null = null
  let evaluateId: string | null = null

  const server = Bun.serve<{ kind: "control" | "signaling" }>({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      state.httpRequests.push(`${req.method} ${url.pathname}`)
      if (url.pathname === "/native-page") {
        return new Response(appPage, { headers: { "content-type": "text/html" } })
      }
      if (url.pathname.endsWith("/browser/host/control")) {
        state.controlUpgradeAttempts++
        return server.upgrade(req, { data: { kind: "control" } })
          ? undefined
          : new Response("control upgrade failed", { status: 400 })
      }
      if (url.pathname.endsWith("/browser/webrtc/host")) {
        state.signalingUpgradeAttempts++
        return server.upgrade(req, { data: { kind: "signaling" } })
          ? undefined
          : new Response("signaling upgrade failed", { status: 400 })
      }
      return new Response("ok")
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "signaling") {
          state.signalingOpened = true
          checkComplete()
          return
        }
        state.controlOpened = true
      },
      message(ws, raw) {
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
          checkComplete()
        }
      },
    },
  })

  const serverUrl = `http://127.0.0.1:${server.port}`
  appPage = smokePage(serverUrl)

  function sendCommand(ws: ServerWebSocket<{ kind: "control" | "signaling" }>, command: Record<string, unknown>) {
    const id = `${mode}-command-${++commandSeq}`
    ws.send(JSON.stringify({ type: "browser.host.command", id, command }))
    return id
  }

  function checkComplete() {
    if (!state.controlOpened || !state.ready || !state.navigated || state.evaluatedTitle !== title) return
    if (mode === "webrtc" && !state.signalingOpened) return
    done.resolve()
  }

  try {
    await run({ serverUrl, state, done: done.promise })
  } finally {
    server.stop(true)
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
        })
      })
    },
    90_000,
  )
})
