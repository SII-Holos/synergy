import { expect, test } from "bun:test"
import { RuntimeHandle, Session, Scope, ScopeStartup, ProviderSdkSource, SandboxHost } from "../src"

test("the public research harness exposes lifecycle, sessions and explicit host contracts", () => {
  expect(typeof RuntimeHandle.open).toBe("function")
  expect(typeof Session.create).toBe("function")
  expect(typeof Scope.fromDirectory).toBe("function")
  expect(typeof ProviderSdkSource.register).toBe("function")
  expect(typeof SandboxHost.register).toBe("function")
  expect(ScopeStartup.plan()).not.toContain("file-watcher")
})

test("public mechanism entries share the same Scope, persisted session and rollout view", async () => {
  const { ScopeContext, SessionContextContributions } = await import("@ericsanchezok/synergy-harness/context")
  const { ConfigDomain } = await import("@ericsanchezok/synergy-harness/config")
  const { Storage } = await import("@ericsanchezok/synergy-harness/persistence")
  const { readRolloutRevision } = await import("@ericsanchezok/synergy-harness/rollout")
  const { Tool, ToolRegistry, ToolInvocation } = await import("@ericsanchezok/synergy-harness/tools")
  const { readRuntimeStats } = await import("@ericsanchezok/synergy-harness/lifecycle")
  const { tmpdir } = await import("./support/fixture")
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "Public entry fixture" })
      expect((await Session.get(session.id)).title).toBe("Public entry fixture")
      await Storage.write(["public-entry", session.id], { scopeID: ScopeContext.current.scope.id })
      expect(await Storage.read<{ scopeID: string }>(["public-entry", session.id])).toEqual({
        scopeID: session.scope.id,
      })
      expect(await readRolloutRevision({ kind: "session", scopeID: session.scope.id, sessionID: session.id })).toBe(0)
      const dispose = SessionContextContributions.register("public-entry-fixture", {
        contribute: async () => ({ context: "Research context", injection: { kind: "fixture" } }),
      })
      try {
        const context = await SessionContextContributions.collect({
          sessionID: session.id,
          scopeID: session.scope.id,
          messages: [],
          isTopSession: true,
          signal: new AbortController().signal,
        })
        expect(context?.context).toContain("Research context")
      } finally {
        dispose()
      }
      expect(ConfigDomain.filepath("general")).toContain("general")
      expect(typeof Tool.define).toBe("function")
      expect(typeof ToolRegistry.register).toBe("function")
      expect(typeof ToolInvocation.invoke).toBe("function")
      expect(Object.isFrozen(readRuntimeStats())).toBe(true)
      await Session.remove(session.id)
    },
  })
})
