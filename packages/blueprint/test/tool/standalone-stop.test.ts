import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { BlueprintLoopStopTool } from "../../src/blueprint/tools/blueprint-loop-stop"
import { testRuntime } from "../support/runtime"

test("Blueprint requests review without Agenda installed", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        const loop = await BlueprintLoopStore.create({ noteID: "note_blueprint", title: "Work", sessionID: session.id })
        await BlueprintLoopStore.updateStatus(session.scope.id, loop.id, { status: "running" })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        const tool = await BlueprintLoopStopTool.init()
        const result = await tool.execute(
          { summary: "Verified" },
          {
            sessionID: session.id,
            messageID: "message_stop",
            agent: "build",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          },
        )
        expect(result.metadata.reviewRequested).toBe(true)
        expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).stopRequest?.summary).toBe("Verified")
      },
    }),
  )
})
