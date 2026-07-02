import fs from "fs/promises"
import type { Browser, BrowserContext, Page } from "playwright"
import { BrowserOwner } from "./owner.js"
import type { BrowserDriver } from "./driver.js"
import { BrowserInstall } from "./install.js"
import { BrowserStorage } from "./storage.js"

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
function nextPageId(): string {
  return `page-${++seq}`
}

export class PlaywrightBrowserDriver implements BrowserDriver.Driver {
  private contexts = new Map<string, InternalContext>()
  private pages = new Map<string, Map<string, Page>>()
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
    for (const ctx of this.contexts.values()) {
      if (ctx.browserContext) {
        try {
          await ctx.browserContext.close()
        } catch {
          // ignore close failures
        }
      }
    }
    if (this._browser) {
      try {
        await this._browser.close()
      } catch {
        // ignore close failures
      }
      this._browser = null
    }
    this.contexts.clear()
    this.pages.clear()
    this._running = false
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
        await fs.access(storageState)
        storageStateOption = storageState
      } catch {
        storageStateOption = undefined
      }

      ctx.browserContext = await this._browser.newContext({
        viewport: { width: 1280, height: 720 },
        acceptDownloads: true,
        storageState: storageStateOption,
      })
      this.contexts.set(key, ctx)
      this.pages.set(key, new Map())
    }
    return { browserContextId: ctx.browserContextId }
  }

  async newPage(owner: BrowserOwner.Info, url?: string): Promise<Page> {
    const key = BrowserOwner.key(owner)
    await this.contextFor(owner)
    const ctx = this.contexts.get(key)!
    if (!ctx.browserContext) throw new Error("Browser context is not available")
    const page = await ctx.browserContext.newPage()
    const pageID = nextPageId()
    ;(page as unknown as Record<string, unknown>)._synergyPageID = pageID
    this.pages.get(key)!.set(pageID, page)
    // Do not navigate here. BrowserSession/BrowserTab.navigate performs URL policy checks.
    return page
  }

  async saveContextStorage(owner: BrowserOwner.Info): Promise<void> {
    const ctx = this.contexts.get(BrowserOwner.key(owner))
    if (!ctx?.browserContext) return
    await BrowserStorage.ensureOwnerDirs(owner)
    await ctx.browserContext.storageState({ path: BrowserStorage.storageStatePath(owner) })
  }

  getPage(owner: BrowserOwner.Info, pageId: string): Page | undefined {
    return this.pages.get(BrowserOwner.key(owner))?.get(pageId)
  }

  async closePage(owner: BrowserOwner.Info, pageId: string): Promise<void> {
    const key = BrowserOwner.key(owner)
    const page = this.pages.get(key)?.get(pageId)
    if (page) {
      try {
        await page.close()
      } catch {
        // ignore close failures
      }
    }
    this.pages.get(key)?.delete(pageId)
  }

  listOwners(): BrowserOwner.Info[] {
    return Array.from(this.contexts.values()).map((ctx) => ctx.owner)
  }
}
