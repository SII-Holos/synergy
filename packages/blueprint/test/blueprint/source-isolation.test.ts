import { afterAll, expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { BlueprintContinuationPolicy } from "../../src/blueprint/continuation"
import type { Info } from "../../src/blueprint/types"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

for (const source of ["lattice", "plugin"] as const) {
  test(`Blueprint preserves an absent ${source} owner's loop without exposing or continuing it`, () =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ title: `Preserved ${source} session` })
          const loop: Info = {
            id: Identifier.ascending("blueprint_loop"),
            noteID: Identifier.ascending("note"),
            title: "Preserved owner run",
            sessionID: session.id,
            auditAgent: "supervisor",
            scopeID: session.scope.id,
            source,
            status: "running",
            time: { created: Date.now(), updated: Date.now() },
          }
          const key = StoragePath.blueprintLoop(Identifier.asScopeID(loop.scopeID), loop.id)
          await Storage.write(key, loop)
          await Session.update(session.id, (draft) => {
            draft.blueprint = { loopID: loop.id, loopRole: "execution" }
          })

          expect((await BlueprintLoopStore.list(loop.scopeID)).some((entry) => entry.id === loop.id)).toBe(false)
          await expect(BlueprintLoopStore.get(loop.scopeID, loop.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
          await expect(
            BlueprintLoopStore.updateStatus(loop.scopeID, loop.id, { status: "cancelled" }),
          ).rejects.toBeInstanceOf(Storage.NotFoundError)
          await expect(
            BlueprintLoopStore.recordStopRequest(loop.scopeID, loop.id, {
              summary: "Unavailable owner",
              requestedAt: Date.now(),
              requesterSessionID: session.id,
              requesterMessageID: Identifier.ascending("message"),
            }),
          ).rejects.toBeInstanceOf(Storage.NotFoundError)
          const proposal = await BlueprintContinuationPolicy.handle({
            session: await Session.get(session.id),
            scopeID: loop.scopeID,
            sessionID: session.id,
            terminalMessageID: Identifier.ascending("message"),
          })
          expect(proposal).toBeUndefined()
          expect(await Storage.read<Info>(key)).toEqual(loop)
        },
      }),
    ))
}
