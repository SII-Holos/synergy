import { describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import { BrowserOwner } from "../../src/browser/owner"
import { PlaywrightBrowserDriver } from "../../src/browser/playwright-driver"

function owner(sessionID: string): BrowserOwner.Info {
  return {
    mode: "session",
    scopeID: "scope-browser-driver",
    sessionID,
    directory: process.cwd(),
  }
}

function fakeBrowser() {
  let browserClosed = false
  let contextCloseCount = 0
  const contexts: Array<Record<string, unknown>> = []
  const browser = {
    async newContext(options: Record<string, unknown>) {
      const pages: Array<Record<string, unknown>> = []
      const context = {
        options,
        pages,
        async newPage() {
          const page = { close: async () => undefined }
          pages.push(page)
          return page
        },
        async close() {
          contextCloseCount++
        },
        async storageState() {},
      }
      contexts.push(context)
      return context
    },
    async close() {
      browserClosed = true
    },
  }
  return {
    browser: browser as unknown as Browser,
    contexts,
    browserClosed: () => browserClosed,
    contextCloseCount: () => contextCloseCount,
  }
}

describe("PlaywrightBrowserDriver", () => {
  test("recommends the managed Browser installer when Chromium launch fails", async () => {
    const driver = new PlaywrightBrowserDriver({
      launchBrowser: async () => {
        throw new Error("Chromium is missing")
      },
    })

    await expect(driver.ensure()).rejects.toThrow('Run "synergy browser install"')
  })

  test("reuses one context per owner and isolates different owners", async () => {
    const fake = fakeBrowser()
    const driver = new PlaywrightBrowserDriver({ launchBrowser: async () => fake.browser })
    const first = await driver.contextFor(owner("session-a"))
    const replay = await driver.contextFor(owner("session-a"))
    const second = await driver.contextFor(owner("session-b"))

    expect(replay.browserContextId).toBe(first.browserContextId)
    expect(second.browserContextId).not.toBe(first.browserContextId)
    expect(fake.contexts).toHaveLength(2)
    expect(driver.listOwners().map(BrowserOwner.key).sort()).toEqual(
      [owner("session-a"), owner("session-b")].map(BrowserOwner.key).sort(),
    )
    await driver.stop()
  })

  test("creates a blank page and releases its owner context", async () => {
    const fake = fakeBrowser()
    const driver = new PlaywrightBrowserDriver({ launchBrowser: async () => fake.browser })
    const pageOwner = owner("page-session")
    await driver.newPage(pageOwner)

    expect(driver.listOwners()).toEqual([pageOwner])
    await driver.releaseOwner(pageOwner)
    expect(driver.listOwners()).toEqual([])
    expect(fake.browserClosed()).toBe(true)
  })

  test("keeps the shared browser until the final owner is released", async () => {
    const fake = fakeBrowser()
    const driver = new PlaywrightBrowserDriver({ launchBrowser: async () => fake.browser })
    await driver.contextFor(owner("session-a"))
    await driver.contextFor(owner("session-b"))

    await driver.releaseOwner(owner("session-a"))
    expect(fake.browserClosed()).toBe(false)
    expect(driver.listOwners()).toEqual([owner("session-b")])

    await driver.releaseOwner(owner("session-b"))
    expect(fake.browserClosed()).toBe(true)
    expect(driver.listOwners()).toEqual([])
  })

  test("launches one fresh shared browser for concurrent owners after retirement", async () => {
    const launches: ReturnType<typeof fakeBrowser>[] = []
    const driver = new PlaywrightBrowserDriver({
      launchBrowser: async () => {
        const fake = fakeBrowser()
        launches.push(fake)
        return fake.browser
      },
    })

    await driver.contextFor(owner("session-a"))
    await driver.releaseOwner(owner("session-a"))
    await Promise.all([driver.contextFor(owner("session-b")), driver.contextFor(owner("session-c"))])

    expect(launches).toHaveLength(2)
    expect(launches[0]?.browserClosed()).toBe(true)
    expect(launches[1]?.browserClosed()).toBe(false)
    expect(driver.listOwners().map(BrowserOwner.key).sort()).toEqual(
      [owner("session-b"), owner("session-c")].map(BrowserOwner.key).sort(),
    )
    await driver.stop()
  })

  test("stop closes every context and the shared browser", async () => {
    const fake = fakeBrowser()
    const driver = new PlaywrightBrowserDriver({ launchBrowser: async () => fake.browser })
    await driver.contextFor(owner("session-a"))
    await driver.contextFor(owner("session-b"))

    await driver.stop()

    expect(fake.contextCloseCount()).toBe(2)
    expect(fake.browserClosed()).toBe(true)
    expect((await driver.ensure()).running).toBe(true)
    await driver.stop()
  })
})
