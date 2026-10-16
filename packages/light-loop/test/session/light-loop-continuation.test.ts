import { expect, test } from "bun:test"
import { LightLoopContinuationPolicy } from "../../src/light-loop/continuation"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkflowSessionService } from "../../src/session/workflow"
import { LightLoopRuntime } from "../../src/light-loop/runtime"
import { testRuntime } from "../support/runtime"

test("continuation persists until the current goal is terminal, without allocating review tasks", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        const evaluate = async () =>
          LightLoopContinuationPolicy.handle({
            session: await Session.get(session.id),
            sessionID: session.id,
            scopeID: session.scope.id,
            terminalMessageID: "msg_terminal",
          })
        expect(await evaluate()).toBeUndefined()
        await WorkflowSessionService.startLightloop(session.id, "Original complete goal")
        const proposal = await evaluate()
        expect(proposal?.kind).toBe("inbox")
        if (proposal?.kind !== "inbox") throw new Error("expected continuation")
        expect(proposal.message.origin).toEqual({ type: "system" })
        expect(proposal.message.metadata?.source).toBe("light_loop_continuation")
        await WorkflowSessionService.updateLightloopInstructions(session.id, "Original goal plus user correction")
        expect((await Session.get(session.id)).workflow).toEqual({
          kind: "lightloop",
          instructions: "Original goal plus user correction",
        })
        expect(await Session.children(session.id)).toEqual([])
        await LightLoopRuntime.setTerminalStatus(session.id, "completed")
        expect(await evaluate()).toBeUndefined()
      },
    }),
  )
})
