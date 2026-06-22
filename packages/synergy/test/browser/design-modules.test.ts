import { describe, test, expect } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"

// ── Design modules that must exist in src/browser/ ──────────────
// These modules provide reusable helper logic for browser tools.
// They should NOT be stub-only — each must export at least one
// function/type/namespace and be imported by at least one runtime
// or tool file.

const SRC_DIR = path.join(import.meta.dirname ?? __dirname, "../../src/browser")

const DESIGN_MODULES = ["screenshot.ts", "snapshot.ts", "annotation.ts", "migration.ts"] as const

// ── File existence ─────────────────────────────────────────────

describe("design modules: file existence", () => {
  for (const mod of DESIGN_MODULES) {
    test(`${mod} exists in src/browser/`, () => {
      const fullPath = path.join(SRC_DIR, mod)
      expect(existsSync(fullPath)).toBe(true)
    })
  }
})

// ── Non-stub verification ──────────────────────────────────────
// A stub module has no exports or only a placeholder comment.
// These tests verify the file has actual content.

describe("design modules: non-stub content", () => {
  for (const mod of DESIGN_MODULES) {
    test(`${mod} is not empty/stub`, () => {
      const fullPath = path.join(SRC_DIR, mod)
      if (!existsSync(fullPath)) {
        throw new Error(`${mod} does not exist at ${fullPath}`)
      }
      const text = readFileSync(fullPath, "utf-8")
      const trimmed = text.trim()
      expect(trimmed.length).toBeGreaterThan(20)
      expect(trimmed).toMatch(/export/)
    })
  }
})

// ── Import verification ────────────────────────────────────────
// Each design module must be imported by at least one runtime or
// tool file. We scan the tool and runtime directories for import
// statements referencing each module.

const TOOL_DIR = path.join(import.meta.dirname ?? __dirname, "../../src/tool")
const RUNTIME_DIR = path.join(import.meta.dirname ?? __dirname, "../../src/browser")

const CONSUMER_DIRS = [TOOL_DIR, RUNTIME_DIR]

describe("design modules: imported by runtime/tool files", () => {
  for (const mod of DESIGN_MODULES) {
    test(`${mod} is imported by at least one consumer`, () => {
      const moduleName = mod.replace(".ts", "")
      const patterns = [
        `./${moduleName}.js`,
        `./${moduleName}"`,
        `./${moduleName}'`,
        `../browser/${moduleName}.js`,
        `../browser/${moduleName}"`,
        `../browser/${moduleName}'`,
      ]

      let found = false
      let foundIn = ""

      outer: for (const dir of CONSUMER_DIRS) {
        let files: string[] = []
        try {
          files = readdirSync(dir).filter((f) => f.endsWith(".ts"))
        } catch {
          continue
        }
        for (const file of files) {
          if (file === mod) continue
          const content = readFileSync(path.join(dir, file), "utf-8")
          for (const pat of patterns) {
            if (content.includes(pat)) {
              found = true
              foundIn = file
              break outer
            }
          }
        }
      }

      expect(found).toBe(true)
      if (found && foundIn) {
        expect(foundIn).toBeTruthy()
      }
    })
  }
})

// ── Specific module contracts ──────────────────────────────────
// These tests define what each design module should expose.

describe("design modules: export contracts", () => {
  test("screenshot.ts exists and has content", async () => {
    const fp = path.join(SRC_DIR, "screenshot.ts")
    if (!existsSync(fp)) {
      // RED: module doesn't exist yet
      expect(false).toBe(true) // force RED
      return
    }
    const text = readFileSync(fp, "utf-8").trim()
    expect(text.length).toBeGreaterThan(20)
    expect(text).toMatch(/export/)
  })

  test("snapshot.ts exists and has content", async () => {
    const fp = path.join(SRC_DIR, "snapshot.ts")
    if (!existsSync(fp)) {
      expect(false).toBe(true)
      return
    }
    const text = readFileSync(fp, "utf-8").trim()
    expect(text.length).toBeGreaterThan(20)
    expect(text).toMatch(/export/)
  })

  test("annotation.ts exists and has content", async () => {
    const fp = path.join(SRC_DIR, "annotation.ts")
    if (!existsSync(fp)) {
      expect(false).toBe(true)
      return
    }
    const text = readFileSync(fp, "utf-8").trim()
    expect(text.length).toBeGreaterThan(20)
    expect(text).toMatch(/export/)
  })

  test("migration.ts exists and has content", async () => {
    const fp = path.join(SRC_DIR, "migration.ts")
    if (!existsSync(fp)) {
      expect(false).toBe(true)
      return
    }
    const text = readFileSync(fp, "utf-8").trim()
    expect(text.length).toBeGreaterThan(20)
    expect(text).toMatch(/export/)
  })
})
