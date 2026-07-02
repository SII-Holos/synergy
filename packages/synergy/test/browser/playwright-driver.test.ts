import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import path from "path"

// BrowserOwner already exists — import for type/namespace usage
import { BrowserOwner } from "../../src/browser/owner.js"

// ── Paths ────────────────────────────────────────────────────────────────

const SRC_BROWSER = path.join(import.meta.dirname ?? __dirname, "../../src/browser")
const DRIVER_PATH = path.join(SRC_BROWSER, "driver.ts")
const PLAYWRIGHT_DRIVER_PATH = path.join(SRC_BROWSER, "playwright-driver.ts")

function createFakePage() {
  return {
    goto: async () => null,
    close: async () => {},
    screenshot: async () => new Uint8Array(),
    mouse: {
      click: async () => {},
    },
    keyboard: {
      type: async () => {},
    },
  }
}

function createFakeBrowser() {
  return {
    newContext: async () => ({
      newPage: async () => createFakePage(),
      close: async () => {},
      storageState: async () => {},
    }),
    close: async () => {},
  }
}

function createTestDriver(mod: Record<string, unknown>) {
  const Driver = mod.PlaywrightBrowserDriver as {
    new (options?: { launchBrowser?: () => Promise<unknown> }): any
  }
  return new Driver({
    launchBrowser: async () => createFakeBrowser(),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  Part A — File existence (RED: files do not exist yet)
//  These assertions fail until the source files are created.
// ═══════════════════════════════════════════════════════════════════════════

describe("BrowserDriver — file existence (RED)", () => {
  test("driver.ts exists in src/browser/", () => {
    // RED: packages/synergy/src/browser/driver.ts does not exist yet.
    // This is the abstract BrowserDriver interface module.
    expect(existsSync(DRIVER_PATH)).toBe(true)
  })

  test("playwright-driver.ts exists in src/browser/", () => {
    // RED: packages/synergy/src/browser/playwright-driver.ts does not exist yet.
    // This is the PlaywrightBrowserDriver implementation class.
    expect(existsSync(PLAYWRIGHT_DRIVER_PATH)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Part B — BrowserDriver interface exports (RED: modules not importable yet)
// ═══════════════════════════════════════════════════════════════════════════

describe("BrowserDriver interface contracts (RED)", () => {
  test("driver.ts exports BrowserDriver namespace", async () => {
    // RED: driver.ts must exist and export a BrowserDriver namespace
    // containing Driver, BrowserContextHandle, PageRecord, DriverState.
    const exports = await importFresh("../../src/browser/driver.js")
    expect(exports).not.toBeNull()
    expect(exports).toHaveProperty("BrowserDriver")
  })

  test("BrowserDriver.Driver interface declares ensure method", () => {
    // RED: BrowserDriver.Driver must declare ensure(): Promise<DriverState>
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/ensure\s*\(\s*\)\s*:\s*Promise/)
  })

  test("BrowserDriver.Driver interface declares stop method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/stop\s*\(\s*\)\s*:\s*Promise/)
  })

  test("BrowserDriver.Driver interface declares contextFor method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/contextFor\s*\(\s*owner/)
    expect(src).toMatch(/BrowserOwner/)
  })

  test("BrowserDriver.Driver interface declares newPage method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/newPage\s*\(\s*owner/)
    expect(src).toMatch(/url\??\s*:/)
  })

  test("BrowserDriver.Driver interface declares getPage method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/getPage\s*\(\s*owner/)
  })

  test("BrowserDriver.Driver interface declares closePage method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/closePage\s*\(\s*owner/)
  })

  test("BrowserDriver.Driver interface declares listOwners method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/listOwners\s*\(\s*\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Part C — PlaywrightBrowserDriver context isolation (RED)
//  Tests verify that contextFor is keyed by BrowserOwner.key(owner),
//  NOT by scopeID alone. Different sessionIDs → different contexts.
// ═══════════════════════════════════════════════════════════════════════════

describe("PlaywrightBrowserDriver context isolation (RED)", () => {
  test("contextFor(ownerA) !== contextFor(ownerB) when sessionIDs differ", async () => {
    // RED: The PlaywrightBrowserDriver must implement BrowserDriver.Driver.
    // When two owners share the same scopeID but have different sessionIDs,
    // contextFor must return different BrowserContextHandles (isolated contexts).
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const ownerA: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-123",
      directory: "/tmp/a",
      sessionID: "ses-AAA",
    }
    const ownerB: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-123",
      directory: "/tmp/b",
      sessionID: "ses-BBB",
    }

    // Keys must differ when sessionIDs differ
    expect(BrowserOwner.key(ownerA)).not.toBe(BrowserOwner.key(ownerB))

    const driver = createTestDriver(mod!)
    const ctxA = await driver.contextFor(ownerA)
    const ctxB = await driver.contextFor(ownerB)

    // Different sessionIDs → different context objects (not same reference)
    expect(ctxA).not.toBe(ctxB)
    // Each context must have a distinct browserContextId
    expect(ctxA.browserContextId).not.toBe(ctxB.browserContextId)
  })

  test("contextFor(same owner) returns same BrowserContextHandle", async () => {
    // RED: Repeated calls to contextFor with the same owner must return
    // the semantically same context (identical browserContextId).
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-abc",
      directory: "/tmp/shared",
      sessionID: "ses-shared",
    }

    const driver = createTestDriver(mod!)
    const ctx1 = await driver.contextFor(owner)
    const ctx2 = await driver.contextFor(owner)

    // Same owner → same context
    expect(ctx1.browserContextId).toBe(ctx2.browserContextId)
  })

  test("contextFor keys by BrowserOwner.key(owner) not scopeID alone", () => {
    // RED: The context map MUST use BrowserOwner.key(owner) as the key.
    // This proves context isolation at the key level. This test verifies
    // the key derivation logic, which exists today.
    const ownerA: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-1",
      directory: "/tmp/a",
      sessionID: "ses-xxx",
    }
    const ownerB: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-1",
      directory: "/tmp/b",
      sessionID: "ses-yyy",
    }

    // scopeIDs are the same, but keys differ because sessionIDs differ
    expect(ownerA.scopeID).toBe(ownerB.scopeID)
    expect(BrowserOwner.key(ownerA)).not.toBe(BrowserOwner.key(ownerB))
    // This invariant must hold in the driver's context map.
  })

  test("scope-owned mode produces key without sessionID", () => {
    const owner: BrowserOwner.Info = {
      mode: "scope",
      scopeID: "scope-global",
      directory: "/tmp/global",
    }

    const key = BrowserOwner.key(owner)
    expect(key).toBe("scope-global:scope")
    expect(key).not.toContain("session:")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Part D — PlaywrightBrowserDriver page lifecycle (RED)
// ═══════════════════════════════════════════════════════════════════════════

describe("PlaywrightBrowserDriver page lifecycle (RED)", () => {
  test("newPage(owner, url) returns a Page with goto/close/mouse/keyboard/screenshot methods", async () => {
    // newPage must create a Playwright Page object with the expected API surface.
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-xyz",
      directory: "/tmp/page-test",
      sessionID: "ses-page-test",
    }

    const driver = createTestDriver(mod!)
    const page = await driver.newPage(owner, "https://example.com")

    // Page must be a real object with Playwright Page methods
    expect(page).not.toBeNull()
    expect(typeof page).toBe("object")
    expect(typeof page.goto).toBe("function")
    expect(typeof page.close).toBe("function")
    expect(typeof page.screenshot).toBe("function")
    expect(page.mouse).toBeDefined()
    expect(typeof page.mouse.click).toBe("function")
    expect(page.keyboard).toBeDefined()
    expect(typeof page.keyboard.type).toBe("function")
  })

  test("newPage tracked by driver and retrievable by internal ID", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-blank",
      directory: "/tmp/blank-test",
      sessionID: "ses-blank",
    }

    const driver = createTestDriver(mod!)
    const page = await driver.newPage(owner)

    // The page has an internal tracking ID stored by the driver
    const pageID = (page as any)._synergyPageID as string
    expect(pageID).toBeTruthy()
    expect(typeof pageID).toBe("string")

    // getPage returns the same page object
    const found = driver.getPage(owner, pageID)
    expect(found).toBe(page)
  })

  test("getPage returns undefined for unknown pageID", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-get-404",
      directory: "/tmp/get-404",
      sessionID: "ses-get-404",
    }

    const driver = createTestDriver(mod!)
    const found = driver.getPage(owner, "nonexistent-page-id")
    expect(found).toBeUndefined()
  })

  test("getPage returns the matched page", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-get",
      directory: "/tmp/get-test",
      sessionID: "ses-get",
    }

    const driver = createTestDriver(mod!)
    const created = await driver.newPage(owner, "https://example.com")
    const pageID = (created as any)._synergyPageID as string
    const found = driver.getPage(owner, pageID)

    expect(found).not.toBeUndefined()
    expect(found).toBe(created)
  })

  test("closePage(owner, pageID) removes the page", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-close",
      directory: "/tmp/close-test",
      sessionID: "ses-close",
    }

    const driver = createTestDriver(mod!)
    const created = await driver.newPage(owner, "https://example.com")
    const pageID = (created as any)._synergyPageID as string

    // Page exists before close
    expect(driver.getPage(owner, pageID)).not.toBeUndefined()

    await driver.closePage(owner, pageID)

    // Page is gone after close
    expect(driver.getPage(owner, pageID)).toBeUndefined()
  })

  test("closePage is idempotent for non-existent pageID", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-close2",
      directory: "/tmp/close2-test",
      sessionID: "ses-close2",
    }

    const driver = createTestDriver(mod!)
    // Should not throw
    await driver.closePage(owner, "nonexistent-page-id")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Part E — PlaywrightBrowserDriver owner listing (RED)
// ═══════════════════════════════════════════════════════════════════════════

describe("PlaywrightBrowserDriver owner listing (RED)", () => {
  test("listOwners() returns array of active BrowserOwner.Info", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-list",
      directory: "/tmp/list-test",
      sessionID: "ses-list",
    }

    const driver = createTestDriver(mod!)

    // Initially empty
    const empty = driver.listOwners() as BrowserOwner.Info[]
    expect(Array.isArray(empty)).toBe(true)

    // After creating a context, the owner appears
    await driver.contextFor(owner)
    const withOwner = driver.listOwners() as BrowserOwner.Info[]
    expect(withOwner.some((o: BrowserOwner.Info) => BrowserOwner.key(o) === BrowserOwner.key(owner))).toBe(true)
  })

  test("listOwners() does not return duplicate entries for same owner", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-dup",
      directory: "/tmp/dup-test",
      sessionID: "ses-dup",
    }

    const driver = createTestDriver(mod!)
    await driver.contextFor(owner)
    await driver.contextFor(owner) // second call reuses context
    await driver.newPage(owner, "https://a.com")
    await driver.newPage(owner, "https://b.com")

    const owners = driver.listOwners() as BrowserOwner.Info[]
    const keys = owners.map((o: BrowserOwner.Info) => BrowserOwner.key(o))
    // owner should appear exactly once
    expect(keys.filter((k: string) => k === BrowserOwner.key(owner))).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Part F — PlaywrightBrowserDriver ensure/stop lifecycle (RED)
// ═══════════════════════════════════════════════════════════════════════════

describe("PlaywrightBrowserDriver ensure/stop lifecycle (RED)", () => {
  test("ensure() initializes the browser and returns DriverState", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const driver = createTestDriver(mod!)
    const state = await driver.ensure()

    expect(state).toHaveProperty("running")
    expect(state.running).toBe(true)
    expect(state).toHaveProperty("browserType")
    expect(state).toHaveProperty("activeOwners")
    expect(typeof state.activeOwners).toBe("number")
  })

  test("ensure() is idempotent", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const driver = createTestDriver(mod!)
    const state1 = await driver.ensure()
    const state2 = await driver.ensure()

    // Both calls succeed
    expect(state1.running).toBe(true)
    expect(state2.running).toBe(true)
  })

  test("stop() shuts down the browser", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const driver = createTestDriver(mod!)
    await driver.ensure()
    await driver.stop()

    // After stop, ensure should succeed again (new browser)
    const state = await driver.ensure()
    expect(state.running).toBe(true)
  })

  test("stop() clears active owners", async () => {
    const mod = await importFresh("../../src/browser/playwright-driver.js")
    expect(mod).not.toBeNull()
    expect(mod!.PlaywrightBrowserDriver).toBeDefined()

    const owner: BrowserOwner.Info = {
      mode: "session",
      scopeID: "scope-stop",
      directory: "/tmp/stop-test",
      sessionID: "ses-stop",
    }

    const driver = createTestDriver(mod!)
    await driver.ensure()
    await driver.contextFor(owner)

    expect(driver.listOwners().length).toBeGreaterThan(0)

    await driver.stop()
    expect(driver.listOwners().length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Part G — Clean architecture: no CdpClient import (RED)
//  The Playwright driver must NOT import from cdp.js — it uses
//  playwright-core's own protocol handling. These tests wait for
//  the source files to exist, then verify no CDP references.
// ═══════════════════════════════════════════════════════════════════════════

describe("playwright-driver.ts — no CdpClient import (RED)", () => {
  test("playwright-driver.ts does not import from cdp.js", () => {
    // RED: Once playwright-driver.ts exists, it must NOT import CdpClient
    // from cdp.js. The whole point of the Playwright driver is to use
    // playwright-core's browser automation instead of raw CDP.
    expect(existsSync(PLAYWRIGHT_DRIVER_PATH)).toBe(true)
    const src = readFileSync(PLAYWRIGHT_DRIVER_PATH, "utf-8")
    expect(src).not.toMatch(/from\s+["'].*cdp\.js["']/)
    expect(src).not.toMatch(/from\s+["'].*cdp["']/)
    expect(src).not.toMatch(/import.*CdpClient/)
  })

  test("driver.ts does not import from cdp.js", () => {
    // RED: The abstract BrowserDriver interface module should also be free
    // of CdpClient imports — it's a pure type/interface module.
    expect(existsSync(DRIVER_PATH)).toBe(true)
    const src = readFileSync(DRIVER_PATH, "utf-8")
    expect(src).not.toMatch(/from\s+["'].*cdp\.js["']/)
    expect(src).not.toMatch(/from\s+["'].*cdp["']/)
    expect(src).not.toMatch(/import.*CdpClient/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Try to dynamically import a module. Returns null if the module doesn't
 * exist yet (RED state). The calling test should assert non-null first.
 */
async function importFresh(modulePath: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(modulePath)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Read source text from a file. Returns empty string if the file doesn't
 * exist (RED state) so tests fail with clear assertion messages.
 */
function readSource(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}
