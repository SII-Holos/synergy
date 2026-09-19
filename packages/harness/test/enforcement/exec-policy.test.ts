import { describe, expect, test } from "bun:test"
import { generateAmendmentForCapability } from "../../src/enforcement/exec-policy"

// ---------------------------------------------------------------------------
// enforcement/exec-policy.test.ts
//
// The surviving surface of the former ExecPolicy module. The rule engine
// (prefix/network rules, approval-mode parsing, and the heuristic allow/ask/deny
// table) was removed because no production caller ever populated
// `GateOptions.execPolicy`; only the refusal-amendment factory is reachable.
// ---------------------------------------------------------------------------

describe("generateAmendmentForCapability", () => {
  test("suggests the guarded profile for a capability that guarding can authorize", () => {
    expect(generateAmendmentForCapability("shell_destructive")).toEqual({
      type: "execPolicy",
      commandPrefix: ["--profile=guarded"],
    })
  })

  test("offers no amendment for a non-bypassable hardline boundary", () => {
    // shell_hardline is refused in every profile, so suggesting a profile
    // transition would be misleading.
    expect(generateAmendmentForCapability("shell_hardline")).toBeUndefined()
  })

  test("keeps the discriminator and command prefix shape stable", () => {
    const amendment = generateAmendmentForCapability("file_external_write")
    expect(amendment?.type).toBe("execPolicy")
    expect(Array.isArray(amendment?.commandPrefix)).toBe(true)
  })
})
