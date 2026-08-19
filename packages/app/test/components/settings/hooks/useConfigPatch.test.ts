import { describe, expect, test } from "bun:test"
import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { buildPatch } from "../../../../src/components/settings/hooks/useConfigPatch"
import { defaultSettingsState } from "../../../../src/components/settings/types"

describe("settings config patch", () => {
  test("persists a Feishu account model variant", () => {
    const state = defaultSettingsState("enter")
    state.channels.feishuAccounts = [
      {
        key: "default",
        enabled: true,
        model: "openai-codex/gpt-5.6-sol",
        variant: "high",
      },
    ]

    const patch = buildPatch({
      cfg: {
        channel: {
          feishu: {
            type: "feishu",
            accounts: {
              default: {
                appId: "app",
                appSecret: "secret",
                model: "openai-codex/gpt-5.6-sol",
              },
            },
          },
        },
      } as Config,
      state,
      originalMcps: {},
    })

    expect((patch.channel as Config["channel"])?.feishu?.accounts.default).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      variant: "high",
    })
  })
  test("does not include theme in the general patch", () => {
    // Theme is applied instantly via a fire-and-forget server call, not through
    // the explicit-save patch. The patch must never carry a theme field.
    const state = defaultSettingsState("enter")
    state.general.theme = ""

    const patch = buildPatch({
      cfg: { theme: "ayu" } as Config,
      state,
      originalMcps: {},
    })

    expect(patch).not.toHaveProperty("theme")
  })

  test("persists Clarus account enablement without adding model fields", () => {
    const state = defaultSettingsState("enter")
    state.channels.clarusAccounts = [{ key: "agent-id", enabled: true }]

    const patch = buildPatch({
      cfg: {
        channel: {
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
      } as Config,
      state,
      originalMcps: {},
    })

    expect((patch.channel as Config["channel"])?.clarus?.accounts["agent-id"]).toEqual({
      enabled: true,
      agent: "synergy",
    })
  })

  test("preserves Clarus accounts while updating a Feishu model variant", () => {
    const state = defaultSettingsState("enter")
    state.channels.feishuAccounts = [
      {
        key: "default",
        enabled: true,
        model: "openai-codex/gpt-5.6-sol",
        variant: "high",
      },
    ]
    const clarus = {
      type: "clarus" as const,
      accounts: {
        agent: {
          enabled: true,
          agent: "synergy-max",
        },
      },
    }

    const patch = buildPatch({
      cfg: {
        channel: {
          feishu: {
            type: "feishu",
            accounts: {
              default: {
                appId: "app",
                appSecret: "secret",
              },
            },
          },
          clarus,
        },
      } as Config,
      state,
      originalMcps: {},
    })

    const channel = patch.channel as NonNullable<Config["channel"]>
    expect(channel.feishu?.accounts.default).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      variant: "high",
    })
    expect(channel.clarus).toEqual(clarus)
  })

  test("model role drafts only materialize as server patch fields", () => {
    const state = defaultSettingsState("enter")
    state.models.model = "openai/gpt-5.5"
    state.models.mini_model = ""

    expect(
      buildPatch({
        cfg: {
          model: "deepseek/deepseek-v4",
          mini_model: "openai/gpt-5.5-mini",
          timeout: {
            invoke_sec: 21600,
            provider: { ttfb_sec: 3600, idle_sec: 900 },
            tool: { default_sec: 7200 },
          },
        } as Config,
        state,
        originalMcps: {},
      }),
    ).toEqual({
      model: "openai/gpt-5.5",
      mini_model: undefined,
    })
  })

  test("persists quick switcher model preferences through the models domain", () => {
    const state = defaultSettingsState("enter")
    state.models.quick_switcher = [{ providerID: "openai", modelID: "gpt-5.5", state: "add" }]

    const patch = buildPatch({
      cfg: {} as Config,
      state,
      originalMcps: {},
    })

    expect(patch.quick_switcher).toEqual({
      models: [{ providerID: "openai", modelID: "gpt-5.5", state: "add" }],
    })
  })

  test("clears quick switcher config when all preferences return to defaults", () => {
    const state = defaultSettingsState("enter")

    const patch = buildPatch({
      cfg: { quick_switcher: { models: [{ providerID: "openai", modelID: "gpt-5.5", state: "remove" }] } } as Config,
      state,
      originalMcps: {},
    })

    expect(patch.quick_switcher).toEqual({ models: [] })
  })

  test("default agent draft persists as default_agent", () => {
    const state = defaultSettingsState("enter")
    state.agents.defaultAgent = "synergy-max"

    const patch = buildPatch({
      cfg: {} as Config,
      state,
      originalMcps: {},
    })

    expect(patch.default_agent).toBe("synergy-max")
  })

  test("default agent is sent when different from server config", () => {
    const state = defaultSettingsState("enter")
    state.agents.defaultAgent = "synergy"

    const patch = buildPatch({
      cfg: { default_agent: "synergy-max" } as Config,
      state,
      originalMcps: {},
    })

    expect(patch.default_agent).toBe("synergy")
  })

  test("default agent not sent when unchanged", () => {
    const state = defaultSettingsState("enter")

    const patch = buildPatch({
      cfg: { default_agent: "synergy" } as Config,
      state,
      originalMcps: {},
    })

    expect(patch).not.toHaveProperty("default_agent")
  })

  test("persists post-write diagnostics policy without touching raw LSP server config", () => {
    const state = defaultSettingsState("enter")
    Object.assign(state.runtime as unknown as Record<string, string>, {
      lspWriteDiagnostics: "false",
      lspDiagnosticsSeverity: "warning",
      lspDiagnosticsScope: "file",
    })

    const patch = buildPatch({
      cfg: {
        lspWriteDiagnostics: true,
        lspDiagnostics: { severity: "error", scope: "project" },
        lsp: false,
      } as unknown as Config,
      state,
      originalMcps: {},
    })

    expect(patch.lspWriteDiagnostics).toBe(false)
    expect(patch.lspDiagnostics).toEqual({ severity: "warning", scope: "file" })
    expect(patch).not.toHaveProperty("lsp")
  })

  test("does not re-save unchanged post-write diagnostics policy", () => {
    const state = defaultSettingsState("enter")
    Object.assign(state.runtime as unknown as Record<string, string>, {
      lspWriteDiagnostics: "true",
      lspDiagnosticsSeverity: "warning",
      lspDiagnosticsScope: "delta",
    })

    const patch = buildPatch({
      cfg: {
        lspWriteDiagnostics: true,
        lspDiagnostics: { severity: "warning", scope: "delta" },
      } as unknown as Config,
      state,
      originalMcps: {},
    })

    expect(patch).not.toHaveProperty("lspWriteDiagnostics")
    expect(patch).not.toHaveProperty("lspDiagnostics")
  })

  test("keeps the absent diagnostics policy implicit at compatibility defaults", () => {
    const state = defaultSettingsState("enter")
    Object.assign(state.runtime as unknown as Record<string, string>, {
      lspWriteDiagnostics: "true",
      lspDiagnosticsSeverity: "error",
      lspDiagnosticsScope: "project",
    })

    const patch = buildPatch({ cfg: {} as Config, state, originalMcps: {} })

    expect(patch).not.toHaveProperty("lspWriteDiagnostics")
    expect(patch).not.toHaveProperty("lspDiagnostics")
  })

  test("persists an explicit Cortex concurrency maximum", () => {
    const state = defaultSettingsState("enter")
    state.runtime.cortexConcurrency = "3"

    const patch = buildPatch({
      cfg: {} as Config,
      state,
      originalMcps: {},
    })

    expect(patch.cortex).toEqual({ maxConcurrentTasks: 3 })
  })

  test("does not materialize the default Cortex concurrency maximum", () => {
    const state = defaultSettingsState("enter")

    const patch = buildPatch({
      cfg: {} as Config,
      state,
      originalMcps: {},
    })

    expect(patch).not.toHaveProperty("cortex")
  })

  test("omits unchanged or invalid Cortex concurrency values", () => {
    const state = defaultSettingsState("enter")
    state.runtime.cortexConcurrency = "6"

    expect(
      buildPatch({
        cfg: { cortex: { maxConcurrentTasks: 6 } } as Config,
        state,
        originalMcps: {},
      }),
    ).not.toHaveProperty("cortex")

    state.runtime.cortexConcurrency = "0"
    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }),
    ).not.toHaveProperty("cortex")
  })

  test("persists an agent worker pool size while preserving other execution settings", () => {
    const state = defaultSettingsState("enter")
    state.runtime.agentWorkers = "3"

    const patch = buildPatch({
      cfg: { execution: { agentWorkers: 6, policyWorkers: 2 } } as Config,
      state,
      originalMcps: {},
    })

    expect(patch.execution).toEqual({ agentWorkers: 3, policyWorkers: 2 })
  })

  test("omits automatic, unchanged, and out-of-range agent worker pool sizes", () => {
    const state = defaultSettingsState("enter")

    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} })).not.toHaveProperty("execution")

    state.runtime.agentWorkers = "6"
    expect(
      buildPatch({
        cfg: { execution: { agentWorkers: 6 } } as Config,
        state,
        originalMcps: {},
      }),
    ).not.toHaveProperty("execution")

    state.runtime.agentWorkers = "65"
    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} })).not.toHaveProperty("execution")
  })

  test("provider idle timeout can be disabled with false", () => {
    const state = defaultSettingsState("enter")
    state.runtime.providerIdleTimeout = "false"

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).timeout,
    ).toEqual({
      invoke_sec: 21600,
      provider: { ttfb_sec: 3600, idle_sec: false },
      tool: { default_sec: 7200 },
    })
  })

  test("coauthor reminder defaults on without materializing experimental config", () => {
    const state = defaultSettingsState("enter")

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toBeUndefined()
  })

  test("coauthor reminder can be disabled in experimental config", () => {
    const state = defaultSettingsState("enter")
    state.runtime.coauthorReminder = "false"

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({ coauthor_reminder: false })
  })

  test("coauthor reminder can be re-enabled from explicit false", () => {
    const state = defaultSettingsState("enter")
    state.runtime.coauthorReminder = "true"

    expect(
      buildPatch({
        cfg: { experimental: { coauthor_reminder: false } } as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({ coauthor_reminder: true })
  })

  test("boss mode defaults off without materializing experimental config", () => {
    const state = defaultSettingsState("enter")

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toBeUndefined()
  })

  test("boss mode fields materialize in experimental config when enabled", () => {
    const state = defaultSettingsState("enter")
    state.runtime.bossMode = "true"
    state.runtime.bossIdentityText = "Ops lead"
    state.runtime.bossBriefingIntervalDays = "7"

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({
      boss_mode: true,
      boss_identity_text: "Ops lead",
      boss_briefing_interval_days: 7,
    })
  })

  test("boss mode can be disabled and clears identity and briefing interval", () => {
    const state = defaultSettingsState("enter")
    state.runtime.bossMode = "false"
    state.runtime.bossIdentityText = ""
    state.runtime.bossBriefingIntervalDays = ""

    expect(
      buildPatch({
        cfg: {
          experimental: {
            boss_mode: true,
            boss_identity_text: "Ops lead",
            boss_briefing_interval_days: 7,
          },
        } as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({
      boss_mode: false,
      // Explicit null clears the stored value: the SDK JSON serializer drops
      // undefined keys, so undefined would never reach the server merge.
      boss_identity_text: null,
      boss_briefing_interval_days: null,
    })
  })

  test("boss identity and briefing interval can be re-added from explicit values", () => {
    const state = defaultSettingsState("enter")
    state.runtime.bossMode = "true"
    state.runtime.bossIdentityText = "Ops lead"
    state.runtime.bossBriefingIntervalDays = "7"

    expect(
      buildPatch({
        cfg: {
          experimental: {
            boss_mode: false,
            boss_identity_text: undefined,
            boss_briefing_interval_days: undefined,
          },
        } as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({
      boss_mode: true,
      boss_identity_text: "Ops lead",
      boss_briefing_interval_days: 7,
    })
  })

  test("does not re-save unchanged boss mode experimental config", () => {
    const state = defaultSettingsState("enter")
    state.runtime.bossMode = "true"
    state.runtime.bossIdentityText = "Ops lead"
    state.runtime.bossBriefingIntervalDays = "7"

    expect(
      buildPatch({
        cfg: {
          experimental: {
            boss_mode: true,
            boss_identity_text: "Ops lead",
            boss_briefing_interval_days: 7,
          },
        } as Config,
        state,
        originalMcps: {},
      }),
    ).not.toHaveProperty("experimental")
  })

  test("omits invalid boss briefing interval values instead of emitting them", () => {
    const state = defaultSettingsState("enter")
    state.runtime.bossMode = "true"
    state.runtime.bossBriefingIntervalDays = "0"

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({ boss_mode: true })

    state.runtime.bossBriefingIntervalDays = "-3"
    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({ boss_mode: true })

    state.runtime.bossBriefingIntervalDays = "abc"
    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).experimental,
    ).toEqual({ boss_mode: true })
  })

  test("does not re-save unchanged sandbox config when enabled is already explicit", () => {
    const state = defaultSettingsState("enter")
    state.safety.sandboxEnabled = "true"
    state.safety.sandboxFallbackPolicy = "warn"

    const patch = buildPatch({
      cfg: {
        sandbox: {
          enabled: true,
          fallbackPolicy: "warn",
        },
      } as Config,
      state,
      originalMcps: {},
    })

    expect(patch).not.toHaveProperty("sandbox")
  })

  test("persists sandbox only when values actually change", () => {
    const state = defaultSettingsState("enter")
    state.safety.sandboxEnabled = "false"

    const patch = buildPatch({
      cfg: {
        sandbox: {
          enabled: true,
          fallbackPolicy: "warn",
        },
      } as Config,
      state,
      originalMcps: {},
    })

    expect(patch.sandbox).toEqual({
      enabled: false,
      fallbackPolicy: "warn",
    })
  })

  test("persists toast mute and duration preferences on the general domain", () => {
    const state = defaultSettingsState("enter")
    state.general.mutedToasts = ["info", "success"]
    state.general.toastDurations.warning = "2500"

    expect(
      buildPatch({
        cfg: {} as Config,
        state,
        originalMcps: {},
      }).toast,
    ).toEqual({
      muted: ["info", "success"],
      durationOverrides: { warning: 2000 },
    })
  })

  test("unmuting the last toast type sends muted:[] so domain merge can clear it", () => {
    const state = defaultSettingsState("enter")

    expect(
      buildPatch({
        cfg: {
          toast: {
            muted: ["info"],
          },
        } as Config,
        state,
        originalMcps: {},
      }).toast,
    ).toEqual({
      muted: [],
    })
  })

  test("unmuting one type while duration overrides remain still clears that muted entry", () => {
    const state = defaultSettingsState("enter")
    state.general.toastDurations.warning = "2500"

    expect(
      buildPatch({
        cfg: {
          toast: {
            muted: ["info"],
            durationOverrides: { warning: 2000 },
          },
        } as Config,
        state,
        originalMcps: {},
      }).toast,
    ).toEqual({
      muted: [],
      durationOverrides: { warning: 2000 },
    })
  })

  test("does not emit toast patch when mute and duration preferences are unchanged", () => {
    const state = defaultSettingsState("enter")
    state.general.mutedToasts = ["error"]
    state.general.toastDurations.info = "1000"

    expect(
      buildPatch({
        cfg: {
          toast: {
            muted: ["error"],
            durationOverrides: { info: 1000 },
          },
        } as Config,
        state,
        originalMcps: {},
      }).toast,
    ).toBeUndefined()
  })

  test("persists a local embedding source and only sends a custom origin for custom mode", () => {
    const state = defaultSettingsState("enter")
    Object.assign(state.library, {
      embeddingSource: "custom",
      embeddingRemoteHost: "https://models.example/",
    })

    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} }).embedding).toEqual({
      local: { source: "custom", remoteHost: "https://models.example/" },
    })

    Object.assign(state.library, { embeddingSource: "huggingface" })
    expect(
      buildPatch({
        cfg: {
          embedding: { local: { source: "custom", remoteHost: "https://models.example/" } },
        } as Config,
        state,
        originalMcps: {},
      }).embedding,
    ).toEqual({ local: { source: "huggingface" } })
  })
})

describe("settings config patch locale", () => {
  test("does not emit locale patch when server has no locale and form is at system default", () => {
    const state = defaultSettingsState("enter")
    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} })).not.toHaveProperty("locale")
  })

  test("emits locale patch when form diverges from absent server locale", () => {
    const state = defaultSettingsState("enter")
    state.general.locale = "en"
    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} }).locale).toBe("en")
  })

  test("emits locale patch when form diverges from explicit server locale", () => {
    const state = defaultSettingsState("enter")
    state.general.locale = "zh-CN"
    expect(buildPatch({ cfg: { locale: "en" } as Config, state, originalMcps: {} }).locale).toBe("zh-CN")
  })

  test("emits explicit system locale when switching from en back to system", () => {
    const state = defaultSettingsState("enter")
    expect(buildPatch({ cfg: { locale: "en" } as Config, state, originalMcps: {} }).locale).toBe("system")
  })

  test("emits explicit system locale when switching from zh-CN back to system", () => {
    const state = defaultSettingsState("enter")
    expect(buildPatch({ cfg: { locale: "zh-CN" } as Config, state, originalMcps: {} }).locale).toBe("system")
  })

  test("does not emit locale patch when form value matches server locale", () => {
    const state = defaultSettingsState("enter")
    state.general.locale = "en"
    expect(buildPatch({ cfg: { locale: "en" } as Config, state, originalMcps: {} })).not.toHaveProperty("locale")
  })
})

describe("settings config patch activity display", () => {
  test("does not emit activityDisplay when the form is at the balanced default", () => {
    const state = defaultSettingsState("enter")
    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} })).not.toHaveProperty("activityDisplay")
  })

  test("emits activityDisplay when the form diverges from an absent server value", () => {
    const state = defaultSettingsState("enter")
    state.general.activityDisplay = "full"
    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} }).activityDisplay).toBe("full")
  })

  test("emits activityDisplay when the form diverges from an explicit server value", () => {
    const state = defaultSettingsState("enter")
    state.general.activityDisplay = "minimal"
    expect(
      buildPatch({ cfg: { activityDisplay: "balanced" } as Config, state, originalMcps: {} }).activityDisplay,
    ).toBe("minimal")
  })

  test("does not emit activityDisplay when the form matches the server value", () => {
    const state = defaultSettingsState("enter")
    state.general.activityDisplay = "full"
    expect(buildPatch({ cfg: { activityDisplay: "full" } as Config, state, originalMcps: {} })).not.toHaveProperty(
      "activityDisplay",
    )
  })
})

describe("settings config patch performance monitoring", () => {
  test("does not emit a performance patch when the form matches the effective value", () => {
    const state = defaultSettingsState("enter")
    state.runtime.performanceEnabled = "false"
    expect(
      buildPatch({
        cfg: { observability: { enabled: false } } as Config,
        state,
        originalMcps: {},
      }),
    ).not.toHaveProperty("observability")
  })

  test("emits performance.enabled true when the master switch disabled it and the form is on", () => {
    const state = defaultSettingsState("enter")
    state.runtime.performanceEnabled = "true"
    const patch = buildPatch({
      cfg: { observability: { enabled: false } } as Config,
      state,
      originalMcps: {},
    })
    expect((patch.observability as { performance?: { enabled?: boolean } })?.performance?.enabled).toBe(true)
  })

  test("emits performance.enabled false when only performance.enabled is set on the server", () => {
    const state = defaultSettingsState("enter")
    state.runtime.performanceEnabled = "false"
    const patch = buildPatch({
      cfg: { observability: { performance: { enabled: true } } } as Config,
      state,
      originalMcps: {},
    })
    expect((patch.observability as { performance?: { enabled?: boolean } })?.performance?.enabled).toBe(false)
  })
})
describe("settings config patch skills compatibility", () => {
  test("does not emit a skills patch when the form matches compatibility defaults", () => {
    const state = defaultSettingsState("enter")
    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} })).not.toHaveProperty("skills")
  })

  test("emits the full compatibility object when one source diverges", () => {
    const state = defaultSettingsState("enter")
    state.skills.claude = false

    expect(buildPatch({ cfg: {} as Config, state, originalMcps: {} }).skills).toEqual({
      compatibility: { agents: true, claude: false, codex: true, openclaw: true },
    })
  })

  test("re-enables a source stored as explicit false", () => {
    const state = defaultSettingsState("enter")
    state.skills.codex = true

    expect(
      buildPatch({
        cfg: {
          skills: {
            compatibility: { agents: true, claude: true, codex: false, openclaw: true },
          },
        } as Config,
        state,
        originalMcps: {},
      }).skills,
    ).toEqual({
      compatibility: { agents: true, claude: true, codex: true, openclaw: true },
    })
  })

  test("does not emit a skills patch when the form matches explicit server values", () => {
    const state = defaultSettingsState("enter")
    state.skills.agents = false
    state.skills.openclaw = false

    expect(
      buildPatch({
        cfg: {
          skills: {
            compatibility: { agents: false, claude: true, codex: true, openclaw: false },
          },
        } as Config,
        state,
        originalMcps: {},
      }),
    ).not.toHaveProperty("skills")
  })
})
