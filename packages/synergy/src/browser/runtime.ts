import path from "path"
import { CdpClient } from "./cdp.js"
import { BrowserInstall } from "./install.js"

// ── BrowserSession placeholder (full interface in session.ts) ─────────

export interface BrowserSession {
  readonly key: BrowserRuntime.SessionKey
  dispose(): Promise<void>
}

// ── SessionFactory pattern (avoids circular dep with session.ts) ─────

let sessionFactory: ((runtime: BrowserRuntime.RuntimeState, key: BrowserRuntime.SessionKey) => BrowserSession) | null =
  null

export function setSessionFactory(factory: typeof sessionFactory): void {
  sessionFactory = factory
}

// ── BrowserRuntime namespace ──────────────────────────────────────────

export namespace BrowserRuntime {
  export interface SessionKey {
    scopeID: string
    sessionID?: string
  }

  export interface RuntimeState {
    running: boolean
    chromiumPath: string | null
    cdpConnection: CdpClient.Connection | null
    sessions: Map<string, BrowserSession>
    health: BrowserInstall.Health | null
  }

  // ── module-level singleton state ────────────────────────────────

  const sessions = new Map<string, BrowserSession>()
  let chromiumProcess: ReturnType<typeof Bun.spawn> | null = null
  let running = false
  let chromiumPath: string | null = null
  let cdpConnection: CdpClient.Connection | null = null

  function sessionKeyStr(key: SessionKey): string {
    return `${key.scopeID}:${key.sessionID ?? "default"}`
  }

  // ── Chromium launch helpers ─────────────────────────────────────

  const CHROMIUM_BASE_ARGS = [
    "--headless=new",
    "--disable-gpu",
    "--user-data-dir",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-plugins",
    "--disable-component-update",
    "--disable-breakpad",
  ]

  function buildArgs(userDataDir: string, usePipe: boolean): string[] {
    const args: string[] = []
    if (usePipe) args.push("--remote-debugging-pipe")
    args.push("--remote-debugging-port=0")
    for (const arg of CHROMIUM_BASE_ARGS) {
      if (arg === "--user-data-dir") {
        args.push(`--user-data-dir=${userDataDir}`)
      } else {
        args.push(arg)
      }
    }
    return args
  }

  function launchChromium(exe: string, args: string[]): ReturnType<typeof Bun.spawn> {
    return Bun.spawn([exe, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  /** Read stderr and resolve with the WebSocket URL when Chromium reports it. Returns null on timeout or exit. */
  async function parseDevToolsURL(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<string | null> {
    const decoder = new TextDecoder()
    let buffer = ""

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    const exited = proc.exited.then(() => null)

    const stderr = proc.stderr
    if (!stderr || typeof stderr === "number") return null

    const readLoop = (async (): Promise<string | null> => {
      try {
        const reader = stderr.getReader()
        while (true) {
          const result = await reader.read()
          if (result.done) return null
          buffer += decoder.decode(result.value, { stream: true })
          const match = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+/)
          if (match) return match[0]
          if (buffer.length > 20_000) buffer = buffer.slice(-10_000)
        }
      } catch {
        return null
      }
    })()

    return Promise.race([readLoop, exited, timeout])
  }

  /** Discover the browser-level WebSocket URL via HTTP endpoint. */
  async function discoverBrowserWS(port: number): Promise<string | null> {
    const targets = await CdpClient.discoverTargets(port)
    const browserTarget = targets.find((t) => t.type === "page" || t.type === "browser")
    if (browserTarget) return browserTarget.webSocketDebuggerUrl
    if (targets.length > 0) return targets[0].webSocketDebuggerUrl
    return null
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Idempotent start: starts Chromium if not already running. */
  export async function ensure(): Promise<RuntimeState> {
    if (running) return state()
    return start()
  }

  /** Start Chromium + connect CDP. */
  export async function start(): Promise<RuntimeState> {
    if (running) return state()

    const exe = await BrowserInstall.discoverChromium()
    if (!exe) throw new Error("Chromium not found")

    const userDataDir = path.join(BrowserInstall.chromiumDir(), "user-data")

    // Attempt 1: with --remote-debugging-pipe
    let wsURL: string | null = null
    let proc = launchChromium(exe, buildArgs(userDataDir, true))
    wsURL = await parseDevToolsURL(proc, 15_000)

    // If process exited quickly (pipe not supported), retry without pipe
    if (!wsURL && proc.exitCode != null) {
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
      proc = launchChromium(exe, buildArgs(userDataDir, false))
      wsURL = await parseDevToolsURL(proc, 15_000)
    }

    if (!wsURL) {
      // Last resort: try to extract port from stderr and use HTTP discovery
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      proc = launchChromium(exe, buildArgs(userDataDir, false))
      const port = await parseDevToolsPort(proc, 15_000)
      if (port) {
        wsURL = await discoverBrowserWS(port)
      }
      if (!wsURL) {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        throw new Error("Could not discover DevTools WebSocket URL")
      }
    }

    const conn = await CdpClient.connectWS(wsURL)

    // Monitor chromium process for unexpected exits
    monitorChromiumExit(proc, conn)

    chromiumProcess = proc
    chromiumPath = exe
    cdpConnection = conn
    running = true

    return state()
  }

  /** Parse just the port number from stderr. Fallback for HTTP discovery. */
  async function parseDevToolsPort(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<number | null> {
    const decoder = new TextDecoder()
    let buffer = ""

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    const exited = proc.exited.then(() => null)
    const stderr = proc.stderr
    if (!stderr || typeof stderr === "number") return null

    const readLoop = (async (): Promise<number | null> => {
      try {
        const reader = stderr.getReader()
        while (true) {
          const result = await reader.read()
          if (result.done) return null
          buffer += decoder.decode(result.value, { stream: true })
          const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)
          if (match) return parseInt(match[1], 10)
          if (buffer.length > 20_000) buffer = buffer.slice(-10_000)
        }
      } catch {
        return null
      }
    })()

    return Promise.race([readLoop, exited, timeout])
  }

  function monitorChromiumExit(proc: ReturnType<typeof Bun.spawn>, conn: CdpClient.Connection): void {
    proc.exited.then(() => {
      if (running) {
        running = false
        cdpConnection = null
        chromiumProcess = null
        try {
          conn.close()
        } catch {
          /* ignore */
        }
      }
    })
  }

  /** Graceful shutdown: close all sessions, kill Chromium. */
  export async function stop(): Promise<void> {
    // Dispose all sessions
    const disposeOps: Promise<void>[] = []
    for (const session of sessions.values()) {
      disposeOps.push(session.dispose())
    }
    await Promise.allSettled(disposeOps)
    sessions.clear()

    // Close CDP connection
    if (cdpConnection) {
      try {
        await cdpConnection.close()
      } catch {
        /* ignore */
      }
      cdpConnection = null
    }

    // Kill Chromium process
    if (chromiumProcess) {
      try {
        chromiumProcess.kill()
      } catch {
        /* ignore */
      }
      chromiumProcess = null
    }

    running = false
    chromiumPath = null
  }

  /** Get current health. Does not start Chromium. */
  export async function health(): Promise<BrowserInstall.Health> {
    if (chromiumPath) {
      return BrowserInstall.healthCheck(chromiumPath)
    }
    // If chromiumPath is null, try discovery (read-only, no launch)
    const discovered = await BrowserInstall.discoverChromium()
    if (discovered) {
      return BrowserInstall.healthCheck(discovered)
    }
    return {
      running: false,
      chromiumPath: null,
      installed: false,
      version: null,
    }
  }

  /** Get or create a BrowserSession for scopeID+sessionID. */
  export function session(key: SessionKey): BrowserSession {
    const k = sessionKeyStr(key)
    const existing = sessions.get(k)
    if (existing) return existing

    if (!sessionFactory) {
      throw new Error("BrowserSession factory not registered — session.ts must call setSessionFactory()")
    }

    const s = sessionFactory(state(), key)
    sessions.set(k, s)
    return s
  }

  /** Dispose a specific BrowserSession. */
  export async function disposeSession(key: SessionKey): Promise<void> {
    const k = sessionKeyStr(key)
    const s = sessions.get(k)
    if (!s) return
    sessions.delete(k)
    await s.dispose()
  }

  /** Register a session externally (for BrowserSession constructor). */
  export function registerSession(key: SessionKey, session: BrowserSession): void {
    sessions.set(sessionKeyStr(key), session)
  }

  /** Get the current runtime state (for debugging). */
  export function state(): RuntimeState {
    return {
      running,
      chromiumPath,
      cdpConnection,
      sessions: new Map(sessions),
      health: null,
    }
  }
}
