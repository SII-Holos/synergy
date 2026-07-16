import { describe, expect, test } from "bun:test"
import "../src/plugin/builtin-icons"
import { hasIcon } from "../src/plugin/icon-registry"
import { getSemanticIcon, SemanticIconToken } from "../src/components/semantic-icon"

const CLARUS_PRODUCT_TOKENS = ["clarus.main", "clarus.project", "clarus.task"] as const

const CLARUS_STATUS_TOKENS = [
  "clarus.status.disabled",
  "clarus.status.connected",
  "clarus.status.reconnecting",
  "clarus.status.sign_in_required",
  "clarus.status.sync_failed",
] as const

const CLARUS_TOKENS = [...CLARUS_PRODUCT_TOKENS, ...CLARUS_STATUS_TOKENS] as const

describe("Clarus semantic icons", () => {
  test("every Clarus semantic token is listed in the SemanticIconToken catalog", () => {
    const missing: string[] = []
    for (const token of CLARUS_TOKENS) {
      if (!(token in SemanticIconToken)) {
        missing.push(token)
      }
    }
    expect(missing).toEqual([])
  })

  test("every Clarus semantic token resolves to a non-empty icon glyph", () => {
    for (const token of CLARUS_TOKENS) {
      const icon = getSemanticIcon(token)
      expect(icon).toBeString()
      expect(icon.length).toBeGreaterThan(0)
    }
  })

  test("every Clarus semantic token glyph is a registered built-in icon", () => {
    const missing: string[] = []
    for (const token of CLARUS_TOKENS) {
      const icon = getSemanticIcon(token)
      if (!hasIcon(icon)) missing.push(`${token}: ${icon}`)
    }
    expect(missing).toEqual([])
  })

  test("clarus.main does not reuse an icon glyph assigned to another product entity", () => {
    const clarusIcon = getSemanticIcon("clarus.main")
    const productTokens = [
      "agenda.main",
      "library.main",
      "performance.main",
      "plugins.main",
      "browser.main",
      "terminal.main",
      "workspace.main",
      "blueprint.main",
      "dag.main",
      "holos.main",
      "mcp.main",
      "cortex.main",
      "notes.main",
      "memory.main",
      "agents.main",
    ] as const
    for (const token of productTokens) {
      expect(getSemanticIcon(token)).not.toBe(clarusIcon)
    }
  })

  test("no two Clarus semantic tokens map to the same Lucide glyph", () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const token of CLARUS_TOKENS) {
      const icon = getSemanticIcon(token)
      const existing = seen.get(icon)
      if (existing) {
        duplicates.push(`${icon}: ${existing}, ${token}`)
      } else {
        seen.set(icon, token)
      }
    }
    expect(duplicates).toEqual([])
  })

  test("Clarus product icon tokens exist and resolve distinctly from status tokens", () => {
    for (const token of CLARUS_PRODUCT_TOKENS) {
      expect(token in SemanticIconToken).toBe(true)
    }
    const productIcons = CLARUS_PRODUCT_TOKENS.map((t) => getSemanticIcon(t))
    const statusIcons = CLARUS_STATUS_TOKENS.map((t) => getSemanticIcon(t))
    for (const pIcon of productIcons) {
      expect(statusIcons).not.toContain(pIcon)
    }
  })

  test("exactly five Clarus status states cover the public connection contract", () => {
    expect(CLARUS_STATUS_TOKENS.length).toBe(5)

    const icons = new Set(CLARUS_STATUS_TOKENS.map((t) => getSemanticIcon(t)))
    // Every status state must have a distinct icon glyph
    expect(icons.size).toBe(5)
  })

  test("clarus.main token exists and resolves to a non-empty icon glyph", () => {
    const mainIcon = getSemanticIcon("clarus.main")
    expect(mainIcon).toBeString()
    expect(mainIcon.length).toBeGreaterThan(0)

    const statusIcons = CLARUS_STATUS_TOKENS.map((t) => getSemanticIcon(t))
    expect(statusIcons).not.toContain(mainIcon)
  })
})
