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
        cfg: { model: "deepseek/deepseek-v4", mini_model: "openai/gpt-5.5-mini" } as Config,
        state,
        originalMcps: {},
      }),
    ).toEqual({
      model: "openai/gpt-5.5",
      mini_model: undefined,
    })
  })
})
