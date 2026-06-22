import { describe, test, expect } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"

// ── Constants ───────────────────────────────────────────────────

const BROWSER_SRC = path.join(import.meta.dirname ?? __dirname, "../../src/browser")
const PKG_JSON = path.join(import.meta.dirname ?? __dirname, "../../package.json")

// ── CDP staleness enforcement ───────────────────────────────────
// After Playwright migration, the hand-rolled CDP layer must be
// removed and no source file may reference stale CDP primitives.

const CDP_FILE = path.join(BROWSER_SRC, "cdp.ts")

const BANNED_TOKENS = [
  "CdpClient",
  "Target.createTarget",
  "Target.attachToTarget",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Page.captureScreenshot",
  "buildCdpCommands",
  "CDPCommand",
] as const

describe("playwright cleanup: cdp.ts removal", () => {
  test("cdp.ts does not exist in src/browser/", () => {
    expect(existsSync(CDP_FILE)).toBe(false)
  })
})

describe("playwright cleanup: banned CDP tokens", () => {
  const browserFiles = readdirSync(BROWSER_SRC).filter((f) => f.endsWith(".ts"))

  // ── Per-file: no banned tokens ──────────────────────────────
  for (const file of browserFiles) {
    for (const token of BANNED_TOKENS) {
      test(`${file} does not contain "${token}"`, () => {
        const content = readFileSync(path.join(BROWSER_SRC, file), "utf-8")
        expect(content).not.toContain(token)
      })
    }
  }
})

// ── Runtime.evaluate scoping ────────────────────────────────────
// After migration, Runtime.evaluate must live ONLY in eval.ts for
// the readonly eval bridge. It must not appear in actions.ts,
// tab.ts, or any other browser module.

describe("playwright cleanup: Runtime.evaluate scoping", () => {
  const runtimeEvalFiles = browserFiles().filter((f) => f !== "eval.ts")

  for (const file of runtimeEvalFiles) {
    test(`${file} does not contain Runtime.evaluate`, () => {
      const content = readFileSync(path.join(BROWSER_SRC, file), "utf-8")
      expect(content).not.toContain("Runtime.evaluate")
    })
  }
})

// ── Dependency enforcement ──────────────────────────────────────
// playwright-core must be a declared dependency.

describe("playwright cleanup: dependency", () => {
  test("playwright-core exists in package.json dependencies", () => {
    const raw = readFileSync(PKG_JSON, "utf-8")
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies).toBeDefined()
    expect(Object.keys(pkg.dependencies!)).toContain("playwright-core")
  })
})

// ── helpers ─────────────────────────────────────────────────────

function browserFiles(): string[] {
  return readdirSync(BROWSER_SRC).filter((f) => f.endsWith(".ts"))
}
