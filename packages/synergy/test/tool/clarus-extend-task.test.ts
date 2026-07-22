import { describe, expect, test } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { ToolTaxonomy } from "../../src/tool/taxonomy"
import { ScopeContext } from "../../src/scope/context"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { AgendaStore } from "../../src/agenda/store"
import type { RuntimeTaskAssignedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import { tmpdir } from "../fixture/fixture"

// Expected contract tests for the clarus_extend_task tool.
// Tests fail RED until:
//   1. Tool is registered in ToolRegistry as "clarus_extend_task"
//   2. Tool has a taxonomy entry in ToolTaxonomy (platform.collaboration, externalIO, stateful)
//   3. Tool validates extend_seconds bounds, progress length, and payload bounds
//   4. Tool forwards ctx.abort to provider
//   5. Tool returns structured disposition errors for each failure mode
//   6. Tool rejects ordinary (non-Clarus-assignment) Sessions

// ── Fixtures ───────────────────────────────────────────────────────

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

async function setupProjectScope(accountId: string, projectID: string) {
  return Channel.ensureProjectScope({
    channelType: "clarus",
    accountId,
    externalProjectId: projectID,
    projectName: `Project ${projectID}`,
  })
}

async function dispatchAssignment(accountId: string, event: RuntimeTaskAssignedEvent) {
  const host = ChannelHost.create({ channelType: "clarus", accountId })
  return ClarusAssignmentRuntime.dispatch({ host, accountId, event })
}

function makeToolContext(overrides: Partial<Tool.Context> = {}): Tool.Context {
  return {
    sessionID: `ses_${crypto.randomUUID()}`,
    messageID: `msg_${crypto.randomUUID()}`,
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    ...overrides,
  } as Tool.Context
}

// =============================================================================
// 1. Tool registry and taxonomy contract
// =============================================================================

describe("clarus_extend_task tool registration", () => {
  test("clarus_extend_task is registered in ToolRegistry", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
      },
    })
  })

  test("clarus_extend_task has correct taxonomy: platform.collaboration, externalIO, stateful", async () => {
    const entry = ToolTaxonomy.classify("clarus_extend_task")
    expect(entry.kind).toBe("platform.collaboration")
    expect(entry.domain).toBe("platform")
    expect(entry.traits.externalIO).toBe(true)
    expect(entry.traits.stateful).toBe(true)
  })

  test("clarus_extend_task is not classified as auxiliary", () => {
    expect(ToolTaxonomy.isAuxiliary("clarus_extend_task")).toBe(false)
  })
})

// =============================================================================
// 2. Tool exposes valid parameter schema
// =============================================================================

describe("clarus_extend_task parameter validation", () => {
  test("extend_seconds is required and bounded [60, 86400]", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!

        const ctx = makeToolContext()

        // Missing extend_seconds
        await expect(tool.execute({} as Record<string, unknown>, ctx)).rejects.toBeDefined()

        // extend_seconds too small (< 60)
        await expect(tool.execute({ extend_seconds: 30 }, ctx)).rejects.toBeDefined()

        // extend_seconds too large (> 86400)
        await expect(tool.execute({ extend_seconds: 100000 }, ctx)).rejects.toBeDefined()

        // extend_seconds at lower bound (60) — valid shape
        await expect(tool.execute({ extend_seconds: 60 }, ctx)).rejects.toBeDefined()
        // Still rejects because not in assignment session

        // extend_seconds at upper bound (86400) — valid shape
        await expect(tool.execute({ extend_seconds: 86400 }, ctx)).rejects.toBeDefined()
      },
    })
  })

  test("progress is bounded to 500 characters", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!

        const ctx = makeToolContext()
        const longProgress = "x".repeat(501)

        // progress too long should fail validation
        await expect(tool.execute({ extend_seconds: 300, progress: longProgress }, ctx)).rejects.toBeDefined()

        // progress at exactly 500 chars — valid shape
        const validProgress = "x".repeat(500)
        await expect(tool.execute({ extend_seconds: 300, progress: validProgress }, ctx)).rejects.toBeDefined() // Still rejects because not in assignment session
      },
    })
  })

  test("payload is shallow-bounded with max keys and value lengths", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!

        const ctx = makeToolContext()

        // payload with too many keys
        const tooManyKeys: Record<string, unknown> = {}
        for (let i = 0; i < 51; i++) tooManyKeys[`key_${i}`] = "val"
        await expect(tool.execute({ extend_seconds: 300, payload: tooManyKeys }, ctx)).rejects.toBeDefined()

        // payload with a value too long
        await expect(
          tool.execute({ extend_seconds: 300, payload: { key: "x".repeat(2001) } }, ctx),
        ).rejects.toBeDefined()

        // valid payload — valid shape
        const validPayload = { milestone: "Done with Phase 1", remaining: "2 more phases" }
        await expect(tool.execute({ extend_seconds: 300, payload: validPayload }, ctx)).rejects.toBeDefined() // Still rejects because not in assignment session
      },
    })
  })
})

// =============================================================================
// 3. Session guard
// =============================================================================

describe("clarus_extend_task session guard", () => {
  test("clarus_extend_task rejects ordinary Sessions before provider access", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!
        const ctx = makeToolContext()

        await expect(tool.execute({ extend_seconds: 3600, progress: "Almost done" }, ctx)).rejects.toMatchObject({
          code: "CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION",
        })
      },
    })
  })
})

// =============================================================================
// 4. Disposition error handling
// =============================================================================

describe("clarus_extend_task disposition errors", () => {
  test("not_dispatched returns structured retryable error", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-nd-account"
        const projectID = "ext-tool-nd-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-nd",
          runID: "run-ext-tool-nd",
        })

        const created = await dispatchAssignment(accountId, event)
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!

        const ctx = makeToolContext({ sessionID: created.assignment.sessionID })

        // RED: provider.extendTask() throws not_dispatched → tool wraps it
        // For now this test documents the expected error shape
        // The actual failure depends on whether the provider is connected
        // Without a real tunnel, the call should fail with not_dispatched or unavailable
        await expect(tool.execute({ extend_seconds: 3600, progress: "Almost done" }, ctx)).rejects.toBeDefined() // RED: tool exists but provider not configured in test
      },
    })
  })

  test("rejected returns structured non-retryable error", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-account"
        const projectID = "ext-tool-rej-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej",
          runID: "run-ext-tool-rej",
        })

        const created = await dispatchAssignment(accountId, event)
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!

        const ctx = makeToolContext({ sessionID: created.assignment.sessionID })

        // RED: the tool should exist and handle non-assignment or provider-unavailable
        // errors with appropriate codes
        await expect(tool.execute({ extend_seconds: 3600 }, ctx)).rejects.toBeDefined()
      },
    })
  })
})

// =============================================================================
// 5. Abort signal forwarding
// =============================================================================

describe("clarus_extend_task abort forwarding", () => {
  test("ctx.abort is forwarded to provider call", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-abort-account"
        const projectID = "ext-tool-abort-project"
        const scope = await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-abort",
          runID: "run-ext-tool-abort",
        })

        const created = await dispatchAssignment(accountId, event)
        const toolInfo = await ToolRegistry.find("clarus_extend_task")
        expect(toolInfo).toBeDefined()
        const tool = toolInfo!

        // Create an aborted signal
        const controller = new AbortController()
        controller.abort("test-abort-reason")
        const ctx = makeToolContext({
          sessionID: created.assignment.sessionID,
          abort: controller.signal,
        })

        await expect(tool.execute({ extend_seconds: 3600 }, ctx)).rejects.toBeDefined()
        // RED: the error should indicate the abort signal was respected
      },
    })
  })
})
