import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { LoopError } from "../../src/blueprint/error"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { NoteEvent } from "@ericsanchezok/synergy-note/event"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

/**
 * BlueprintLoopStore transition validation tests.
 *
 * These tests encode the contracted transition table:
 *   armed     → running,cancelled
 *   running   → auditing,completed,failed,cancelled
 *   auditing  → running,completed,failed,cancelled
 *   completed → completed
 *   failed    → (none)
 *   cancelled → (none)
 */

describe("BlueprintLoopStore transitions", () => {
  test("rejects a second active loop for the same Blueprint", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const first = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "First active loop",
            sessionID: "ses_first",
          })

          await expect(
            BlueprintLoopStore.create({
              noteID: "note_test",
              title: "Second active loop",
              sessionID: "ses_second",
            }),
          ).rejects.toBeInstanceOf(LoopError.AlreadyActive)

          try {
            await BlueprintLoopStore.create({
              noteID: "note_test",
              title: "Second active loop",
              sessionID: "ses_second",
            })
            throw new Error("expected BlueprintLoopAlreadyActive")
          } catch (err) {
            expect(err).toBeInstanceOf(LoopError.AlreadyActive)
            expect((err as InstanceType<typeof LoopError.AlreadyActive>).data).toEqual({
              noteID: "note_test",
              loopID: first.id,
              sessionID: "ses_first",
              status: "armed",
            })
          }
        },
      })
    }))

  test("allows a new loop after the previous active loop is terminal", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const first = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "First loop",
            sessionID: "ses_first",
          })
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, first.id, {
            status: "cancelled",
          })

          const second = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Second loop",
            sessionID: "ses_second",
          })
          expect(second.id).not.toBe(first.id)
          expect(second.status).toBe("armed")
        },
      })
    }))

  test("publishes Blueprint note metadata updates with blueprint-only changed fields", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const note = await NoteStore.create({
            title: "Blueprint note",
            kind: "blueprint",
            blueprint: {},
          })
          const updates: Array<{
            note: { id: string; blueprint?: { activeLoopID?: string; runCount?: number } }
            changed: string[]
          }> = []
          const unsub = Bus.subscribe(NoteEvent.Updated, (event) => {
            if (event.properties.note.id === note.id) updates.push(event.properties)
          })
          try {
            const loop = await BlueprintLoopStore.create({
              noteID: note.id,
              title: "Run Blueprint",
              sessionID: "ses_blueprint",
            })
            await BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "cancelled" })

            expect(updates.map((event) => event.changed)).toEqual([["blueprint"], ["blueprint"]])
            expect(updates[0].note.blueprint?.activeLoopID).toBe(loop.id)
            expect(updates[0].note.blueprint?.runCount).toBe(1)
            expect(updates[1].note.blueprint?.activeLoopID).toBeUndefined()
          } finally {
            unsub()
          }
        },
      })
    }))

  test("armed → running is valid", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const id = Identifier.ascending("blueprint_loop")
          const scopeID = ScopeContext.current.scope.id
          const sid = Identifier.asScopeID(scopeID)
          const now = Date.now()
          await Storage.write(StoragePath.blueprintLoop(sid, id), {
            id,
            noteID: "note_test",
            title: "Armed Loop",
            sessionID: "ses_test",
            scopeID: sid as string,
            status: "armed",
            time: { created: now, updated: now },
          })

          const updated = await BlueprintLoopStore.updateStatus(scopeID, id, {
            status: "running" as any,
          })
          expect(updated.status).toBe("running")
        },
      })
    }))

  test("armed → cancelled is valid", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const id = Identifier.ascending("blueprint_loop")
          const scopeID = ScopeContext.current.scope.id
          const sid = Identifier.asScopeID(scopeID)
          const now = Date.now()
          await Storage.write(StoragePath.blueprintLoop(sid, id), {
            id,
            noteID: "note_test",
            title: "Armed Loop",
            sessionID: "ses_test",
            scopeID: sid as string,
            status: "armed",
            time: { created: now, updated: now },
          })

          const updated = await BlueprintLoopStore.updateStatus(scopeID, id, {
            status: "cancelled" as any,
          })
          expect(updated.status).toBe("cancelled")
        },
      })
    }))

  test("armed → completed is invalid (skip running)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const id = Identifier.ascending("blueprint_loop")
          const scopeID = ScopeContext.current.scope.id
          const sid = Identifier.asScopeID(scopeID)
          const now = Date.now()
          await Storage.write(StoragePath.blueprintLoop(sid, id), {
            id,
            noteID: "note_test",
            title: "Armed Loop",
            sessionID: "ses_test",
            scopeID: sid as string,
            status: "armed",
            time: { created: now, updated: now },
          })

          await expect(
            BlueprintLoopStore.updateStatus(scopeID, id, { status: "completed" as any }),
          ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
        },
      })
    }))

  test("running → auditing is valid (leaves running for a non-terminal hold)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Running Loop",
            sessionID: "ses_test",
          })
          // create() returns "armed"; transition to running first
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })

          const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "auditing" as any,
          })
          expect(updated.status).toBe("auditing")
        },
      })
    }))

  test("auditing → running is valid (resume)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → running → auditing
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "auditing" as any,
          })

          const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          expect(updated.status).toBe("running")
        },
      })
    }))

  test("auditing → cancelled is valid", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → running → auditing
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "auditing" as any,
          })

          const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "cancelled" as any,
          })
          expect(updated.status).toBe("cancelled")
        },
      })
    }))

  test("auditing → completed is valid", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → running → auditing
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "auditing" as any,
          })

          const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "completed" as any,
          })
          expect(updated.status).toBe("completed")
        },
      })
    }))

  test("completed → running is invalid (terminal state)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → running → completed
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          await BlueprintLoopStore.complete(ScopeContext.current.scope.id, loop.id)

          await expect(
            BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
              status: "running" as any,
            }),
          ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
        },
      })
    }))

  test("failed → running is invalid (terminal state)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → running → failed
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "failed" as any,
          })

          await expect(
            BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
              status: "running" as any,
            }),
          ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
        },
      })
    }))

  test("cancelled → running is invalid (terminal state)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → cancelled
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "cancelled" as any,
          })

          await expect(
            BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
              status: "running" as any,
            }),
          ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
        },
      })
    }))

  test("completed → completed is idempotent (same terminal state)", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = (await Scope.fromDirectory(tmp.path)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_test",
            title: "Loop",
            sessionID: "ses_test",
          })
          // armed → running → completed
          await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "running" as any,
          })
          await BlueprintLoopStore.complete(ScopeContext.current.scope.id, loop.id)

          const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
            status: "completed" as any,
          })
          expect(updated.status).toBe("completed")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
