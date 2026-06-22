import path from "path"
import { Log } from "../util/log"
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

  // ── Public API ──────────────────────────────────────────────────

  /** Idempotent start: starts the driver if not already running. */
  export async function ensure(): Promise<RuntimeState> {
    if (running) return state()

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
