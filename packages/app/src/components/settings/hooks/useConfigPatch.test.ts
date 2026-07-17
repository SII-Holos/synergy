import { describe, expect, test } from "bun:test"
import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { buildPatch } from "./useConfigPatch"
import { defaultSettingsState } from "../types"

describe("settings config patch", () => {
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
