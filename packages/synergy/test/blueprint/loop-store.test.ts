import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { LoopError } from "../../src/blueprint/error"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"

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
  test("armed → running is valid", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const id = Identifier.ascending("blueprint_loop")
        const scopeID = Instance.scope.id
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

    await Instance.provide({
      scope,
      fn: async () => {
        const id = Identifier.ascending("blueprint_loop")
        const scopeID = Instance.scope.id
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

    await Instance.provide({
      scope,
      fn: async () => {
        const id = Identifier.ascending("blueprint_loop")
        const scopeID = Instance.scope.id
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

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Running Loop",
          sessionID: "ses_test",
        })
        // create() returns "armed"; transition to running first
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })

        const updated = await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "waiting" as any,
        })
        expect(updated.status as string).toBe("waiting")
      },
    })
  })

  test("waiting → running is valid (resume)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → running → waiting
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "waiting" as any,
        })

        const updated = await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        expect(updated.status).toBe("running")
      },
    })
  })

  test("waiting → cancelled is valid", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → running → waiting
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "waiting" as any,
        })

        const updated = await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "cancelled" as any,
        })
        expect(updated.status).toBe("cancelled")
      },
    })
  })

  test("auditing → completed is valid", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → running → auditing
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "auditing" as any,
        })

        const updated = await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "completed" as any,
        })
        expect(updated.status).toBe("completed")
      },
    })
  })

  test("completed → running is invalid (terminal state)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → running → completed
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.complete(Instance.scope.id, loop.id)

        await expect(
          BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, { status: "running" as any }),
        ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
      },
    })
  })

  test("failed → running is invalid (terminal state)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → running → failed
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "failed" as any,
        })

        await expect(
          BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, { status: "running" as any }),
        ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
      },
    })
  })

  test("cancelled → running is invalid (terminal state)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → cancelled
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "cancelled" as any,
        })

        await expect(
          BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, { status: "running" as any }),
        ).rejects.toBeInstanceOf(LoopError.InvalidTransition)
      },
    })
  })

  test("completed → completed is idempotent (same terminal state)", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await Instance.provide({
      scope,
      fn: async () => {
        const loop = await BlueprintLoopStore.create({
          noteID: "note_test",
          title: "Loop",
          sessionID: "ses_test",
        })
        // armed → running → completed
        await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "running" as any,
        })
        await BlueprintLoopStore.complete(Instance.scope.id, loop.id)

        const updated = await BlueprintLoopStore.updateStatus(Instance.scope.id, loop.id, {
          status: "completed" as any,
        })
        expect(updated.status).toBe("completed")
      },
    })
  })
})
