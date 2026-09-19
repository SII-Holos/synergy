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

  /**
   * The single per-profile regression assertion for this change.
   *
   * `guarded` and `autonomous` must be indistinguishable in their *failure*
   * handling, and `full_access` must differ only where classification is
   * unavailable. Stated as a difference rather than a snapshot so that a
   * future edit to either profile's failure handling fails here first. The
   * healthy baseline reflects the classifier's host-level hardline verdict
   * for `rm -rf /` (non-bypassable, denied under every non-full_access
   * profile) rather than a risk the profiles could ask about.
   */
  test("guarded and autonomous are unchanged and full_access differs only when classification is unavailable", async () => {
    const base = { activeWorkspace: import.meta.dir, workspaceType: "worktree" as const }
    const command = "rm -rf /"
    const profileIds = ["guarded", "autonomous", "full_access"] as const
    const gateFor = (profileId: (typeof profileIds)[number]) => EnforcementGate.create({ ...base, profileId })

    PolicyWorker.configure()
    const healthy = {
      guarded: (await gateFor("guarded")).evaluate("bash", { command }),
      autonomous: (await gateFor("autonomous")).evaluate("bash", { command }),
      full_access: (await gateFor("full_access")).evaluate("bash", { command }),
    }

    expect(healthy.guarded).toMatchObject({
      decision: "deny",
      opaque: false,
      refusal: { matchedPermission: "shell_hardline", permanent: true },
    })
    expect(healthy.autonomous).toMatchObject({
      decision: "deny",
      opaque: false,
      refusal: { matchedPermission: "shell_hardline", permanent: true },
    })
    expect(healthy.full_access).toMatchObject({ decision: "allow", opaque: false })

    await PolicyWorker.stop()
    const failed = {
      guarded: await (await gateFor("guarded")).evaluateIsolated("bash", { command }),
      autonomous: await (await gateFor("autonomous")).evaluateIsolated("bash", { command }),
      full_access: await (await gateFor("full_access")).evaluateIsolated("bash", { command }),
    }

    // guarded and autonomous remain the same conservative transient denial, and
    // remain identical to each other apart from the profile that answered.
    expect(failed.guarded).toEqual({ ...failed.autonomous, profileId: "guarded" })
    expect(failed.autonomous).toMatchObject({
      decision: "deny",
      opaque: true,
      refusal: { permanent: false, matchedPermission: "protected_op" },
      capabilities: [{ class: "protected_op", nonBypassable: true, opaque: true }],
    })

    // full_access is the only profile that differs, and only here: the decision
    // is the same allow as above, while the failure stays visible for audit and
    // no refusal is emitted.
    expect(failed.full_access.decision).toBe(healthy.full_access.decision)
    expect(failed.full_access.opaque).toBe(true)
    expect(failed.full_access.refusal).toBeUndefined()
    expect(failed.full_access.capabilities).toMatchObject([{ class: "protected_op", nonBypassable: true }])
  })
})
