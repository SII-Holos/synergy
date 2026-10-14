import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { BlueprintLoopStopTool } from "../../src/blueprint/tools/blueprint-loop-stop"
import { testRuntime } from "../support/runtime"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { BlueprintLoopApproveTool } from "../../src/blueprint/tools/blueprint-loop-approve"
import { BlueprintLoopRejectTool } from "../../src/blueprint/tools/blueprint-loop-reject"

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
        const reviewer = await Agent.get("supervisor")
        expect(reviewer.prompt).toContain("Formally submit the verdict")
        expect(reviewer.prompt).toContain("execution session ID from your launch context")
        expect(reviewer.prompt).toContain("Cannot verify is blocking")
        expect(reviewer.prompt).not.toMatch(/note_read|view_file|scan_files|via `task`|reason:|sessionID:/)
        const approve = await BlueprintLoopApproveTool.init()
        const reject = await BlueprintLoopRejectTool.init()
        for (const verdict of [approve, reject]) {
          expect(verdict.description).toContain("execution session ID provided in your launch context")
          expect(verdict.description).toContain("automatically")
          expect(verdict.description).toContain("Do not send a separate")
        }
        expect(reject.description).toContain("BLOCKING or NON-BLOCKING")
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
