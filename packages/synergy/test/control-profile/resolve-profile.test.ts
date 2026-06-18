import { describe, expect, test } from "bun:test"
import { ControlProfileCompiler } from "../../src/control-profile/compiler"
import type { ProfileId, ProfileIdInput } from "../../src/control-profile/types"

// Minimal inline mock of resolveEffectiveProfile for direct unit testing
// This mirrors the logic in tool-resolver.ts
function resolveEffectiveProfile(agentProfile: string | undefined, topLevelProfile: string | undefined): ProfileId {
  return ControlProfileCompiler.normalize(agentProfile ?? topLevelProfile)
}

describe("resolveEffectiveProfile", () => {
  test("default is guarded when nothing is configured", () => {
    expect(resolveEffectiveProfile(undefined, undefined)).toBe("guarded")
  })

  test("top-level config overrides default", () => {
    expect(resolveEffectiveProfile(undefined, "manual")).toBe("manual")
  })

  test("agent config overrides top-level", () => {
    expect(resolveEffectiveProfile("full_access", "guarded")).toBe("full_access")
  })

  test("agent config has highest precedence", () => {
    expect(resolveEffectiveProfile("autonomous", "manual")).toBe("autonomous")
  })

  test("invalid top-level falls back to guarded", () => {
    expect(resolveEffectiveProfile(undefined, "bogus")).toBe("guarded")
  })

  test("both absent falls back to guarded", () => {
    expect(resolveEffectiveProfile(undefined, undefined)).toBe("guarded")
  })

  test("all four valid profiles are accepted", () => {
    const ids: ProfileId[] = ["manual", "guarded", "autonomous", "full_access"]
    for (const id of ids) {
      expect(resolveEffectiveProfile(id, undefined)).toBe(id)
    }
  })

  test("legacy profile ids map to the new four modes", () => {
    const cases: Record<ProfileIdInput, ProfileId> = {
      review: "manual",
      workspace: "guarded",
      auto_review: "autonomous",
      manual: "manual",
      guarded: "guarded",
      autonomous: "autonomous",
      full_access: "full_access",
    }
    for (const [input, expected] of Object.entries(cases)) {
      expect(resolveEffectiveProfile(input, undefined)).toBe(expected)
    }
  })
})
