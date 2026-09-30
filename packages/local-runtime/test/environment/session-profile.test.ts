import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { testRuntime } from "../support/runtime"
import { createSession } from "../../src/session-api"

test("explicit profile selection reuses its owner policy without allocating or changing the default", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Config.updateGlobal({ resources: { defaultEnvironment: null } })
        const first = await createSession({ environmentProfile: "native" })
        const second = await createSession({ environmentProfile: "native" })
        expect(first.environmentID).toBeTruthy()
        expect(second.environmentID).toBe(first.environmentID)
        expect(await Environment.get(first.environmentID!, "home")).toMatchObject({ state: "idle", generation: 0 })
        expect((await Session.create()).environmentID).toBeNull()
      },
    }),
  )
})

test("invalid and conflicting profile choices fail before creating an environment", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await expect(createSession({ environmentProfile: "missing" })).rejects.toThrow("profile")
        await expect(createSession({ environmentProfile: "native", environmentID: null })).rejects.toThrow(
          "environmentID",
        )
        expect(await Environment.list("home")).toEqual([])
      },
    }),
  )
})

test("a workspace-reused profile follows the chosen independent copy, never the main checkout", async () => {
  const { tmpdir } = await import("@ericsanchezok/synergy-harness/test/support/fixture")
  await using runtime = await testRuntime()
  await using tmp = await tmpdir({ git: true })
  await runtime.run(async () => {
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Config.updateGlobal({
          resources: {
            defaultEnvironment: null,
            environments: { perFiles: { provider: "native", spec: {}, reuse: "workspace" } },
          },
        })
        const main = await createSession({ environmentProfile: "perFiles" })
        const copy = await createSession({
          environmentProfile: "perFiles",
          workspace: { mode: "create", name: "profile-copy" },
        })
        expect(copy.workspaceID).not.toBe(main.workspaceID)
        expect(copy.environmentID).not.toBe(main.environmentID)
        const same = await createSession({
          environmentProfile: "perFiles",
          workspace: {
            mode: "workspace",
            workspaceID: copy.workspaceID!,
            workspaceGeneration: (
              await (
                await import("@ericsanchezok/synergy-harness/workspace")
              ).WorkspaceCatalog.get(copy.workspaceID!, scope.id)
            ).binding.generation,
          },
        })
        expect(same.environmentID).toBe(copy.environmentID)
        expect((await Environment.list(scope.id)).every((item) => item.state === "idle" && item.generation === 0)).toBe(
          true,
        )
      },
    })
  })
})

test("global workspace reuse also binds only after files are selected, and no-execution cannot create a copy", async () => {
  const { tmpdir } = await import("@ericsanchezok/synergy-harness/test/support/fixture")
  await using runtime = await testRuntime()
  await using tmp = await tmpdir({ git: true })
  await runtime.run(async () => {
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Config.updateGlobal({
          resources: {
            defaultEnvironment: "perFiles",
            environments: { perFiles: { provider: "native", spec: {}, reuse: "workspace" } },
          },
        })
        const main = await createSession()
        const copy = await createSession({ workspace: { mode: "create", name: "global-copy" } })
        expect(copy.environmentID).not.toBe(main.environmentID)
        await expect(
          createSession({ environmentID: null, workspace: { mode: "create", name: "must-not-create" } }),
        ).rejects.toMatchObject({ name: "SessionLocationError" })
      },
    })
  })
})

test("profile summaries name existing bindings without allocating them and retain invalid defaults", async () => {
  const { ResourceProfiles } = await import("../../src/environment/profiles")
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await Config.updateGlobal({
          resources: {
            defaultEnvironment: "missing",
            environments: { desk: { provider: "native", spec: {}, reuse: "session" } },
          },
        })
        const session = await createSession({ environmentProfile: "desk" })
        const summary = await ResourceProfiles.list("home")
        expect(summary.defaultEnvironment).toBe("missing")
        expect(summary.bindings?.[session.environmentID!]).toContain("desk")
        expect((await Environment.get(session.environmentID!, "home")).generation).toBe(0)
      },
    }),
  )
})
