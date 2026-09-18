import { afterEach, describe, expect, test } from "bun:test"
import { EnforcementGate } from "../../src/enforcement/gate"
import { PolicyWorker } from "../../src/enforcement/policy-worker"

afterEach(() => {
  PolicyWorker.configure()
})

describe("Policy classification fallback", () => {
  for (const profileId of ["guarded", "autonomous"] as const) {
    test(`returns a finite conservative ${profileId} decision when the Policy worker is unavailable`, async () => {
      await PolicyWorker.stop()
      const gate = await EnforcementGate.create({
        activeWorkspace: import.meta.dir,
        workspaceType: "worktree",
        profileId,
      })

      const envelope = await gate.evaluateIsolated("bash", { command: "ls" })

      expect(envelope).toMatchObject({
        decision: "deny",
        opaque: true,
        refusal: {
          matchedPermission: "protected_op",
          permanent: false,
        },
        capabilities: [
          {
            class: "protected_op",
            nonBypassable: true,
            reason: "policy classification unavailable",
          },
        ],
      })
    })
  }

  test("allows an unclassified operation under full_access when the Policy worker is unavailable", async () => {
    await PolicyWorker.stop()
    const gate = await EnforcementGate.create({
      activeWorkspace: import.meta.dir,
      workspaceType: "worktree",
      profileId: "full_access",
    })

    const envelope = await gate.evaluateIsolated("bash", { command: "ls" })

    expect(envelope.decision).toBe("allow")
    expect(envelope.refusal).toBeUndefined()
    expect(envelope.opaque).toBe(true)
    expect(envelope.capabilities).toMatchObject([
      {
        class: "protected_op",
        nonBypassable: true,
        opaque: true,
        reason: "policy classification unavailable",
      },
    ])
  })

  test("records the classification failure under full_access for audit", async () => {
    await PolicyWorker.stop()
    const gate = await EnforcementGate.create({
      activeWorkspace: import.meta.dir,
      workspaceType: "worktree",
      profileId: "full_access",
    })

    await gate.evaluateIsolated("bash", { command: "ls" })

    const audit = gate.getAuditRecords()
    expect(audit.at(-1)?.capabilities.map((cap) => cap.class)).toContain("protected_op")
  })

  test("allows an unclassified destructive command under full_access", async () => {
    await PolicyWorker.stop()
    const gate = await EnforcementGate.create({
      activeWorkspace: import.meta.dir,
      workspaceType: "worktree",
      profileId: "full_access",
    })

    const envelope = await gate.evaluateIsolated("bash", { command: "rm -rf /" })

    expect(envelope.decision).toBe("allow")
    expect(envelope.refusal).toBeUndefined()
  })
})
