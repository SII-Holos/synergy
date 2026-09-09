import { describe, expect, test } from "bun:test"
import { settingsSaveFooterStatus } from "../../../src/components/settings/settings-save-status"

describe("Settings footer save status", () => {
  test("shows a new dirty draft instead of a stale save error", () => {
    expect(
      settingsSaveFooterStatus({
        saving: false,
        dirty: true,
        resultCurrent: false,
        aggregate: "error",
        server: "error",
        personalize: "idle",
      }),
    ).toBe("dirty")
  })

  test("keeps the current draft's save error visible", () => {
    expect(
      settingsSaveFooterStatus({
        saving: false,
        dirty: true,
        resultCurrent: true,
        aggregate: "error",
        server: "error",
        personalize: "idle",
      }),
    ).toBe("error")
  })

  test("clears a stale save error after the failed draft is reverted", () => {
    expect(
      settingsSaveFooterStatus({
        saving: false,
        dirty: false,
        resultCurrent: false,
        aggregate: "error",
        server: "error",
        personalize: "idle",
      }),
    ).toBe("idle")
  })

  test("keeps an active save ahead of the dirty state", () => {
    expect(
      settingsSaveFooterStatus({
        saving: true,
        dirty: true,
        resultCurrent: true,
        aggregate: "saving",
        server: "idle",
        personalize: "idle",
      }),
    ).toBe("saving")
  })
})

test("treats personalize loading as an active save state", () => {
  expect(
    settingsSaveFooterStatus({
      saving: false,
      dirty: false,
      resultCurrent: false,
      aggregate: "idle",
      server: "idle",
      personalize: "loading",
    }),
  ).toBe("saving")
})
