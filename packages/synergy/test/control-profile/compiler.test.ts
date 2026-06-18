import { describe, expect, test } from "bun:test"
import { ControlProfileCompiler } from "../../src/control-profile/compiler"

const context = {
  workspace: "/Users/test/project",
  workspaceType: "worktree",
}

function rule(profile: ReturnType<typeof ControlProfileCompiler.resolve>, permission: string) {
  return profile.ruleset.find((r) => r.permission === permission)
}

describe("ControlProfile identity", () => {
  test("exposes exactly four built-in profile ids", () => {
    expect(ControlProfileCompiler.profileIds).toEqual(["manual", "guarded", "autonomous", "full_access"])
  })

  test("each profile has an English label", () => {
    const labels = ControlProfileCompiler.profileIds.map((id) => ControlProfileCompiler.getProfile(id).label)
    expect(labels).toEqual(["Manual Approval", "Guarded", "Autonomous", "Full Access"])
  })

  test("legacy profile ids normalize to the new modes", () => {
    expect(ControlProfileCompiler.normalize("review")).toBe("manual")
    expect(ControlProfileCompiler.normalize("workspace")).toBe("guarded")
    expect(ControlProfileCompiler.normalize("auto_review")).toBe("autonomous")
  })
})

describe("manual profile policy", () => {
  test("asks for low, medium, and high risk capabilities", () => {
    const profile = ControlProfileCompiler.resolve("manual", context)
    expect(profile.approval).toMatchObject({ lowRisk: "ask", mediumRisk: "ask", highRisk: "ask" })
    expect(rule(profile, "file_read")?.action).toBe("ask")
    expect(rule(profile, "file_write")?.action).toBe("ask")
    expect(rule(profile, "shell_destructive")?.action).toBe("ask")
  })

  test("uses workspace sandbox and blocks allow-all bypass", () => {
    const profile = ControlProfileCompiler.resolve("manual", context)
    expect(profile.sandbox.mode).toBe("workspace_write")
    expect(profile.allowAllBlocked).toBe(true)
  })
})

describe("guarded profile policy", () => {
  test("auto-allows ordinary workspace work and asks for high-risk capabilities", () => {
    const profile = ControlProfileCompiler.resolve("guarded", context)
    expect(profile.approval).toMatchObject({ lowRisk: "allow", mediumRisk: "allow", highRisk: "ask" })
    expect(rule(profile, "file_read")?.action).toBe("allow")
    expect(rule(profile, "file_write")?.action).toBe("allow")
    expect(rule(profile, "shell")?.action).toBe("allow")
    expect(rule(profile, "file_external")?.action).toBe("ask")
    expect(rule(profile, "shell_destructive")?.nonBypassable).toBe(true)
  })

  test("keeps the workspace boundary", () => {
    const profile = ControlProfileCompiler.resolve("guarded", context)
    expect(profile.filesystem.writeRoots).toContain(context.workspace)
    expect(profile.sandbox.mode).toBe("workspace_write")
    expect(profile.network.mode).toBe("restricted")
  })
})

describe("autonomous profile policy", () => {
  test("auto-allows low and medium risk work but denies high-risk capabilities", () => {
    const profile = ControlProfileCompiler.resolve("autonomous", context)
    expect(profile.approval).toMatchObject({ lowRisk: "allow", mediumRisk: "allow", highRisk: "deny" })
    expect(rule(profile, "file_read")?.action).toBe("allow")
    expect(rule(profile, "file_write")?.action).toBe("allow")
    expect(rule(profile, "shell")?.action).toBe("allow")
    expect(rule(profile, "file_external")?.action).toBe("deny")
    expect(rule(profile, "platform_control")?.action).toBe("deny")
  })

  test("matches guarded filesystem, network, and sandbox boundaries", () => {
    const guarded = ControlProfileCompiler.resolve("guarded", context)
    const autonomous = ControlProfileCompiler.resolve("autonomous", context)
    expect(autonomous.filesystem).toEqual(guarded.filesystem)
    expect(autonomous.network).toEqual(guarded.network)
    expect(autonomous.sandbox).toEqual(guarded.sandbox)
  })
})

describe("full_access profile policy", () => {
  test("allows all capability classes without a sandbox", () => {
    const profile = ControlProfileCompiler.resolve("full_access", context)
    expect(profile.approval).toMatchObject({ lowRisk: "allow", mediumRisk: "allow", highRisk: "allow" })
    expect(profile.filesystem.readRoots).toContain("/")
    expect(profile.filesystem.writeRoots).toContain("/")
    expect(profile.sandbox.mode).toBe("none")
    expect(rule(profile, "identity_act")?.action).toBe("allow")
  })

  test("is forbidden in unattended interaction mode", () => {
    const result = ControlProfileCompiler.resolve("full_access", {
      ...context,
      interactionMode: "unattended",
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("unattended")
  })
})

describe("ControlProfile compiler output", () => {
  test("resolved profile includes PermissionNext-compatible rules", () => {
    const profile = ControlProfileCompiler.resolve("guarded", context)
    expect(Array.isArray(profile.ruleset)).toBe(true)
    for (const item of profile.ruleset) {
      expect(typeof item.permission).toBe("string")
      expect(typeof item.pattern).toBe("string")
      expect(["allow", "deny", "ask"]).toContain(item.action)
    }
  })

  test("resolved profile contains filesystem, network, sandbox, and summary metadata", () => {
    const profile = ControlProfileCompiler.resolve("autonomous", context)
    expect(Array.isArray(profile.filesystem.readRoots)).toBe(true)
    expect(["disabled", "restricted", "enabled"]).toContain(profile.network.mode)
    expect(["none", "workspace_write", "read_only"]).toContain(profile.sandbox.mode)
    expect(profile.summary?.approval.mode).toBe("autonomous")
  })

  test("requires workspace context", () => {
    expect(() => ControlProfileCompiler.resolve("guarded", {} as any)).toThrow()
  })
})
