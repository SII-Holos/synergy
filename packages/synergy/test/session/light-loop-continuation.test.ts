import { afterEach, describe, expect, mock, test } from "bun:test"
import { Cortex } from "../../src/cortex"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { LightLoopContinuationPolicy } from "../../src/light-loop/continuation"
import type { ContinuationKernel } from "../../src/session/continuation-kernel"
import type { Info as SessionInfo } from "../../src/session/types"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const originalPrepare = (Cortex as any).prepare
const originalStart = (Cortex as any).start
const originalUpdate = Session.update

afterEach(() => {
  ;(Cortex as any).prepare = originalPrepare
  ;(Cortex as any).start = originalStart
  ;(Session.update as any) = originalUpdate
})

function gate(session: Partial<SessionInfo>): ContinuationKernel.Gate {
  return {
    session: session as SessionInfo,
    scopeID: "scope_test",
    sessionID: session.id ?? "ses_test",
    terminalMessageID: "msg_terminal",
  }
}

describe("LightLoopContinuationPolicy", () => {
  test("proposes a system continuation when Light Loop is active", async () => {
    const proposal = await LightLoopContinuationPolicy.handle(
      gate({
        id: "ses_light_loop",
        workflow: { kind: "lightloop", instructions: "Write unit tests" },
      }),
    )

    if (!proposal || proposal.kind !== "inbox") throw new Error("expected inbox proposal")
    expect(proposal.kind).toBe("inbox")
    expect(proposal.mode).toBe("steer")
    expect(proposal.message.summary?.title).toBe("Continue light loop")
    expect(proposal.message.origin).toEqual({ type: "system" })
    expect(proposal.message.metadata?.source).toBe("light_loop_continuation")
    expect(proposal.message.parts).toHaveLength(1)
    const part = proposal.message.parts[0]
    expect(part.type).toBe("text")
    if (part.type !== "text") throw new Error("expected text part")
    expect(part.origin).toBe("system")
    expect(part.synthetic).toBeUndefined()
    expect(part.text).toContain("Task: Write unit tests")
    expect(part.text).toContain("loop_stop()")
  })

  test.each([
    { name: "another workflow", workflow: { kind: "plan" as const } },
    { name: "no workflow", workflow: undefined },
  ])("does not propose for $name", async ({ workflow }) => {
    expect(await LightLoopContinuationPolicy.handle(gate({ workflow }))).toBeUndefined()
  })

  test.each(["completed", "failed", "cancelled", "timed_out", "iteration_exhausted"] as const)(
    "does not propose for a %s Light Loop retained for plugin lifecycle delivery",
    async (status) => {
      expect(
        await LightLoopContinuationPolicy.handle(
          gate({
            workflow: {
              kind: "lightloop",
              instructions: "Plugin-owned task",
              status,
              pluginOwner: {
                pluginId: "test-plugin",
                pluginGeneration: "generation-one",
                scopeId: "scope_test",
              },
            },
          }),
        ),
      ).toBeUndefined()
    },
  )

  test("does not propose while a completion review is pending", async () => {
    const proposal = await LightLoopContinuationPolicy.handle(
      gate({
        id: "ses_review_pending",
        workflow: {
          kind: "lightloop",
          instructions: "Write unit tests",
          stopRequest: {
            summary: "done",
            requestedAt: Date.now(),
            requesterSessionID: "ses_review_pending",
            requesterMessageID: "msg_123",
            reviewSessionID: "ses_reviewer",
          },
        },
      }),
    )

    expect(proposal).toBeUndefined()
  })

  test("prepares, binds, and starts a reviewer for a pending stop intent", async () => {
    const order: string[] = []
    const session = {
      id: "ses_partial_review",
      workflow: {
        kind: "lightloop" as const,
        instructions: "Write unit tests",
        reviewAgent: "security-reviewer",
        reviewTools: {
          plugin__truthward__context_query: true,
          plugin__truthward__n03_artifact_get: true,
        },
        stopRequest: {
          summary: "done",
          completed: ["Implemented the behavior"],
          evidence: ["Focused tests pass"],
          requestedAt: Date.now(),
          requesterSessionID: "ses_partial_review",
          requesterMessageID: "msg_123",
        },
      },
    }
    ;(Cortex as any).prepare = mock(async (input: any) => {
      order.push("prepare")
      expect(input.parentSessionID).toBe(session.id)
      expect(input.parentMessageID).toBe("msg_123")
      expect(input.agent).toBe("security-reviewer")
      expect(input.tools).toEqual({
        plugin__truthward__context_query: true,
        plugin__truthward__n03_artifact_get: true,
      })
      expect(input.tools).not.toHaveProperty("plugin__truthward__n03_submit")
      expect(input.visibility).toBe("visible")
      expect(input.notifyParentOnComplete).toBe(false)
      expect(input.prompt).toContain("Focused tests pass")
      return { id: "ctx_review", sessionID: "ses_reviewer", status: "queued" }
    })
    ;(Session.update as any) = mock(async (_sessionID: string, fn: (draft: any) => void) => {
      order.push("bind")
      fn(session)
    })
    ;(Cortex as any).start = mock(async (taskID: string) => {
      order.push("start")
      expect(taskID).toBe("ctx_review")
      expect((session.workflow.stopRequest as any).reviewTaskID).toBe("ctx_review")
      expect((session.workflow.stopRequest as any).reviewSessionID).toBe("ses_reviewer")
    })

    const proposal = await LightLoopContinuationPolicy.handle(gate(session))

    expect(proposal).toEqual({ kind: "handled" })
    expect(order).toEqual(["prepare", "bind", "start"])
  })

  test("reuses a completed reviewer that omitted the terminal review tool", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const requesterMessageID = "msg_review_request"
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "ctx_completed_review",
            parentSessionID: execution.id,
            parentMessageID: requesterMessageID,
            description: "Review LightLoop",
            agent: "lightloop-reviewer",
            status: "completed",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        })
        await Session.update(execution.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Write unit tests",
            status: "reviewing",
            stopRequest: {
              summary: "done",
              requestedAt: Date.now(),
              requesterSessionID: execution.id,
              requesterMessageID,
              reviewTaskID: "ctx_completed_review",
              reviewSessionID: reviewer.id,
            },
          }
        })
        ;(Cortex as any).prepare = mock(async (input: any) => {
          expect(input.sessionID).toBe(reviewer.id)
          expect(input.parentSessionID).toBe(execution.id)
          expect(input.parentMessageID).toBe(requesterMessageID)
          expect(input.reuseInterrupted).toBe(true)
          expect(input.tools).toEqual({
            "*": false,
            light_loop_approve: true,
            light_loop_reject: true,
          })
          expect(input.prompt).toContain(`Execution session ID: ${execution.id}`)
          expect(input.prompt).toContain("Do not search for sessions")
          return { id: "ctx_recovery_review", sessionID: reviewer.id, status: "queued" }
        })
        ;(Cortex as any).start = mock(async (taskID: string) => {
          expect(taskID).toBe("ctx_recovery_review")
        })

        const proposal = await LightLoopContinuationPolicy.handle(gate(await Session.get(execution.id)))

        expect(proposal).toEqual({ kind: "handled" })
        const recovered = await Session.get(execution.id)
        if (recovered.workflow?.kind !== "lightloop") throw new Error("expected LightLoop workflow")
        expect(recovered.workflow.stopRequest?.reviewSessionID).toBe(reviewer.id)
        expect(recovered.workflow.stopRequest?.reviewTaskID).toBe("ctx_recovery_review")
        expect(recovered.workflow.stopRequest?.reviewToolRecoveryAttempts).toBe(1)
      },
    })
  })

  test("terminalizes after the bounded terminal-tool recovery budget is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const requesterMessageID = "msg_review_request"
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "ctx_exhausted_review",
            parentSessionID: execution.id,
            parentMessageID: requesterMessageID,
            description: "Review LightLoop",
            agent: "lightloop-reviewer",
            status: "completed",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        })
        await Session.update(execution.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Write unit tests",
            status: "reviewing",
            stopRequest: {
              summary: "done",
              requestedAt: Date.now(),
              requesterSessionID: execution.id,
              requesterMessageID,
              reviewTaskID: "ctx_exhausted_review",
              reviewSessionID: reviewer.id,
              reviewToolRecoveryAttempts: 2,
            },
          }
        })
        const prepare = mock(async () => {
          throw new Error("recovery must not relaunch after exhaustion")
        })
        ;(Cortex as any).prepare = prepare

        const proposal = await LightLoopContinuationPolicy.handle(gate(await Session.get(execution.id)))

        expect(proposal).toEqual({ kind: "handled" })
        expect(prepare).not.toHaveBeenCalled()
        expect((await Session.get(execution.id)).workflow).toBeUndefined()
      },
    })
  })

  test("terminalizes with the real launch error when the reviewer failed to launch", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const requesterMessageID = "msg_review_request"
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "ctx_launch_failed_review",
            parentSessionID: execution.id,
            parentMessageID: requesterMessageID,
            description: "Review LightLoop",
            agent: "lightloop-reviewer",
            status: "error",
            error: "No model configured for agent lightloop-reviewer",
            launchFailure: true,
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        })
        await Session.update(execution.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Write unit tests",
            status: "reviewing",
            stopRequest: {
              summary: "done",
              requestedAt: Date.now(),
              requesterSessionID: execution.id,
              requesterMessageID,
              reviewTaskID: "ctx_launch_failed_review",
              reviewSessionID: reviewer.id,
            },
          }
        })
        const prepare = mock(async () => {
          throw new Error("recovery must not relaunch after a launch failure")
        })
        ;(Cortex as any).prepare = prepare

        const proposal = await LightLoopContinuationPolicy.handle(gate(await Session.get(execution.id)))

        expect(proposal).toEqual({ kind: "handled" })
        expect(prepare).not.toHaveBeenCalled()
        const finalized = await Session.get(execution.id)
        expect(finalized.workflow).toBeUndefined()
        const messages = await Session.messages({ sessionID: execution.id })
        const failure = messages.find((message) => message.info.metadata?.source === "light_loop_exhaustion")
        if (!failure) throw new Error("expected an exhaustion failure message")
        const part = failure.parts.find((p) => p.type === "text")
        if (!part || part.type !== "text") throw new Error("expected a text failure part")
        expect(part.text).toContain("reviewer_launch_failed")
        expect(part.text).toContain("No model configured for agent lightloop-reviewer")
      },
    })
  })

  test.each(["error", "cancelled"] as const)(
    "retries when reviewer is %s by consuming recovery budget",
    async (status) => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const execution = await Session.create({})
          const requesterMessageID = "msg_review_request"
          const reviewer = await Session.create({
            parentID: execution.id,
            cortex: {
              taskID: "ctx_errored_review",
              parentSessionID: execution.id,
              parentMessageID: requesterMessageID,
              description: "Review LightLoop",
              agent: "lightloop-reviewer",
              status,
              ...(status === "error" ? { error: "some crash" } : {}),
              startedAt: Date.now(),
              completedAt: Date.now(),
            },
          })
          await Session.update(execution.id, (draft) => {
            draft.workflow = {
              kind: "lightloop",
              instructions: "Write unit tests",
              status: "reviewing",
              stopRequest: {
                summary: "done",
                requestedAt: Date.now(),
                requesterSessionID: execution.id,
                requesterMessageID,
                reviewTaskID: "ctx_errored_review",
                reviewSessionID: reviewer.id,
              },
            }
          })
          ;(Cortex as any).prepare = mock(async (input: any) => {
            expect(input.sessionID).toBe(reviewer.id)
            expect(input.parentSessionID).toBe(execution.id)
            expect(input.parentMessageID).toBe(requesterMessageID)
            expect(input.reuseInterrupted).toBe(true)
            return { id: "ctx_recovery_review", sessionID: reviewer.id, status: "queued" }
          })
          ;(Cortex as any).start = mock(async () => {})

          const proposal = await LightLoopContinuationPolicy.handle(gate(await Session.get(execution.id)))

          expect(proposal).toEqual({ kind: "handled" })
          const recovered = await Session.get(execution.id)
          if (recovered.workflow?.kind !== "lightloop") throw new Error("expected LightLoop workflow")
          expect(recovered.workflow.stopRequest?.reviewSessionID).toBe(reviewer.id)
          expect(recovered.workflow.stopRequest?.reviewTaskID).toBe("ctx_recovery_review")
          expect(recovered.workflow.stopRequest?.reviewToolRecoveryAttempts).toBe(1)
        },
      })
    },
  )

  test("delivers an inbox failure message when non-plugin Light Loop review recovery is exhausted", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const requesterMessageID = "msg_review_request"
        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            taskID: "ctx_exhausted_review",
            parentSessionID: execution.id,
            parentMessageID: requesterMessageID,
            description: "Review LightLoop",
            agent: "lightloop-reviewer",
            status: "completed",
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        })
        await Session.update(execution.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            instructions: "Write unit tests",
            status: "reviewing",
            stopRequest: {
              summary: "done",
              requestedAt: Date.now(),
              requesterSessionID: execution.id,
              requesterMessageID,
              reviewTaskID: "ctx_exhausted_review",
              reviewSessionID: reviewer.id,
              reviewToolRecoveryAttempts: 2,
            },
          }
        })
        const prepare = mock(async () => {
          throw new Error("recovery must not relaunch after exhaustion")
        })
        ;(Cortex as any).prepare = prepare

        const proposal = await LightLoopContinuationPolicy.handle(gate(await Session.get(execution.id)))

        expect(proposal).toEqual({ kind: "handled" })
        expect(prepare).not.toHaveBeenCalled()
        expect((await Session.get(execution.id)).workflow).toBeUndefined()

        const messages = await Session.messages({ sessionID: execution.id })
        const failure = messages.find((message) => message.info.metadata?.source === "light_loop_exhaustion")
        expect(failure?.info.role).toBe("assistant")
        const part = failure?.parts[0]
        expect(part?.type).toBe("text")
        if (part?.type !== "text") throw new Error("expected failure text")
        expect(part.text).toContain("review_terminal_tool_missing")
        expect(await SessionInbox.list(execution.id)).toEqual([])
      },
    })
  })
})
