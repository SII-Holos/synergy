import { describe, expect, test } from "bun:test"
import {
  hasExplicitSettingsChanges,
  saveExplicitSettingsChanges,
  type ExplicitSettingsSaveSource,
} from "./settings-explicit-save"

describe("settings explicit save coordination", () => {
  test("treats a dirty Custom Instructions source as an explicit settings change", () => {
    const sources = [source(false), source(true)]
    expect(hasExplicitSettingsChanges(sources)).toBe(true)
  })

  test("saves every dirty source and closes only when all succeed", async () => {
    const calls: string[] = []
    let closed = false
    const saved = await saveExplicitSettingsChanges(
      [source(false, "clean", calls), source(true, "server", calls), source(true, "personalize", calls)],
      () => {
        closed = true
      },
    )

    expect(saved).toBe(true)
    expect(calls).toEqual(["server", "personalize"])
    expect(closed).toBe(true)
  })

  test("keeps Settings open when any dirty source fails", async () => {
    let closed = false
    const saved = await saveExplicitSettingsChanges(
      [source(true, "server", [], true), source(true, "personalize", [], false)],
      () => {
        closed = true
      },
    )

    expect(saved).toBe(false)
    expect(closed).toBe(false)
  })
})

function source(dirty: boolean, label = "source", calls: string[] = [], succeeds = true): ExplicitSettingsSaveSource {
  return {
    dirty: () => dirty,
    save: async () => {
      calls.push(label)
      return succeeds
    },
  }
}
