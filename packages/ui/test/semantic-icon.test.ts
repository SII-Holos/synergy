import { describe, expect, test } from "bun:test"
import { getSemanticIcon, SemanticIconToken } from "../src/components/semantic-icon"

const allowedDuplicateIcons: Record<string, string[]> = {
  "arrow-left": ["navigation.back", "browser.back", "account.logout"],
  braces: ["connection.lsp", "settings.lsp"],
  cable: ["connection.mcp", "settings.mcp"],
  circle: ["session.idle", "state.empty"],
  globe: ["settings.channels", "browser.main"],
  "help-circle": ["session.waiting", "settings.questions"],
  "refresh-ccw": ["action.refresh", "browser.refresh"],
  satellite: ["connection.holos", "settings.holos"],
}

describe("semantic icons", () => {
  test("every token resolves to an icon key", () => {
    for (const token of Object.keys(SemanticIconToken) as Array<keyof typeof SemanticIconToken>) {
      expect(getSemanticIcon(token)).toBe(SemanticIconToken[token])
    }
  })

  test("blueprint uses a plan icon distinct from approval stamping", () => {
    expect(getSemanticIcon("orchestration.blueprint")).toBe("clipboard-list")
    expect(getSemanticIcon("orchestration.blueprint")).not.toBe("stamp")
  })

  test("duplicate Lucide usage is explicitly allowed", () => {
    const grouped = new Map<string, string[]>()
    for (const [token, icon] of Object.entries(SemanticIconToken)) {
      grouped.set(icon, [...(grouped.get(icon) ?? []), token])
    }

    for (const [icon, tokens] of grouped) {
      if (tokens.length <= 1) continue
      expect(tokens.sort()).toEqual((allowedDuplicateIcons[icon] ?? []).sort())
    }
  })
})
