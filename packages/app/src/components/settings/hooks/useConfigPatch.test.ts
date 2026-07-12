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

  test("clears toast config when mute and duration overrides return to defaults", () => {
    const state = defaultSettingsState("enter")

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
})
