import fs from "fs/promises"
import path from "node:path"
import type { Browser, BrowserContext, Page } from "playwright-core"
import { BrowserOwner } from "./owner.js"
import type { BrowserDriver } from "./driver.js"
import { BrowserInstall } from "./install.js"
import { BrowserStorage } from "./storage.js"
import { BrowserNetworkGateway } from "./network-gateway.js"
import { PlaywrightRuntime } from "./playwright-runtime.js"

interface InternalContext {
  owner: BrowserOwner.Info
  browserContextId: string
  browserContext?: BrowserContext
}

export interface PlaywrightBrowserDriverOptions {
  launchBrowser?: () => Promise<Browser>
  browserType?: string
}

let seq = 0
function nextContextId(): string {
  return `ctx-${++seq}`
}
export class PlaywrightBrowserDriver implements BrowserDriver.Driver {
  private contexts = new Map<string, InternalContext>()
  private _running = false
  private _browserType: string
  private _browser: Browser | null = null
  private launchPromise: Promise<void> | null = null
  private pendingContexts = 0

  constructor(private options: PlaywrightBrowserDriverOptions = {}) {
    this._browserType = options.browserType ?? "chromium"
  }

  async ensure(): Promise<BrowserDriver.DriverState> {
    if (this._running) return { running: true, browserType: this._browserType, activeOwners: this.contexts.size }

    if (!this.launchPromise) {
      this.launchPromise = this.launch().finally(() => {
        this.launchPromise = null
      })
    }
    await this.launchPromise
    return { running: true, browserType: this._browserType, activeOwners: this.contexts.size }
  }

  async stop(): Promise<void> {
    const failures: unknown[] = []
    if (this.launchPromise) {
      try {
        await this.launchPromise
      } catch (error) {
        failures.push(error)
      }
    }
    for (const ctx of this.contexts.values()) {
      if (!ctx.browserContext) continue
      try {
        await ctx.browserContext.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (this._browser) {
      try {
        await this._browser.close()
      } catch (error) {
        failures.push(error)
      }
      this._browser = null
    }
    this.contexts.clear()
    this._running = false
    if (failures.length) throw new AggregateError(failures, "Playwright Browser driver did not stop cleanly.")
  }

  async contextFor(owner: BrowserOwner.Info): Promise<BrowserDriver.BrowserContextHandle> {
    BrowserOwner.assertValid(owner)
    this.pendingContexts++
    try {
      await this.ensure()
      const key = BrowserOwner.key(owner)
      let ctx = this.contexts.get(key)
      if (!ctx) {
        ctx = { owner: { ...owner }, browserContextId: nextContextId() }
        if (!this._browser) throw new Error("Browser is not running")

        await BrowserStorage.ensureOwnerDirs(owner)
        const storageState = BrowserStorage.storageStatePath(owner)
        let storageStateOption: string | undefined
        try {
          const info = await fs.lstat(storageState)
          const real = await fs.realpath(storageState)
          const realProfile = await fs.realpath(BrowserStorage.profileDir(owner))
          if (
            info.isFile() &&
            !info.isSymbolicLink() &&
            info.size <= 32 * 1024 * 1024 &&
            real.startsWith(`${realProfile}${path.sep}`)
          ) {
            storageStateOption = storageState
          }
        } catch {
          storageStateOption = undefined
        }

        const proxy = await BrowserNetworkGateway.proxyFor(owner)
        ctx.browserContext = await this._browser.newContext({
          viewport: { width: 1280, height: 720 },
          acceptDownloads: true,
          storageState: storageStateOption,
          proxy,
        })
        this.contexts.set(key, ctx)
      }
      return { browserContextId: ctx.browserContextId }
    } finally {
      this.pendingContexts--
      await this.retireBrowserIfIdle()
    }
  }

  async newPage(owner: BrowserOwner.Info): Promise<Page> {
    const key = BrowserOwner.key(owner)
    await this.contextFor(owner)
    const ctx = this.contexts.get(key)!
    if (!ctx.browserContext) throw new Error("Browser context is not available")
    return ctx.browserContext.newPage()
  }

  async saveContextStorage(owner: BrowserOwner.Info): Promise<void> {
    const ctx = this.contexts.get(BrowserOwner.key(owner))
    if (!ctx?.browserContext) return
    await BrowserStorage.ensureOwnerDirs(owner)
    const target = BrowserStorage.storageStatePath(owner)
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    let failure: unknown
    try {
      await ctx.browserContext.storageState({ path: temporary })
      const info = await fs.lstat(temporary)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) {
        throw new Error("Browser storage state is unsafe or exceeds 32 MB.")
      }
      await fs.chmod(temporary, 0o600)
      await BrowserStorage.replaceFileAtomically(temporary, target)
    } catch (error) {
      failure = error
    }
    try {
      await fs.rm(temporary, { force: true })
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], "Browser profile save and cleanup both failed.")
      throw cleanupError
    }
    if (failure) throw failure
  }

  async releaseOwner(owner: BrowserOwner.Info): Promise<void> {
    const key = BrowserOwner.key(owner)
    const context = this.contexts.get(key)?.browserContext
    if (!context) {
      this.contexts.delete(key)
      await this.retireBrowserIfIdle()
      return
    }
    try {
      await context.close()
      this.contexts.delete(key)
      await this.retireBrowserIfIdle()
    } catch (error) {
      throw new AggregateError([error], "Playwright Browser owner context did not close cleanly.")
    }
  }

  listOwners(): BrowserOwner.Info[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.owner)
  }

  private async launch(): Promise<void> {
    try {
      if (this.options.launchBrowser) {
        this._browser = await this.options.launchBrowser()
      } else {
        const playwright = PlaywrightRuntime.load()
        if (!playwright.chromium) throw new Error("Playwright chromium is unavailable")

        const executablePath = await BrowserInstall.discoverChromium()
        this._browser = await playwright.chromium.launch({
          headless: true,
          timeout: 10_000,
          ...(executablePath ? { executablePath } : {}),
          args: BrowserInstall.chromiumLaunchArgs(),
        })
      }
      this._running = true
    } catch (error) {
      this._browser = null
      this._running = false
      throw new Error(
        `Unable to launch Playwright Chromium. Run "synergy browser install" to install verified managed Chromium, run "synergy browser doctor" for diagnostics, or set CHROMIUM_PATH to a usable executable. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  private async retireBrowserIfIdle(): Promise<void> {
    if (this.contexts.size > 0 || this.pendingContexts > 0 || !this._browser) return
    const browser = this._browser
    this._browser = null
    this._running = false
    await browser.close()
  }
}
