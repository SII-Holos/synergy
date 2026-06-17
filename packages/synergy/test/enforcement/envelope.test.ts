import { test, expect, describe } from "bun:test"
import { CapabilityRequest } from "../../src/enforcement/capability"
import { ExecutionEnvelope } from "../../src/enforcement/envelope"
import { WorkspacePolicy } from "../../src/workspace/policy"

describe("CapabilityRequest", () => {
  // === Requirement 1: CapabilityRequest carries permission + workspace boundary info ===

  test("constructs with permission and workspace boundary metadata", () => {
    const req = new CapabilityRequest({
      permission: "bash",
      patterns: ["rm -rf /"],
      metadata: {
        workspaceBoundary: true,
        outsideWorkspace: true,
        targetPath: "/etc/passwd",
      },
    })

    expect(req.permission).toBe("bash")
    expect(req.patterns).toEqual(["rm -rf /"])
    expect(req.metadata.workspaceBoundary).toBe(true)
    expect(req.metadata.outsideWorkspace).toBe(true)
    expect(req.metadata.targetPath).toBe("/etc/passwd")
  })

  test("constructs without workspace boundary fields for normal operations", () => {
    const req = new CapabilityRequest({
      permission: "edit",
      patterns: ["src/foo.ts"],
      metadata: {},
    })

    expect(req.permission).toBe("edit")
    expect(req.metadata.workspaceBoundary).toBeUndefined()
    expect(req.metadata.outsideWorkspace).toBeUndefined()
  })

  test("marks request as nonBypassable when workspace boundary is crossed", () => {
    const req = new CapabilityRequest({
      permission: "bash",
      patterns: ["cat /etc/shadow"],
      metadata: {
        workspaceBoundary: true,
        outsideWorkspace: true,
        targetPath: "/etc/shadow",
      },
    })

    expect(req.nonBypassable).toBe(true)
  })

  test("does not mark request as nonBypassable for in-workspace operations", () => {
    const req = new CapabilityRequest({
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
    })

    expect(req.nonBypassable).toBe(false)
  })
})

describe("ExecutionEnvelope", () => {
  // === Requirement 2: ExecutionEnvelope wraps a request with policy context ===

  test("envelope carries workspace policy and capability request", () => {
    const req = new CapabilityRequest({
      permission: "bash",
      patterns: ["cat /etc/hostname"],
      metadata: {
        workspaceBoundary: true,
        outsideWorkspace: true,
        targetPath: "/etc/hostname",
      },
    })

    const policy: WorkspacePolicy = {
      activeRoot: "/workspace/synergy",
      workspaceType: "main",
      scopeID: "d_test123",
      contains: (p: string) => p.startsWith("/workspace/synergy"),
    }

    const envelope = new ExecutionEnvelope({ request: req, policy })

    expect(envelope.request).toBe(req)
    expect(envelope.policy).toBe(policy)
    expect(envelope.request.nonBypassable).toBe(true)
  })

  test("envelope with nonBypassable request cannot be auto-approved", () => {
    const req = new CapabilityRequest({
      permission: "bash",
      patterns: ["rm /outside/file"],
      metadata: {
        workspaceBoundary: true,
        outsideWorkspace: true,
        targetPath: "/outside/file",
      },
    })

    const policy: WorkspacePolicy = {
      activeRoot: "/workspace/synergy",
      workspaceType: "main",
      scopeID: "d_test123",
      contains: (p: string) => p.startsWith("/workspace/synergy"),
    }

    const envelope = new ExecutionEnvelope({ request: req, policy })

    expect(envelope.canAutoApprove()).toBe(false)
  })

  test("envelope without boundary crossing can be auto-approved", () => {
    const req = new CapabilityRequest({
      permission: "edit",
      patterns: ["src/app.ts"],
      metadata: {},
    })

    const policy: WorkspacePolicy = {
      activeRoot: "/workspace/synergy",
      workspaceType: "main",
      scopeID: "d_test123",
      contains: (p: string) => p.startsWith("/workspace/synergy"),
    }

    const envelope = new ExecutionEnvelope({ request: req, policy })

    expect(envelope.canAutoApprove()).toBe(true)
  })
})
