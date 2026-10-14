import { describe, expect, test } from "bun:test"
import { buildSupervisorPrompt } from "../../src/prompts/supervisor/builder"

describe("BlueprintLoop supervisor prompt", () => {
  test("requires evidence that matches the semantic strength of required outcomes", () => {
    const prompt = buildSupervisorPrompt([])

    expect(prompt).toContain("Evidence must match the semantic strength of the claim")
    expect(prompt).toContain("A weaker proxy cannot prove a stronger outcome")
    expect(prompt).toContain("A required outcome classified as Cannot verify is blocking")
    expect(prompt).toContain("Approve only when every required outcome is Verified complete")
    expect(prompt).not.toContain("any Cannot verify items are documented and non-blocking")
    expect(prompt).not.toContain("Deferred or manual-only items are documented and non-blocking")
    expect(prompt).toContain("blueprint_loop_approve")
    expect(prompt).toContain("blueprint_loop_reject")
    expect(prompt).toMatch(/execution session ID.*launch context/)
    expect(prompt).not.toMatch(/note_read|view_file|scan_files|via `task`|reason:|sessionID:/)
    expect(prompt).not.toContain("Before calling")
  })
})
