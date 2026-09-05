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

describe("settings form boss mode", () => {
  test("defaults boss mode off with empty identity and briefing interval", () => {
    expect(initializedRuntime({})).toMatchObject({
      bossMode: "false",
      bossIdentityText: "",
      bossBriefingIntervalDays: "",
    })
  })

  test("hydrates enabled boss mode with identity and briefing interval", () => {
    expect(
      initializedRuntime({
        experimental: {
          boss_mode: true,
          boss_identity_text: "Ops lead",
          boss_briefing_interval_days: 7,
        },
      }),
    ).toMatchObject({
      bossMode: "true",
      bossIdentityText: "Ops lead",
      bossBriefingIntervalDays: "7",
    })
  })

  test("hydrates explicit boss mode false", () => {
    expect(initializedRuntime({ experimental: { boss_mode: false } }).bossMode).toBe("false")
  })

  test("defaults persona preset to none with 0.5 traits when config is absent", () => {
    expect(initializedRuntime({})).toMatchObject({
      bossPersonaPreset: "none",
      bossPersonaFormality: "0.5",
      bossPersonaConciseness: "0.5",
      bossPersonaProactiveness: "0.5",
      bossPersonaWarmth: "0.5",
    })
  })

  test("hydrates a stored built-in persona preset", () => {
    expect(
      initializedRuntime({
        experimental: {
          boss_persona: { preset: "project_manager" },
        },
      }),
    ).toMatchObject({
      bossPersonaPreset: "project_manager",
      bossPersonaFormality: "0.5",
      bossPersonaConciseness: "0.5",
      bossPersonaProactiveness: "0.5",
      bossPersonaWarmth: "0.5",
    })
  })

  test("hydrates a stored custom persona with its trait numbers", () => {
    expect(
      initializedRuntime({
        experimental: {
          boss_persona: {
            preset: "custom",
            formality: 0.9,
            conciseness: 0.25,
            proactiveness: 0.6,
            warmth: 0.05,
          },
        },
      }),
    ).toMatchObject({
      bossPersonaPreset: "custom",
      bossPersonaFormality: "0.9",
      bossPersonaConciseness: "0.25",
      bossPersonaProactiveness: "0.6",
      bossPersonaWarmth: "0.05",
    })
  })

  test("boss name stays empty on init (it is read from the library by the panel)", () => {
    expect(initializedRuntime({}).bossName).toBe("")
  })
})

describe("settings form performance monitoring", () => {
  test("defaults performance monitoring on when observability config is absent", () => {
    expect(initializedRuntime({}).performanceEnabled).toBe("true")
  })

  test("hydrates explicit performance.enabled false", () => {
    expect(initializedRuntime({ observability: { performance: { enabled: false } } }).performanceEnabled).toBe("false")
  })

  test("honors the master observability.enabled switch when performance.enabled is unset", () => {
    expect(initializedRuntime({ observability: { enabled: false } }).performanceEnabled).toBe("false")
    expect(initializedRuntime({ observability: { enabled: true } }).performanceEnabled).toBe("true")
  })
})

describe("settings form channel accounts", () => {
  test("hydrates Feishu model overrides and Clarus enablement", () => {
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
          clarus: {
            type: "clarus",
            accounts: {
              "agent-id": {
                enabled: false,
                agent: "synergy",
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
      clarusAccounts: [
        {
          key: "agent-id",
          enabled: false,
        },
      ],
      githubAccounts: [],
    })
  })
})

describe("settings form github integration", () => {
  test("defaults identity sync off and agenda watch on when github config is absent", () => {
    expect(initializedGithub({})).toEqual({
      identitySyncEnabled: false,
      identitySyncName: "",
      identitySyncEmail: "",
      watchEnabled: true,
    })
  })

  test("hydrates identity sync overrides and explicit watch disablement", () => {
    expect(
      initializedGithub({
        github: {
          identitySync: { enabled: true, name: "Codex Bot", email: "bot@example.com" },
          watch: { enabled: false },
        },
      }),
    ).toEqual({
      identitySyncEnabled: true,
      identitySyncName: "Codex Bot",
      identitySyncEmail: "bot@example.com",
      watchEnabled: false,
    })
  })

  test("treats explicit watch enabled false and identitySync enabled false as configured", () => {
    expect(
      initializedGithub({
        github: { identitySync: { enabled: false }, watch: { enabled: false } },
      }),
    ).toMatchObject({ identitySyncEnabled: false, watchEnabled: false })
  })
})

function initializedGithub(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    colorScheme: () => "system",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.github
}

function initializedRuntime(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    colorScheme: () => "system",
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
    colorScheme: () => "system",
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

describe("settings form activity display hydration", () => {
  test("defaults to balanced when absent from config", () => {
    expect(initializedActivityDisplay({})).toBe("balanced")
  })

  test("hydrates explicit full display from config", () => {
    expect(initializedActivityDisplay({ activityDisplay: "full" })).toBe("full")
  })

  test("hydrates explicit minimal display from config", () => {
    expect(initializedActivityDisplay({ activityDisplay: "minimal" })).toBe("minimal")
  })
})
describe("settings form skills compatibility hydration", () => {
  test("defaults all skill sources on when compatibility config is absent", () => {
    expect(initializedSkills({})).toEqual({
      agents: true,
      claude: true,
      codex: true,
      openclaw: true,
    })
  })

  test("hydrates explicit per-source compatibility toggles", () => {
    expect(
      initializedSkills({
        skills: {
          compatibility: { agents: false, claude: true, codex: false, openclaw: true },
        },
      }),
    ).toEqual({
      agents: false,
      claude: true,
      codex: false,
      openclaw: true,
    })
  })
})

function initializedSkills(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    colorScheme: () => "system",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.skills
}

function initializedActivityDisplay(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    colorScheme: () => "system",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.general.activityDisplay
}

function initializedGeneral(config: Record<string, unknown>) {
  const [settings, setSettings] = createStore(defaultSettingsState("enter"))

  ensureInit({
    cfg: config as Config,
    setName: "global",
    refreshing: () => false,
    initialized: () => false,
    initializedForSet: undefined,
    sendShortcut: () => "enter",
    colorScheme: () => "system",
    setSettings,
    setInitialized: () => undefined,
    originalMcpsRef: { current: {} },
  })

  return settings.general.locale
}
