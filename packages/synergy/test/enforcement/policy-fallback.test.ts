import { afterEach, describe, expect, test } from "bun:test"
import { EnforcementGate } from "@/enforcement/gate"
import { PolicyWorker } from "@/enforcement/policy-worker"

afterEach(() => {
  PolicyWorker.configure()
})

describe("Policy classification fallback", () => {
  for (const profileId of ["guarded", "autonomous", "full_access"] as const) {
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
})
