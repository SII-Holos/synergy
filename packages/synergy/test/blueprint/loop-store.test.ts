import { describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { LoopError } from "../../src/blueprint/error"
import { Bus } from "../../src/bus"
import { NoteEvent } from "../../src/note/event"
import { NoteStore } from "../../src/note"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Plugin } from "../../src/plugin"

/**
 * BlueprintLoopStore transition validation tests.
 *
 * These tests encode the contracted transition table:
 *   armed    → running,cancelled
 *   running  → waiting,auditing,completed,failed,cancelled
 *   waiting  → running,cancelled
 *   auditing → running,completed,failed,cancelled,waiting
 *   terminal states (completed,failed,cancelled) → no outgoing
 *
 * The current updateStatus() does NOT validate transitions — it applies any
 * status blindly. These tests will RED-fail until transition validation is
 * added.
 *
 * Usage of `as any` on status values bypasses TypeScript narrowing for enum
 * members (armed, waiting) not yet declared in LoopStatus. The casts are
 * intentional — these tests verify runtime contract behavior.
 */

describe("BlueprintLoopStore transitions", () => {
  test("rejects a second active loop for the same Blueprint", async () => {
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
  })

  test("allows a new loop after the previous active loop is terminal", async () => {
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
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, first.id, { status: "cancelled" })

        const second = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Second loop",
          sessionID: "ses_second",
        })
        expect(second.id).not.toBe(first.id)
        expect(second.status).toBe("armed")
      },
    })
  })

  test("publishes Blueprint note metadata updates with blueprint-only changed fields", async () => {
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
  })

  test("armed → running is valid", async () => {
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
  })

  test("armed → cancelled is valid", async () => {
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
  })

  test("armed → completed is invalid (skip running)", async () => {
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
  })

  test("running → waiting is valid", async () => {
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
          status: "waiting" as any,
        })
        expect(updated.status as string).toBe("waiting")
      },
    })
  })

  test("waiting → running is valid (resume)", async () => {
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
        // armed → running → waiting
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "waiting" as any,
        })

        const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "running" as any,
        })
        expect(updated.status).toBe("running")
      },
    })
  })

  test("waiting → cancelled is valid", async () => {
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
        // armed → running → waiting
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "waiting" as any,
        })

        const updated = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "cancelled" as any,
        })
        expect(updated.status).toBe("cancelled")
      },
    })
  })

  test("auditing → completed is valid", async () => {
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
  })

  test("completed → running is invalid (terminal state)", async () => {
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
          BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" as any }),
        ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
      },
    })
  })

  test("failed → running is invalid (terminal state)", async () => {
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
          BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" as any }),
        ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
      },
    })
  })

  test("cancelled → running is invalid (terminal state)", async () => {
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
          BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" as any }),
        ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
      },
    })
  })

  test("completed → completed is idempotent (same terminal state)", async () => {
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
  })
  test("delivers blueprint.after only once for terminal plugin-owned loops", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const originalDeliverHookForPlugin = Plugin.deliverHookForPlugin
    const calls: unknown[][] = []
    ;(Plugin as any).deliverHookForPlugin = mock(async (...args: unknown[]) => {
      calls.push(args)
      return { status: "delivered", handlerCount: 1 }
    })

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const pluginLoop = await BlueprintLoopStore.create({
            noteID: "note_plugin_hook",
            title: "Plugin loop",
            sessionID: "ses_plugin_hook",
            source: "plugin",
            pluginOwner: {
              pluginId: "research-plugin",
              pluginGeneration: "generation-one",
              scopeId: scope.id,
            },
          })
          await BlueprintLoopStore.updateStatus(scope.id, pluginLoop.id, { status: "cancelled" })

          const userLoop = await BlueprintLoopStore.create({
            noteID: "note_user_hook",
            title: "User loop",
            sessionID: "ses_user_hook",
          })
          await BlueprintLoopStore.updateStatus(scope.id, userLoop.id, { status: "cancelled" })

          expect(calls).toHaveLength(1)
          expect(calls[0]).toEqual([
            "research-plugin",
            "generation-one",
            "blueprint.after",
            { loop: expect.objectContaining({ id: pluginLoop.id, status: "cancelled", source: "plugin" }) },
          ])
          const delivered = await BlueprintLoopStore.get(scope.id, pluginLoop.id)
          expect(delivered.terminalHookDeliveredAt).toBeNumber()
          expect(delivered.terminalHookError).toBeUndefined()
        },
      })
    } finally {
      ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
    }
  })

  test("records blueprint.after failures and retries until delivery succeeds", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const originalDeliverHookForPlugin = Plugin.deliverHookForPlugin
    let attempt = 0
    ;(Plugin as any).deliverHookForPlugin = mock(async () => {
      attempt++
      if (attempt === 1) {
        return {
          status: "failed",
          handlerCount: 1,
          error: "Hook blueprint.after handler failed: state write failed",
        }
      }
      return { status: "delivered", handlerCount: 1 }
    })

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const loop = await BlueprintLoopStore.create({
            noteID: "note_plugin_retry",
            title: "Plugin retry",
            sessionID: "ses_plugin_retry",
            source: "plugin",
            pluginOwner: {
              pluginId: "research-plugin",
              pluginGeneration: "generation-one",
              scopeId: scope.id,
            },
          })
          await BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "cancelled" })
          const failed = await BlueprintLoopStore.get(scope.id, loop.id)
          expect(failed.terminalHookDeliveredAt).toBeUndefined()
          expect(failed.terminalHookError).toContain("state write failed")

          await BlueprintLoopStore.deliverTerminalHook(scope.id, loop.id)
          const retried = await BlueprintLoopStore.get(scope.id, loop.id)
          expect(retried.terminalHookDeliveredAt).toBeNumber()
          expect(retried.terminalHookError).toBeUndefined()
          expect(attempt).toBe(2)
        },
      })
    } finally {
      ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
    }
  })

  test("serializes concurrent blueprint.after retries into one delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope
    const originalDeliverHookForPlugin = Plugin.deliverHookForPlugin

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          ;(Plugin as any).deliverHookForPlugin = mock(async () => ({
            status: "failed",
            handlerCount: 1,
            error: "temporary failure",
          }))
          const loop = await BlueprintLoopStore.create({
            noteID: "note_plugin_concurrent",
            title: "Plugin concurrent delivery",
            sessionID: "ses_plugin_concurrent",
            source: "plugin",
            pluginOwner: {
              pluginId: "research-plugin",
              pluginGeneration: "generation-one",
              scopeId: scope.id,
            },
          })
          await BlueprintLoopStore.updateStatus(scope.id, loop.id, { status: "cancelled" })

          const delivery = mock(async () => {
            await Bun.sleep(10)
            return { status: "delivered", handlerCount: 1 }
          })
          ;(Plugin as any).deliverHookForPlugin = delivery
          await Promise.all([
            BlueprintLoopStore.deliverTerminalHook(scope.id, loop.id),
            BlueprintLoopStore.deliverTerminalHook(scope.id, loop.id),
          ])

          expect(delivery).toHaveBeenCalledTimes(1)
          const updated = await BlueprintLoopStore.get(scope.id, loop.id)
          expect(updated.terminalHookDeliveredAt).toBeNumber()
        },
      })
    } finally {
      ;(Plugin as any).deliverHookForPlugin = originalDeliverHookForPlugin
    }
  })
})
