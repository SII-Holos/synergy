import { describe, expect, test } from "bun:test"
import { buildProfile } from "../../src/control-profile/profiles"
import { Instance } from "../../src/scope/instance"
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
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "file_external_read")?.action).toBe("allow")
      },
    })
  })

  test("autonomous denies file_external_write", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
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
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "network_request")?.action).toBe("allow")
      },
    })
  })

  test("autonomous allows mcp_invoke, asks for plugin_invoke", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "mcp_invoke")?.action).toBe("allow")
        expect(rule(profile, "plugin_invoke")?.action).toBe("ask")
        expect(rule(profile, "plugin_invoke")?.nonBypassable).toBe(true)
      },
    })
  })

  test("autonomous allows identity_act and communication_email", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
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
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(rule(profile, "platform_control")?.action).toBe("allow")
      },
    })
  })

  test("autonomous denies shell_hardline", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
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
    await Instance.provide({
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
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.filesystem.readRoots).toContain("/")
      },
    })
  })

  test("autonomous filesystem has workspace as writeRoots", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.filesystem.writeRoots).toEqual([workspace])
      },
    })
  })
})

describe("autonomous profile sandbox", () => {
  test("autonomous sandbox mode is workspace_write", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.sandbox.mode).toBe("workspace_write")
      },
    })
  })
})

describe("profile isolation", () => {
  test("guarded still has original rules (not affected by autonomous changes)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await guardedProfile()
        // Guarded should still ask for file_external_read — it was NOT changed to "allow"
        expect(rule(profile, "file_external_read")?.action).toBe("ask")
      },
    })
  })
})

describe("autonomous profile summary", () => {
  test("autonomous deniedCapabilities contains shell_hardline and shell_destructive", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const profile = await autonomousProfile()
        expect(profile.summary?.deniedCapabilities).toEqual(["shell_hardline", "shell_destructive"])
      },
    })
  })
})
