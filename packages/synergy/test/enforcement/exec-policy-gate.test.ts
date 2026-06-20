import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// enforcement/exec-policy-gate.test.ts
//
// Integration RED tests verifying ExecPolicy hooks into EnforcementGate.
// These test that bash tool invocations are routed through the exec-policy
// system before the gate produces its final enforcement decision.
// ---------------------------------------------------------------------------

import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

// ------------------------------------------------------------------
// 6. Gate Integration with ExecPolicy
// ------------------------------------------------------------------
describe("EnforcementGate exec-policy integration", () => {
  test("gate.evaluate with bash tool and allow rule returns no capabilities for shell", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const { parsePrefixRule } = await import("../../src/enforcement/exec-policy")

        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "guarded",
          execPolicy: { rules: [parsePrefixRule("allow git status")!] },
        })

        const envelope = gate.evaluate("bash", {
          command: "git status",
          workdir: Instance.directory,
        })

        // When execPolicy says "allow", the gate should not escalate to shell
        // capability — the policy has already authorized this command.
        const shellCaps = envelope.capabilities.filter((c: any) => c.class.startsWith("shell"))
        expect(shellCaps).toEqual([])
        // Decision must be "allow" since the policy authorized it
        expect(envelope.decision).toBe("allow")
      },
    })
  })

  test("gate.evaluate with bash tool and forbidden rule returns shell hardline", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const { parsePrefixRule } = await import("../../src/enforcement/exec-policy")

        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "guarded",
          execPolicy: { rules: [parsePrefixRule("forbid rm -rf")!] },
        })

        const envelope = gate.evaluate("bash", {
          command: "rm -rf node_modules",
        })

        // A forbidden exec-policy rule should produce shell_hardline
        const hardline = envelope.capabilities.find((c: any) => c.class === "shell_hardline")
        expect(hardline).toBeDefined()
        expect(hardline!.nonBypassable).toBe(true)
        // Decision must be "deny"
        expect(envelope.decision).toBe("deny")
      },
    })
  })

  test("gate.evaluate with bash tool and prompt rule performs normal classify", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const { parsePrefixRule } = await import("../../src/enforcement/exec-policy")

        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "guarded",
          execPolicy: { rules: [parsePrefixRule("ask bun run build")!] },
        })

        const envelope = gate.evaluate("bash", {
          command: "bun run build 2>&1 | head -30",
          workdir: Instance.directory,
        })

        // When execPolicy says "ask" (prompt), the gate should still perform
        // normal capability classification so the user can see what's at stake.
        const shellCap = envelope.capabilities.find((c: any) => c.class === "shell" || c.class === "shell_read")
        expect(shellCap).toBeDefined()
        // Decision must be "ask" since policy requires a prompt
        expect(envelope.decision).toBe("ask")
      },
    })
  })
})
