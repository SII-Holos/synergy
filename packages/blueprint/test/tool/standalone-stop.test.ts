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
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"

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

async function executionSession(input: Parameters<typeof Session.create>[0] = {}) {
  const session = await Session.create(input)
  const loop = await BlueprintLoopStore.create({ noteID: "note_pause", title: "Blocked work", sessionID: session.id })
  await BlueprintLoopStore.updateStatus(session.scope.id, loop.id, { status: "running" })
  await Session.update(session.id, (draft) => {
    draft.blueprint = { loopID: loop.id, loopRole: "execution" }
  })
  return { session, loop }
}

function toolContext(sessionID: string, abort = new AbortController().signal): Tool.Context {
  return { sessionID, messageID: "message_pause", agent: "build", abort, metadata() {}, async ask() {} }
}

test("an executor pauses with a durable blocker without requesting review or requiring Agenda cleanup", async () => {
  await using runtime = await testRuntime(undefined, () => {
    setBlueprintAgendaAssertClear(async () => {
      throw new Error("A wakeup is still active")
    })
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { session, loop } = await executionSession()
        const tool = await BlueprintLoopStopTool.init()
        const result = await tool.execute(
          tool.parameters.parse({ action: "pause", summary: "  Waiting for execution authorization.  " }),
          toolContext(session.id),
        )
        expect(result.metadata).toMatchObject({ pauseRequested: true, reviewRequested: false })
        expect(result.output).toContain("Waiting for execution authorization.")
        expect(await SessionLifecycle.snapshot(session.id)).toMatchObject({
          reason: "workflow",
          description: "Waiting for execution authorization.",
        })
        const after = await BlueprintLoopStore.get(session.scope.id, loop.id)
        expect(after.status).toBe("running")
        expect(after.stopRequest).toBeUndefined()
        expect(after.auditTaskID).toBeUndefined()
        expect((await Session.get(session.id)).blueprint?.loopID).toBe(loop.id)
        const firstPause = await SessionLifecycle.snapshot(session.id)
        await tool.execute(
          tool.parameters.parse({ action: "pause", summary: "Repeated blocker" }),
          toolContext(session.id),
        )
        expect(await SessionLifecycle.snapshot(session.id)).toEqual(firstPause)
      },
    }),
  )
})

test("pause stops the original execution lease only after the caller persists its tool result", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { session } = await executionSession()
        const lease = SessionManager.acquire(session.id)!
        const tool = await BlueprintLoopStopTool.init()
        const params = tool.parameters.parse({ action: "pause", summary: "Authorization required" })
        const ctx = toolContext(session.id, lease.signal)
        try {
          const result = await tool.execute(params, ctx)
          expect(lease.signal.aborted).toBe(false)
          expect(tool.afterPersist).toBeFunction()
          {
            using control = await Lock.write(`session-control:${session.id}`)
            const stalled = Promise.withResolvers<never>()
            const timer = setTimeout(() => stalled.reject(new Error("Pause waited on its own control lock")), 1_000)
            try {
              await Promise.race([Promise.resolve(tool.afterPersist?.(params, ctx, result)), stalled.promise])
            } finally {
              clearTimeout(timer)
            }
          }
          expect(lease.signal.aborted).toBe(true)
          expect((await SessionLifecycle.snapshot(session.id))?.description).toBe("Authorization required")
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    }),
  )
})

for (const delegated of [false, true])
  test(`a ${delegated ? "Cortex" : "unattended"} executor cannot claim an ignored pause`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const parent = await Session.create()
          const { session, loop } = await executionSession(
            delegated
              ? {
                  parentID: parent.id,
                  interaction: SessionInteraction.interactive("test"),
                  cortex: {
                    taskID: "ctx_pause",
                    parentSessionID: parent.id,
                    parentMessageID: "msg_parent",
                    description: "Delegated fixture",
                    agent: "developer",
                    status: "running",
                    startedAt: Date.now(),
                  },
                }
              : { interaction: SessionInteraction.unattended("test") },
          )
          const tool = await BlueprintLoopStopTool.init()
          await expect(
            tool.execute(tool.parameters.parse({ action: "pause", summary: "Needs input" }), toolContext(session.id)),
          ).rejects.toThrow("interactive")
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
          expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).stopRequest).toBeUndefined()
        },
      }),
    )
  })

for (const invalid of ["blank summary", "reviewer", "cancelled signal"] as const)
  test(`pause rejects ${invalid} without state changes`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const { session, loop } = await executionSession()
          if (invalid === "reviewer")
            await Session.update(session.id, (draft) => {
              draft.blueprint!.loopRole = "audit"
            })
          const controller = new AbortController()
          if (invalid === "cancelled signal") controller.abort(new Error("Execution cancelled"))
          const tool = await BlueprintLoopStopTool.init()
          const before = await BlueprintLoopStore.get(session.scope.id, loop.id)
          await expect(
            tool.execute(
              tool.parameters.parse({
                action: "pause",
                summary: invalid === "blank summary" ? "  " : "Needs authorization",
              }),
              toolContext(session.id, controller.signal),
            ),
          ).rejects.toThrow()
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
          expect(await BlueprintLoopStore.get(session.scope.id, loop.id)).toEqual(before)
        },
      }),
    )
  })

test("pause cannot replace a pending independent review request", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { session, loop } = await executionSession()
        const tool = await BlueprintLoopStopTool.init()
        await tool.execute({ summary: "Verified" }, toolContext(session.id))
        await expect(
          tool.execute(tool.parameters.parse({ action: "pause", summary: "Changed my mind" }), toolContext(session.id)),
        ).rejects.toThrow("review")
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        expect((await BlueprintLoopStore.get(session.scope.id, loop.id)).stopRequest?.summary).toBe("Verified")
      },
    }),
  )
})

test("concurrent pause and review requests cannot both be accepted", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { session, loop } = await executionSession()
        const tool = await BlueprintLoopStopTool.init()
        const results = await Promise.allSettled([
          tool.execute(
            tool.parameters.parse({ action: "pause", summary: "Needs authorization" }),
            toolContext(session.id),
          ),
          tool.execute(
            tool.parameters.parse({ action: "request_review", summary: "Verified" }),
            toolContext(session.id),
          ),
        ])
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const after = await BlueprintLoopStore.get(session.scope.id, loop.id)
        expect(!!after.stopRequest).not.toBe(!!(await SessionLifecycle.snapshot(session.id)))
      },
    }),
  )
})
