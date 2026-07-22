import { describe, expect, test } from "bun:test"

const settingsCSS = await Bun.file(new URL("./settings-panel.css", import.meta.url)).text()

function ruleBody(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return settingsCSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? ""
}

describe("settings presentation contract", () => {
  test("uses the shared dialog body-padding token for the add-target layout", () => {
    expect(ruleBody(".settings-link-add-dialog")).toContain("--dialog-body-padding: 0")
  })

  test("keeps the complete model-role details reachable in short viewports", () => {
    expect(ruleBody(".settings-model-detail-surface")).toContain("overflow-y: auto")
  })
})
