import { describe, expect, test } from "bun:test"
import {
  hasExplicitSettingsChanges,
  rebaseDraftAfterSave,
  retainDraftAfterSave,
  saveExplicitSettingsChanges,
  themeIdToSettingsValue,
  type ExplicitSettingsSaveSource,
} from "../../../src/components/settings/settings-explicit-save"

describe("settings explicit save coordination", () => {
  test("treats a dirty Custom Instructions source as an explicit settings change", () => {
    const sources = [source(false), source(true)]
    expect(hasExplicitSettingsChanges(sources)).toBe(true)
  })

  test("saves every dirty source without closing Settings", async () => {
    const calls: string[] = []
    let closed = false
    const saved = await saveExplicitSettingsChanges([
      source(false, "clean", calls),
      source(true, "server", calls),
      source(true, "personalize", calls),
    ])

    expect(saved).toBe(true)
    expect(calls).toEqual(["server", "personalize"])
    expect(closed).toBe(false)
  })

  test("keeps Settings open when any dirty source fails", async () => {
    let closed = false
    const saved = await saveExplicitSettingsChanges([
      source(true, "server", [], true),
      source(true, "personalize", [], false),
    ])

    expect(saved).toBe(false)
    expect(closed).toBe(false)
  })
  test("continues saving other sources when one source throws", async () => {
    const calls: string[] = []
    const saved = await saveExplicitSettingsChanges([
      {
        dirty: () => true,
        save: async () => {
          calls.push("throws")
          throw new Error("save failed")
        },
      },
      source(true, "continues", calls),
    ])

    expect(saved).toBe(false)
    expect(calls).toEqual(["throws", "continues"])
  })

  test("clears a saved draft only while it still matches the submitted value", () => {
    expect(retainDraftAfterSave("auto", "auto")).toBeUndefined()
    expect(retainDraftAfterSave("manual", "auto")).toBe("manual")
  })
  test("maps the live theme id to the stored settings value", () => {
    expect(themeIdToSettingsValue("ayu")).toBe("ayu")
    expect(themeIdToSettingsValue("catppuccin")).toBe("catppuccin")
  })

  test("stores the default theme as an empty string", () => {
    expect(themeIdToSettingsValue("synergy")).toBe("")
    expect(themeIdToSettingsValue("synergy", "synergy")).toBe("")
    expect(themeIdToSettingsValue("catppuccin", "catppuccin")).toBe("")
    expect(themeIdToSettingsValue("ayu", "catppuccin")).toBe("ayu")
  })
  test("rebases only edits made while the submitted settings were saving", () => {
    const refreshed = {
      general: { username: "alice", locale: "en" },
      runtime: { watcherIgnore: ["dist", "coverage"] },
    }
    const submitted = {
      general: { username: " alice ", locale: "en" },
      runtime: { watcherIgnore: ["dist"] },
    }
    const current = {
      general: { username: " alice ", locale: "zh-CN" },
      runtime: { watcherIgnore: ["dist", "tmp"] },
    }

    expect(rebaseDraftAfterSave(refreshed, submitted, current)).toEqual({
      general: { username: "alice", locale: "zh-CN" },
      runtime: { watcherIgnore: ["dist", "tmp"] },
    })
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
