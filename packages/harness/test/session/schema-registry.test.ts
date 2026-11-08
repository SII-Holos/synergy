import { expect, spyOn, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { z } from "zod"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionSchemaRegistry } from "../../src/session/schema-registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("creation rechecks changed and removed parent bindings before publication", async () => {
  const Binding = z.strictObject({ project: z.string() })
  await using owned = await testRuntime({
    register() {
      SessionSchemaRegistry.register("binding-fixture", {
        shape: { ownerBinding: Binding.optional() },
        inherit: ["ownerBinding"],
        validateMutation({ next, parent }) {
          if (parent && JSON.stringify(parent.ownerBinding) !== JSON.stringify(next.ownerBinding))
            throw new Error("Parent binding changed")
        },
      })
    },
  })
  await owned.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        for (const change of ["replace", "remove"] as const) {
          const input = { ownerBinding: { project: "project-a" }, workspaceID: null }
          const root = await Session.create(input)
          const read = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const original = SessionManager.getSession
          let held = false
          const gate = spyOn(SessionManager, "getSession").mockImplementation(async (...args) => {
            const result = await original(...args)
            if (args[0] === root.id && !held) {
              held = true
              read.resolve()
              await release.promise
            }
            return result
          })
          const rescue = setTimeout(() => {
            read.reject(new Error("Parent read barrier timed out"))
            release.resolve()
          }, 5_000)
          const pending = Session.create({ parentID: root.id }).then(
            () => undefined,
            (error: unknown) => error,
          )
          try {
            await read.promise
            if (change === "remove") await Session.remove(root.id)
            else
              await Session.update(root.id, (draft) => Object.assign(draft, { ownerBinding: { project: "project-b" } }))
            release.resolve()
            expect(await pending).toMatchObject({
              message: change === "remove" ? "Parent Session no longer exists" : "Parent binding changed",
            })
            expect((await Session.readChildIndex(root.scope.id, root.id)).entries.length).toBe(0)
            expect((await Session.list({ parentOnly: false })).total).toBe(change === "remove" ? 0 : 1)
          } finally {
            release.resolve()
            await pending
            clearTimeout(rescue)
            gate.mockRestore()
          }
          if (change === "replace") await Session.remove(root.id)
        }
      },
    }),
  )
})

test("owner creation inheritance and mutation validation run before canonical publication", async () => {
  const Binding = z.strictObject({ project: z.string() })
  await using owned = await testRuntime({
    register() {
      SessionSchemaRegistry.register("binding-fixture", {
        shape: { ownerBinding: Binding.optional() },
        inherit: ["ownerBinding"],
        validateMutation({
          previous,
          next,
          parent,
        }: {
          previous?: Record<string, unknown>
          next: Record<string, unknown>
          parent?: Record<string, unknown>
        }) {
          const binding = Binding.optional().parse(next.ownerBinding)
          if (previous && JSON.stringify(previous.ownerBinding) !== JSON.stringify(binding))
            throw new Error("Binding is immutable")
          if (parent && JSON.stringify(parent.ownerBinding) !== JSON.stringify(binding))
            throw new Error("Parent binding changed")
          next.title = "A validation callback cannot edit the canonical record"
        },
      })
    },
  })
  await owned.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const input = { title: "Bound root", ownerBinding: { project: "project-a" }, workspaceID: null }
        const root = await Session.create(input)
        const child = await Session.create({ parentID: root.id })
        expect(Session.publicInfo(child)).toMatchObject({ ownerBinding: { project: "project-a" } })
        const conflicting = { parentID: root.id, ownerBinding: { project: "project-b" } }
        await expect(Session.create(conflicting)).rejects.toThrow("Parent binding changed")
        await expect(
          Session.update(root.id, (draft) =>
            Object.assign(draft, { ownerBinding: { project: "project-b" }, title: "Invalid" }),
          ),
        ).rejects.toThrow("Binding is immutable")
        await expect(
          Session.update(root.id, (draft) => Object.assign(draft, { ownerBinding: undefined })),
        ).rejects.toThrow("Binding is immutable")
        expect(Session.publicInfo(await Session.get(root.id))).toMatchObject({
          title: "Bound root",
          ownerBinding: { project: "project-a" },
        })
        expect((await Session.children(root.id)).map((entry) => entry.id)).toEqual([child.id])
        const invalid = { title: "Invalid", ownerBinding: { project: "project-a", extra: true } }
        await expect(Session.create(invalid)).rejects.toThrow()
        expect((await Session.list({ parentOnly: false })).total).toBe(2)
        const personal = await Session.create({ title: "Personal" })
        await expect(
          Session.update(personal.id, (draft) => Object.assign(draft, { ownerBinding: { project: "project-a" } })),
        ).rejects.toThrow("Binding is immutable")
      },
    }),
  )
})

test(
  "core preserves unknown kinds and nested owner metadata through read update and transcript import",
  () =>
    runtime.run(async () => {
      const isolated = await createIsolatedTestEnv()
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "--eval",
          `
      import assert from "node:assert/strict"
      import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
      import { registerHarness } from "@ericsanchezok/synergy-harness/lifecycle"
      import path from "node:path"
      const home = process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME
      const context = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: { ...process.env } })
      await context.run(async () => {
      registerHarness()

      const { StorageMaintenance } = await import("@ericsanchezok/synergy-harness/storage/maintenance")
      await using storageHandle = await StorageMaintenance.open({ migrate: false })
      const { default: z } = await import("zod")
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
      })
      context.dispose()
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
    }),
  30_000,
)

afterRuntimeTests(() => runtime.close())
