import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { LoopStopTool } from "../../src/light-loop/tools/loop-stop"
import { testRuntime } from "../support/runtime"

test("Light Loop requests review without Agenda installed", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "lightloop", instructions: "Complete the work" }
        })
        const tool = await LoopStopTool.init()
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
        expect(result.metadata.loopStopRequested).toBe(true)
        expect((await Session.get(session.id)).workflow).toMatchObject({
          kind: "lightloop",
          stopRequest: { summary: "Verified" },
        })
      },
    }),
  )
})
