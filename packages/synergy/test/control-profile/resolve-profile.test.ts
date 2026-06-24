import { describe, expect, test } from "bun:test"
import { ControlProfileCompiler } from "../../src/control-profile/compiler"
import type { ProfileId } from "../../src/control-profile/types"

// Minimal inline mock of resolveEffectiveProfile for direct unit testing
// This mirrors the logic in tool-resolver.ts
function resolveEffectiveProfile(
  sessionProfile: string | undefined,
  agentProfile: string | undefined,
  topLevelProfile: string | undefined,
): ProfileId {
  return ControlProfileCompiler.normalize(sessionProfile ?? agentProfile ?? topLevelProfile)
}

describe("resolveEffectiveProfile", () => {
  test("default is guarded when nothing is configured", () => {
    expect(resolveEffectiveProfile(undefined, undefined, undefined)).toBe("guarded")
  })

  test("top-level config overrides default", () => {
    expect(resolveEffectiveProfile(undefined, undefined, "full_access")).toBe("full_access")
  })

  test("agent config overrides top-level", () => {
    expect(resolveEffectiveProfile(undefined, "full_access", "guarded")).toBe("full_access")
  })

  test("session config has highest precedence", () => {
    expect(resolveEffectiveProfile("autonomous", "full_access", "guarded")).toBe("autonomous")
  })

  test("invalid top-level falls back to guarded", () => {
    expect(resolveEffectiveProfile(undefined, undefined, "bogus")).toBe("guarded")
  })

  test("both absent falls back to guarded", () => {
    expect(resolveEffectiveProfile(undefined, undefined, undefined)).toBe("guarded")
  })

  test("all valid profiles are accepted", () => {
    const ids: ProfileId[] = ["guarded", "autonomous", "full_access"]
    for (const id of ids) {
      expect(resolveEffectiveProfile(id, undefined, undefined)).toBe(id)
    }
  })
})
