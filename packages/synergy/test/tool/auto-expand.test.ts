import { afterAll, describe, expect, mock, test } from "bun:test"
import z from "zod"
import { MCP } from "../../src/mcp"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolExposure } from "../../src/tool/exposure"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"
import { ToolScheduler } from "../../src/session/tool-scheduler"

afterAll(async () => {
  // These tests dispatch through the module-level ToolScheduler singleton.
  // Leave it admitting work for sibling files sharing the same shard process:
  // stop() clears any scheduler created here, configure() re-opens admission.
  await ToolScheduler.stop()
  ToolScheduler.configure()
})

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  name: "Test Model",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

const allowAllAgent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "full_access",
} as any

function runtimeProcessor() {
  const callbacks = new Map<string, Promise<unknown>>()
  return {
    message: { id: "message_test" },
    partFromToolCall: () => undefined,
    updateToolCallState: async () => {},
    executeOnce<T>(callID: string, execute: () => Promise<T>) {
      const existing = callbacks.get(callID)
      if (existing) return existing as Promise<T>
      const callback = Promise.resolve().then(execute)
      callbacks.set(callID, callback)
      return callback
    },
    beginExecution(callID: string) {
      return {
        callID,
        promise: Promise.resolve(undefined),
        resolve() {},
        complete() {},
        fail() {},
        get outcome() {
          return undefined
        },
        get status() {
          return "pending" as const
        },
      }
    },
  } as any
}

async function registerTool(id: string, exposure: ToolExposure.Info, onExecute?: () => void): Promise<string> {
  await ToolRegistry.register(
    Tool.define(
      id,
      {
        description: "Test auto-expand probe.",
        parameters: z.object({ value: z.number().optional() }),
        async execute() {
          onExecute?.()
          return { title: id, output: `ran:${id}`, metadata: {} }
        },
      },
      { exposure },
    ),
  )
  return id
}

function freshID(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}`
}

describe("ToolResolver auto-expand eligibility", () => {
  test("deferred group tools are auto-expandable when authorized", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_group"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(true)
        expect(resolved.definitions.some((def) => def.id === id)).toBe(false)
      },
    })
  })

  test("search-mode tools are auto-expandable when authorized", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_search"), {
          mode: "search",
          title: "Auto Search",
          keywords: ["auto"],
        })
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(true)
      },
    })
  })

  test("permission-denied tools are never auto-expandable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_denied"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const denyAgent = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", [id]: "deny" }),
        }
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: denyAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(false)
      },
    })
  })

  test("userTools-disabled tools are never auto-expandable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_user_disabled"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          userTools: { [id]: false },
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(false)
      },
    })
  })

  test("agents denied expand_tools are never auto-expandable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_no_expand"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const denyExpandAgent = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", expand_tools: "deny" }),
        }
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: denyExpandAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(false)
      },
    })
  })

  test("Plan-mode-blocked tools are never auto-expandable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_plan"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "plan" }
        })
        const planSession = await Session.get(session.id)
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session: planSession,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(false)
        expect(resolved.definitions.some((def) => def.id === id)).toBe(false)
      },
    })
  })

  test("internal ephemeral tools are never auto-expandable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = freshID("auto_internal")
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          ephemeralTools: [
            {
              id,
              description: "Internal helper",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              async execute() {
                return { title: id, output: "unexpected", metadata: {} }
              },
            },
          ],
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(false)
      },
    })
  })

  test("deferred MCP server group tools are auto-expandable when ≥ threshold", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalToolEntries = MCP.toolEntries
    const serverName = "auto-mcp"
    const toolIDs = Array.from({ length: ToolExposure.MCP_DEFER_THRESHOLD }, (_, index) =>
      ToolExposure.mcpToolID(serverName, `tool_${index}`),
    )
    ;(MCP as any).toolEntries = async () =>
      toolIDs.map((id, index) => ({
        id,
        serverName,
        toolName: `tool_${index}`,
        tool: { description: "MCP auto tool" },
      }))
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const resolved = await ToolResolver.resolveWithAvailability({
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            processor: runtimeProcessor(),
            includeMCP: true,
          })
          expect(resolved.autoExpandable.has(toolIDs[0])).toBe(true)
        },
      })
    } finally {
      ;(MCP as any).toolEntries = originalToolEntries
    }
  })
})

describe("ToolResolver auto-expand resolution", () => {
  test("runtimeToolFor is undefined while hidden and resolves the real tool after expansion", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_resolve"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const input = {
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          includeMCP: false,
        }
        expect(await ToolResolver.runtimeToolFor({ ...input, processor: runtimeProcessor() }, id)).toBeUndefined()

        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ["auto-test"] }
        })
        const fresh = await Session.get(session.id)
        const resolved = await ToolResolver.runtimeToolFor(
          { ...input, session: fresh, processor: runtimeProcessor() },
          id,
        )
        expect(resolved).toBeDefined()
        expect(resolved!.executor).toBe("control_plane")
        const result = await (resolved!.tool as any).execute({ value: 1 }, { toolCallId: "call_auto_resolve" })
        expect(result.output).toBe(`ran:${id}`)
      },
    })
  })

  test("autoExpandTool persists the expansion and returns the real runtime tool", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_persist"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const expanded = await ToolResolver.autoExpandTool(
          {
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            processor: runtimeProcessor(),
            includeMCP: false,
          },
          id,
        )
        expect(expanded).toBeDefined()
        expect(expanded!.group).toBe("auto-test")
        const fresh = await Session.get(session.id)
        expect(fresh.toolState?.expandedGroups).toContain("auto-test")
        const result = await (expanded!.tool as any).execute({ value: 1 }, { toolCallId: "call_auto_persist" })
        expect(result.output).toBe(`ran:${id}`)
      },
    })
  })

  test("autoExpandTool returns undefined for an unknown tool", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const expanded = await ToolResolver.autoExpandTool(
          {
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            processor: runtimeProcessor(),
            includeMCP: false,
          },
          "never_registered_tool",
        )
        expect(expanded).toBeUndefined()
        expect((await Session.get(session.id)).toolState).toBeUndefined()
      },
    })
  })
  test("concurrent auto-expands of different groups keep both in toolState", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const idA = freshID("auto_concurrent_a")
        const idB = freshID("auto_concurrent_b")
        await registerTool(idA, { mode: "group", group: "auto-concurrent-a" })
        await registerTool(idB, { mode: "group", group: "auto-concurrent-b" })
        const session = await Session.create({})
        const input = {
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        }

        const [a, b] = await Promise.all([
          ToolResolver.autoExpandTool({ ...input }, idA),
          ToolResolver.autoExpandTool({ ...input }, idB),
        ])
        expect(a).toBeDefined()
        expect(b).toBeDefined()
        const fresh = await Session.get(session.id)
        expect(fresh.toolState?.expandedGroups).toContain("auto-concurrent-a")
        expect(fresh.toolState?.expandedGroups).toContain("auto-concurrent-b")
      },
    })
  })
})

type TurnResult = {
  parts: Array<Record<string, any>>
  events: Array<{ type: string; tool?: string; callID?: string; data?: Record<string, unknown> }>
  streamInput?: Record<string, unknown>
}

async function runAutoExpandTurn(input: {
  sessionID: string
  messageID: string
  toolName: string
  callID: string
  args: Record<string, unknown>
  executionTools: Record<string, any>
  executorKinds: Record<string, any>
  autoExpandable: Set<string>
  resolverInput: Omit<ToolResolver.Input, "processor">
  emitToolError?: boolean
}): Promise<TurnResult> {
  const { AgentTurn } = await import("../../src/session/agent-turn")
  const { Config } = await import("../../src/config/config")
  const { Bus } = await import("../../src/bus")
  const { Plugin } = await import("../../src/plugin")
  const { ExperienceEncoder } = await import("../../src/library/experience-encoder")
  const { Snapshot } = await import("../../src/session/snapshot")
  const { MessageV2 } = await import("../../src/session/message-v2")
  const { Observability } = await import("../../src/observability")

  const events: TurnResult["events"] = []
  const parts = new Map<string, Record<string, any>>()
  const originals = {
    stream: AgentTurn.stream,
    updatePart: Session.updatePart,
    updatePartDelta: Session.updatePartDelta,
    flushPartWrites: Session.flushPartWrites,
    parts: MessageV2.parts,
    updateMessage: Session.updateMessage,
    updateAssistantContextUsage: Session.updateAssistantContextUsage,
    updateLastExchange: Session.updateLastExchange,
    configCurrent: Config.current,
    pluginTrigger: Plugin.trigger,
    experienceComplete: ExperienceEncoder.onComplete,
    busPublish: Bus.publish,
    snapshotTrack: Snapshot.track,
    observabilityEmit: Observability.emit,
  }
  try {
    ;(Session.updatePart as any) = mock(async (value: any) => {
      const part = "part" in value ? value.part : value
      parts.set(part.id, part)
      return part
    })
    ;(Session.updatePartDelta as any) = mock(async (part: any) => {
      parts.set(part.id, part)
      return part
    })
    ;(Session.flushPartWrites as any) = mock(async () => {})
    ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
    ;(Session.updateMessage as any) = mock(async (message: any) => message)
    ;(Session.updateAssistantContextUsage as any) = mock(async () => {})
    ;(Session.updateLastExchange as any) = mock(async () => {})
    ;(Config.current as any) = mock(async () => ({ experimental: {}, timeout: { tool: { default_sec: 60 } } }))
    ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
    ;(ExperienceEncoder.onComplete as any) = mock(() => {})
    ;(Bus.publish as any) = mock(async () => {})
    ;(Snapshot.track as any) = mock(async () => "snapshot_test")
    ;(Observability.emit as any) = mock(async (type: string, value: any) => {
      events.push({ type, tool: value?.tool, callID: value?.callID, data: value?.data })
      return undefined
    })

    const processor = SessionProcessor.create({
      assistantMessage: {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "assistant",
        parentID: "msg_user",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        agent: "synergy",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0 },
      },
      sessionID: input.sessionID,
      model,
      abort: new AbortController().signal,
    })
    let streamInputSeen: Record<string, unknown> | undefined
    ;(AgentTurn.stream as any) = mock(async (streamInputArg: any) => {
      streamInputSeen = streamInputArg
      return {
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "tool-input-start", id: input.callID, toolName: input.toolName }
          yield { type: "tool-call", toolCallId: input.callID, toolName: input.toolName, input: input.args }
          if (input.emitToolError) {
            yield {
              type: "tool-error",
              toolCallId: input.callID,
              toolName: input.toolName,
              input: input.args,
              error: new Error(`Model tried to call unavailable tool '${input.toolName}'`),
            }
          }
          yield { type: "finish" }
        })(),
        contextUsageDraft: undefined,
        usage: Promise.resolve(undefined),
        async dispose() {},
      }
    })

    await processor.process({
      user: { id: "msg_user" } as any,
      agent: allowAllAgent,
      abort: new AbortController().signal,
      sessionID: input.sessionID,
      system: [],
      messages: [],
      toolDefinitions: [],
      executionTools: input.executionTools,
      executorKinds: input.executorKinds,
      activeToolIDs: [],
      autoExpandable: input.autoExpandable,
      resolverInput: input.resolverInput,
      model,
    } as any)

    return { parts: [...parts.values()], events, streamInput: streamInputSeen }
  } finally {
    ;(AgentTurn.stream as any) = originals.stream
    ;(Session.updatePart as any) = originals.updatePart
    ;(Session.updatePartDelta as any) = originals.updatePartDelta
    ;(Session.flushPartWrites as any) = originals.flushPartWrites
    ;(MessageV2.parts as any) = originals.parts
    ;(Session.updateMessage as any) = originals.updateMessage
    ;(Session.updateAssistantContextUsage as any) = originals.updateAssistantContextUsage
    ;(Session.updateLastExchange as any) = originals.updateLastExchange
    ;(Config.current as any) = originals.configCurrent
    ;(Plugin.trigger as any) = originals.pluginTrigger
    ;(ExperienceEncoder.onComplete as any) = originals.experienceComplete
    ;(Bus.publish as any) = originals.busPublish
    ;(Snapshot.track as any) = originals.snapshotTrack
    ;(Observability.emit as any) = originals.observabilityEmit
  }
}

describe("SessionProcessor auto-expand interception", () => {
  test("executes a deferred group tool call in the same turn and persists the expansion", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const executionCount = { value: 0 }
        const id = await registerTool(freshID("auto_turn"), { mode: "group", group: "auto-test" }, () => {
          executionCount.value++
        })
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(true)

        const { parts, events } = await runAutoExpandTurn({
          sessionID: session.id,
          messageID: "msg_auto_turn",
          toolName: id,
          callID: "call_auto_turn",
          args: { value: 42 },
          executionTools: resolved.executionTools,
          executorKinds: resolved.executorKinds,
          autoExpandable: resolved.autoExpandable,
          resolverInput: {
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            includeMCP: false,
          },
        })

        const part = parts.find((item) => item.type === "tool" && item.callID === "call_auto_turn")
        expect(part).toBeDefined()
        expect(part!.state.status).toBe("completed")
        expect(part!.state.output).toBe(`ran:${id}`)
        expect(part!.state.metadata?.autoExpanded).toBe(true)
        expect(executionCount.value).toBe(1)

        const fresh = await Session.get(session.id)
        expect(fresh.toolState?.expandedGroups).toContain("auto-test")

        const event = events.find((item) => item.type === "tool.auto_expanded")
        expect(event).toBeDefined()
        expect(event!.tool).toBe(id)
        expect(event!.callID).toBe("call_auto_turn")
        expect(event!.data).toMatchObject({ group: "auto-test" })
      },
    })
  })

  test("keeps the part running through a tool-error event and still completes the call", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_error"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })

        const { parts, events } = await runAutoExpandTurn({
          sessionID: session.id,
          messageID: "msg_auto_error",
          toolName: id,
          callID: "call_auto_error",
          args: { value: 1 },
          executionTools: resolved.executionTools,
          executorKinds: resolved.executorKinds,
          autoExpandable: resolved.autoExpandable,
          resolverInput: {
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            includeMCP: false,
          },
          emitToolError: true,
        })

        const part = parts.find((item) => item.type === "tool" && item.callID === "call_auto_error")
        expect(part).toBeDefined()
        expect(part!.state.status).toBe("completed")
        expect(part!.state.output).toBe(`ran:${id}`)
        expect(events.some((item) => item.type === "tool.auto_expanded")).toBe(true)
      },
    })
  })

  test("permission-denied tool calls keep the diagnostic failure and never expand", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_denied_turn"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const denyAgent = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", [id]: "deny" }),
        }
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: denyAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })
        expect(resolved.autoExpandable.has(id)).toBe(false)

        const { parts } = await runAutoExpandTurn({
          sessionID: session.id,
          messageID: "msg_auto_denied",
          toolName: id,
          callID: "call_auto_denied",
          args: { value: 1 },
          executionTools: resolved.executionTools,
          executorKinds: resolved.executorKinds,
          autoExpandable: resolved.autoExpandable,
          resolverInput: {
            agent: denyAgent,
            model,
            sessionID: session.id,
            session,
            includeMCP: false,
          },
          emitToolError: true,
        })

        const part = parts.find((item) => item.type === "tool" && item.callID === "call_auto_denied")
        expect(part).toBeDefined()
        expect(part!.state.status).toBe("error")
        expect((await Session.get(session.id)).toolState).toBeUndefined()
      },
    })
  })

  test("unknown tools keep the existing unknown_tool diagnostic behavior", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })

        const { parts } = await runAutoExpandTurn({
          sessionID: session.id,
          messageID: "msg_auto_unknown",
          toolName: "hallucinated_tool",
          callID: "call_auto_unknown",
          args: {},
          executionTools: resolved.executionTools,
          executorKinds: resolved.executorKinds,
          autoExpandable: resolved.autoExpandable,
          resolverInput: {
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            includeMCP: false,
          },
          emitToolError: true,
        })

        const part = parts.find((item) => item.type === "tool" && item.callID === "call_auto_unknown")
        expect(part).toBeDefined()
        expect(part!.state.status).toBe("error")
        expect(part!.state.error).toContain("unavailable tool")
        expect((await Session.get(session.id)).toolState).toBeUndefined()
      },
    })
  })
  test("does not leak processor-internal fields into the AgentTurn stream input", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = await registerTool(freshID("auto_no_leak"), { mode: "group", group: "auto-test" })
        const session = await Session.create({})
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          processor: runtimeProcessor(),
          includeMCP: false,
        })

        const { parts, events, streamInput } = await runAutoExpandTurn({
          sessionID: session.id,
          messageID: "msg_auto_no_leak",
          toolName: id,
          callID: "call_auto_no_leak",
          args: { value: 1 },
          executionTools: resolved.executionTools,
          executorKinds: resolved.executorKinds,
          autoExpandable: resolved.autoExpandable,
          resolverInput: {
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            includeMCP: false,
          },
        })

        // The worker protocol envelope schema is strict; processor-internal
        // fields must never be forwarded to AgentTurn.stream or the worker
        // serialization would reject the whole turn.
        expect(streamInput).toBeDefined()
        expect("autoExpandable" in streamInput!).toBe(false)
        expect("resolverInput" in streamInput!).toBe(false)
        expect("executionTools" in streamInput!).toBe(false)
        expect("executorKinds" in streamInput!).toBe(false)

        const part = parts.find((item) => item.type === "tool" && item.callID === "call_auto_no_leak")
        expect(part).toBeDefined()
        expect(part!.state.status).toBe("completed")
        expect(events.some((item) => item.type === "tool.auto_expanded")).toBe(true)
      },
    })
  })
  test("auto-expanded MCP tools validate model arguments before dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalToolEntries = MCP.toolEntries
    const serverName = "auto-validate-mcp"
    const toolIDs = Array.from({ length: ToolExposure.MCP_DEFER_THRESHOLD }, (_, index) =>
      ToolExposure.mcpToolID(serverName, `tool_${index}`),
    )
    const executeCalls = { value: 0 }
    ;(MCP as any).toolEntries = async () =>
      toolIDs.map((id, index) => ({
        id,
        serverName,
        toolName: `tool_${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: false,
        },
        tool: {
          description: "MCP validate tool",
          inputSchema: {
            type: "json-schema",
            schema: {
              type: "object",
              properties: { value: { type: "number" } },
              additionalProperties: false,
            },
          },
          execute: async () => {
            executeCalls.value++
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      }))
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const resolved = await ToolResolver.resolveWithAvailability({
            agent: allowAllAgent,
            model,
            sessionID: session.id,
            session,
            processor: runtimeProcessor(),
            includeMCP: true,
          })
          expect(resolved.autoExpandable.has(toolIDs[0])).toBe(true)

          const { parts, events } = await runAutoExpandTurn({
            sessionID: session.id,
            messageID: "msg_auto_validate",
            toolName: toolIDs[0],
            callID: "call_auto_validate",
            args: { value: "not-a-number" },
            executionTools: resolved.executionTools,
            executorKinds: resolved.executorKinds,
            autoExpandable: resolved.autoExpandable,
            resolverInput: {
              agent: allowAllAgent,
              model,
              sessionID: session.id,
              session,
              includeMCP: true,
            },
          })

          const part = parts.find((item) => item.type === "tool" && item.callID === "call_auto_validate")
          expect(part).toBeDefined()
          expect(part!.state.status).toBe("error")
          expect(part!.state.error).toContain("invalid arguments")
          expect(executeCalls.value).toBe(0)
          expect(events.some((item) => item.type === "tool.auto_expanded")).toBe(true)
          const fresh = await Session.get(session.id)
          expect(fresh.toolState?.expandedGroups).toContain(`mcp:${serverName}`)
        },
      })
    } finally {
      ;(MCP as any).toolEntries = originalToolEntries
    }
  })
})
