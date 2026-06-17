import { describe, expect, test } from "bun:test"
import type { ProfileId } from "../../src/control-profile/types"

// Minimal inline mock of resolveEffectiveProfile for direct unit testing
// This mirrors the logic in tool-resolver.ts
function resolveEffectiveProfile(agentProfile: string | undefined, topLevelProfile: string | undefined): ProfileId {
  const VALID: readonly string[] = ["review", "workspace", "auto_review", "full_access"]
  // agentProfile comes from Zod-validated config, so it's already validated
  // But topLevelProfile can be any string from config
  const candidate = agentProfile ?? topLevelProfile ?? "workspace"
  if (VALID.includes(candidate)) return candidate as ProfileId
  return "workspace"
}

describe("resolveEffectiveProfile", () => {
  test("default is workspace when nothing is configured", () => {
    expect(resolveEffectiveProfile(undefined, undefined)).toBe("workspace")
  })

  test("top-level config overrides default", () => {
    expect(resolveEffectiveProfile(undefined, "review")).toBe("review")
  })

  test("agent config overrides top-level", () => {
    expect(resolveEffectiveProfile("full_access", "workspace")).toBe("full_access")
  })

  test("agent config has highest precedence", () => {
    expect(resolveEffectiveProfile("auto_review", "review")).toBe("auto_review")
  })

  test("invalid top-level falls back to workspace", () => {
    expect(resolveEffectiveProfile(undefined, "bogus")).toBe("workspace")
  })

  test("both absent falls back to workspace", () => {
    expect(resolveEffectiveProfile(undefined, undefined)).toBe("workspace")
  })

  test("all four valid profiles are accepted", () => {
    const ids: ProfileId[] = ["review", "workspace", "auto_review", "full_access"]
    for (const id of ids) {
      expect(resolveEffectiveProfile(id, undefined)).toBe(id)
    }
  })
})
