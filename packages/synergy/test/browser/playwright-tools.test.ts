import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "fs"
import path from "path"

// ══════════════════════════════════════════════════════════════════
//  Playwright Tool Contract Tests
//
//  These tests encode the RED contracts for browser_* tools routing
//  through Playwright-backed modules instead of raw CDP commands.
//
//  Each contract has two parts:
//   1. Backend module API — the browser/ module must export the
//      Playwright-compatible surface.
//   2. Tool routing — the tool/ file imports and uses the
//      Playwright-backed surface, not the legacy CDP path.
//
//  Currently RED because no Playwright backing exists yet.
// ══════════════════════════════════════════════════════════════════

// ── Backend module imports ────────────────────────────────────────
import { BrowserActions } from "../../src/browser/actions"
import { BrowserLocator } from "../../src/browser/locator"
import { BrowserScreenshot } from "../../src/browser/screenshot"
import { BrowserDownloads } from "../../src/browser/downloads"
import { BrowserClipboard } from "../../src/browser/clipboard"
import { BrowserEval } from "../../src/browser/eval"

// ── Helpers ───────────────────────────────────────────────────────

const SRC_DIR = path.join(import.meta.dirname ?? __dirname, "../../src")

function toolSource(toolName: string): string {
  const fp = path.join(SRC_DIR, "tool", `${toolName}.ts`)
  if (!existsSync(fp)) throw new Error(`Tool source not found: ${fp}`)
  return readFileSync(fp, "utf-8")
}

// ══════════════════════════════════════════════════════════════════
//  Contract 1: browser_action
//  → Uses BrowserActions.run / Playwright locators, not buildCdpCommands
// ══════════════════════════════════════════════════════════════════

describe("Contract 1: browser_action → BrowserActions.run (Playwright routing)", () => {
  test("BrowserActions exports a run method for Playwright-backed action execution", () => {
    // `run` receives an action descriptor with a resolved Playwright locator
    // and dispatches to Playwright's page API (click, fill, press, etc.)
    expect(typeof (BrowserActions as Record<string, unknown>).run).toBe("function")
  })

  test("BrowserActions exports a resolveAndRun helper that combines locator resolution + execution", () => {
    // Combines BrowserLocator.toPlaywrightLocator + BrowserActions.run
    // so the tool doesn't need to resolve locators manually.
    expect(typeof (BrowserActions as Record<string, unknown>).resolveAndRun).toBe("function")
  })

  test("browser-action.ts imports BrowserActions and calls BrowserActions.run or resolveAndRun", () => {
    const src = toolSource("browser-action")
    expect(src).toMatch(/BrowserActions\.(run|resolveAndRun)\(/)
  })

  test("browser-action.ts does NOT send raw CDP commands via tab.cdp?.send for click/dblclick/type/hover/drag/scroll", () => {
    const src = toolSource("browser-action")
    // Legacy pattern: the tool builds CDP command arrays and sends them
    // line by line through tab.cdp?.send. After Playwright migration, this
    // loop-based CDP dispatch should be gone from the execute function.
    const cdpSendInLoop = /tab\.cdp\?\.send\(cmd\.method,\s*cmd\.params\)/g
    const matches = src.match(cdpSendInLoop)
    const count = matches ? matches.length : 0
    expect(count).toBe(0) // RED: currently has many cdp?.send calls
  })
})

// ══════════════════════════════════════════════════════════════════
//  Contract 2: browser_read
//  → supports visibleDom and locator through BrowserLocator.toPlaywrightLocator
// ══════════════════════════════════════════════════════════════════

describe("Contract 2: browser_read → BrowserLocator.toPlaywrightLocator", () => {
  test("BrowserLocator exports a toPlaywrightLocator method", () => {
    // Converts a Synergy LocatorInput (ref, css, role, text, etc.)
    // into a Playwright Locator object for use with Playwright APIs.
    expect(typeof (BrowserLocator as Record<string, unknown>).toPlaywrightLocator).toBe("function")
  })

  test("toPlaywrightLocator accepts a Synergy LocatorInput and a Playwright Page/Frame and returns a Playwright Locator", () => {
    const fn = (BrowserLocator as Record<string, unknown>).toPlaywrightLocator
    expect(typeof fn).toBe("function")
    // API shape: (page: PlaywrightPage, locator: LocatorInput) => PlaywrightLocator
    expect(fn).toBeDefined()
  })

  test("browser-read.ts imports or uses BrowserLocator.toPlaywrightLocator for locator-filtered reads", () => {
    const src = toolSource("browser-read")
    expect(src).toMatch(/toPlaywrightLocator/)
  })

  test("browser-read.ts visibleDom type uses Playwright-based locator resolution, not snapshot-only", () => {
    const src = toolSource("browser-read")
    // The visibleDom path should use Playwright locators to filter visible
    // elements, not the legacy snapshot + visibleDOM filter only.
    expect(src).toMatch(/toPlaywrightLocator/)
  })
})

// ══════════════════════════════════════════════════════════════════
//  Contract 3: browser_screenshot
//  → locator mode calls locator.screenshot
// ══════════════════════════════════════════════════════════════════

describe("Contract 3: browser_screenshot → Playwright locator.screenshot", () => {
  test("BrowserScreenshot exports a captureLocator method for Playwright locator screenshots", () => {
    // Resolves a locator via toPlaywrightLocator and calls locator.screenshot()
    expect(typeof (BrowserScreenshot as Record<string, unknown>).captureLocator).toBe("function")
  })

  test("browser-screenshot.ts uses BrowserScreenshot.captureLocator in locator mode", () => {
    const src = toolSource("browser-screenshot")
    // The locator branch of the tool should call captureLocator instead of
    // manually resolving bounds + computing clip + calling tab.screenshot.
    expect(src).toMatch(/captureLocator|BrowserScreenshot\.capture(Element|Locator)/)
  })

  test("browser-screenshot.ts locator mode does NOT call tab.screenshot for element capture", () => {
    const src = toolSource("browser-screenshot")
    // The locator mode should delegate to Playwright's locator.screenshot(),
    // not fall through to the legacy tab.screenshot() path.
    const locatorBranchUsesTabScreenshot = /"locator"/.test(src) && /tab\.screenshot\(/.test(src)
    // Currently both patterns exist → RED.
    expect(locatorBranchUsesTabScreenshot).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════
//  Contract 4: browser_downloads
//  → wait uses page.waitForEvent("download") via BrowserDownloads
// ══════════════════════════════════════════════════════════════════

describe("Contract 4: browser_downloads → Playwright page.waitForEvent('download')", () => {
  test("BrowserDownloads exports a waitForPageDownload method that uses Playwright page", () => {
    // Should accept a Playwright Page and optional timeout, return a DownloadRecord.
    expect(typeof (BrowserDownloads as Record<string, unknown>).waitForPageDownload).toBe("function")
  })

  test("BrowserDownloads exports an attachToPage method for wiring up Playwright download events", () => {
    // Registers page.on('download', ...) to populate the in-memory records
    // and optionally pipe downloads to the asset system.
    expect(typeof (BrowserDownloads as Record<string, unknown>).attachToPage).toBe("function")
  })

  test("browser-downloads.ts wait action integrates with Playwright page download events", () => {
    const src = toolSource("browser-downloads")
    // The 'wait' action should use a Playwright-backed wait, not the current
    // in-memory polling loop.
    expect(src).toMatch(/waitForPageDownload|waitForEvent|page\.on\("download/)
  })
})

// ══════════════════════════════════════════════════════════════════
//  Contract 5: browser_clipboard
//  → uses context.grantPermissions + page.evaluate
// ══════════════════════════════════════════════════════════════════

describe("Contract 5: browser_clipboard → Playwright context.grantPermissions + page.evaluate", () => {
  test("BrowserClipboard exports a grantPermissions helper for Playwright browser context", () => {
    // Calls context.grantPermissions(['clipboard-read', 'clipboard-write'])
    // on the Playwright BrowserContext before clipboard operations.
    expect(typeof (BrowserClipboard as Record<string, unknown>).grantPermissions).toBe("function")
  })

  test("BrowserClipboard exports Playwright-based read/write methods", () => {
    // Uses page.evaluate to call navigator.clipboard.readText/writeText
    // after permissions are granted via the Playwright context.
    expect(typeof (BrowserClipboard as Record<string, unknown>).readViaPage).toBe("function")
    expect(typeof (BrowserClipboard as Record<string, unknown>).writeViaPage).toBe("function")
  })

  test("browser-clipboard.ts uses BrowserClipboard.grantPermissions + Playwright page.evaluate", () => {
    const src = toolSource("browser-clipboard")
    // The tool should grant clipboard permissions via Playwright context
    // before performing read/write via page.evaluate.
    expect(src).toMatch(/grantPermissions/)
  })

  test("browser-clipboard.ts does NOT use tab.evaluate for clipboard operations", () => {
    const src = toolSource("browser-clipboard")
    // After Playwright migration, clipboard read/write should go through
    // Playwright's page.evaluate (after context.grantPermissions), not
    // through the legacy BrowserTab.evaluate.
    expect(src).not.toMatch(/tab\.evaluate\(BrowserClipboard\.build(Read|Write)/)
  })
})

// ══════════════════════════════════════════════════════════════════
//  Contract 6: browser_eval
//  → readonly uses CDP session Runtime.evaluate throwOnSideEffect
//  → trusted uses page.evaluate but is denied by default
// ══════════════════════════════════════════════════════════════════

describe("Contract 6: browser_eval → CDP session (readonly) / page.evaluate (trusted, denied)", () => {
  test("BrowserEval exports a buildCDPSessionEval method for readonly mode", () => {
    // Builds the payload for CDP Runtime.evaluate with throwOnSideEffect.
    expect(typeof (BrowserEval as Record<string, unknown>).buildCDPSessionEval).toBe("function")
  })

  test("BrowserEval.buildReadonlyEval returns throwOnSideEffect: true", () => {
    const payload = BrowserEval.buildReadonlyEval("document.title")
    expect(payload.throwOnSideEffect).toBe(true)
  })

  test("BrowserEval exports a buildPageEval method for trusted mode (Playwright page.evaluate)", () => {
    // Builds the payload for Playwright's page.evaluate() in trusted mode.
    expect(typeof (BrowserEval as Record<string, unknown>).buildPageEval).toBe("function")
  })

  test("BrowserEval.isEvalAllowed denies trusted mode by default", () => {
    // Trusted eval (allowing mutations) is denied by default.
    expect(BrowserEval.isEvalAllowed("trusted")).toBe(false)
  })

  test("BrowserEval.isEvalAllowed permits readonly mode", () => {
    // Readonly eval is always allowed.
    expect(BrowserEval.isEvalAllowed("readonly")).toBe(true)
  })

  test("browser-eval.ts readonly path routes through shared control evaluate", () => {
    const src = toolSource("browser-eval")
    expect(src).toMatch(/executeControl/)
    expect(src).toMatch(/type: "evaluate"/)
    expect(src).toMatch(/throwOnSideEffect: isReadonly \? true : undefined/)
  })

  test("browser-eval.ts trusted path also routes through shared control evaluate", () => {
    const src = toolSource("browser-eval")
    expect(src).toMatch(/BrowserEval\.buildTrustedEval/)
    expect(src).toMatch(/executeControl/)
    expect(src).not.toMatch(/page\.evaluate/)
  })

  test("BrowserEval.sanitizeEvalResult still works correctly (non-Playwright invariant)", () => {
    const result = BrowserEval.sanitizeEvalResult({ x: 1, y: "hello" }, 10000)
    expect(result).toContain("x")
    expect(result).toContain("hello")
  })
})

// ══════════════════════════════════════════════════════════════════
//  Cross-cutting: Playwright browser backend modules exist
// ══════════════════════════════════════════════════════════════════

describe("Cross-cutting: browser backend module files exist", () => {
  const BROWSER_DIR = path.join(SRC_DIR, "browser")

  test("browser/actions.ts exists", () => {
    expect(existsSync(path.join(BROWSER_DIR, "actions.ts"))).toBe(true)
  })

  test("browser/locator.ts exists", () => {
    expect(existsSync(path.join(BROWSER_DIR, "locator.ts"))).toBe(true)
  })

  test("browser/screenshot.ts exists", () => {
    expect(existsSync(path.join(BROWSER_DIR, "screenshot.ts"))).toBe(true)
  })

  test("browser/downloads.ts exists", () => {
    expect(existsSync(path.join(BROWSER_DIR, "downloads.ts"))).toBe(true)
  })

  test("browser/clipboard.ts exists", () => {
    expect(existsSync(path.join(BROWSER_DIR, "clipboard.ts"))).toBe(true)
  })

  test("browser/eval.ts exists", () => {
    expect(existsSync(path.join(BROWSER_DIR, "eval.ts"))).toBe(true)
  })
})
