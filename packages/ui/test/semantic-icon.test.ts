import { describe, expect, test } from "bun:test"
import { getSemanticIcon, SemanticIconToken } from "../src/components/semantic-icon"

const allowedDuplicateIcons: Record<string, string[]> = {
  "arrow-left": ["navigation.back", "browser.back", "account.logout"],
  "arrow-right": ["navigation.forward", "browser.forward"],
  "book-open": ["settings.learning", "perf.library"],
  braces: ["connection.lsp", "settings.lsp"],
  cable: ["connection.mcp", "settings.mcp"],
  circle: ["session.idle", "state.empty"],
  copy: ["action.copy", "window.restore"],
  "file-text": ["command.init", "settings.instructions"],
  gauge: ["settings.usage", "perf.vitals"],
  github: ["settings.github", "account.repository"],
  globe: ["settings.channels", "browser.main"],
  "hard-drive": ["perf.memory", "perf.storage"],
  "help-circle": ["action.info", "session.waiting", "settings.questions"],
  "git-merge": ["command.commit", "orchestration.holos-branch"],
  mail: ["session.inbox", "settings.email"],
  "notebook-pen": ["command.note", "notes.main"],
  "octagon-alert": ["session.retry", "state.warning"],
  "panel-bottom": ["app.bottomSpace", "app.statusBar"],
  radar: ["settings.performance", "perf.dashboard"],
  "refresh-ccw": ["action.refresh", "browser.refresh"],
  route: ["orchestration.dag", "perf.timeline", "perf.trace", "perf.routes"],
  satellite: ["connection.holos", "settings.holos"],
  "square-pen": ["notes.create", "session.new"],
  sun: ["settings.appearance", "settings.colorLight"],
  x: ["action.close", "window.close"],
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
