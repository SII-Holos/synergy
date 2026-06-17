import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// control-profile/compiler.test.ts
//
// Tests for the ControlProfile compiler — profile definitions, policy
// generation, PermissionNext ruleset output, and interaction-mode gating.
//
// These tests encode the DESIGN CONTRACT before implementation exists.
// They MUST fail (RED) with module-not-found or type errors until
// packages/synergy/src/control-profile/compiler.ts is created.
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// 1. Profile identity — exactly four built-in profiles
// ------------------------------------------------------------------
describe("ControlProfile identity", () => {
  test("exposes exactly four built-in profile ids", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")
    const ids = ControlProfileCompiler.profileIds
    expect(ids).toBeDefined()
    expect(Array.isArray(ids)).toBe(true)
    expect(ids.length).toBe(4)
    expect(ids).toContain("review")
    expect(ids).toContain("workspace")
    expect(ids).toContain("auto_review")
    expect(ids).toContain("full_access")
  })

  test("each profile has a non-empty label", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    for (const id of ["review", "workspace", "auto_review", "full_access"] as const) {
      const profile = ControlProfileCompiler.getProfile(id)
      expect(profile).toBeDefined()
      expect(typeof profile.label).toBe("string")
      expect(profile.label.length).toBeGreaterThan(0)
    }
  })

  test("review profile has 审阅 label", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")
    const profile = ControlProfileCompiler.getProfile("review")
    expect(profile.label).toBe("审阅")
  })

  test("workspace profile has 工作区 label", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")
    const profile = ControlProfileCompiler.getProfile("workspace")
    expect(profile.label).toBe("工作区")
  })

  test("auto_review profile has 自动审查 label", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")
    const profile = ControlProfileCompiler.getProfile("auto_review")
    expect(profile.label).toBe("自动审查")
  })

  test("full_access profile has 完全访问权限 label", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")
    const profile = ControlProfileCompiler.getProfile("full_access")
    expect(profile.label).toBe("完全访问权限")
  })
})

// ------------------------------------------------------------------
// 2. Review profile — read-only workspace
// ------------------------------------------------------------------
describe("review profile policy", () => {
  const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

  test("review denies all file_write capability classes", () => {
    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // file_write must be denied
    const writeRule = profile.ruleset.find((r: any) => r.permission === "file_write")
    expect(writeRule).toBeDefined()
    expect(writeRule.action).toBe("deny")
  })

  test("review denies shell", () => {
    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const shellRule = profile.ruleset.find((r: any) => r.permission === "shell")
    expect(shellRule).toBeDefined()
    expect(shellRule.action).toBe("deny")
  })

  test("review denies network_request", () => {
    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const netRule = profile.ruleset.find((r: any) => r.permission === "network_request")
    expect(netRule).toBeDefined()
    expect(netRule.action).toBe("deny")
  })

  test("review denies external actions (mcp_invoke, plugin_invoke)", () => {
    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    for (const perm of ["mcp_invoke", "plugin_invoke", "channel_outbound", "communication_email", "identity_act"]) {
      const rule = profile.ruleset.find((r: any) => r.permission === perm)
      expect(rule).toBeDefined()
      expect(rule.action).toBe("deny")
    }
  })

  test("review sandbox policy is read_only", () => {
    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.sandbox).toBeDefined()
    expect(profile.sandbox.mode).toBe("read_only")
  })

  test("review allowAll does NOT bypass review restrictions", () => {
    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // The profile must carry a flag or non-overridable rules so that
    // allowAll never silently grants write/shell/network in review mode.
    expect(profile.allowAllBlocked).toBe(true)
  })
})

// ------------------------------------------------------------------
// 3. workspace profile — read/write workspace, shell ask, network restricted
// ------------------------------------------------------------------
describe("workspace profile policy", () => {
  const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

  test("workspace allows file_read and file_write inside workspace", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const readRule = profile.ruleset.find((r: any) => r.permission === "file_read")
    expect(readRule).toBeDefined()
    expect(readRule.action).toBe("allow")

    const writeRule = profile.ruleset.find((r: any) => r.permission === "file_write")
    expect(writeRule).toBeDefined()
    expect(writeRule.action).toBe("allow")
  })

  test("workspace sets shell to ask", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const shellRule = profile.ruleset.find((r: any) => r.permission === "shell")
    expect(shellRule).toBeDefined()
    expect(shellRule.action).toBe("ask")
  })

  test("workspace sets network_request to ask (restricted)", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const netRule = profile.ruleset.find((r: any) => r.permission === "network_request")
    expect(netRule).toBeDefined()
    expect(netRule.action).toBe("ask")
  })

  test("workspace marks file_external, shell_destructive, identity_act, communication, platform_control, mcp_invoke, plugin_invoke as nonBypassable", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const nonBypassablePerms = [
      "file_external",
      "shell_destructive",
      "identity_act",
      "communication_email",
      "channel_outbound",
      "platform_control",
      "mcp_invoke",
      "plugin_invoke",
    ]

    for (const perm of nonBypassablePerms) {
      const rule = profile.ruleset.find((r: any) => r.permission === perm)
      expect(rule).toBeDefined()
      expect(rule.action).toBe("ask")
      // NonBypassable categories must carry metadata marking them as such
      expect(rule.nonBypassable).toBe(true)
    }
  })

  test("workspace sandbox mode is workspace_write", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.sandbox).toBeDefined()
    expect(profile.sandbox.mode).toBe("workspace_write")
  })

  test("workspace filesystem policy permits reads/writes inside workspace", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.filesystem).toBeDefined()
    // writeRoots must include the workspace
    expect(profile.filesystem.writeRoots).toContain("/Users/test/project")
  })
})

// ------------------------------------------------------------------
// 4. auto_review profile — same boundaries as workspace, different approval
// ------------------------------------------------------------------
describe("auto_review profile matches workspace boundaries", () => {
  const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

  test("auto_review filesystem policy is identical to workspace", () => {
    const workspaceProfile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })
    const autoReviewProfile = ControlProfileCompiler.resolve("auto_review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // Filesystem boundaries must match exactly
    expect(autoReviewProfile.filesystem).toEqual(workspaceProfile.filesystem)
  })

  test("auto_review network policy is identical to workspace", () => {
    const workspaceProfile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })
    const autoReviewProfile = ControlProfileCompiler.resolve("auto_review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(autoReviewProfile.network).toEqual(workspaceProfile.network)
  })

  test("auto_review sandbox policy is identical to workspace", () => {
    const workspaceProfile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })
    const autoReviewProfile = ControlProfileCompiler.resolve("auto_review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(autoReviewProfile.sandbox).toEqual(workspaceProfile.sandbox)
  })

  test("auto_review approvalPolicy differs from workspace approvalPolicy", () => {
    const workspaceProfile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })
    const autoReviewProfile = ControlProfileCompiler.resolve("auto_review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // Approval policy must be structurally different — auto_review can
    // auto-approve low-risk actions but must escalate high-risk.
    expect(autoReviewProfile.approvalPolicy).not.toEqual(workspaceProfile.approvalPolicy)
    expect(typeof autoReviewProfile.approvalPolicy).toBe("object")
  })

  test("auto_review approves low-risk file_read actions", () => {
    const profile = ControlProfileCompiler.resolve("auto_review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // auto_review guardian may auto-approve low-risk reads
    expect(profile.approvalPolicy.autoApprovePatterns).toBeDefined()
    expect(Array.isArray(profile.approvalPolicy.autoApprovePatterns)).toBe(true)
  })

  test("auto_review never silently approves nonBypassable categories", () => {
    const profile = ControlProfileCompiler.resolve("auto_review", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // The approval policy must forbid silent approval of nonBypassable
    // capabilities; auto_review is a guardian, not a bypass.
    expect(profile.approvalPolicy.silentApproveNonBypassable).toBe(false)
  })
})

// ------------------------------------------------------------------
// 5. full_access profile — unrestricted filesystem/network, no OS sandbox
// ------------------------------------------------------------------
describe("full_access profile policy", () => {
  const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

  test("full_access allows full filesystem read/write", () => {
    const profile = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const readRule = profile.ruleset.find((r: any) => r.permission === "file_read")
    expect(readRule).toBeDefined()
    expect(readRule.action).toBe("allow")

    const writeRule = profile.ruleset.find((r: any) => r.permission === "file_write")
    expect(writeRule).toBeDefined()
    expect(writeRule.action).toBe("allow")

    const extRule = profile.ruleset.find((r: any) => r.permission === "file_external")
    expect(extRule).toBeDefined()
    expect(extRule.action).toBe("allow")
  })

  test("full_access allows shell and network", () => {
    const profile = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    const shellRule = profile.ruleset.find((r: any) => r.permission === "shell")
    expect(shellRule).toBeDefined()
    expect(shellRule.action).toBe("allow")

    const netRule = profile.ruleset.find((r: any) => r.permission === "network_request")
    expect(netRule).toBeDefined()
    expect(netRule.action).toBe("allow")
  })

  test("full_access has no OS sandbox", () => {
    const profile = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.sandbox).toBeDefined()
    expect(profile.sandbox.mode).toBe("none")
  })

  test("full_access still marks communication/identity outbound actions as nonBypassable", () => {
    const profile = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // Even in full_access, sending email, acting as identity, or platform
    // control must be nonBypassable — user must confirm.
    const nonBypassablePerms = ["identity_act", "communication_email", "channel_outbound", "platform_control"]
    for (const perm of nonBypassablePerms) {
      const rule = profile.ruleset.find((r: any) => r.permission === perm)
      expect(rule).toBeDefined()
      expect(rule.nonBypassable).toBe(true)
    }
  })

  test("full_access is forbidden in unattended interaction mode", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    // full_access must not compile or must return a denied/error result
    // when interaction mode is unattended.
    const result = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
      interactionMode: "unattended",
    })

    // Either the resolution rejects the profile entirely or marks it invalid
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("unattended")
  })

  test("full_access is valid in attended mode", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    const result = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
      interactionMode: "attended",
    })

    expect(result.valid).toBe(true)
  })
})

// ------------------------------------------------------------------
// 6. Profile compiler produces PermissionNext ruleset
// ------------------------------------------------------------------
describe("ControlProfile compiler ruleset output", () => {
  const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

  test("resolved profile always includes a PermissionNext-compatible ruleset", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(Array.isArray(profile.ruleset)).toBe(true)
    // Every rule must have permission, pattern, and action fields
    for (const rule of profile.ruleset) {
      expect(typeof rule.permission).toBe("string")
      expect(typeof rule.pattern).toBe("string")
      expect(["allow", "deny", "ask"]).toContain(rule.action)
    }
  })

  test("profile-owned nonBypassable categories are retained after compilation", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    // The nonBypassable flag must survive compilation so that
    // EnforcementGate can enforce it.
    const destructiveShell = profile.ruleset.find((r: any) => r.permission === "shell_destructive")
    expect(destructiveShell).toBeDefined()
    expect(destructiveShell.nonBypassable).toBe(true)
  })

  test("resolved profile contains filesystem policy with readRoots and writeRoots", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.filesystem).toBeDefined()
    expect(Array.isArray(profile.filesystem.readRoots)).toBe(true)
    expect(Array.isArray(profile.filesystem.writeRoots)).toBe(true)
    expect(Array.isArray(profile.filesystem.protectedPaths)).toBe(true)
  })

  test("resolved profile contains network policy with mode", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.network).toBeDefined()
    expect(["disabled", "restricted", "enabled"]).toContain(profile.network.mode)
  })

  test("resolved profile contains sandbox policy with mode and fallback", () => {
    const profile = ControlProfileCompiler.resolve("workspace", {
      workspace: "/Users/test/project",
      workspaceType: "worktree",
    })

    expect(profile.sandbox).toBeDefined()
    expect(["none", "workspace_write", "read_only"]).toContain(profile.sandbox.mode)
    expect(["deny", "warn", "allow"]).toContain(profile.sandbox.fallback)
  })
})

// ------------------------------------------------------------------
// 7. Worktree invariant
// ------------------------------------------------------------------
describe("ControlProfile worktree boundary", () => {
  test("worktree session active workspace is the worktree path", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    const profile = ControlProfileCompiler.resolve("review", {
      workspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    // The filesystem policy must reflect the worktree path as the active root
    expect(profile.filesystem.readRoots).toContain("/Users/test/synergy-control-profile")
  })

  test("original checkout is external under review/workspace/auto_review", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    for (const id of ["review", "workspace", "auto_review"] as const) {
      const profile = ControlProfileCompiler.resolve(id, {
        workspace: "/Users/test/synergy-control-profile",
        workspaceType: "worktree",
      })

      // The original checkout path (/Users/test/synergy) must be treated
      // as external — not inside any of the readRoots or writeRoots.
      const allRoots = [...profile.filesystem.readRoots, ...profile.filesystem.writeRoots]
      const originalCheckout = "/Users/test/synergy"
      const isInside = allRoots.some((r: string) => originalCheckout.startsWith(r))
      expect(isInside).toBe(false)
    }
  })

  test("full_access opens original checkout and sibling worktrees", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    const profile = ControlProfileCompiler.resolve("full_access", {
      workspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    // full_access has unrestricted filesystem; readRoots should be broad
    // enough to cover the original checkout.
    expect(profile.filesystem.readRoots).toContain("/")
  })
})

// ------------------------------------------------------------------
// 8. Profile ID type safety and validation
// ------------------------------------------------------------------
describe("ControlProfile validation", () => {
  test("getProfile throws on unknown profile id", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    expect(() => ControlProfileCompiler.getProfile("nonexistent" as any)).toThrow()
  })

  test("resolve throws on unknown profile id", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    expect(() =>
      ControlProfileCompiler.resolve("bogus" as any, {
        workspace: "/Users/test/project",
        workspaceType: "worktree",
      }),
    ).toThrow()
  })

  test("resolve requires workspace context", () => {
    const { ControlProfileCompiler } = require("../../src/control-profile/compiler")

    expect(() => ControlProfileCompiler.resolve("review", {} as any)).toThrow()
  })
})
