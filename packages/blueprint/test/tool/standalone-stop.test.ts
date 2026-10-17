import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { BlueprintLoopStopTool, setBlueprintAgendaAssertClear } from "../../src/blueprint/tools/blueprint-loop-stop"
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
        for (const reader of ["read", "view_file", "scan_files", "file_search"])
          expect(PermissionNext.evaluate(reader, "source.ts", reviewer.permission).action).toBe("allow")
        for (const writer of ["edit", "write", "apply_patch", "revise_file", "save_file", "resolve_conflicts"])
          expect(PermissionNext.evaluate(writer, "source.ts", reviewer.permission).action).toBe("deny")
        const approve = await BlueprintLoopApproveTool.init()
        const reject = await BlueprintLoopRejectTool.init()
        expect(Object.keys(approve.parameters.shape)).toEqual(["summary"])
        expect(Object.keys(reject.parameters.shape)).toEqual(["reason"])
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

test("cancelled execution cannot request review after waiting for the Agenda guard", async () => {
  const controller = new AbortController()
  await using runtime = await testRuntime(undefined, () => {
    setBlueprintAgendaAssertClear(async () => {
      controller.abort(new Error("Execution cancelled"))
    })
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        const loop = await BlueprintLoopStore.create({ noteID: "note_cancelled", title: "Work", sessionID: session.id })
        await BlueprintLoopStore.updateStatus(session.scope.id, loop.id, { status: "running" })
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        const tool = await BlueprintLoopStopTool.init()
        await expect(
          tool.execute(
            { summary: "Verified" },
            {
              sessionID: session.id,
              messageID: "message_stop",
              agent: "build",
              abort: controller.signal,
              metadata() {},
              async ask() {},
            },
          ),
        ).rejects.toThrow("Execution cancelled")
        expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).stopRequest).toBeUndefined()
      },
    }),
  )
})
