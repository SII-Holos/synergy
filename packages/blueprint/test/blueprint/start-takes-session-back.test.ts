import { afterAll, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { BlueprintLoopSources } from "../../src/blueprint/source"
import { BlueprintLoopService } from "../../src/blueprint/service"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime(undefined, () => BlueprintLoopSources.register("lattice"))
afterAll(() => runtime.close())

test("starting a loop on a paused session releases the pause before delivery", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create()
        const note = await NoteStore.create({ title: "Restart", kind: "blueprint", blueprint: {} })
        const loop = await BlueprintLoopStore.create({ noteID: note.id, title: note.title, sessionID: session.id })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "failed", description: "provider refused" })

        const delivered = Promise.withResolvers<void>()
        const pausedAtDelivery: boolean[] = []
        const delivery = spyOn(SessionManager, "deliver").mockImplementation(async () => {
          pausedAtDelivery.push(!!(await SessionLifecycle.snapshot(session.id)))
          delivered.resolve()
        })
        let started
        try {
          started = await BlueprintLoopService.start(session.scope.id, loop.id, "restart the run")
          await delivered.promise
        } finally {
          delivery.mockRestore()
        }

        expect(pausedAtDelivery).toEqual([false])
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        expect(started.status).toBe("running")
      },
    })
  }))

test("a machine-owned start refuses a paused session without writing a binding or a running claim", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create()
        const note = await NoteStore.create({ title: "Machine restart", kind: "blueprint", blueprint: {} })
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          title: note.title,
          sessionID: session.id,
          source: "lattice",
        })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "failed", description: "provider refused" })

        const delivery = spyOn(SessionManager, "deliver")
        try {
          await expect(BlueprintLoopService.start(session.scope.id, loop.id)).rejects.toMatchObject({
            name: "BlueprintLoopSessionPaused",
            data: { loopID: loop.id, sessionID: session.id, source: "lattice" },
          })
          expect(delivery).not.toHaveBeenCalled()
        } finally {
          delivery.mockRestore()
        }

        expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).status).toBe("armed")
        expect((await Session.get(session.id)).blueprint).toBeUndefined()
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("failed")
      },
    })
  }))
