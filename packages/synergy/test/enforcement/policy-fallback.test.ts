import { afterEach, describe, expect, test } from "bun:test"
import { EnforcementGate } from "@/enforcement/gate"
import { PolicyWorker } from "@/enforcement/policy-worker"

afterEach(() => {
  PolicyWorker.configure()
})

describe("Policy classification fallback", () => {
  test("returns a finite conservative decision when the Policy worker is unavailable", async () => {
    await PolicyWorker.stop()
    const gate = await EnforcementGate.create({
      activeWorkspace: import.meta.dir,
      workspaceType: "worktree",
      profileId: "autonomous",
    })

    const envelope = await gate.evaluateIsolated("bash", { command: "ls" })

    expect(envelope).toMatchObject({
      decision: "deny",
      opaque: true,
      capabilities: [
        {
          class: "protected_op",
          nonBypassable: true,
          reason: "policy classification unavailable",
        },
      ],
    })
  })
})
