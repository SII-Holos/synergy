import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// enforcement/gate.test.ts
//
// Tests for the EnforcementGate — the centralized choke point that classifies
// tool calls into capabilities, applies profile-based rules, and produces
// execution envelopes with audit records.
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// 1. Path classification through the gate — worktree boundary
// ------------------------------------------------------------------
describe("EnforcementGate path classification", () => {
  test("read within active worktree is classified as file_read (inside)", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("read", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    expect(result.capabilities).toBeDefined()
    expect(result.capabilities.length).toBeGreaterThan(0)

    // The primary capability is file_read — an inside-workspace read
    const primary = result.capabilities.find((c: any) => c.class === "file_read")
    expect(primary).toBeDefined()
    expect(primary.nonBypassable).toBe(false)
  })

  test("read of original checkout in worktree is classified as file_external + nonBypassable", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    // The original checkout is a sibling directory, not inside the
    // active worktree workspace.
    const result = gate.classify("read", {
      filePath: "/Users/test/synergy/src/index.ts",
    })

    const external = result.capabilities.find((c: any) => c.class === "file_external")
    expect(external).toBeDefined()
    expect(external.nonBypassable).toBe(true)
  })

  test("read of home directory is classified as file_external + nonBypassable", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("read", {
      filePath: "/Users/test/.ssh/id_rsa",
    })

    const external = result.capabilities.find((c: any) => c.class === "file_external")
    expect(external).toBeDefined()
    expect(external.nonBypassable).toBe(true)
  })

  test("write within active worktree is classified as file_write (inside)", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("write", {
      filePath: "/Users/test/synergy-control-profile/src/app.ts",
    })

    const primary = result.capabilities.find((c: any) => c.class === "file_write")
    expect(primary).toBeDefined()
    // Inside workspace write is not nonBypassable by itself
    expect(primary.nonBypassable).toBe(false)
  })

  test("write outside active workspace is classified as file_external", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("write", {
      filePath: "/tmp/output.log",
    })

    const external = result.capabilities.find((c: any) => c.class === "file_external")
    expect(external).toBeDefined()
    expect(external.nonBypassable).toBe(true)
  })

  test("revise_file target path is classified from hashline patch header", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("revise_file", {
      input: "[/tmp/output.log#A1B2]\nSWAP 1..1:\n+updated\n",
    })

    const external = result.capabilities.find((c: any) => c.class === "file_external")
    expect(external).toBeDefined()
    expect(external.nonBypassable).toBe(true)
  })
})

// ------------------------------------------------------------------
// 2. Shell classification
// ------------------------------------------------------------------
describe("EnforcementGate shell classification", () => {
  test("simple ls within workspace is classified as shell_read", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "ls -la",
      workdir: "/Users/test/synergy-control-profile",
    })

    const shell = result.capabilities.find((c: any) => c.class === "shell_read")
    expect(shell).toBeDefined()
  })

  test("build commands are classified as approval-required shell", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "bun run build 2>&1 | head -30",
      workdir: "/Users/test/synergy-control-profile",
    })

    const shell = result.capabilities.find((c: any) => c.class === "shell")
    expect(shell).toBeDefined()
  })

  test("read-only inspection with stderr redirected to /dev/null remains shell_read", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "ls -la script/generate.ts 2>/dev/null; head -50 script/generate.ts 2>/dev/null || true",
      workdir: "/Users/test/synergy-control-profile",
    })

    const classNames = result.capabilities.map((c: any) => c.class)
    expect(classNames).toContain("shell_read")
    expect(classNames).not.toContain("file_external")
  })

  test("rm -rf is classified as shell_destructive", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "rm -rf node_modules",
    })

    const destructive = result.capabilities.find((c: any) => c.class === "shell_destructive")
    expect(destructive).toBeDefined()
    expect(destructive.nonBypassable).toBe(true)
  })

  test("rm targeting protected path is shell_destructive + file_external", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "rm -rf /etc/config",
    })

    const destructive = result.capabilities.find((c: any) => c.class === "shell_destructive")
    expect(destructive).toBeDefined()

    const external = result.capabilities.find((c: any) => c.class === "file_external")
    expect(external).toBeDefined()
  })

  test("command targeting external path produces file_external capability", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "cat /etc/passwd",
    })

    const external = result.capabilities.find((c: any) => c.class === "file_external")
    expect(external).toBeDefined()
    expect(external.nonBypassable).toBe(true)
    expect(external.paths).toContain("/etc/passwd")
  })
})

// ------------------------------------------------------------------
// 3. Network classification
// ------------------------------------------------------------------
describe("EnforcementGate network classification", () => {
  test("webfetch tool classifies as network_request", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("webfetch", {
      url: "https://example.com/api/data",
    })

    const net = result.capabilities.find((c: any) => c.class === "network_request")
    expect(net).toBeDefined()
  })

  test("external communication and platform tools classify as nonBypassable", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    expect(gate.classify("email_read", {}).capabilities).toContainEqual({
      class: "communication_email",
      nonBypassable: true,
    })
    expect(gate.classify("arxiv_search", {}).capabilities).toContainEqual({
      class: "network_request",
      nonBypassable: true,
    })

    const inspire = gate.classify("inspire_submit", {}).capabilities
    expect(inspire).toContainEqual({ class: "network_request", nonBypassable: true })
    expect(inspire).toContainEqual({ class: "platform_control", nonBypassable: true })
  })

  test("agora collaboration tools classify as external network and platform control", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    expect(gate.classify("agora_read", {}).capabilities).toContainEqual({
      class: "network_request",
      nonBypassable: true,
    })

    const post = gate.classify("agora_post", {}).capabilities
    expect(post).toContainEqual({ class: "network_request", nonBypassable: true })
    expect(post).toContainEqual({ class: "platform_control", nonBypassable: true })

    const join = gate.classify("agora_join", { directory: "/tmp/agora-workspace" }).capabilities
    expect(join).toContainEqual({ class: "network_request", nonBypassable: true })
    expect(join).toContainEqual({ class: "platform_control", nonBypassable: true })
    expect(join).toContainEqual(
      expect.objectContaining({ class: "file_external", nonBypassable: true, paths: ["/tmp/agora-workspace"] }),
    )
  })

  test("manual profile asks for external network and communication tools", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "manual",
    })

    expect(gate.evaluate("webfetch", { url: "https://example.com" }).decision).toBe("ask")
    expect(gate.evaluate("email_read", {}).decision).toBe("ask")
    expect(gate.evaluate("inspire_submit", {}).decision).toBe("ask")
  })
})

// ------------------------------------------------------------------
// 4. Gate produces execution envelope and audit
// ------------------------------------------------------------------
describe("EnforcementGate execution envelope", () => {
  test("evaluate returns envelope with profile and capabilities", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("read", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    expect(envelope).toBeDefined()
    expect(typeof envelope.canAutoApprove).toBe("function")

    // In workspace profile, inside-workspace reads are low-risk
    expect(envelope.canAutoApprove()).toBe(true)
  })

  test("evaluate for external read produces non-auto-approvable envelope", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("read", {
      filePath: "/Users/test/synergy/src/main.ts",
    })

    // External reads are nonBypassable => cannot auto-approve
    expect(envelope.canAutoApprove()).toBe(false)
  })

  test("evaluate on shell_destructive cannot auto-approve", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("bash", {
      command: "rm -rf /some/path",
    })

    expect(envelope.canAutoApprove()).toBe(false)
  })

  test("audit record is produced for each evaluation", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    // Clear any prior audit state
    gate.clearAudit()

    gate.evaluate("read", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    const records = gate.getAuditRecords()
    expect(records).toBeDefined()
    expect(records.length).toBe(1)
    expect(records[0].tool).toBe("read")
    expect(records[0].capabilities).toBeDefined()
    expect(Array.isArray(records[0].capabilities)).toBe(true)
    expect(typeof records[0].timestamp).toBe("number")
  })

  test("audit records accumulate across multiple evaluations", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    gate.clearAudit()
    gate.evaluate("read", { filePath: "/Users/test/synergy-control-profile/a.ts" })
    gate.evaluate("write", { filePath: "/Users/test/synergy-control-profile/b.ts" })
    gate.evaluate("bash", { command: "ls" })

    const records = gate.getAuditRecords()
    expect(records.length).toBe(3)
  })
})

// ------------------------------------------------------------------
// 5. Profile-driven gating
// ------------------------------------------------------------------
describe("EnforcementGate profile integration", () => {
  test("gate with manual profile asks for write tool", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "manual",
    })

    const envelope = gate.evaluate("write", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    expect(envelope.decision).toBe("ask")
  })

  test("gate with manual profile asks for shell", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "manual",
    })

    const envelope = gate.evaluate("bash", {
      command: "ls",
    })

    expect(envelope.decision).toBe("ask")
  })

  test("manual profile asks for read tool", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "manual",
    })

    const envelope = gate.evaluate("read", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    expect(envelope.decision).toBe("ask")
  })

  test("gate with guarded profile asks for inside-workspace write", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("write", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    expect(envelope.decision).toBe("ask")
  })

  test("gate with guarded profile allows safe read-only shell and asks for ordinary shell", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    expect(gate.evaluate("bash", { command: "ls -la" }).decision).toBe("allow")
    expect(gate.evaluate("bash", { command: "bun dev generate 2>/dev/null" }).decision).toBe("ask")
  })

  test("gate with autonomous profile has same boundaries as guarded but denies high risk", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "autonomous",
    })

    const envelope = gate.evaluate("read", {
      filePath: "/Users/test/synergy-control-profile/src/index.ts",
    })

    expect(envelope.decision).toBe("allow")
    expect(envelope.profileId).toBe("autonomous")

    const shell = gate.evaluate("bash", {
      command: "bun run build",
    })
    expect(shell.decision).toBe("allow")

    const external = gate.evaluate("read", {
      filePath: "/etc/hosts",
    })
    expect(external.decision).toBe("deny")
  })

  test("gate with full_access allows external reads", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "full_access",
      interactionMode: "attended",
    })

    const envelope = gate.evaluate("read", {
      filePath: "/etc/hosts",
    })

    // full_access allows reading anywhere
    expect(envelope.decision).toBe("allow")
  })

  test("gate rejects full_access in unattended mode", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")

    // Creating a gate with full_access + unattended must fail
    expect(() =>
      EnforcementGate.create({
        activeWorkspace: "/Users/test/synergy-control-profile",
        workspaceType: "worktree",
        profileId: "full_access",
        interactionMode: "unattended",
      }),
    ).toThrow()
  })
})

// ------------------------------------------------------------------
// 6. Duplicate capability guard
// ------------------------------------------------------------------
describe("EnforcementGate duplicate capability guard", () => {
  test("gate prevents duplicate ask for same capability from same tool call", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    // First eval — produces envelope with pending capabilities
    gate.evaluate("write", {
      filePath: "/Users/test/synergy-control-profile/src/a.ts",
    })

    // Second eval with same capability should not create a duplicate
    // pending — either it's already resolved or it's still pending.
    // Implementations may vary: re-ask, reuse, or error.
    // The contract: gate tracks ownership of capabilities.
    expect(gate.hasPendingCapability("file_write")).toBe(true)
  })

  test("gate resolves pending capability on decision", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    gate.evaluate("write", {
      filePath: "/Users/test/synergy-control-profile/src/a.ts",
    })

    expect(gate.hasPendingCapability("file_write")).toBe(true)

    // Mark the capability as resolved
    gate.resolveCapability("file_write")

    expect(gate.hasPendingCapability("file_write")).toBe(false)
  })
})

// ------------------------------------------------------------------
// 7. Argument-aware multi-capability classification
// ------------------------------------------------------------------
describe("EnforcementGate multi-capability classification", () => {
  test("one tool call can produce multiple capabilities", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    // bash with a command that touches external paths
    const result = gate.classify("bash", {
      command: "curl https://api.example.com | tee /tmp/output.log",
    })

    // Should produce shell, network_request, and file_external
    const classNames = result.capabilities.map((c: any) => c.class)
    expect(classNames).toContain("shell")
    expect(classNames).toContain("network_request")
    expect(classNames).toContain("file_external")
  })

  test("multi-capability result preserves nonBypassable on external capabilities", () => {
    const { EnforcementGate } = require("../../src/enforcement/gate")
    const gate = EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("bash", {
      command: "curl https://example.com -o /tmp/data.json",
    })

    // All capabilities that touch external should be nonBypassable
    for (const cap of result.capabilities) {
      if (cap.class === "file_external" || cap.class === "network_request") {
        expect(cap.nonBypassable).toBe(true)
      }
    }
  })
})
