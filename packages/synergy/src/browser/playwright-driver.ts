import type { Browser, BrowserContext, Page } from "playwright"
import { BrowserOwner } from "./owner.js"
import type { BrowserDriver } from "./driver.js"

interface InternalContext {
  owner: BrowserOwner.Info
  browserContextId: string
  browserContext?: BrowserContext
}

let seq = 0
function nextContextId(): string {
  return `ctx-${++seq}`
}
function nextTabId(): string {
  return `tab-${++seq}`
}

export class PlaywrightBrowserDriver implements BrowserDriver.Driver {
  private contexts = new Map<string, InternalContext>()
  private pages = new Map<string, Map<string, Page>>()
  private _running = false
  private _browserType = "chromium"
  private _browser: Browser | null = null

  async ensure(): Promise<BrowserDriver.DriverState> {
    if (this._running) return { running: true, browserType: this._browserType, activeOwners: this.contexts.size }

    try {
      const playwright = (await import("playwright")) as { chromium?: { launch(): Promise<Browser> } }
      if (playwright.chromium) this._browser = await playwright.chromium.launch()
    } catch {
      this._browser = null
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
      if (this._browser) {
        ctx.browserContext = await this._browser.newContext({
          viewport: { width: 1280, height: 720 },
          acceptDownloads: true,
        })
      }
      this.contexts.set(key, ctx)
      this.pages.set(key, new Map())
    }
    return { browserContextId: ctx.browserContextId }
  }

  async newPage(owner: BrowserOwner.Info, url?: string): Promise<Page> {
    const key = BrowserOwner.key(owner)
    await this.contextFor(owner)
    const ctx = this.contexts.get(key)!
    const page = ctx.browserContext ? await ctx.browserContext.newPage() : createMockPage(url)
    const tabID = nextTabId()
    ;(page as unknown as Record<string, unknown>)._synergyTabID = tabID
    this.pages.get(key)!.set(tabID, page)
    // Do not navigate here. BrowserSession/BrowserTab.navigate performs URL policy checks.
    return page
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

function createMockPage(url?: string): Page {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  let currentUrl = url ?? "about:blank"
  let currentTitle = ""
  let closed = false
  const mockContext = {
    grantPermissions: async () => {},
    newCDPSession: async () => ({
      send: async () => ({ result: { value: null } }),
      detach: async () => {},
    }),
  }

  const mockPage = {
    url: () => currentUrl,
    title: async () => currentTitle,
    goto: async (u: string) => {
      currentUrl = u
      return null
    },
    reload: async () => null,
    goBack: async () => null,
    goForward: async () => null,
    close: async () => {
      closed = true
    },
    isClosed: () => closed,
    context: () => mockContext,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler)
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler)
    },
    mouse: {
      click: async () => {},
      wheel: async () => {},
      move: async () => {},
      down: async () => {},
      up: async () => {},
    },
    keyboard: {
      type: async () => {},
      press: async () => {},
    },
    screenshot: async () => Buffer.from("") as Buffer,
    evaluate: async () => null,
    locator: () => mockLocator,
    getByRole: () => mockLocator,
    getByText: () => mockLocator,
    getByLabel: () => mockLocator,
    getByPlaceholder: () => mockLocator,
    getByTestId: () => mockLocator,
    waitForURL: async () => {},
    waitForLoadState: async () => {},
    setViewportSize: async () => {},
    viewportSize: () => ({ width: 1280, height: 720 }),
  }

  return mockPage as unknown as Page
}

const mockLocator = {
  click: async () => {},
  dblclick: async () => {},
  fill: async () => {},
  type: async () => {},
  selectOption: async () => {},
  check: async () => {},
  uncheck: async () => {},
  hover: async () => {},
  dragTo: async () => {},
  waitFor: async () => {},
  screenshot: async () => Buffer.from(""),
  boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
  evaluate: async () => null,
}
