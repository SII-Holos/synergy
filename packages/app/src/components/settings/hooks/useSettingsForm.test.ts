import { describe, expect, test } from "bun:test"
import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { ensureInit, readLegacyQuickSwitcherPreferences, type EnsureInitParams } from "./useSettingsForm"

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

describe("settings form post-write diagnostics", () => {
  test("initializes compatibility defaults when diagnostics settings are absent", () => {
    expect(initializedRuntime({})).toMatchObject({
      lspWriteDiagnostics: "true",
      lspDiagnosticsSeverity: "error",
      lspDiagnosticsScope: "project",
    })
  })

  test("initializes explicit diagnostics settings", () => {
    expect(
      initializedRuntime({
        lspWriteDiagnostics: false,
        lspDiagnostics: { severity: "warning", scope: "delta" },
      }),
    ).toMatchObject({
      lspWriteDiagnostics: "false",
      lspDiagnosticsSeverity: "warning",
      lspDiagnosticsScope: "delta",
    })
  })
})

function initializedRuntime(config: Record<string, unknown>) {
  let runtime: unknown
  const setSettings = ((...args: unknown[]) => {
    if (args[0] === "runtime") runtime = args[1]
  }) as unknown as EnsureInitParams["setSettings"]

  ensureInit({
    cfg: config as unknown as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    setSettings,
    setInitialized: () => {},
    originalMcpsRef: { current: {} },
  })

  return runtime
}

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
