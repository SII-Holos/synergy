import { describe, expect, test } from "bun:test"
import { readLegacyQuickSwitcherPreferences } from "./useSettingsForm"

describe("settings form legacy quick switcher migration", () => {
  test("reads current quick switcher preferences from the legacy localStorage key", () => {
    const storage = storageWithModel({
      quickSwitcher: [
        { providerID: "openai", modelID: "gpt-5.5", state: "add" },
        { providerID: "anthropic", modelID: "claude-sonnet", state: "remove" },
        { providerID: "bad", modelID: "ignored", state: "invalid" },
      ],
    })

    expect(readLegacyQuickSwitcherPreferences(storage)).toEqual([
      { providerID: "openai", modelID: "gpt-5.5", state: "add" },
      { providerID: "anthropic", modelID: "claude-sonnet", state: "remove" },
    ])
  })

  test("converts older user visibility preferences", () => {
    const storage = storageWithModel({
      user: [
        { providerID: "openai", modelID: "gpt-5.5", visibility: "show" },
        { providerID: "anthropic", modelID: "claude-sonnet", visibility: "hide" },
      ],
    })

    expect(readLegacyQuickSwitcherPreferences(storage)).toEqual([
      { providerID: "openai", modelID: "gpt-5.5", state: "add" },
      { providerID: "anthropic", modelID: "claude-sonnet", state: "remove" },
    ])
  })
})

function storageWithModel(value: unknown): Storage {
  const entries = new Map<string, string>([["synergy.global.dat:model", JSON.stringify(value)]])
  return {
    get length() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    getItem(key: string) {
      return entries.get(key) ?? null
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null
    },
    removeItem(key: string) {
      entries.delete(key)
    },
    setItem(key: string, value: string) {
      entries.set(key, value)
    },
  }
}
