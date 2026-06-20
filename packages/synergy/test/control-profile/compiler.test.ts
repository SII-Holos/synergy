import { describe, expect, test } from "bun:test"
import { ControlProfileCompiler } from "../../src/control-profile/compiler"
import type { ResolvedProfile } from "../../src/control-profile/types"

const context = {
  workspace: "/Users/test/project",
  workspaceType: "worktree",
}

function rule(profile: ResolvedProfile, permission: string) {
  return profile.ruleset.find((r) => r.permission === permission)
}

describe("ControlProfile identity", () => {
  test("exposes exactly three built-in profile ids", () => {
    expect(ControlProfileCompiler.profileIds).toEqual(["guarded", "autonomous", "full_access"])
  })

  test("each profile has an English label", async () => {
    const labels = await Promise.all(
      ControlProfileCompiler.profileIds.map(async (id) => {
        const profile = await ControlProfileCompiler.getProfile(id)
        return profile.label
      }),
    )
    expect(labels).toEqual(["Guarded", "Autonomous", "Full Access"])
  })

  test("unknown profile ids normalize to guarded", () => {
    expect(ControlProfileCompiler.normalize("bogus")).toBe("guarded")
  })
})

describe("guarded profile policy", () => {
  test("auto-allows safe reads, workspace writes, and network while asking for riskier capabilities", async () => {
    const profile = await ControlProfileCompiler.resolve("guarded", context)
    expect(profile.approval).toMatchObject({ lowRisk: "allow", mediumRisk: "ask", highRisk: "ask" })
    expect(rule(profile, "file_read")?.action).toBe("allow")
    expect(rule(profile, "shell_read")?.action).toBe("allow")
    expect(rule(profile, "file_write")?.action).toBe("allow")
    expect(rule(profile, "network_request")?.action).toBe("allow")
    expect(rule(profile, "shell")?.action).toBe("ask")
    expect(rule(profile, "file_external")?.action).toBe("ask")
    expect(rule(profile, "shell_hardline")?.action).toBe("deny")
    expect(rule(profile, "shell_destructive")?.nonBypassable).toBe(true)
  })

  test("keeps the workspace boundary", async () => {
    const profile = await ControlProfileCompiler.resolve("guarded", context)
    expect(profile.filesystem.writeRoots).toContain(context.workspace)
    expect(profile.sandbox.mode).toBe("workspace_write")
    expect(profile.network.mode).toBe("restricted")
  })
})

describe("autonomous profile policy", () => {
  test("auto-allows most capabilities, denies only shell_hardline", async () => {
    const profile = await ControlProfileCompiler.resolve("autonomous", context)
    expect(profile.approval).toMatchObject({ lowRisk: "allow", mediumRisk: "allow", highRisk: "deny" })
    expect(rule(profile, "file_read")?.action).toBe("allow")
    expect(rule(profile, "shell_read")?.action).toBe("allow")
    expect(rule(profile, "file_write")?.action).toBe("allow")
    expect(rule(profile, "shell")?.action).toBe("allow")
    expect(rule(profile, "file_external")?.action).toBe("allow")
    expect(rule(profile, "platform_control")?.action).toBe("allow")
    expect(rule(profile, "shell_destructive")?.action).toBe("ask")
    expect(rule(profile, "shell_hardline")?.action).toBe("deny")
  })

  test("shares network and sandbox boundaries with guarded while allowing full read", async () => {
    const guarded = await ControlProfileCompiler.resolve("guarded", context)
    const autonomous = await ControlProfileCompiler.resolve("autonomous", context)
    expect(autonomous.filesystem.readRoots).toEqual(["/"])
    expect(autonomous.filesystem.writeRoots).toEqual(guarded.filesystem.writeRoots)
    expect(autonomous.network).toEqual(guarded.network)
    expect(autonomous.sandbox).toEqual(guarded.sandbox)
  })
})

describe("full_access profile policy", () => {
  test("allows all capability classes without a sandbox", async () => {
    const profile = await ControlProfileCompiler.resolve("full_access", context)
    expect(profile.approval).toMatchObject({ lowRisk: "allow", mediumRisk: "allow", highRisk: "allow" })
    expect(profile.filesystem.readRoots).toContain("/")
    expect(profile.filesystem.writeRoots).toContain("/")
    expect(profile.sandbox.mode).toBe("none")
    expect(rule(profile, "identity_act")?.action).toBe("allow")
  })

  test("is forbidden in unattended interaction mode", async () => {
    const result = await ControlProfileCompiler.resolve("full_access", {
      ...context,
      interactionMode: "unattended",
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("unattended")
  })
})

describe("ControlProfile compiler output", () => {
  test("resolved profile includes PermissionNext-compatible rules", async () => {
    const profile = await ControlProfileCompiler.resolve("guarded", context)
    expect(Array.isArray(profile.ruleset)).toBe(true)
    for (const item of profile.ruleset) {
      expect(typeof item.permission).toBe("string")
      expect(typeof item.pattern).toBe("string")
      expect(["allow", "deny", "ask"]).toContain(item.action)
    }
  })

  test("resolved profile contains filesystem, network, sandbox, and summary metadata", async () => {
    const profile = await ControlProfileCompiler.resolve("autonomous", context)
    expect(Array.isArray(profile.filesystem.readRoots)).toBe(true)
    expect(["disabled", "restricted", "enabled"]).toContain(profile.network.mode)
    expect(["none", "workspace_write", "read_only"]).toContain(profile.sandbox.mode)
    expect(profile.summary?.approval.mode).toBe("autonomous")
  })

  test("requires workspace context", async () => {
    await expect(ControlProfileCompiler.resolve("guarded", {} as any)).rejects.toThrow()
  })
})
