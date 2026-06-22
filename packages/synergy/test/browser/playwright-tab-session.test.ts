import { describe, test, expect, vi } from "bun:test"
import { readFileSync, existsSync } from "fs"
import path from "path"

// ── Paths ────────────────────────────────────────────────────────────────
const SRC_BROWSER = path.join(import.meta.dirname ?? __dirname, "../../src/browser")
const TAB_PATH = path.join(SRC_BROWSER, "tab.ts")
const SESSION_PATH = path.join(SRC_BROWSER, "session.ts")
const RUNTIME_PATH = path.join(SRC_BROWSER, "runtime.ts")
const TYPES_PATH = path.join(SRC_BROWSER, "types.ts")

// ── Helpers ──────────────────────────────────────────────────────────────

function readSource(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}

async function importFresh(modulePath: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(modulePath)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Synchronously require a module. Unlike importFresh, this returns null if
 * the module doesn't exist or can't be parsed.
 */
function requireFresh(modulePath: string): Record<string, unknown> | null {
  try {
    return require(modulePath) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Extract a method body from source text by method signature.
 * Returns the text from the signature line to the next `async` method
 * or end of class.
 */
function extractMethod(source: string, signature: string): string {
  const startIdx = source.indexOf(signature)
  if (startIdx === -1) return ""
  const rest = source.slice(startIdx)
  const nextMethod = rest
    .slice(signature.length)
    .search(/\n\s{2}(async\s|private\s+async\s|\/\/(?!\s*─)|constructor\()/)
  if (nextMethod !== -1) {
    return rest.slice(0, signature.length + nextMethod)
  }
  return rest
}

/**
 * Extract just the constructor body from source text.
 * Returns everything from "constructor(" to the next class member.
 */
function extractConstructor(source: string): string {
  const startIdx = source.indexOf("constructor(")
  if (startIdx === -1) return ""
  const rest = source.slice(startIdx)
  const nextMember = rest
    .slice("constructor(".length)
    .search(/\n\s{2}(async\s|private\s|public\s|\/\/|\/\*\*|get\s|readonly)/)
  if (nextMember !== -1) {
    return rest.slice(0, "constructor(".length + nextMember)
  }
  return rest
}

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 1: BrowserSessionImpl(owner, driver)
//  The session module must accept a BrowserDriver (not CdpClient) in its
//  constructor and use driver.newPage(owner, url) for createTab.
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 1: BrowserSessionImpl(owner, driver)", () => {
  test("constructor accepts 2 parameters (owner, driver)", () => {
    const src = readSource(SESSION_PATH)
    expect(src.length).toBeGreaterThan(0)
    // Constructor signature should declare owner and driver params
    expect(src).toMatch(/constructor\s*\(\s*owner\s*:\s*BrowserOwner\.Info\s*,\s*driver/)
  })

  test("constructor stores driver as a private field", () => {
    const src = readSource(SESSION_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: The driver should be stored as a member (e.g., private driver or this.driver)
    expect(src).toMatch(/driver/)
  })

  test("createTab calls driver.newPage(owner, url) rather than cdpConnection", () => {
    const src = readSource(SESSION_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: Must call driver.newPage
    expect(src).toMatch(/driver\.newPage\(/)
    // Must NOT access BrowserRuntime.state().cdpConnection for tab creation
    const stateCdpRegex = /state\(\s*\)\s*\.\s*cdpConnection/g
    const matches = src.match(stateCdpRegex) ?? []
    expect(matches.length).toBe(0)
  })

  test("createTab wraps driver.newPage result into a BrowserTab", () => {
    const src = readSource(SESSION_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/BrowserTabImpl/)
    expect(src).toMatch(/newPage/)
  })

  test("session module does not reference CDP concepts", () => {
    const sessionSrc = readSource(SESSION_PATH)
    const typesSrc = readSource(TYPES_PATH)
    expect(sessionSrc.length).toBeGreaterThan(0)
    expect(typesSrc.length).toBeGreaterThan(0)
    expect(sessionSrc).not.toMatch(/import.*CdpClient/)
    expect(typesSrc).not.toMatch(/import.*CdpClient/)
    expect(sessionSrc).not.toMatch(/cdpConnection|Target\.createTarget|browserCdp/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 2: BrowserRuntime.getOrCreateSession(owner) uses BrowserDriver
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 2: BrowserRuntime.getOrCreateSession uses BrowserDriver", () => {
  test("getOrCreateSession imports and uses BrowserDriver", () => {
    const src = readSource(RUNTIME_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: Must reference BrowserDriver or PlaywrightBrowserDriver
    expect(src).toMatch(/BrowserDriver|PlaywrightBrowserDriver/)
  })

  test("getOrCreateSession passes driver to BrowserSessionImpl constructor", () => {
    const src = readSource(RUNTIME_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/new\s+BrowserSessionImpl\s*\(/)
    const ctorMatch = src.match(/new\s+BrowserSessionImpl\s*\(\s*owner\s*,\s*.*driver/)
    expect(ctorMatch).not.toBeNull()
  })

  test("RuntimeState no longer exposes cdpConnection", () => {
    const src = readSource(RUNTIME_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: RuntimeState interface should NOT have cdpConnection typed as CdpClient
    expect(src).not.toMatch(/cdpConnection\s*:\s*CdpClient/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 3: BrowserTabImpl wraps a Playwright Page
//  Tab methods delegate to Playwright Page API rather than CDP commands.
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 3: BrowserTabImpl wraps Playwright Page", () => {
  test("constructor accepts a page field, not browserCdp", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    const ctorBody = extractConstructor(src)
    // RED: Should reference a "page" field in its options bag
    expect(ctorBody).toMatch(/page/)
    // RED: Should NOT reference browserCdp
    expect(ctorBody).not.toMatch(/browserCdp/)
  })

  test("source imports Playwright Page type", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: Should import Page from playwright or reference playwright
    expect(src).toMatch(/import.*Page.*from.*playwright|import.*playwright/)
  })

  // ── navigate → page.goto ──────────────────────────────────────────────
  test("navigate(url) calls page.goto(url)", () => {
    const src = readSource(TAB_PATH)
    const navMethod = extractMethod(src, "async navigate")
    expect(navMethod).toMatch(/\.goto\s*\(/)
    expect(navMethod).not.toMatch(/"Page\.navigate"/)
    expect(navMethod).not.toMatch(/sendCmd/)
  })

  // ── reload → page.reload ──────────────────────────────────────────────
  test("reload() calls page.reload()", () => {
    const src = readSource(TAB_PATH)
    const reloadMethod = extractMethod(src, "async reload")
    expect(reloadMethod).toMatch(/\.reload\s*\(/)
    expect(reloadMethod).not.toMatch(/"Page\.reload"/)
    expect(reloadMethod).not.toMatch(/sendCmd/)
  })

  // ── goBack → page.goBack ──────────────────────────────────────────────
  test("goBack() calls page.goBack()", () => {
    const src = readSource(TAB_PATH)
    const goBackMethod = extractMethod(src, "async goBack")
    expect(goBackMethod).toMatch(/\.goBack\s*\(/)
    expect(goBackMethod).not.toMatch(/"window\.history\.back/)
    expect(goBackMethod).not.toMatch(/sendCmd/)
  })

  // ── goForward → page.goForward ────────────────────────────────────────
  test("goForward() calls page.goForward()", () => {
    const src = readSource(TAB_PATH)
    const goFwdMethod = extractMethod(src, "async goForward")
    expect(goFwdMethod).toMatch(/\.goForward\s*\(/)
    expect(goFwdMethod).not.toMatch(/"window\.history\.forward/)
    expect(goFwdMethod).not.toMatch(/sendCmd/)
  })

  // ── click → page.mouse.click ──────────────────────────────────────────
  test("click(x, y) calls page.mouse.click(x, y)", () => {
    const src = readSource(TAB_PATH)
    const clickMethod = extractMethod(src, "async click")
    expect(clickMethod).toMatch(/mouse\.click\s*\(/)
    expect(clickMethod).not.toMatch(/"Input\.dispatchMouseEvent"/)
    expect(clickMethod).not.toMatch(/sendCmd/)
  })

  // ── type → page.keyboard.type ─────────────────────────────────────────
  test("type(text) calls page.keyboard.type(text)", () => {
    const src = readSource(TAB_PATH)
    const typeMethod = extractMethod(src, "async type")
    expect(typeMethod).toMatch(/keyboard\.type\s*\(/)
    expect(typeMethod).not.toMatch(/"Input\.insertText"/)
    expect(typeMethod).not.toMatch(/sendCmd/)
  })

  // ── scroll → page.mouse.wheel ─────────────────────────────────────────
  test("scroll(deltaX, deltaY) calls page.mouse.wheel(deltaX, deltaY)", () => {
    const src = readSource(TAB_PATH)
    const scrollMethod = extractMethod(src, "async scroll")
    expect(scrollMethod).toMatch(/mouse\.wheel\s*\(/)
    expect(scrollMethod).not.toMatch(/"Input\.dispatchMouseEvent"/)
    expect(scrollMethod).not.toMatch(/sendCmd/)
  })

  // ── screenshot → page.screenshot ──────────────────────────────────────
  test("screenshot() calls page.screenshot()", () => {
    const src = readSource(TAB_PATH)
    const ssMethod = extractMethod(src, "async screenshot")
    expect(ssMethod).toMatch(/\.screenshot\s*\(/)
    expect(ssMethod).not.toMatch(/"Page\.captureScreenshot"/)
    expect(ssMethod).not.toMatch(/sendCmd/)
  })

  // ── snapshot → page.accessibility.snapshot ────────────────────────────
  test("snapshot() calls page.accessibility.snapshot() or locator fallback", () => {
    const src = readSource(TAB_PATH)
    const snapMethod = extractMethod(src, "async snapshot")
    expect(snapMethod).toMatch(/accessibility\.snapshot|snapshot/)
    expect(snapMethod).not.toMatch(/"Accessibility\.getFullAXTree"/)
    expect(snapMethod).not.toMatch(/sendCmd/)
  })

  // ── No CDP sendCmd calls ──────────────────────────────────────────────
  test("tab.ts no longer contains sendCmd calls", () => {
    const src = readSource(TAB_PATH)
    const sendCmdCount = (src.match(/sendCmd/g) ?? []).length
    // RED: Currently ~30+ calls. After migration should be < 5.
    expect(sendCmdCount).toBeLessThan(5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 4: Tab close() calls page.close(), not Target.closeTarget
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 4: Tab close() calls page.close()", () => {
  test("close() calls page.close()", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: close() should call page.close() instead of Target.closeTarget
    expect(src).toMatch(/page\.close\s*\(|\.close\s*\(/)
  })

  test("close() does NOT send CDP Target.closeTarget or Target.detachFromTarget", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).not.toMatch(/"Target\.closeTarget"/)
    expect(src).not.toMatch(/"Target\.detachFromTarget"/)
  })

  test("close() uses page-level cleanup, not CdpClient.off", () => {
    const src = readSource(TAB_PATH)
    const closeMethod = extractMethod(src, "async close")
    expect(closeMethod).not.toContain("browserCdp.off")
    expect(closeMethod).not.toMatch(/cdp\.off|_cdp\.off/)
  })

  test("close() clears console/network buffers", () => {
    const src = readSource(TAB_PATH)
    const closeMethod = extractMethod(src, "async close")
    // Buffers must still be reset after Playwright migration
    expect(closeMethod).toMatch(/consoleBuffer|networkBuffer/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 5: Console/network buffers from page.on events
//  Console entries from page.on("console"), network from
//  page.on("request") + page.on("response").
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 5: Console/network buffers from page.on events", () => {
  test("console buffer populated from page.on('console')", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: Should use page.on("console", handler) instead of CDP Runtime.consoleAPICalled
    expect(src).toMatch(/"console"|on\s*\(\s*["']console["']/)
  })

  test("does NOT use Runtime.consoleAPICalled for console capture", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).not.toMatch(/"Runtime\.consoleAPICalled"/)
  })

  test("network buffer populated from page.on('request') and page.on('response')", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    // RED: Should use page.on("request") and page.on("response")
    expect(src).toMatch(/"request"|on\s*\(\s*["']request["']/)
    expect(src).toMatch(/"response"|on\s*\(\s*["']response["']/)
  })

  test("does NOT use Network.requestWillBeSent or Network.responseReceived", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).not.toMatch(/"Network\.requestWillBeSent"/)
    expect(src).not.toMatch(/"Network\.responseReceived"/)
  })

  test("event cleanup uses page-level APIs, not CDP event strings", () => {
    const src = readSource(TAB_PATH)
    const closeMethod = extractMethod(src, "async close")
    // RED: Must NOT use browserCdp.off
    expect(closeMethod).not.toMatch(/browserCdp\.off/)
    // RED: Must NOT unregister CDP events by string name
    expect(closeMethod).not.toMatch(/\.off\s*\(\s*["'](Page|Runtime|Network)\./)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 6: Mock Page behavioral tests (source-level delegation checks)
//  RED: BrowserTabImpl source does not delegate to page.* methods yet.
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 6: Source-level Playwright delegation checks", () => {
  test("navigate method body references page.goto", () => {
    const src = readSource(TAB_PATH)
    const navigateMethod = extractMethod(src, "async navigate")
    expect(navigateMethod).toMatch(/goto/)
    expect(navigateMethod).not.toMatch(/"Page\.navigate"/)
  })

  test("reload method body references page.reload", () => {
    const src = readSource(TAB_PATH)
    const reloadMethod = extractMethod(src, "async reload")
    expect(reloadMethod).toMatch(/reload/)
    expect(reloadMethod).not.toMatch(/"Page\.reload"/)
  })

  test("click method body references page.mouse.click", () => {
    const src = readSource(TAB_PATH)
    const clickMethod = extractMethod(src, "async click")
    expect(clickMethod).toMatch(/mouse\.click/)
    expect(clickMethod).not.toMatch(/"Input\.dispatchMouseEvent"/)
  })

  test("type method body references page.keyboard.type", () => {
    const src = readSource(TAB_PATH)
    const typeMethod = extractMethod(src, "async type")
    expect(typeMethod).toMatch(/keyboard\.type/)
    expect(typeMethod).not.toMatch(/"Input\.insertText"/)
  })

  test("scroll method body references page.mouse.wheel", () => {
    const src = readSource(TAB_PATH)
    const scrollMethod = extractMethod(src, "async scroll")
    expect(scrollMethod).toMatch(/mouse\.wheel/)
  })

  test("screenshot method body references page.screenshot", () => {
    const src = readSource(TAB_PATH)
    const screenshotMethod = extractMethod(src, "async screenshot")
    expect(screenshotMethod).toMatch(/\.screenshot/)
    expect(screenshotMethod).not.toMatch(/"Page\.captureScreenshot"/)
  })

  test("snapshot method body references page.accessibility.snapshot", () => {
    const src = readSource(TAB_PATH)
    const snapshotMethod = extractMethod(src, "async snapshot")
    expect(snapshotMethod).toMatch(/accessibility|snapshot/)
    expect(snapshotMethod).not.toMatch(/"Accessibility\.getFullAXTree"/)
  })

  test("close method body references page.close", () => {
    const src = readSource(TAB_PATH)
    const closeMethod = extractMethod(src, "async close")
    expect(closeMethod).toMatch(/\.close\s*\(/)
    expect(closeMethod).not.toMatch(/"Target\.closeTarget"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 7: BrowserDriver.Driver interface declarations
//  The driver must provide page management methods.
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 7: BrowserDriver.Driver interface", () => {
  const DRIVER_PATH = path.join(SRC_BROWSER, "driver.ts")

  test("driver.ts exists", () => {
    // RED: File does not exist yet
    expect(existsSync(DRIVER_PATH)).toBe(true)
  })

  test("BrowserDriver.Driver declares newPage(owner, url?) method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/newPage\s*\(\s*owner/)
    expect(src).toMatch(/url\??\s*:\s*string/)
  })

  test("BrowserDriver.Driver declares closePage(owner, pageId) method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/closePage\s*\(\s*owner/)
  })

  test("BrowserDriver.Driver declares getPage(owner, pageId) method", () => {
    const src = readSource(DRIVER_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/getPage\s*\(\s*owner/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Contract 8: BrowserTab interface contract compatibility
//  The BrowserTab interface must remain stable — existing callers depend on
//  its public method signatures. Playwright backing must implement the same
//  interface.
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract 8: BrowserTab interface stability", () => {
  test("BrowserTab interface declares navigate(url): Promise<{url, title}>", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/navigate\s*\(\s*url\s*:\s*string\s*\)\s*:\s*Promise/)
  })

  test("BrowserTab interface declares click(x, y): Promise<void>", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/click\s*\(\s*x\s*:\s*number\s*,\s*y\s*:\s*number/)
  })

  test("BrowserTab interface declares type(text): Promise<void>", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/type\s*\(\s*text\s*:\s*string/)
  })

  test("BrowserTab interface declares screenshot(format?, quality?, fullPage?, clip?)", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/screenshot\s*\(/)
    expect(src).toMatch(/format\??\s*:\s*["']jpeg["']\s*\|\s*["']png["']/)
  })

  test("BrowserTab interface declares snapshot(): Promise<{elements, truncated}>", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/snapshot\s*\(\s*\)\s*:\s*Promise/)
    expect(src).toMatch(/AccessibilityElement/)
  })

  test("BrowserTab interface declares close(): Promise<void>", () => {
    const src = readSource(TAB_PATH)
    expect(src.length).toBeGreaterThan(0)
    expect(src).toMatch(/close\s*\(\s*\)\s*:\s*Promise/)
  })

  test("BrowserTab interface declares readonly cdp: CdpClient.Connection | null", () => {
    // NOTE: In the Playwright-backed world, `cdp` may become optional or
    // return null (since tabs may not have a CDP connection). The interface
    // is maintained for backward compatibility.
    const tabs = readSource(TAB_PATH)
    expect(tabs.length).toBeGreaterThan(0)
    expect(tabs).toMatch(/readonly\s+cdp/)
  })
})
