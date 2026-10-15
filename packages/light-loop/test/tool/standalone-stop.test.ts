import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { LoopStopTool } from "../../src/light-loop/tools/loop-stop"
import { testRuntime } from "../support/runtime"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { LightLoopApproveTool } from "../../src/light-loop/tools/light-loop-approve"
import { LightLoopRejectTool } from "../../src/light-loop/tools/light-loop-reject"

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
        const reviewer = await Agent.get("lightloop-reviewer")
        for (const reader of ["read", "view_file", "scan_files", "file_search"])
          expect(PermissionNext.evaluate(reader, "source.ts", reviewer.permission).action).toBe("allow")
        for (const writer of ["edit", "write", "apply_patch", "revise_file", "save_file", "resolve_conflicts"])
          expect(PermissionNext.evaluate(writer, "source.ts", reviewer.permission).action).toBe("deny")
        expect(reviewer.prompt).toContain("Formally submit the verdict")
        expect(reviewer.prompt).toContain("execution session ID from your launch context")
        expect(reviewer.prompt).toContain("Cannot verify items are documented and non-blocking")
        expect(reviewer.prompt).not.toMatch(/session_read|view_file|scan_files|`bash`|via `task`|reason:|sessionID:/)
        const approve = await LightLoopApproveTool.init()
        const reject = await LightLoopRejectTool.init()
        for (const verdict of [approve, reject]) {
          expect(verdict.description).toContain("execution session ID provided in your launch context")
          expect(verdict.description).toContain("automatically")
          expect(verdict.description).toContain("Do not send a separate")
        }
        expect(reject.description).toContain("BLOCKING or NON-BLOCKING")
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
