import fs from "fs/promises"
import path from "node:path"
import type { Browser, BrowserContext, Page } from "playwright"
import { BrowserOwner } from "./owner.js"
import type { BrowserDriver } from "./driver.js"
import { BrowserInstall } from "./install.js"
import { BrowserStorage } from "./storage.js"
import { BrowserNetworkGateway } from "./network-gateway.js"

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

  constructor(private options: PlaywrightBrowserDriverOptions = {}) {
    this._browserType = options.browserType ?? "chromium"
  }

  private launchArgs(): string[] {
    return [
      "--headless=new",
      "--disable-gpu",
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-breakpad",
    ]
  }

  async ensure(): Promise<BrowserDriver.DriverState> {
    if (this._running) return { running: true, browserType: this._browserType, activeOwners: this.contexts.size }

    try {
      if (this.options.launchBrowser) {
        this._browser = await this.options.launchBrowser()
      } else {
        const playwright = (await import("playwright")) as {
          chromium?: { launch(options?: Record<string, unknown>): Promise<Browser> }
        }
        if (!playwright.chromium) throw new Error("Playwright chromium is unavailable")

        const executablePath = await BrowserInstall.discoverChromium()
        this._browser = await playwright.chromium.launch({
          headless: true,
          timeout: 10_000,
          ...(executablePath ? { executablePath } : {}),
          args: this.launchArgs(),
        })
      }
    } catch (error) {
      throw new Error(
        `Unable to launch Playwright Chromium. Run "bunx playwright install chromium" or set CHROMIUM_PATH to a usable Chromium executable. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    this._running = true
    return { running: true, browserType: this._browserType, activeOwners: this.contexts.size }
  }

  async stop(): Promise<void> {
    const failures: unknown[] = []
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
      return
    }
    try {
      await context.close()
      this.contexts.delete(key)
    } catch (error) {
      throw new AggregateError([error], "Playwright Browser owner context did not close cleanly.")
    }
  }

  listOwners(): BrowserOwner.Info[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.owner)
  }
}
