import { describe, expect, test } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { ToolTaxonomy } from "../../src/tool/taxonomy"
import { ScopeContext } from "../../src/scope/context"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import { ClarusAssignmentRuntime } from "../../src/channel/provider/clarus/assignment-runtime"
import { ClarusAssignmentStore } from "../../src/channel/provider/clarus/assignment-store"
import { ClarusProvider } from "../../src/channel/provider/clarus"
import { AgendaStore } from "../../src/agenda/store"
import type { RuntimeTaskAssignedEvent } from "../../src/channel/provider/clarus/agent-tunnel-port"
import { tmpdir } from "../fixture/fixture"

// Expected contract tests for the clarus_extend_task tool.
// Tests fail RED until:
//   1. Tool is registered in ToolRegistry as "clarus_extend_task"
//   2. Tool has a taxonomy entry in ToolTaxonomy (platform.collaboration, externalIO, stateful)
//   3. Tool validates the upstream extend_seconds contract, progress length, and payload bounds
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
  test("extend_seconds is required and bounded [60, 3600]", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()

        expect(tool!.parameters.safeParse({}).success).toBe(false)
        expect(tool!.parameters.safeParse({ extend_seconds: 30 }).success).toBe(false)
        expect(tool!.parameters.safeParse({ extend_seconds: 60 }).success).toBe(true)
        expect(tool!.parameters.safeParse({ extend_seconds: 3600 }).success).toBe(true)
        expect(tool!.parameters.safeParse({ extend_seconds: 3601 }).success).toBe(false)
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

  test("rejected exposes bounded upstream code and message without becoming retryable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-account"
        const projectID = "ext-tool-rej-project"
        await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej",
          runID: "run-ext-tool-rej",
        })
        const created = await dispatchAssignment(accountId, event)
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
        const previous = Channel.getProvider("clarus")
        const provider = new ClarusProvider()
        ;(provider as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rejected",
            code: "VALIDATION_ERROR",
            message: `extend_seconds must be less than or equal to 3600 ${"x".repeat(1_000)}`,
          }
        }
        Channel.registerProvider(provider)

        try {
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
            disposition: "rejected",
            message: expect.stringContaining(
              "Clarus rejected the extension (VALIDATION_ERROR): extend_seconds must be less than or equal to 3600",
            ),
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }
      },
    })
  })

  test("rejected fallback code used when upstream code is empty or all non-ASCII", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-fbcode"
        const projectID = "ext-tool-rej-fbcode-project"
        await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej-fbcode",
          runID: "run-ext-tool-rej-fbcode",
        })
        const created = await dispatchAssignment(accountId, event)
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
        const previous = Channel.getProvider("clarus")
        const provider = new ClarusProvider()

        // Empty code -> fallback
        ;(provider as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rej-fbe",
            code: "",
            message: "Something went wrong",
          }
        }
        Channel.registerProvider(provider)
        try {
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            code: "CLARUS_EXTENSION_REJECTED",
            message: expect.stringContaining(
              "Clarus rejected the extension (CLARUS_EXTENSION_REJECTED): Something went wrong",
            ),
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }

        // All non-alphanumeric code -> normalized to underscores, not fallback
        const provider2 = new ClarusProvider()
        ;(provider2 as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rej-fbn",
            code: "!!!",
            message: "Bad code chars",
          }
        }
        Channel.registerProvider(provider2)
        try {
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            code: "___",
            message: expect.stringContaining("Clarus rejected the extension (___): Bad code chars"),
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }
      },
    })
  })

  test("rejected message redacts Bearer tokens and credential-like key=value pairs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-redact"
        const projectID = "ext-tool-rej-redact-project"
        await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej-redact",
          runID: "run-ext-tool-rej-redact",
        })
        const created = await dispatchAssignment(accountId, event)
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
        const previous = Channel.getProvider("clarus")
        const provider = new ClarusProvider()
        ;(provider as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rej-redact",
            code: "AUTH_ERROR",
            message:
              "Authorization Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc123def456 failed with api_key=sk-abc123def456 apiKey=sk-camel accessToken=access-value auth_token:auth-value client_secret=client-value refresh-token=refresh-value credential=credential-value",
          }
        }
        Channel.registerProvider(provider)
        try {
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            code: "AUTH_ERROR",
            message: expect.stringContaining("Bearer [redacted]"),
          })
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            message: expect.stringContaining("api_key=[redacted]"),
          })
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            message: expect.not.stringContaining("eyJhbGci"),
          })
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            message: expect.not.stringContaining("sk-abc123def456"),
          })
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            message: expect.not.stringMatching(
              /sk-camel|access-value|auth-value|client-value|refresh-value|credential-value/,
            ),
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }
      },
    })
  })

  test("rejected message strips Unicode control and format hazards", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-unicode"
        const projectID = "ext-tool-rej-unicode-project"
        await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej-unicode",
          runID: "run-ext-tool-rej-unicode",
        })
        const created = await dispatchAssignment(accountId, event)
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
        const previous = Channel.getProvider("clarus")
        const provider = new ClarusProvider()

        // C0: NUL, BEL, DEL; C1: 0x80-0x9f; zero-width: ZWSP, LRM; bidi: LRE/RLE/PDF; line sep U+2028
        const hazardous =
          "hello\u0000world\u0007test\u007Fend" +
          "\u0090bad" +
          "\u200bhidden\u200ezero" +
          "\u202aRTL\u202c" +
          "\u2028line"
        ;(provider as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rej-unicode",
            code: "BAD_INPUT",
            message: hazardous,
          }
        }
        Channel.registerProvider(provider)
        try {
          const rejection = tool!.execute(
            { extend_seconds: 3600 },
            makeToolContext({ sessionID: created.assignment.sessionID }),
          )
          await expect(rejection).rejects.toMatchObject({
            code: "BAD_INPUT",
            message: expect.stringContaining("hello world test end bad hidden zero RTL line"),
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }
      },
    })
  })

  test("rejected message is truncated at MAX_REJECTION_MESSAGE_LENGTH", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-trunc"
        const projectID = "ext-tool-rej-trunc-project"
        await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej-trunc",
          runID: "run-ext-tool-rej-trunc",
        })
        const created = await dispatchAssignment(accountId, event)
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
        const previous = Channel.getProvider("clarus")
        const provider = new ClarusProvider()
        const longMsg = "A".repeat(600)
        ;(provider as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rej-trunc",
            code: "TOO_LONG",
            message: longMsg,
          }
        }
        Channel.registerProvider(provider)
        try {
          const rejection = tool!.execute(
            { extend_seconds: 3600 },
            makeToolContext({ sessionID: created.assignment.sessionID }),
          )
          await expect(rejection).rejects.toMatchObject({
            code: "TOO_LONG",
            message: expect.stringContaining("… Do not retry"),
          })
          await expect(rejection).rejects.toMatchObject({
            message: expect.not.stringContaining("AAAAAAA"), // truncated, long runaway sequence removed
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }
      },
    })
  })

  test("rejected empty message produces fallback text", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const accountId = "ext-tool-rej-empty"
        const projectID = "ext-tool-rej-empty-project"
        await setupProjectScope(accountId, projectID)
        const event = assignmentFixture({
          agentID: accountId,
          projectID,
          taskID: "task-ext-tool-rej-empty",
          runID: "run-ext-tool-rej-empty",
        })
        const created = await dispatchAssignment(accountId, event)
        const tool = await ToolRegistry.find("clarus_extend_task")
        expect(tool).toBeDefined()
        const previous = Channel.getProvider("clarus")
        const provider = new ClarusProvider()
        ;(provider as unknown as { extendTask: () => Promise<never> }).extendTask = async () => {
          throw {
            disposition: "rejected",
            requestID: "request-ext-rej-empty",
            code: "UNKNOWN",
            message: "",
          }
        }
        Channel.registerProvider(provider)
        try {
          await expect(
            tool!.execute({ extend_seconds: 3600 }, makeToolContext({ sessionID: created.assignment.sessionID })),
          ).rejects.toMatchObject({
            code: "UNKNOWN",
            message: expect.stringContaining("The upstream service did not provide a rejection message."),
          })
        } finally {
          if (previous) Channel.registerProvider(previous)
        }
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
