import { describe, expect, test } from "bun:test"
import { shouldRefreshGlobalConfig } from "../../src/context/global-config-sync"

describe("global config snapshot refresh", () => {
  test("refreshes the global authority for global client-side field updates", () => {
    for (const field of ["locale", "theme", "keybinds", "layout", "toast", "defaultSessionWorkspace"]) {
      expect(
        shouldRefreshGlobalConfig({
          scope: "global",
          changedFields: [field],
        }),
      ).toBe(true)
    }
  })

  test("ignores server-side global config fields", () => {
    expect(
      shouldRefreshGlobalConfig({
        scope: "global",
        changedFields: ["model"],
      }),
    ).toBe(false)
    expect(
      shouldRefreshGlobalConfig({
        scope: "global",
        changedFields: ["toast", "model"],
      }),
    ).toBe(false)
  })

  test("keeps project config updates out of the global authority", () => {
    expect(
      shouldRefreshGlobalConfig({
        scope: "project",
        changedFields: ["locale"],
      }),
    ).toBe(false)
  })
})
