import { describe, expect, test } from "bun:test"
import { ApprovalCache } from "../../src/enforcement/gate"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

// ------------------------------------------------------------------
// ApprovalCache unit tests
// ------------------------------------------------------------------
describe("ApprovalCache", () => {
  test("get returns null for unknown key", () => {
    const cache = new ApprovalCache()
    expect(cache.get("shell")).toBeNull()
  })

  test("put stores a decision and get retrieves it", () => {
    const cache = new ApprovalCache()
    cache.put("shell", "approved_for_session")
    expect(cache.get("shell")).toBe("approved_for_session")
  })

  test("put overwrites previous entry", () => {
    const cache = new ApprovalCache()
    cache.put("shell", "approved_for_session")
    cache.put("shell", "denied")
    expect(cache.get("shell")).toBe("denied")
  })

  test("clear removes all entries", () => {
    const cache = new ApprovalCache()
    cache.put("shell", "approved_for_session")
    cache.put("network_request", "denied")
    cache.clear()
    expect(cache.get("shell")).toBeNull()
    expect(cache.get("network_request")).toBeNull()
  })

  test("different keys don't interfere", () => {
    const cache = new ApprovalCache()
    cache.put("shell", "approved_for_session")
    cache.put("network_request", "denied")
    expect(cache.get("shell")).toBe("approved_for_session")
    expect(cache.get("network_request")).toBe("denied")
  })
})

// ------------------------------------------------------------------
// EnforcementGate approval cache integration tests
// ------------------------------------------------------------------
describe("EnforcementGate approval cache", () => {
  test("first evaluate with shell returns ask; approveCapability makes second evaluate return allow", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "guarded",
        })

        // guarded profile asks for shell execution
        const first = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(first.decision).toBe("ask")

        // Approve the capability for this session
        gate.approveCapability(first.capabilities)

        // Second evaluate with same capability should now be "allow"
        const second = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(second.decision).toBe("allow")
      },
    })
  })

  test("different capability classes do not share cache entries", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "guarded",
        })

        // guarded profile asks for shell execution
        const shellEnvelope = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(shellEnvelope.decision).toBe("ask")

        // Approve only shell
        gate.approveCapability(shellEnvelope.capabilities)

        // Now shell should be cached as approved
        const cachedShell = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(cachedShell.decision).toBe("allow")

        // But email_read (communication_email) should still ask
        const emailEnvelope = gate.evaluate("email_read", {})
        expect(emailEnvelope.decision).toBe("ask")
      },
    })
  })

  test("clearApprovalCache resets all cached decisions", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "guarded",
        })

        // First evaluation asks
        const first = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(first.decision).toBe("ask")

        // Approve
        gate.approveCapability(first.capabilities)

        // Second evaluation should be allow
        const second = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(second.decision).toBe("allow")

        // Clear the cache
        gate.clearApprovalCache()

        // Third evaluation should ask again
        const third = gate.evaluate("bash", {
          command: "bun dev generate 2>/dev/null",
        })
        expect(third.decision).toBe("ask")
      },
    })
  })

  test("cached allow does not override profile deny decisions", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const { EnforcementGate } = await import("../../src/enforcement/gate")
        const gate = await EnforcementGate.create({
          activeWorkspace: Instance.directory,
          workspaceType: "main",
          profileId: "autonomous",
        })
        // autonomous profile denies destructive shell commands
        const deniedEnvelope = gate.evaluate("bash", {
          command: "git push",
        })
        expect(deniedEnvelope.decision).toBe("deny")

        // Second evaluation of same destructive command — still denied
        const again = gate.evaluate("bash", { command: "git push" })
        expect(again.decision).toBe("deny")
      },
    })
  })
})
