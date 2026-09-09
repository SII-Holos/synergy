import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("core preserves unknown kinds and nested owner metadata through read update and transcript import", async () => {
  const isolated = await createIsolatedTestEnv()
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      import z from "zod"
      const { Scope } = await import("@ericsanchezok/synergy-harness/scope")
      const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
      const { Session } = await import("@ericsanchezok/synergy-harness/session")
      const { SessionExport } = await import("@ericsanchezok/synergy-harness/session/session-export")
      const { SessionImport } = await import("@ericsanchezok/synergy-harness/session/session-import")
      const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
      const { StoragePath } = await import("@ericsanchezok/synergy-harness/storage/path")
      const { SessionSchemaRegistry } = await import("@ericsanchezok/synergy-harness/session/schema-registry")
      const scope = Scope.home()
      const early = Session.Info
      assert.equal("blueprint" in early.out.shape, false)
      const ownerFields = {
        agenda: { itemID: "scheduled-old", ownerRevision: { checkpoint: [1, 2] } },
        blueprint: { loopID: "loop-old", loopRole: "execution", resume: { cursor: "next" } },
        superplan: { runID: "splan-old", role: "node", extra: { result: null } },
      }
      await ScopeContext.provide({ scope, fn: async () => {
        for (const workflow of [
          { kind: "future-research", payload: { rows: [{ metric: 0.5 }], nested: { ready: false } } },
          { kind: "lightloop", instructions: "continue", stopRequest: { future: { checkpoint: [3, 4] } } },
        ]) {
          const created = await Session.create({ title: "legacy-owner-state" })
          const fields = { ...ownerFields, workflow }
          const key = StoragePath.sessionInfo(scope.id, created.id)
          await Storage.write(key, { ...created, ...fields })
          const read = await Session.get(created.id)
          for (const [key, value] of Object.entries(fields)) assert.deepEqual(read[key], value)
          await Session.update(created.id, draft => { draft.title = "updated-in-core" })
          const report = await SessionExport.generate({ sessionID: created.id, mode: "full" })
          const imported = await SessionImport.fromBuffer(new TextEncoder().encode(JSON.stringify(report)))
          const restored = await Session.get(imported.rootSessionID)
          for (const [key, value] of Object.entries(fields)) assert.deepEqual(restored[key], value)
          assert.equal(restored.title, "updated-in-core")
          const persisted = Session.PersistedInfo.parse(restored)
          for (const [key, value] of Object.entries(fields)) assert.deepEqual(persisted[key], value)
          await Session.remove(created.id)
          await Session.remove(imported.rootSessionID)
        }
      } })
      const contribution = { shape: { blueprint: z.object({ loopID: z.string() }).optional() } }
      SessionSchemaRegistry.register("restored-owner", contribution)
      assert.equal("blueprint" in early.out.shape, true)
      assert.doesNotThrow(() => SessionSchemaRegistry.register("restored-owner", contribution))
      assert.throws(() => SessionSchemaRegistry.register("conflict", { shape: { blueprint: z.string() } }), /already owned/)
    `,
    ],
    env: { ...isolated.env, SYNERGY_OBSERVABILITY_INLINE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
  } finally {
    await isolated.dispose()
  }
}, 30_000)
