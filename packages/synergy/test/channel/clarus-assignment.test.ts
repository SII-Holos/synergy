import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentPrompt, ClarusDeadline } from "../../src/channel/provider/clarus/assignment-prompt"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusResultOutbox } from "../../src/channel/provider/clarus/result-outbox"
import type { RuntimeTaskAssignedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { ScopeContext } from "../../src/scope/context"
import { AgendaStore } from "../../src/agenda/store"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

// =============================================================================
// Host-mediated dispatch helper — the canonical production path
// =============================================================================
async function dispatchAssignment(accountId: string, event: RuntimeTaskAssignedEvent) {
  const host = ChannelHost.create({ channelType: "clarus", accountId })
  return ClarusAssignmentRuntime.dispatch({ host, accountId, event })
}

// =============================================================================
// Test fixtures
// =============================================================================

function assignmentFixture(overrides: Partial<RuntimeTaskAssignedEvent> = {}): RuntimeTaskAssignedEvent {
  return {
    kind: "known",
    type: "runtimeTaskAssigned",
    agentID: "agent-fixture",
    requestID: crypto.randomUUID(),
    projectID: "project-fixture",
    runID: `run-${crypto.randomUUID()}`,
    taskID: `task-${crypto.randomUUID()}`,
    phase: "implementation",
    subtaskID: `subtask-${crypto.randomUUID()}`,
    attempt: 1,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    goal: "Implement the feature",
    instructions: "Use clean architecture",
    input: { files: ["src/a.ts"] },
    context: { lang: "TypeScript" },
    epoch: 1,
    generation: 1,
    ...overrides,
  }
}

function resultPayload() {
  return {
    success: true,
    output: "Done",
    artifacts: [],
    evidenceRefs: [],
    notaryRefs: [],
    error: null,
    submittedBy: "synergy",
  }
}

async function setupProjectScope(accountId: string, projectID: string) {
  return Channel.ensureProjectScope({
    channelType: "clarus",
    accountId,
    externalProjectId: projectID,
    projectName: `Project ${projectID}`,
  })
}

// =============================================================================
// 1. Assignment identity and Session lifecycle
// =============================================================================

describe("Clarus assignment identity and Session lifecycle", () => {
  test("first assignment creates exactly one task-target Session in the correct managed Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("identity-account", "identity-project")
        const event = assignmentFixture({
          agentID: "identity-account",
          projectID: "identity-project",
          taskID: "task-identity-1",
          runID: "run-identity-1",
        })

        const result = await dispatchAssignment("identity-account", event)
        const session = await Session.get(result.assignment.sessionID)

        expect(result.created).toBe(true)
        expect(session.scope.id).toBe(scope.id)
        expect(session.scope.type).toBe("project")
        expect(session.endpoint).not.toBeUndefined()
        expect(session.endpoint?.channel?.target?.kind).toBe("task")
        expect(session.interaction).toEqual({ mode: "unattended", source: "channel:clarus" })
        expect(session.controlProfile).toBe("autonomous")
        expect(await SessionInbox.list(session.id)).toHaveLength(2)
        expect(result.assignment).not.toHaveProperty("scopeID")
        expect(result.assignment).not.toHaveProperty("workspacePath")
        expect(result.assignment.sessionID).toBe(session.id)
        expect(result.assignment.status).toBe("running")
      },
    })
  })

  test("exact replay with same runID is no-op and returns same Session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("replay-account", "replay-project")
        const event = assignmentFixture({
          agentID: "replay-account",
          projectID: "replay-project",
          taskID: "task-replay-1",
          runID: "run-replay-1",
        })

        const first = await dispatchAssignment("replay-account", event)
        const second = await dispatchAssignment("replay-account", event)

        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(second.assignment.sessionID).toBe(first.assignment.sessionID)
        expect(await SessionInbox.list(first.assignment.sessionID)).toHaveLength(2)
      },
    })
  })
  test("concurrent exact replay converges on one Session and one delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("concurrent-replay-account", "concurrent-replay-project")
        const event = assignmentFixture({
          agentID: "concurrent-replay-account",
          projectID: "concurrent-replay-project",
          taskID: "task-concurrent-replay-1",
          runID: "run-concurrent-replay-1",
          subtaskID: "subtask-concurrent-replay-1",
        })

        const results = await Promise.all([
          dispatchAssignment("concurrent-replay-account", event),
          dispatchAssignment("concurrent-replay-account", event),
        ])

        expect(new Set(results.map((result) => result.assignment.sessionID)).size).toBe(1)
        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(await ScopeContext.provide({ scope, fn: () => Session.list().then((list) => list.total) })).toBe(1)
        expect(await SessionInbox.list(results[0]!.assignment.sessionID)).toHaveLength(2)
      },
    })
  })

  test("new run/attempt reuses Session with a new deterministic delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("rerun-account", "rerun-project")
        const firstEvent = assignmentFixture({
          agentID: "rerun-account",
          projectID: "rerun-project",
          taskID: "task-rerun-1",
          runID: "run-v1",
        })
        const secondEvent = assignmentFixture({
          agentID: "rerun-account",
          projectID: "rerun-project",
          taskID: "task-rerun-1",
          runID: "run-v2",
          attempt: 2,
        })

        const first = await dispatchAssignment("rerun-account", firstEvent)
        const second = await dispatchAssignment("rerun-account", secondEvent)

        expect(first.created).toBe(true)
        expect(second.created).toBe(true)
        expect(second.assignment.sessionID).toBe(first.assignment.sessionID)
        expect(second.assignment.runID).toBe("run-v2")
        expect(second.assignment.taskID).toBe("task-rerun-1")

        const inbox = await SessionInbox.list(first.assignment.sessionID)
        expect(inbox).toHaveLength(4)
        const deliveryKeys = inbox.map((i) => i.deliveryKey).filter(Boolean)
        expect(new Set(deliveryKeys).size).toBe(4)
      },
    })
  })

  test("new attempt in the same run reuses the Session with a new delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await setupProjectScope("attempt-account", "attempt-project")
        const firstEvent = assignmentFixture({
          agentID: "attempt-account",
          projectID: "attempt-project",
          taskID: "task-attempt-1",
          runID: "run-attempt-1",
          subtaskID: "subtask-attempt-1",
          attempt: 1,
        })
        const secondEvent = {
          ...firstEvent,
          requestID: crypto.randomUUID(),
          attempt: 2,
        }

        const first = await dispatchAssignment("attempt-account", firstEvent)
        const second = await dispatchAssignment("attempt-account", secondEvent)

        expect(first.created).toBe(true)
        expect(second.created).toBe(true)
        expect(second.assignment.sessionID).toBe(first.assignment.sessionID)
        expect(await SessionInbox.list(first.assignment.sessionID)).toHaveLength(4)
      },
    })
  })
  test("new attempt after acknowledged result resets the assignment to running", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await setupProjectScope("completed-attempt-account", "completed-attempt-project")
        const firstEvent = assignmentFixture({
          agentID: "completed-attempt-account",
          projectID: "completed-attempt-project",
          taskID: "task-completed-attempt-1",
          runID: "run-completed-attempt-1",
          subtaskID: "subtask-completed-attempt-1",
          attempt: 1,
        })
        const first = await dispatchAssignment("completed-attempt-account", firstEvent)
        await ClarusResultOutbox.submit({
          sessionID: first.assignment.sessionID,
          payload: resultPayload(),
          send: async () => {},
        })
        expect((await ClarusAssignmentStore.findBySessionID(first.assignment.sessionID))?.assignment).toMatchObject({
          status: "completed",
          resultState: "acknowledged",
        })

        const second = await dispatchAssignment("completed-attempt-account", {
          ...firstEvent,
          requestID: crypto.randomUUID(),
          attempt: 2,
        })

        expect(second.created).toBe(true)
        expect(second.assignment).toMatchObject({
          sessionID: first.assignment.sessionID,
          attempt: 2,
          status: "running",
          resultState: "none",
          extensionState: "none",
        })
        expect(second.assignment.resultRequestID).toBeUndefined()
        expect(await SessionInbox.list(first.assignment.sessionID)).toHaveLength(4)
      },
    })
  })

  test("expired delayed assignment is skipped before Session creation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await setupProjectScope("expired-account", "expired-project")
        const event = assignmentFixture({
          agentID: "expired-account",
          projectID: "expired-project",
          taskID: "task-expired-1",
          runID: "run-expired-1",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        })

        await expect(dispatchAssignment("expired-account", event)).rejects.toMatchObject({
          name: "ClarusAssignmentExpiredError",
        })
        expect((await Session.list()).total).toBe(0)
        expect(
          await ClarusAssignmentStore.findByIdentity({
            accountId: "expired-account",
            projectID: "expired-project",
            taskID: "task-expired-1",
          }),
        ).toBeUndefined()
      },
    })
  })

  test("archived assignment Session blocks replay without creating a replacement", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("archived-account", "archived-project")
        const event = assignmentFixture({
          agentID: "archived-account",
          projectID: "archived-project",
          taskID: "task-archived-1",
          runID: "run-archived-1",
        })
        const first = await dispatchAssignment("archived-account", event)
        const session = await Session.get(first.assignment.sessionID)
        if (!session.endpoint) throw new Error("Expected Clarus assignment endpoint")
        await Session.archiveForEndpoint(session.endpoint, { scope })

        await expect(
          dispatchAssignment("archived-account", {
            ...event,
            requestID: crypto.randomUUID(),
            runID: "run-archived-2",
          }),
        ).rejects.toMatchObject({
          name: "ClarusAssignmentSessionArchivedError",
          data: { sessionID: first.assignment.sessionID },
        })

        expect((await Session.list()).total).toBe(0)
        const binding = await ClarusAssignmentStore.findByIdentity({
          accountId: "archived-account",
          projectID: "archived-project",
          taskID: "task-archived-1",
        })
        expect(binding?.assignment.sessionID).toBe(first.assignment.sessionID)
        expect(binding?.assignment.status).toBe("running")
      },
    })
  })

  test("new task retry creates a new Session and carries retryOfTaskID lineage", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("retry-account", "retry-project")
        const originalEvent = assignmentFixture({
          agentID: "retry-account",
          projectID: "retry-project",
          taskID: "task-original",
          runID: "run-original",
        })
        const retryEvent: RuntimeTaskAssignedEvent = {
          ...assignmentFixture({
            agentID: "retry-account",
            projectID: "retry-project",
            taskID: "task-retry",
            runID: "run-retry",
          }),
          retryOfTaskID: "task-original",
        }

        const original = await dispatchAssignment("retry-account", originalEvent)
        const retry = await dispatchAssignment("retry-account", retryEvent)

        expect(original.created).toBe(true)
        expect(retry.created).toBe(true)
        expect(retry.assignment.sessionID).not.toBe(original.assignment.sessionID)
        expect(retry.assignment.taskID).toBe("task-retry")
        expect(await SessionInbox.list(original.assignment.sessionID)).toHaveLength(2)
        expect(await SessionInbox.list(retry.assignment.sessionID)).toHaveLength(2)

        const originalSession = await Session.get(original.assignment.sessionID)
        const retrySession = await Session.get(retry.assignment.sessionID)
        expect(originalSession.scope.id).toBe(scope.id)
        expect(retrySession.scope.id).toBe(scope.id)
        expect(retryEvent.retryOfTaskID).toBe("task-original")
      },
    })
  })

  test("assignment Session uses autonomous control profile and unattended interaction", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("profile-account", "profile-project")
        const event = assignmentFixture({
          agentID: "profile-account",
          projectID: "profile-project",
          taskID: "task-profile-1",
          runID: "run-profile-1",
        })

        const result = await dispatchAssignment("profile-account", event)
        const session = await Session.get(result.assignment.sessionID)

        expect(session.controlProfile).toBe("autonomous")
        expect(session.interaction).toEqual({ mode: "unattended", source: "channel:clarus" })
      },
    })
  })
})

// =============================================================================
// 2. Assignment prompt structure
// =============================================================================

describe("Clarus assignment prompt structure", () => {
  test("contract: userPrompt includes every supplied field in deterministic order", () => {
    const event = assignmentFixture({
      goal: "Build the authentication module",
      instructions: "Use OAuth 2.0 with PKCE",
      input: { files: ["src/auth.ts", "src/oauth.ts"] },
      context: { framework: "Hono", runtime: "Bun" },
      taskInput: { budgets: { timeMs: 600000 } },
      attemptMode: "retry",
      retryOfTaskID: "task-previous",
    })

    const prompt = ClarusAssignmentPrompt.userPrompt("test-account", event)
    const lines = prompt.split("\n")

    expect(lines[0]).toBe("## Clarus assignment")
    expect(lines[2]).toBe("Account: test-account")
    expect(lines[3]).toBe(`Project: ${event.projectID}`)
    expect(lines[7]).toBe(`Phase: ${event.phase}`)
    expect(lines[8]).toBe(`Attempt: ${event.attempt}`)
    expect(lines[9]).toBe(`Attempt mode: ${event.attemptMode}`)
    expect(lines[10]).toBe(`Deadline: ${event.deadlineAt}`)
    expect(lines[11]).toBe(`Retry of: task-previous`)

    expect(countOccurrences(prompt, "**Goal**")).toBe(1)
    expect(countOccurrences(prompt, "**Instructions**")).toBe(1)
    expect(countOccurrences(prompt, "**Input**")).toBe(1)
    expect(countOccurrences(prompt, "**Context**")).toBe(1)
    expect(countOccurrences(prompt, "**Task input**")).toBe(1)
  })

  test("contract: userPrompt omits absent optionals without placeholders", () => {
    const event = assignmentFixture({
      goal: null,
      instructions: null,
      input: null,
      context: null,
      taskInput: null,
      attemptMode: undefined,
      retryOfTaskID: undefined,
    })
    const prompt = ClarusAssignmentPrompt.userPrompt("test-account", event)

    expect(prompt).not.toContain("**Goal**")
    expect(prompt).not.toContain("**Instructions**")
    expect(prompt).not.toContain("**Input**")
    expect(prompt).not.toContain("**Context**")
    expect(prompt).not.toContain("**Task input**")
    expect(prompt).not.toContain("null")
    expect(prompt).not.toContain("N/A")
    expect(prompt).not.toContain("undefined")
    expect(prompt).not.toContain("Attempt mode:")
    expect(prompt).toContain("## Clarus assignment")
  })

  test("contract: userPrompt preserves field order with partial fields supplied", () => {
    const event = assignmentFixture({
      goal: null,
      instructions: "Only instructions provided",
      input: null,
      context: { env: "prod" },
      taskInput: null,
    })
    const prompt = ClarusAssignmentPrompt.userPrompt("test-account", event)

    expect(prompt).not.toContain("**Goal**")
    const instrIdx = prompt.indexOf("**Instructions**")
    const ctxIdx = prompt.indexOf("**Context**")
    expect(instrIdx).toBeGreaterThan(0)
    expect(ctxIdx).toBeGreaterThan(instrIdx)
  })

  test("contract: participationGuidance is a separate text from userPrompt", () => {
    const event = assignmentFixture()
    const guidance = ClarusAssignmentPrompt.participationGuidance(event)

    expect(guidance).toContain("external Clarus task as an autonomous agent")
    expect(guidance).toContain(event.taskID)
    expect(guidance).toContain(event.projectID)
    expect(guidance).toContain(event.runID)

    const prompt = ClarusAssignmentPrompt.userPrompt("test-account", event)
    expect(prompt).not.toContain("external Clarus task as an autonomous agent")
  })

  test("dispatch delivers userPrompt including input, context, attemptMode, and retryOfTaskID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("prompt-account", "prompt-project")
        const event = assignmentFixture({
          agentID: "prompt-account",
          projectID: "prompt-project",
          taskID: "task-prompt",
          runID: "run-prompt",
          goal: "Process invoicing",
          instructions: "Use batch processing",
          input: { batchSize: 100 },
          context: { tenantID: "t-42" },
          taskInput: { priority: "high" },
          attemptMode: "retry",
          retryOfTaskID: "task-earlier",
        })

        const result = await dispatchAssignment("prompt-account", event)
        const inbox = await SessionInbox.list(result.assignment.sessionID)
        const assignmentItem = inbox.find((i) => i.deliveryKey?.startsWith("clarus-assignment:"))
        expect(assignmentItem).toBeDefined()

        const textParts = assignmentItem!.message?.parts?.filter(
          (p: { type: string; text?: string }) => p.type === "text",
        )
        expect(textParts).toBeDefined()
        const textContent = textParts?.map((p: { type: string; text?: string }) => p.text ?? "").join("\n") ?? ""

        expect(textContent).toContain("batchSize")
        expect(textContent).toContain("tenantID")
        expect(textContent).toContain("priority")
        expect(textContent).toContain("Attempt mode:")
        expect(textContent).toContain("Retry of:")
        expect(textContent).toContain("task-earlier")
      },
    })
  })

  test("dispatch delivers separate hidden system-origin participation guidance", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("guidance-account", "guidance-project")
        const event = assignmentFixture({
          agentID: "guidance-account",
          projectID: "guidance-project",
          taskID: "task-guidance",
          runID: "run-guidance",
        })

        const result = await dispatchAssignment("guidance-account", event)
        const inbox = await SessionInbox.list(result.assignment.sessionID)

        expect(inbox.length).toBeGreaterThanOrEqual(2)

        const guidanceItems = inbox.filter((i) => i.message?.visible === false && i.message?.origin?.type !== "user")
        expect(guidanceItems.length).toBeGreaterThanOrEqual(1)

        const visibleUserItems = inbox.filter((i) => i.message?.visible !== false)
        expect(visibleUserItems.length).toBeGreaterThanOrEqual(1)
      },
    })
  })
})

// =============================================================================
// 3. Deadline lead computation
// =============================================================================

describe("Clarus deadline lead computation", () => {
  test("computes bounded lead as min(5m, max(30s, 10% window))", () => {
    const now = 1_000_000_000
    expect(ClarusDeadline.leadMs(now + 600_000, now)).toBe(60_000)
    expect(ClarusDeadline.leadMs(now + 1_200_000, now)).toBe(120_000)
    expect(ClarusDeadline.leadMs(now + 3_600_000, now)).toBe(ClarusDeadline.MAX_LEAD_MS)
    expect(ClarusDeadline.leadMs(now + 7_200_000, now)).toBe(ClarusDeadline.MAX_LEAD_MS)
  })

  test("near or past deadlines use the earliest safe immediate trigger", () => {
    const now = 1_000_000_000
    expect(ClarusDeadline.leadMs(now + 40_000, now)).toBe(ClarusDeadline.MIN_LEAD_MS)
    expect(ClarusDeadline.leadMs(now - 3_600_000, now)).toBe(ClarusDeadline.MIN_LEAD_MS)
    expect(ClarusDeadline.triggerAt(now + 10_000, now)).toBe(now + 1_000)
    expect(ClarusDeadline.triggerAt(now - 5_000, now)).toBe(now + 1_000)
  })

  test("far-future deadline caps at five minute lead", () => {
    const now = 1_000_000_000
    expect(ClarusDeadline.leadMs(now + 86_400_000, now)).toBe(ClarusDeadline.MAX_LEAD_MS)
    expect(ClarusDeadline.leadMs(now + 604_800_000, now)).toBe(ClarusDeadline.MAX_LEAD_MS)
  })

  test("future Agenda trigger time is deadline minus lead", () => {
    const now = 1_000_000_000
    const deadlineAt = now + 3_600_000
    expect(ClarusDeadline.triggerAt(deadlineAt, now)).toBe(deadlineAt - ClarusDeadline.MAX_LEAD_MS)
  })
})

// =============================================================================
// 4. Deadline Agenda lifecycle
// =============================================================================

describe("Clarus deadline Agenda lifecycle", () => {
  test("dispatch creates one hidden Session-guidance reminder in the task Project Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("deadline-account", "deadline-project")
        const deadlineAt = new Date(Date.now() + 7_200_000).toISOString()
        const event = assignmentFixture({
          agentID: "deadline-account",
          projectID: "deadline-project",
          taskID: "task-deadline-1",
          runID: "run-deadline-1",
          deadlineAt,
        })

        const result = await dispatchAssignment("deadline-account", event)
        const items = await AgendaStore.list(scope.id)
        const deadlineItems = items.filter((item) => item.tags?.includes("clarus") && item.tags.includes("deadline"))

        expect(deadlineItems).toHaveLength(1)
        const item = deadlineItems[0]!
        expect(item.status).toBe("active")
        expect(item.deliveryMode).toBe("session_guidance")
        expect(item.origin.scope.id).toBe(scope.id)
        expect(item.origin.sessionID).toBe(result.assignment.sessionID)
        expect(item.prompt).toBe(ClarusDeadline.guidance())
        expect(item.triggers).toEqual([
          {
            type: "at",
            at: new Date(deadlineAt).getTime() - ClarusDeadline.MAX_LEAD_MS,
          },
        ])
      },
    })
  })

  test("assignment without a deadline creates no reminder", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("no-deadline-account", "no-deadline-project")
        const event = assignmentFixture({
          agentID: "no-deadline-account",
          projectID: "no-deadline-project",
          taskID: "task-no-deadline",
          runID: "run-no-deadline",
          deadlineAt: null,
        })

        await dispatchAssignment("no-deadline-account", event)

        const items = await AgendaStore.list(scope.id)
        expect(items.filter((item) => item.tags?.includes("deadline"))).toHaveLength(0)
      },
    })
  })

  test("exact replay keeps one reminder with the same deterministic ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("dedup-dl-account", "dedup-dl-project")
        const event = assignmentFixture({
          agentID: "dedup-dl-account",
          projectID: "dedup-dl-project",
          taskID: "task-dedup-dl",
          runID: "run-dedup-dl",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        await dispatchAssignment("dedup-dl-account", event)
        const firstItems = (await AgendaStore.list(scope.id)).filter((item) => item.tags?.includes("deadline"))
        expect(firstItems).toHaveLength(1)

        await dispatchAssignment("dedup-dl-account", event)
        const replayItems = (await AgendaStore.list(scope.id)).filter((item) => item.tags?.includes("deadline"))
        expect(replayItems).toHaveLength(1)
        expect(replayItems[0]!.id).toBe(firstItems[0]!.id)
      },
    })
  })

  test("remote Project pause leaves an accepted task reminder active", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "pause-dl-account"
        const projectID = "pause-dl-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-pause-dl-1",
          runID: "run-pause-dl-1",
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        })

        await dispatchAssignment(accountId, event)
        const host = ChannelHost.create({ channelType: "clarus", accountId })
        await host.projects.ensure({ externalProjectId: projectID, name: "Paused project", isActive: false })

        const items = (await AgendaStore.list(scope.id)).filter((item) => item.tags?.includes("deadline"))
        expect(items).toHaveLength(1)
        expect(items[0]!.status).toBe("active")
      },
    })
  })
})

// =============================================================================
// 5. Agenda delivery contract
// =============================================================================

describe("Agenda delivery contract for Clarus deadline", () => {
  test("Agenda fires hidden system guidance into the same assignment Session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("delivery-account", "delivery-project")
        const event = assignmentFixture({
          agentID: "delivery-account",
          projectID: "delivery-project",
          taskID: "task-delivery-1",
          runID: "run-delivery-1",
        })

        const result = await dispatchAssignment("delivery-account", event)

        const systemGuidance = ClarusAssignmentPrompt.participationGuidance(event)
        await SessionInbox.deliverUnique({
          sessionID: result.assignment.sessionID,
          deliveryKey: `clarus-deadline-guidance:${event.taskID}`,
          mode: "steer",
          message: {
            role: "user",
            parts: [{ type: "text", text: systemGuidance }],
            visible: false,
            origin: { type: "agenda", label: "agenda" },
            metadata: { source: "agenda", agendaItemID: "deadline-item-1" },
          },
        })

        const inbox = await SessionInbox.list(result.assignment.sessionID)
        const guidanceItems = inbox.filter((i) => i.deliveryKey?.includes("deadline-guidance"))
        expect(guidanceItems).toHaveLength(1)
        expect(guidanceItems[0]!.message?.visible).toBe(false)
        expect(guidanceItems[0]!.source?.type).toBe("agenda")
      },
    })
  })

  test("Agenda delivery does NOT create a visible user prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("hidden-account", "hidden-project")
        const event = assignmentFixture({
          agentID: "hidden-account",
          projectID: "hidden-project",
          taskID: "task-hidden-1",
          runID: "run-hidden-1",
        })

        const result = await dispatchAssignment("hidden-account", event)

        await SessionInbox.deliverUnique({
          sessionID: result.assignment.sessionID,
          deliveryKey: `clarus-deadline-hidden:${event.taskID}`,
          mode: "steer",
          message: {
            role: "user",
            parts: [{ type: "text", text: "Hidden deadline guidance" }],
            visible: false,
            origin: { type: "agenda", label: "agenda" },
          },
        })

        const inbox = await SessionInbox.list(result.assignment.sessionID)

        const assignmentItems = inbox.filter((i) => i.deliveryKey?.startsWith("clarus-assignment:"))
        for (const item of assignmentItems) {
          expect(item.message?.visible).not.toBe(false)
        }

        const guidanceItems = inbox.filter((i) => i.deliveryKey?.includes("deadline-hidden"))
        for (const item of guidanceItems) {
          expect(item.message?.visible).toBe(false)
        }

        const visibleUserItems = inbox.filter(
          (i) => i.message?.role === "user" && i.message?.visible !== false && !i.deliveryKey?.includes("deadline"),
        )
        expect(visibleUserItems).toHaveLength(1)
      },
    })
  })
})

// =============================================================================
// 6. Result outbox disposition invariants
// =============================================================================

describe("Clarus result outbox disposition", () => {
  test("result payload persists before send", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("persist-account", "persist-project")
        const event = assignmentFixture({
          agentID: "persist-account",
          projectID: "persist-project",
          taskID: "task-persist",
          runID: "run-persist",
        })

        const created = await dispatchAssignment("persist-account", event)

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash

        let persistedBeforeSend = false
        let recordStateBeforeSend = ""

        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          send: async () => {
            const hashes = await Storage.scan(StoragePath.clarusProviderResultOutboxRoot(acctHash))
            expect(hashes.length).toBeGreaterThan(0)
            const record = await Storage.read<{ state: string; payload: unknown }>(
              StoragePath.clarusProviderResultOutbox(acctHash, hashes[0]!),
            )
            recordStateBeforeSend = record.state
            persistedBeforeSend = record.state === "pending"
          },
        })

        expect(persistedBeforeSend).toBe(true)
        expect(recordStateBeforeSend).toBe("pending")
      },
    })
  })

  test("not_dispatched result may retry with a new request ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("retry-result-account", "retry-result-project")
        const event = assignmentFixture({
          agentID: "retry-result-account",
          projectID: "retry-result-project",
          taskID: "task-retry-result",
          runID: "run-retry-result",
        })

        const created = await dispatchAssignment("retry-result-account", event)

        const failure = {
          disposition: "not_dispatched" as const,
          requestID: "request-failed-1",
          code: "NOT_CONNECTED",
          message: "not connected",
        }

        let firstRequestID: string | undefined
        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async (input) => {
              firstRequestID = input.requestID
              throw failure
            },
          }),
        ).rejects.toEqual(failure)

        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          resultState: "not_dispatched",
          status: "running",
        })

        let secondRequestID: string | undefined
        await ClarusResultOutbox.submit({
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          send: async (input) => {
            secondRequestID = input.requestID
          },
        })

        expect(firstRequestID).toBeString()
        expect(secondRequestID).toBeString()
        expect(secondRequestID).not.toBe(firstRequestID)
        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          resultState: "acknowledged",
          status: "completed",
        })
      },
    })
  })

  test("rejected disposition never auto-retries", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("reject-no-retry-account", "reject-no-retry-project")
        const event = assignmentFixture({
          agentID: "reject-no-retry-account",
          projectID: "reject-no-retry-project",
          taskID: "task-reject-no-retry",
          runID: "run-reject-no-retry",
        })

        const created = await dispatchAssignment("reject-no-retry-account", event)

        const rejected = {
          disposition: "rejected" as const,
          requestID: "request-rejected",
          code: "RESULT_REJECTED",
          message: "result rejected",
        }

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw rejected
            },
          }),
        ).rejects.toEqual(rejected)

        expect(
          (await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment.resultState,
        ).toBe("rejected")

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_ASSIGNMENT_NOT_RUNNING" })
      },
    })
  })

  test("ambiguous disposition never auto-retries", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("ambiguous-no-retry-account", "ambiguous-no-retry-project")
        const event = assignmentFixture({
          agentID: "ambiguous-no-retry-account",
          projectID: "ambiguous-no-retry-project",
          taskID: "task-ambiguous-no-retry",
          runID: "run-ambiguous-no-retry",
        })

        const created = await dispatchAssignment("ambiguous-no-retry-account", event)

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {
              throw new Error("connection lost mid-dispatch")
            },
          }),
        ).rejects.toThrow("connection lost mid-dispatch")

        expect((await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID))?.assignment).toMatchObject({
          resultState: "ambiguous",
        })

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_ASSIGNMENT_NOT_RUNNING" })
      },
    })
  })

  test("pending crash becomes ambiguous on recovery — no auto-retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = await setupProjectScope("crash-account", "crash-project")
        const event = assignmentFixture({
          agentID: "crash-account",
          projectID: "crash-project",
          taskID: "task-crash-pending",
          runID: "run-crash-pending",
        })

        const created = await dispatchAssignment("crash-account", event)

        const located = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(located).toBeDefined()
        const acctHash = located!.accountHash
        const assignmentHash = located!.assignmentHash

        const pending = await ClarusAssignmentStore.beginResult(created.assignment.sessionID, "request-crash-pending")
        await Storage.write(StoragePath.clarusProviderResultOutbox(acctHash, acctHash), {
          requestID: "request-crash-pending",
          assignmentHash,
          sessionID: created.assignment.sessionID,
          payload: resultPayload(),
          state: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })

        await ClarusResultOutbox.recover(acctHash)

        const recovered = await ClarusAssignmentStore.findBySessionID(created.assignment.sessionID)
        expect(recovered?.assignment.resultState).toBe("ambiguous")

        await expect(
          ClarusResultOutbox.submit({
            sessionID: created.assignment.sessionID,
            payload: resultPayload(),
            send: async () => {},
          }),
        ).rejects.toMatchObject({ code: "CLARUS_TOOL_ASSIGNMENT_NOT_RUNNING" })
      },
    })
  })
})

// =============================================================================
// Helpers
// =============================================================================

function countOccurrences(text: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}
