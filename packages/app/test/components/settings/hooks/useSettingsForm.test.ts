import { describe, expect, test } from "bun:test"
import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { createStore } from "solid-js/store"
import {
  ensureInit,
  readLegacyQuickSwitcherPreferences,
} from "../../../../src/components/settings/hooks/useSettingsForm"
import { defaultSettingsState } from "../../../../src/components/settings/types"

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

describe("settings form Cortex concurrency", () => {
  test("hydrates the configured global maximum", () => {
    expect(initializedRuntime({ cortex: { maxConcurrentTasks: 6 } }).cortexConcurrency).toBe("6")
  })
})

describe("settings form agent worker pool", () => {
  test("hydrates the configured pool size", () => {
    expect(initializedRuntime({ execution: { agentWorkers: 6 } }).agentWorkers).toBe("6")
  })

  test("keeps automatic pool sizing blank when no size is configured", () => {
    expect(initializedRuntime({}).agentWorkers).toBe("")
  })
})

describe("settings form channel model variants", () => {
  test("hydrates the configured account model variant", () => {
    expect(
      initializedChannels({
        channel: {
          feishu: {
            type: "feishu",
            accounts: {
              default: {
                appId: "app",
                appSecret: "secret",
                model: "openai-codex/gpt-5.6-sol",
                variant: "high",
              },
            },
          },
        },
      }),
    ).toEqual({
      feishuAccounts: [
        {
          key: "default",
          enabled: true,
          model: "openai-codex/gpt-5.6-sol",
          variant: "high",
        },
      ],
    })
  })
})

function initializedRuntime(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.runtime
}

function initializedChannels(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.channels
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

describe("settings form locale hydration", () => {
  test("defaults locale to system when absent from config", () => {
    expect(initializedGeneral({})).toBe("system")
  })

  test("hydrates explicit en locale from config", () => {
    expect(initializedGeneral({ locale: "en" })).toBe("en")
  })

  test("hydrates explicit zh-CN locale from config", () => {
    expect(initializedGeneral({ locale: "zh-CN" })).toBe("zh-CN")
  })

  test("hydrates explicit system locale from config", () => {
    expect(initializedGeneral({ locale: "system" })).toBe("system")
  })
})

function initializedGeneral(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.general.locale
}
