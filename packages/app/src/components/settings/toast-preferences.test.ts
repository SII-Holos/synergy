import { describe, expect, test } from "bun:test"
import {
  nextMutedToasts,
  parseToastDurationOverrides,
  toastConfigFromPreferences,
  toastConfigFromServerToast,
} from "./toast-preferences"
import { emptyToastDurationOverrides } from "./types"

describe("toast preference helpers", () => {
  test("adds and removes muted toast types without duplicates", () => {
    expect(nextMutedToasts([], "info", true)).toEqual(["info"])
    expect(nextMutedToasts(["info"], "info", true)).toEqual(["info"])
    expect(nextMutedToasts(["info", "error"], "info", false)).toEqual(["error"])
    expect(nextMutedToasts(["info", "not-a-type"], "success", true)).toEqual(["info", "success"])
  })

  test("builds runtime toast config from form state", () => {
    const durations = emptyToastDurationOverrides()
    durations.warning = "2500"

    expect(toastConfigFromPreferences(["info", "bogus"], durations)).toEqual({
      muted: ["info"],
      durationOverrides: { warning: 2000 },
    })
    expect(toastConfigFromPreferences([], emptyToastDurationOverrides())).toBeUndefined()
  })

  test("parses only valid positive toast duration overrides", () => {
    const durations = emptyToastDurationOverrides()
    durations.info = "4000"
    durations.success = "0"
    durations.warning = "abc"
    durations.error = "12000"

    expect(parseToastDurationOverrides(durations)).toEqual({
      info: 4000,
      error: 8000,
    })
  })

  test("normalizes server toast config for runtime application", () => {
    expect(
      toastConfigFromServerToast({
        muted: ["success", "nope"],
        durationOverrides: { error: 9000, info: -1 },
      }),
    ).toEqual({
      muted: ["success"],
      durationOverrides: { error: 8000 },
    })
    expect(toastConfigFromServerToast(undefined)).toBeUndefined()
    expect(toastConfigFromServerToast({})).toBeUndefined()
  })
})
