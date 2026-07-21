import { expect, test } from "bun:test"
import { ApprovalPolicy } from "../../src/control-profile/approval"
import { buildProfile } from "../../src/control-profile/profiles"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import type { ResolvedProfile } from "../../src/control-profile/types"
import { SYNERGY_PROFILE_CAPABILITIES } from "../../../util/src/capability"

const workspace = "/tmp/test"

/** Find a permission rule within a resolved profile's ruleset. */
function rule(profile: ResolvedProfile, permission: string) {
  return profile.ruleset.find((r) => r.permission === permission)
}

async function fullAccessProfile() {
  return buildProfile("full_access", { workspace, workspaceType: "main" })
}

test("full_access allows file_read (maps file_search)", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      expect(rule(profile, "file_read")?.action).toBe("allow")
    },
  })
})

test("full_access profile — decidePermission returns allow for file_search", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      const decision = ApprovalPolicy.decidePermission(profile, "file_search", {})
      expect(decision).toMatchObject({
        action: "allow",
      })
      expect(decision.capabilities).toContain("file_read")
    },
  })
})

test("full_access profile — decidePermission returns allow for all low-risk tools", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      const lowRiskTools = [
        "file_search",
        "scan_files",
        "parse_code",
        "view_file",
        "glob",
        "read",
        "webfetch",
        "websearch",
        "file_search",
      ]
      for (const tool of lowRiskTools) {
        const decision = ApprovalPolicy.decidePermission(profile, tool, {})
        expect(decision.action, `tool: ${tool}`).toBe("allow")
      }
    },
  })
})

test("full_access profile — decidePermission returns allow for medium-risk tools", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      const mediumRiskTools = ["bash", "edit", "write", "revise_file", "save_file"]
      for (const tool of mediumRiskTools) {
        const decision = ApprovalPolicy.decidePermission(profile, tool, {})
        expect(decision.action, `tool: ${tool}`).toBe("allow")
      }
    },
  })
})

test("full_access profile — decidePermission returns allow for high-risk tools", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      const highRiskTools = ["secrets", "email_send", "session_send"]
      for (const tool of highRiskTools) {
        const decision = ApprovalPolicy.decidePermission(profile, tool, {})
        expect(decision.action, `tool: ${tool}`).toBe("allow")
      }
    },
  })
})

test("full_access allows every profile capability", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      for (const permission of SYNERGY_PROFILE_CAPABILITIES) {
        expect(rule(profile, permission)?.action, permission).toBe("allow")
      }
    },
  })
})

test("full_access allows non-bypassable protected and hardline permissions", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const profile = await fullAccessProfile()
      expect(ApprovalPolicy.decidePermission(profile, "protected_op", { nonBypassable: true }).action).toBe("allow")
      expect(ApprovalPolicy.decidePermission(profile, "shell_hardline", {}).action).toBe("allow")
    },
  })
})
