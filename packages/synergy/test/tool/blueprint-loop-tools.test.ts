import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { AgendaStore } from "../../src/agenda/store"
import { BlueprintLoopStore } from "../../src/blueprint"
import { Cortex } from "../../src/cortex"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { BlueprintLoopReviewAccess } from "../../src/session/blueprint-loop-review-access"
import { BlueprintContinuationPolicy } from "../../src/session/blueprint-continuation"
import { SessionManager } from "../../src/session/manager"
import { BlueprintLoopApproveTool } from "../../src/tool/blueprint-loop-approve"
import { BlueprintLoopRejectTool } from "../../src/tool/blueprint-loop-reject"
import { BlueprintLoopStopTool } from "../../src/tool/blueprint-loop-stop"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

let originalPrepare: typeof Cortex.prepare
let originalStart: typeof Cortex.start
let originalCancel: typeof Cortex.cancel
let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalPrepare = Cortex.prepare
  originalStart = Cortex.start
  originalCancel = Cortex.cancel
  originalDeliver = SessionManager.deliver
})

afterEach(() => {
  ;(Cortex.prepare as any) = originalPrepare
  ;(Cortex.start as any) = originalStart
  ;(Cortex.cancel as any) = originalCancel
  ;(SessionManager.deliver as any) = originalDeliver
})

function ctx(sessionID: string, agent = "synergy"): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

async function createRunningLoop(input?: {
  auditAgent?: string
  userPrompt?: string
  budget?: { maxRuntimeMs: number; maxIterations: number }
  auditTools?: Record<string, boolean>
  source?: "user" | "lattice"
  sourceDigest?: string
}) {
  const session = await Session.create({})
  const loop = await BlueprintLoopStore.create({
    noteID: "note_blueprint",
    title: "Test Blueprint",
    sessionID: session.id,
    auditAgent: input?.auditAgent,
    budget: input?.budget,
    auditTools: input?.auditTools,
    source: input?.source,
    sourceDigest: input?.sourceDigest,
  })
  const running = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
    status: "running",
    userPrompt: input?.userPrompt ?? null,
  })
  await Session.update(session.id, (draft) => {
    draft.blueprint = { loopID: loop.id, loopRole: "execution" }
  })
  return { session, loop: running }
}

function installReviewerLaunch(launches: Parameters<typeof Cortex.prepare>[0][] = []) {
  const tasks = new Map<string, Awaited<ReturnType<typeof Cortex.prepare>>>()
  ;(Cortex.prepare as any) = mock(async (input: Parameters<typeof Cortex.prepare>[0]) => {
    launches.push(input)
    const taskID = Identifier.short("cortex")
    const startedAt = Date.now()
    const reviewSession = await Session.create({
      parentID: input.parentSessionID,
      cortex: {
        taskID,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
        description: input.description,
        agent: input.agent,
        executionRole: input.executionRole,
        startedAt,
        status: "queued",
      },
    })
    const task = {
      id: taskID,
      sessionID: reviewSession.id,
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      description: input.description,
      prompt: input.prompt,
      agent: input.agent,
      executionRole: input.executionRole,
      category: input.category,
      status: "queued" as const,
      startedAt,
      notifyParentOnComplete: input.notifyParentOnComplete,
    } as Awaited<ReturnType<typeof Cortex.prepare>>
    tasks.set(taskID, task)
    return task
  })
  ;(Cortex.start as any) = mock(async (taskID: string) => {
    const task = tasks.get(taskID)
    if (!task) throw new Error(`Cortex task ${taskID} not found`)
    task.status = "running"
    await Session.update(task.sessionID, (draft) => {
      if (draft.cortex) draft.cortex.status = "running"
    })
    return task
  })
  return launches
}

async function startPendingReview(sessionID: string) {
  const session = await Session.get(sessionID)
  return BlueprintContinuationPolicy.handle({
    session,
    scopeID: ScopeContext.current.scope.id,
    sessionID,
    terminalMessageID: Identifier.ascending("message"),
  })
}

async function requestReview(input?: Parameters<typeof createRunningLoop>[0]) {
  const running = await createRunningLoop(input)
  const launches = installReviewerLaunch()
  const tool = await BlueprintLoopStopTool.init()
  const result = await tool.execute(
    {
      summary: "All Blueprint requirements are implemented.",
      completed: ["Implemented the requested behavior"],
      evidence: ["Focused tests pass"],
      remaining: [],
    },
    ctx(running.session.id),
  )
  await startPendingReview(running.session.id)
  const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, running.loop.id)
  return { ...running, loop, launches, result, reviewSessionID: loop.auditSessionID! }
}

describe("blueprint_loop_stop", () => {
  test("registry contains exactly the three BlueprintLoop lifecycle tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const ids = (await ToolRegistry.tools("test-provider"))
          .map((tool) => tool.id)
          .filter((id) => id.startsWith("blueprint_loop_"))
          .sort()
        expect(ids).toEqual(["blueprint_loop_approve", "blueprint_loop_reject", "blueprint_loop_stop"])
      },
    })
  })

  test("records a durable stop intent without launching the reviewer", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop({
          auditAgent: "security-reviewer",
          userPrompt: "Do not change the public CLI contract.",
          auditTools: { plugin__truthward__context_query: true, plugin__truthward__n03_artifact_get: true },
          source: "lattice",
        })
        const launches = installReviewerLaunch()
        const tool = await BlueprintLoopStopTool.init()
        const result = await tool.execute(
          {
            summary: "All Blueprint requirements are implemented.",
            completed: ["Implemented the requested behavior"],
            evidence: ["Focused tests pass"],
            remaining: [],
          },
          ctx(session.id),
        )

        const updated = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(result.metadata.loopStopRequested).toBe(true)
        expect(result.metadata).toMatchObject({
          reviewRequested: true,
          reviewStarted: false,
          requiredAgentAction: "end_turn",
        })
        expect(JSON.parse(result.output)).toMatchObject({
          ok: true,
          code: "BLUEPRINT_LOOP_REVIEW_QUEUED",
          review: {
            requested: true,
            started: false,
            startsAfterAssistantTurn: true,
          },
          requiredAgentAction: {
            kind: "end_turn",
          },
        })
        expect(result.output).toContain("Do not call another tool")
        expect(result.output).toContain("future Lattice Pathway Step")
        expect(launches).toHaveLength(0)

        const duplicateBeforeReview = await tool.execute(
          { summary: "Duplicate request before the execution turn ends." },
          ctx(session.id),
        )
        expect(JSON.parse(duplicateBeforeReview.output)).toMatchObject({
          ok: true,
          code: "BLUEPRINT_LOOP_REVIEW_ALREADY_QUEUED",
          duplicate: true,
          review: {
            requested: true,
            started: false,
            startsAfterAssistantTurn: true,
          },
          requiredAgentAction: { kind: "end_turn" },
        })
        expect(launches).toHaveLength(0)

        expect(updated.status).toBe("running")
        expect(updated.auditSessionID).toBeUndefined()
        expect(updated.auditTaskID).toBeUndefined()
        expect((updated as any).stopRequest).toMatchObject({
          summary: "All Blueprint requirements are implemented.",
          completed: ["Implemented the requested behavior"],
          evidence: ["Focused tests pass"],
          requesterSessionID: session.id,
        })

        await startPendingReview(session.id)
        const reviewing = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(launches).toHaveLength(1)
        expect(launches[0].agent).toBe("security-reviewer")
        expect(launches[0].parentSessionID).toBe(session.id)
        expect(launches[0].notifyParentOnComplete).toBe(false)
        expect(launches[0].visibility).toBe("visible")
        expect(launches[0].prompt).toContain(`Session ID: ${session.id}`)
        expect(launches[0].prompt).toContain("Do not change the public CLI contract.")
        expect(launches[0].prompt).toContain("blueprint_loop_approve")
        expect(launches[0].prompt).toContain("blueprint_loop_reject")
        expect(launches[0].prompt).toContain("Change Scope, boundaries, and non-goals")
        expect(launches[0].prompt).toContain("future Lattice Pathway steps")
        expect(launches[0].prompt).toContain("first successful blueprint_loop_stop")
        // Audit launch receives exactly persisted auditTools, no execution-only submit tool
        expect(launches[0].tools).toEqual({
          plugin__truthward__context_query: true,
          plugin__truthward__n03_artifact_get: true,
        })
        expect(launches[0].tools).not.toHaveProperty("plugin__truthward__n03_submit")

        expect(reviewing.status).toBe("auditing")
        expect(reviewing.auditTaskID).toBeDefined()
        const reviewSession = await Session.get(reviewing.auditSessionID!)
        expect(reviewSession.blueprint).toEqual({ loopID: loop.id, loopRole: "audit" })
      },
    })
  })

  test("is idempotent while a recorded review is pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, launches, reviewSessionID } = await requestReview()
        const tool = await BlueprintLoopStopTool.init()
        const result = await tool.execute({ summary: "Still done" }, ctx(session.id))

        expect(launches).toHaveLength(1)
        expect(result.metadata.reviewSessionID).toBe(reviewSessionID)
        expect(JSON.parse(result.output)).toMatchObject({
          ok: true,
          code: "BLUEPRINT_LOOP_REVIEW_ALREADY_STARTED",
          review: {
            requested: true,
            started: true,
          },
          requiredAgentAction: {
            kind: "end_turn",
          },
        })
        expect(result.output).toContain("Do not call tools to inspect")
      },
    })
  })

  test("rejects calls outside the bound execution session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { loop } = await createRunningLoop()
        const unrelated = await Session.create({})
        await Session.update(unrelated.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "audit" }
        })

        const tool = await BlueprintLoopStopTool.init()
        await expect(tool.execute({ summary: "done" }, ctx(unrelated.id))).rejects.toThrow(
          "Only the BlueprintLoop execution session may request review",
        )
      },
    })
  })
  test("rejects audit while an Agenda item can still wake the BlueprintLoop session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop()
        const agenda = await AgendaStore.create({
          title: "Blueprint experiment progress",
          prompt: "Check the Blueprint experiment",
          triggers: [{ type: "every", interval: "30m" }],
          wake: true,
          silent: false,
          autoDone: true,
          createdBy: "agent",
          sessionID: session.id,
        })
        const launches = installReviewerLaunch()
        const tool = await BlueprintLoopStopTool.init()

        await expect(tool.execute({ summary: "done" }, ctx(session.id))).rejects.toThrow(
          `agenda_cancel(id="${agenda.id}")`,
        )
        expect(launches).toHaveLength(0)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
      },
    })
  })
})

describe("BlueprintLoopReviewAccess", () => {
  test("resolves only the reviewer recorded on the active audit", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, reviewSessionID } = await requestReview({ auditAgent: "security-reviewer" })
        const access = await BlueprintLoopReviewAccess.resolve({
          agent: "security-reviewer",
          reviewSessionID,
        })
        expect(access?.executionSession.id).toBe(session.id)

        expect(
          await BlueprintLoopReviewAccess.resolve({
            agent: "supervisor",
            reviewSessionID,
          }),
        ).toBeUndefined()
      },
    })
  })
})

describe("blueprint_loop_approve", () => {
  test("completes the loop and notifies the execution session from the recorded reviewer", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop, reviewSessionID } = await requestReview()
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const tool = await BlueprintLoopApproveTool.init()
        const result = await tool.execute(
          { sessionID: session.id, summary: "All acceptance criteria are verified." },
          ctx(reviewSessionID, "supervisor"),
        )

        expect(result.metadata.loopApproved).toBe(true)
        expect(await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).toMatchObject({
          status: "completed",
          summary: "All acceptance criteria are verified.",
        })
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].target).toBe(session.id)
        expect(deliveries[0].mail.metadata).toMatchObject({
          source: "blueprint_loop_completed",
          sourceSessionID: reviewSessionID,
          summary: "All acceptance criteria are verified.",
        })
        const part = deliveries[0].mail.parts[0]
        expect(part.type).toBe("text")
        if (part.type === "text") expect(part.origin).toBe("system")
      },
    })
  })

  test("rejects approval from the execution session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await requestReview()
        const tool = await BlueprintLoopApproveTool.init()
        await expect(
          tool.execute({ sessionID: session.id, summary: "approved" }, ctx(session.id, "supervisor")),
        ).rejects.toThrow("Only the recorded reviewer session may approve this BlueprintLoop review")
      },
    })
  })

  test("does not inject parent-session instructions for a Lattice-owned loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop, reviewSessionID } = await requestReview({
          source: "lattice",
          sourceDigest: "digest-a",
        })
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const approve = await BlueprintLoopApproveTool.init()
        const result = await approve.execute(
          { sessionID: session.id, summary: "All requirements verified" },
          ctx(reviewSessionID, "supervisor"),
        )

        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("completed")
        expect(deliveries).toHaveLength(0)
        expect(result.output).not.toContain("result_analysis")
        expect(result.output).not.toContain("pathway_patch")
      },
    })
  })
})

describe("blueprint_loop_reject", () => {
  test("returns the loop to execution with structured audit feedback", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop, reviewSessionID } = await requestReview()
        const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
        ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
          deliveries.push(input)
        })

        const tool = await BlueprintLoopRejectTool.init()
        const result = await tool.execute(
          {
            sessionID: session.id,
            reason: "One acceptance criterion is not verified.",
            completed: "Core implementation is correct.",
            remaining: "The CLI contract test is missing. BLOCKING",
            instructions: "Add and run the CLI contract test.",
          },
          ctx(reviewSessionID, "supervisor"),
        )

        const updated = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(updated.status).toBe("running")
        expect(updated.audit?.attempts).toBe(1)
        expect(updated.audit?.lastReason).toBe("One acceptance criterion is not verified.")
        expect(updated.auditSessionID).toBeUndefined()
        expect(result.metadata.loopRejected).toBe(true)
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0].mail.metadata).toMatchObject({
          source: "blueprint_loop_rejected",
          sourceSessionID: reviewSessionID,
          reason: "One acceptance criterion is not verified.",
        })
        const part = deliveries[0].mail.parts[0]
        expect(part.type).toBe("text")
        if (part.type === "text") expect(part.origin).toBe("system")
      },
    })
  })

  test("exhausts the configured iteration budget when the rejection reaches the limit", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop, reviewSessionID } = await requestReview({
          budget: { maxRuntimeMs: 60_000, maxIterations: 1 },
        })
        ;(SessionManager.deliver as any) = mock(async () => {})
        const reject = await BlueprintLoopRejectTool.init()
        const result = await reject.execute(
          {
            sessionID: session.id,
            reason: "Acceptance evidence is incomplete.",
            remaining: "Add the missing verification. BLOCKING",
            instructions: "Run and record the missing verification.",
          },
          ctx(reviewSessionID, "supervisor"),
        )

        const exhausted = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(exhausted.status).toBe("failed")
        expect(exhausted.error).toContain("iteration_exhausted")
        expect(exhausted.audit?.attempts).toBe(1)
        expect(result.metadata.iterationExhausted).toBe(true)
      },
    })
  })

  test("rejects feedback from an unrecorded reviewer session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session } = await requestReview()
        const unrelated = await Session.create({})
        const tool = await BlueprintLoopRejectTool.init()
        await expect(
          tool.execute(
            {
              sessionID: session.id,
              reason: "missing evidence",
              remaining: "Verification is missing. BLOCKING",
              instructions: "Run the required checks.",
            },
            ctx(unrelated.id, "supervisor"),
          ),
        ).rejects.toThrow("Only the recorded reviewer session may reject this BlueprintLoop review")
      },
    })
  })
})
