import { describe, expect, test } from "bun:test"
import { defaultSettingsState, emptyMcp } from "../../../src/components/settings/types"
import {
  parseToolTimeoutOverrides,
  validateSettingsDraft,
} from "../../../src/components/settings/settings-draft-validation"
import { buildPatch } from "../../../src/components/settings/hooks/useConfigPatch"
import { saveSettingsSources } from "../../../src/components/settings/settings-explicit-save"

describe("Settings draft validation", () => {
  test("keeps incomplete and duplicate MCP drafts out of writes without dropping their input", () => {
    const state = defaultSettingsState("enter")
    state.mcps.entries = [
      { ...emptyMcp(), command: "fixture-server" },
      { ...emptyMcp(), key: "remote", type: "remote", url: "file:///fixture", timeout: "1.5" },
      { ...emptyMcp(), key: "remote", command: "fixture-server" },
    ]
    expect(validateSettingsDraft(state).map(({ page, field }) => [page, field])).toEqual([
      ["mcp", "0.key"],
      ["mcp", "1.key"],
      ["mcp", "1.url"],
      ["mcp", "1.timeout"],
      ["mcp", "2.key"],
    ])
    expect(state.mcps.entries[0]?.command).toBe("fixture-server")
  })

  test("validates only active MCP transport fields and accepts a complete paused server", () => {
    const state = defaultSettingsState("enter")
    state.mcps.entries = [{ ...emptyMcp(), key: "local", command: "fixture-server", enabled: false, url: "invalid" }]
    expect(validateSettingsDraft(state)).toEqual([])
    state.mcps.entries[0]!.command = ""
    expect(validateSettingsDraft(state)).toContainEqual(expect.objectContaining({ page: "mcp", field: "0.command" }))
  })

  test("checks MCP pair names without conflating case-sensitive environment variables", () => {
    const state = defaultSettingsState("enter")
    state.mcps.entries = [
      { ...emptyMcp(), key: "local", command: "fixture-server", environment: "TOKEN=one\ntoken=two" },
    ]
    expect(validateSettingsDraft(state)).toEqual([])
    state.mcps.entries[0]!.environment = "=value"
    expect(validateSettingsDraft(state)).toContainEqual(
      expect.objectContaining({ page: "mcp", field: "0.environment" }),
    )
    state.mcps.entries[0] = {
      ...emptyMcp(),
      key: "remote",
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: "Authorization: one\nauthorization: two",
    }
    expect(validateSettingsDraft(state)).toContainEqual(expect.objectContaining({ page: "mcp", field: "0.headers" }))
  })

  test("accepts defaults, optional empty values and disabled idle timeout", () => {
    const state = defaultSettingsState("enter")
    state.runtime.providerIdleTimeout = "false"
    expect(validateSettingsDraft(state)).toEqual([])
  })

  test("keeps every invalid numeric field associated with its page", () => {
    const state = defaultSettingsState("enter")
    state.runtime.invokeTimeout = "-1"
    state.runtime.providerWallTimeout = "Infinity"
    state.runtime.agentWorkers = "65"
    state.email.smtpPort = "1.5"
    expect(validateSettingsDraft(state).map(({ page, field }) => [page, field])).toEqual([
      ["timeouts", "invokeTimeout"],
      ["timeouts", "providerWallTimeout"],
      ["timeouts", "agentWorkers"],
      ["email", "smtpPort"],
    ])
  })

  test("rejects precise recall values outside the probability range", () => {
    const state = defaultSettingsState("enter")
    state.library.memorySimThreshold = "1.2"
    state.library.experienceSimThreshold = "-0.1"
    state.library.experienceEpsilon = "Infinity"
    expect(validateSettingsDraft(state).map(({ page, field }) => [page, field])).toEqual([
      ["memory", "memorySimThreshold"],
      ["experience", "experienceSimThreshold"],
      ["experience", "experienceEpsilon"],
    ])
  })

  test("blocks all writes before an invalid draft can be dropped from the patch", async () => {
    const state = defaultSettingsState("enter")
    state.runtime.cortexConcurrency = "0"
    const calls: string[] = []
    const result = await saveSettingsSources([
      {
        page: "timeouts",
        dirty: () => true,
        validate: () => validateSettingsDraft(state).length === 0,
        save: async () => {
          calls.push("config")
          return true
        },
      },
      {
        page: "voice",
        dirty: () => true,
        save: async () => {
          calls.push("voice")
          return true
        },
      },
    ])
    expect(result.saved).toBe(false)
    expect(result.failed[0]?.page).toBe("timeouts")
    expect(calls).toEqual([])
    expect(state.runtime.cortexConcurrency).toBe("0")
  })

  test("accepts JSON and line-based tool overrides without losing entries", () => {
    expect(parseToolTimeoutOverrides('{"bash":600,"webfetch":120}')).toEqual({ bash: 600, webfetch: 120 })
    expect(parseToolTimeoutOverrides("bash=600\nwebfetch=120")).toEqual({ bash: 600, webfetch: 120 })
    const state = defaultSettingsState("enter")
    state.runtime.toolOverrides = '{"bash":600,"webfetch":120}'
    expect(buildPatch({ cfg: {}, state, originalMcps: {} }).timeout).toMatchObject({
      tool: { overrides: { bash: 600, webfetch: 120 } },
    })
  })

  test("rejects a malformed override as a whole and retains the original draft", () => {
    for (const value of ['{"bash":0}', '{"bash":"600"}', "null", "bash=600\nbroken", "bash=Infinity", "=600"]) {
      expect(parseToolTimeoutOverrides(value)).toBeUndefined()
      const state = defaultSettingsState("enter")
      state.runtime.toolOverrides = value
      expect(validateSettingsDraft(state)).toContainEqual(
        expect.objectContaining({ page: "timeouts", field: "toolOverrides" }),
      )
      expect(state.runtime.toolOverrides).toBe(value)
    }
  })
})
