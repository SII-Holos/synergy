import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { BlueprintLoopReviewAccess } from "../../src/blueprint/review-access"
import { BlueprintContinuationPolicy } from "../../src/blueprint/continuation"
import { expect, spyOn, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BlueprintLoopStore } from "../../src/blueprint/loop-store"
import { BlueprintLoopApproveTool } from "../../src/blueprint/tools/blueprint-loop-approve"
import { BlueprintLoopRejectTool } from "../../src/blueprint/tools/blueprint-loop-reject"
import { testRuntime } from "../support/runtime"

function context(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message_verdict",
    agent: "supervisor",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}
async function pendingReview() {
  const execution = await Session.create({})
  const loop = await BlueprintLoopStore.create({
    noteID: "note_review",
    title: "Required outcome",
    sessionID: execution.id,
  })
  const reviewer = await Session.create({
    parentID: execution.id,
    cortex: {
      taskID: "ctx_review",
      parentSessionID: execution.id,
      parentMessageID: "message_stop",
      description: "Audit",
      agent: "supervisor",
      status: "running",
      startedAt: Date.now(),
    },
  })
  await Session.update(execution.id, (draft) => {
    draft.blueprint = { loopID: loop.id, loopRole: "execution", source: "user" }
  })
  await Session.update(reviewer.id, (draft) => {
    draft.blueprint = { loopID: loop.id, loopRole: "audit", source: "user" }
  })
  await BlueprintLoopStore.updateStatus(execution.scope.id, loop.id, { status: "running" })
  await BlueprintLoopStore.recordStopRequest(execution.scope.id, loop.id, {
    summary: "Verified artifacts and tests",
    requestedAt: Date.now(),
    requesterSessionID: execution.id,
    requesterMessageID: "message_stop",
  })
  await BlueprintLoopStore.updateStatus(execution.scope.id, loop.id, {
    status: "auditing",
    auditSessionID: reviewer.id,
    auditTaskID: "ctx_review",
  })
  return { execution, reviewer, loop }
}

test("only the bound reviewer can approve using a natural-language verdict", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { execution, reviewer, loop } = await pendingReview()
        const approve = await BlueprintLoopApproveTool.init()
        await expect(approve.execute({ summary: "Self approval" }, context(execution.id))).rejects.toThrow()
        await expect(BlueprintLoopStore.complete(execution.scope.id, loop.id)).rejects.toThrow()
        expect((await BlueprintLoopStore.get(execution.scope.id, loop.id)).status).toBe("auditing")
        await approve.execute({ summary: "Required outcome independently verified" }, context(reviewer.id))
        expect(await BlueprintLoopStore.get(execution.scope.id, loop.id)).toMatchObject({
          status: "completed",
          summary: "Required outcome independently verified",
        })
        await expect(approve.execute({ summary: "Late verdict" }, context(reviewer.id))).rejects.toThrow()
      },
    }),
  )
})

test("rejection preserves the reviewer for rework but withdraws its authority", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { execution, reviewer, loop } = await pendingReview()
        const reject = await BlueprintLoopRejectTool.init()
        await reject.execute(
          { reason: "The empty-input behavior is missing. Add it and verify the actual result." },
          context(reviewer.id),
        )
        expect(await BlueprintLoopStore.get(execution.scope.id, loop.id)).toMatchObject({
          status: "running",
          auditSessionID: reviewer.id,
          audit: { attempts: 1 },
        })
        expect((await Session.get(reviewer.id)).blueprint?.loopRole).toBeUndefined()
        const approve = await BlueprintLoopApproveTool.init()
        await expect(approve.execute({ summary: "Stale verdict" }, context(reviewer.id))).rejects.toThrow()
      },
    }),
  )
})

test("rework waits for the prior reviewer turn and reuses its session with a fresh task binding", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const { execution, reviewer, loop } = await pendingReview()
        await (
          await BlueprintLoopRejectTool.init()
        ).execute({ reason: "Verify empty input before acceptance" }, context(reviewer.id))
        await BlueprintLoopStore.recordStopRequest(execution.scope.id, loop.id, {
          summary: "Empty input verified",
          requestedAt: Date.now(),
          requesterSessionID: execution.id,
          requesterMessageID: "message_second_stop",
        })
        const gate = {
          session: await Session.get(execution.id),
          sessionID: execution.id,
          scopeID: execution.scope.id,
          terminalMessageID: "message_terminal",
        }
        let prepared: Awaited<ReturnType<typeof Cortex.prepare>>
        using prepare = spyOn(Cortex, "prepare").mockImplementation(
          Object.assign(
            async (input: Parameters<typeof Cortex.prepare>[0]) => {
              expect(input.sessionID).toBe(reviewer.id)
              expect(input.parentMessageID).toBe("message_second_stop")
              await Session.update(reviewer.id, (draft) => {
                draft.cortex = {
                  ...draft.cortex!,
                  taskID: "ctx_second",
                  parentMessageID: input.parentMessageID,
                  status: "queued",
                }
              })
              prepared = { id: "ctx_second", sessionID: reviewer.id, status: "queued" } as Awaited<
                ReturnType<typeof Cortex.prepare>
              >
              return prepared
            },
            { force: Cortex.prepare.force, schema: Cortex.prepare.schema },
          ),
        )
        using start = spyOn(Cortex, "start").mockImplementation(async () => prepared)
        expect(await BlueprintContinuationPolicy.handle(gate)).toBeUndefined()
        expect(prepare).not.toHaveBeenCalled()
        await Session.update(reviewer.id, (draft) => {
          draft.cortex!.status = "completed"
        })
        expect(await BlueprintContinuationPolicy.handle(gate)).toEqual({ kind: "handled" })
        expect(await BlueprintLoopStore.get(execution.scope.id, loop.id)).toMatchObject({
          status: "auditing",
          auditSessionID: reviewer.id,
          auditTaskID: "ctx_second",
        })
        expect(await Session.children(execution.id)).toHaveLength(1)
        await Session.update(reviewer.id, (draft) => {
          draft.cortex!.taskID = "ctx_old"
        })
        await expect(
          (await BlueprintLoopApproveTool.init()).execute({ summary: "Stale review" }, context(reviewer.id)),
        ).rejects.toThrow()
      },
    }),
  )
})

for (const verdict of ["approve", "reject"] as const) {
  test(`cancelled reviewer cannot ${verdict} after reading its binding`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const { execution, reviewer, loop } = await pendingReview()
          const controller = new AbortController()
          const resolve = BlueprintLoopReviewAccess.resolve
          using binding = spyOn(BlueprintLoopReviewAccess, "resolve").mockImplementation(async (input) => {
            const result = await resolve(input)
            controller.abort(new Error("Review cancelled"))
            return result
          })
          const ctx = { ...context(reviewer.id), abort: controller.signal }
          const operation =
            verdict === "approve"
              ? (await BlueprintLoopApproveTool.init()).execute({ summary: "Verified" }, ctx)
              : (await BlueprintLoopRejectTool.init()).execute({ reason: "More work" }, ctx)
          await expect(operation).rejects.toThrow("Review cancelled")
          expect(await BlueprintLoopStore.get(execution.scope.id, loop.id)).toMatchObject({
            status: "auditing",
            auditTaskID: "ctx_review",
          })
        },
      }),
    )
  })
}
