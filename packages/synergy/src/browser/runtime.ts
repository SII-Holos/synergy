import { Log } from "../util/log"
import { GlobalBus } from "../bus/global"
import { BrowserInstall } from "./install.js"
import { BrowserOwner } from "./owner.js"
import { PlaywrightBrowserDriver } from "./playwright-driver.js"
import type { BrowserDriver } from "./driver.js"

import type { BrowserSession } from "./types.js"
export { type BrowserSession } from "./types.js"

// ── BrowserRuntime namespace ──────────────────────────────────────────
export namespace BrowserRuntime {
  export interface RuntimeState {
    running: boolean
    chromiumPath: string | null
    driver: BrowserDriver.Driver | null
    sessions: Map<string, BrowserSession>
    health: BrowserInstall.Health | null
  }

  // ── module-level singleton state ────────────────────────────────
  const log = Log.create({ service: "browser.runtime" })

  const sessions = new Map<string, BrowserSession>()
  let running = false
  let chromiumPath: string | null = null
  let driver: BrowserDriver.Driver | null = null

  // ── Public API ──────────────────────────────────────────────────

  // Dispose a session's browser page when the session is deleted or archived
  // (issue #350 D3/H4). Each session-owned browser holds a Chromium renderer
  // (~100–300MB); without this they accumulate until the server exits. Installed
  // once, only while the runtime is live (i.e. only when the browser is used),
  // so no Playwright/Chromium cost is paid by sessions that never opened one.
  let reaperInstalled = false
  function installSessionReaper() {
    if (reaperInstalled) return
    reaperInstalled = true
    GlobalBus.on("event", (event) => {
      const payload = event?.payload
      const info = payload?.properties?.info
      if (!info?.id) return
      const archived = payload.type === "session.updated" && info.time?.archived
      const deleted = payload.type === "session.deleted"
      if (!archived && !deleted) return
      const scopeID = info.scope?.id
      if (!scopeID) return
      // directory is required by the type but unused for the session-mode key.
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID,
        directory: info.scope?.directory ?? "",
        sessionID: info.id,
      }
      void disposeSession(owner).catch((error) =>
        log.warn("failed to dispose browser session on lifecycle event", { sessionID: info.id, error }),
      )
    })
  }

  /** Idempotent start: starts the driver if not already running. */
  export async function ensure(): Promise<RuntimeState> {
    if (running) return state()
    installSessionReaper()

    // Discover chromium for health check (Playwright handles its own launch)
    const exe = await BrowserInstall.discoverChromium()
    if (exe) {
      chromiumPath = exe
    }

    const pwDriver = new PlaywrightBrowserDriver()
    await pwDriver.ensure()
    driver = pwDriver
    running = true

    return state()
  }

  /** Start the driver. */
  export async function start(): Promise<RuntimeState> {
    if (running) return state()
    installSessionReaper()

    const exe = await BrowserInstall.discoverChromium()
    if (!exe) throw new Error("Chromium not found")

    chromiumPath = exe

    const pwDriver = new PlaywrightBrowserDriver()
    await pwDriver.ensure()
    driver = pwDriver
    running = true

    return state()
  }

  /** Graceful shutdown: close all sessions, stop driver. */
  export async function stop(): Promise<void> {
    // Dispose all sessions
    const disposeOps: Promise<void>[] = []
    for (const session of sessions.values()) {
      disposeOps.push(session.dispose())
    }
    await Promise.allSettled(disposeOps)
    sessions.clear()

    // Stop driver
    if (driver) {
      try {
        await driver.stop()
      } catch {
        /* ignore */
      }
      driver = null
    }

    running = false
    chromiumPath = null
  }

  /** Get current health. Does not start the driver. */
  export async function health(): Promise<BrowserInstall.Health> {
    if (chromiumPath) {
      return BrowserInstall.healthCheck(chromiumPath)
    }
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

  /** Dispose a specific BrowserSession. */
  export async function disposeSession(owner: BrowserOwner.Info): Promise<void> {
    const k = BrowserOwner.key(owner)
    const s = sessions.get(k)
    if (!s) return
    sessions.delete(k)
    await s.dispose()
  }

  /** Register a session externally (for BrowserSession constructor). */
  export function registerSession(owner: BrowserOwner.Info, session: BrowserSession): void {
    sessions.set(BrowserOwner.key(owner), session)
  }

  /** Create or retrieve a BrowserSession for the given owner. */
  export async function getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    BrowserOwner.assertValid(owner)
    const k = BrowserOwner.key(owner)
    const existing = sessions.get(k)
    if (existing) return existing

    if (!driver) {
      throw new Error("Browser driver not running")
    }

    const { BrowserSessionImpl } = await import("./session.js")
    const session = new BrowserSessionImpl(owner, driver)
    sessions.set(k, session)
    await session.restore()
    return session
  }

  /** Get the current runtime state (for debugging). */
  export function state(): RuntimeState {
    return {
      running,
      chromiumPath,
      driver,
      sessions: new Map(sessions),
      health: null,
    }
  }
}
