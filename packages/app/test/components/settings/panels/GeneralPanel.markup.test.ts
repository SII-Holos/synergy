import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("GeneralPanel toast mute markup", () => {
  test("does not nest Kobalte Switch inside a native label", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/GeneralPanel.tsx"),
      "utf8",
    )
    expect(source).toContain('<div class="settings-muted-toggle">')
    expect(source).not.toMatch(/<label class="settings-muted-toggle">/)
    expect(source).toContain("setToastConfig")
    expect(source).toContain("toastConfigFromPreferences")
    expect(source).toContain("nextMutedToasts")
  })
})
