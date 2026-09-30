import { describe, expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"

describe("native Computer eligibility", () => {
  for (const profileId of ["guarded", "autonomous", "full_access"] as const) {
    for (const tool of ["computer_apps", "computer_observe", "computer_action"]) {
      test(`${profileId} ${tool}`, async () => {
        const gate = await EnforcementGate.create({
          activeWorkspace: process.cwd(),
          workspaceType: "main",
          profileId,
        })
        const result = gate.evaluate(tool, {})
        expect(result.decision).toBe(profileId === "full_access" ? "allow" : "deny")
        expect(result.capabilities).toEqual([
          expect.objectContaining({
            class: tool === "computer_apps" || tool === "computer_observe" ? "computer_observe" : "computer_interact",
            nonBypassable: true,
          }),
        ])
        if (profileId !== "full_access") expect(result.refusal?.guidance).toContain("Full Access")
      })
    }
  }
})

test("foreground observation is classified as interaction", async () => {
  const gate = await EnforcementGate.create({
    activeWorkspace: process.cwd(),
    workspaceType: "main",
    profileId: "full_access",
  })
  expect(gate.evaluate("computer_observe", { foreground: true }).capabilities).toEqual([
    expect.objectContaining({ class: "computer_interact", nonBypassable: true }),
  ])
})
