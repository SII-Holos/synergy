import { describe, expect, test } from "bun:test"
import { shouldRefreshGlobalConfig } from "./global-config-sync"

describe("global config snapshot refresh", () => {
  test("refreshes the global authority for global locale updates", () => {
    expect(
      shouldRefreshGlobalConfig({
        scope: "global",
        changedFields: ["locale"],
      }),
    ).toBe(true)
  })

  test("ignores unrelated global config fields", () => {
    expect(
      shouldRefreshGlobalConfig({
        scope: "global",
        changedFields: ["theme"],
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
