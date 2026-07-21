import { describe, expect, test } from "bun:test"
import { ApprovalPolicy } from "../../src/control-profile/approval"
import { buildProfile } from "../../src/control-profile/profiles"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import type { ResolvedProfile } from "../../src/control-profile/types"

const workspace = "/tmp/test"

/** Find a permission rule within a resolved profile's ruleset. */
function rule(profile: ResolvedProfile, permission: string) {
  return profile.ruleset.find((r) => r.permission === permission)
}

async function autonomousProfile() {
  return buildProfile("autonomous", { workspace, workspaceType: "main" })
}

async function guardedProfile() {
  return buildProfile("guarded", { workspace, workspaceType: "main" })
}

describe("autonomous profile capabilities", () => {
  test("autonomous allows file_external_read", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "file_external_read")?.action).toBe("allow")
      },
    })
  })

  test("autonomous denies file_external_write", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "file_external_write")?.action).toBe("deny")
        expect(rule(profile, "file_external_write")?.nonBypassable).toBe(true)
      },
    })
  })

  test("autonomous allows network_request", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "network_request")?.action).toBe("allow")
      },
    })
  })

  test("autonomous allows PR publication while denying generic remote writes", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "shell_remote_publish")?.action).toBe("allow")
        expect(rule(profile, "shell_remote_write")?.action).toBe("deny")
      },
    })
  })

  test("autonomous allows mcp and ordinary delegated capabilities but denies secrets", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "mcp_invoke")?.action).toBe("allow")
        expect(rule(profile, "file_read")?.action).toBe("allow")
        expect(rule(profile, "file_write")?.action).toBe("allow")
        expect(rule(profile, "shell")?.action).toBe("allow")
        expect(rule(profile, "network_request")?.action).toBe("allow")
        expect(rule(profile, "secrets")?.action).toBe("deny")
        expect(rule(profile, "secrets")?.nonBypassable).toBe(true)
      },
    })
  })

  test("autonomous allows identity_act and communication_email", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "identity_act")?.action).toBe("allow")
        expect(rule(profile, "communication_email")?.action).toBe("allow")
      },
    })
  })

  test("autonomous allows platform_control", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "platform_control")?.action).toBe("allow")
      },
    })
  })

  test("autonomous denies shell_hardline", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        const r = rule(profile, "shell_hardline")
        expect(r?.action).toBe("deny")
        expect(r?.nonBypassable).toBe(true)
      },
    })
  })

  test("autonomous has shell_destructive as deny", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "shell_destructive")?.action).toBe("deny")
      },
    })
  })
})

describe("autonomous profile filesystem", () => {
  test("autonomous filesystem has / as readRoots", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.filesystem.readRoots).toContain("/")
      },
    })
  })

  test("autonomous filesystem has workspace as writeRoots", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.filesystem.writeRoots).toEqual([workspace])
      },
    })
  })

  test("autonomous filesystem includes trusted skill roots as writeRoots", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const trustedRoots = ["/tmp/test/.codex/skills", "/tmp/test/.claude/skills"]
        const profile = await buildProfile("autonomous", { workspace, workspaceType: "main", trustedRoots })

        expect(profile.filesystem.writeRoots).toEqual([workspace, ...trustedRoots])
      },
    })
  })

  test("guarded filesystem includes trusted skill roots as writeRoots", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const trustedRoots = ["/tmp/test/.codex/skills", "/tmp/test/.claude/skills"]
        const profile = await buildProfile("guarded", { workspace, workspaceType: "main", trustedRoots })

        expect(profile.filesystem.writeRoots).toEqual([workspace, ...trustedRoots])
        expect(profile.filesystem.readRoots).toEqual([workspace, ...trustedRoots])
      },
    })
  })
})

describe("autonomous profile sandbox", () => {
  test("autonomous sandbox mode is workspace_write", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.sandbox.mode).toBe("workspace_write")
      },
    })
  })
})

describe("profile isolation", () => {
  test("guarded auto-allows low-risk reads while keeping shell gated", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await guardedProfile()
        expect(rule(profile, "file_external_read")?.action).toBe("allow")
        expect(rule(profile, "shell")?.action).toBe("ask")
      },
    })
  })
})

describe("autonomous profile summary", () => {
  test("autonomous deniedCapabilities is derived from its denied rules", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.summary?.deniedCapabilities).toEqual([
          "shell_branch_mutation",
          "shell_remote_write",
          "shell_destructive",
          "shell_hardline",
          "file_external_write",
          "secrets",
          "prompt_transform",
          "compaction_transform",
          "permission_hook",
          "browser_eval_trusted",
        ])
      },
    })
  })
})

describe("autonomous profile approval risk", () => {
  test("delegated task is a low-risk capability and MCP invocation is medium-risk", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(ApprovalPolicy.decidePermission(profile, "task", {}).action).toBe("allow")
        expect(ApprovalPolicy.decidePermission(profile, "mcp_invoke", {}).action).toBe("allow")

        expect(ApprovalPolicy.decidePermission(profile, "secrets", {}).action).toBe("deny")
      },
    })
  })

  test("workspace boundary read metadata remains low risk", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await guardedProfile()
        const decision = ApprovalPolicy.decidePermission(profile, "external_directory", {
          workspaceBoundary: true,
          outsideWorkspace: true,
        })
        expect(decision).toMatchObject({
          action: "allow",
          risk: "low",
          capabilities: ["file_external_read"],
        })

        const approval = ApprovalPolicy.withAudit(ApprovalPolicy.metadata(profile.approval, decision, "auto_allowed"))
        expect(approval.audit?.visible).toBe(false)
      },
    })
  })

  test("audit visibility belongs to approval metadata", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const guarded = await guardedProfile()
        const autonomous = await autonomousProfile()

        const guardedWrite = ApprovalPolicy.decidePermission(guarded, "edit", {})
        const guardedApproval = ApprovalPolicy.withAudit(
          ApprovalPolicy.metadata(guarded.approval, guardedWrite, "auto_allowed"),
        )
        expect(guardedApproval.audit?.visible).toBe(false)

        const autonomousTask = ApprovalPolicy.decidePermission(autonomous, "task", {})
        const autonomousApproval = ApprovalPolicy.withAudit(
          ApprovalPolicy.metadata(autonomous.approval, autonomousTask, "auto_allowed"),
        )
        expect(autonomousApproval.audit?.visible).toBe(false)
      },
    })
  })
})
