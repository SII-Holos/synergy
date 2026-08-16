import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

type QueueStream<T> = {
  stream: AsyncIterable<T>
  push: (event: T) => void
}

function eventQueue<T>(): QueueStream<T> {
  const waiters: Array<() => void> = []
  let buffer: T[] = []
  const stream = {
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift()!
          continue
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
        })
      }
    },
  }
  return {
    stream,
    push(event: T) {
      buffer.push(event)
      waiters.shift()?.()
    },
  }
}

type SessionUpdateCall = Record<string, unknown>

interface AgentHarness {
  calls: {
    sessionCreate: Array<Record<string, unknown>>
    sessionPrompt: Array<Record<string, unknown>>
    sessionSummarize: Array<Record<string, unknown>>
    sessionCommand: Array<Record<string, unknown>>
    sessionAbort: Array<Record<string, unknown>>
    permissionReply: Array<Record<string, unknown>>
  }
  eventStreams: Array<QueueStream<unknown>>
  sessionUpdates: SessionUpdateCall[]
}

function makeSdk(
  options: {
    agents?: Array<Record<string, unknown>>
    messages?: Array<Record<string, unknown>>
    messageData?: unknown
    providers?: Array<Record<string, unknown>>
  } = {},
) {
  const calls = {
    sessionCreate: [] as Array<Record<string, unknown>>,
    sessionPrompt: [] as Array<Record<string, unknown>>,
    sessionSummarize: [] as Array<Record<string, unknown>>,
    sessionCommand: [] as Array<Record<string, unknown>>,
    sessionAbort: [] as Array<Record<string, unknown>>,
    permissionReply: [] as Array<Record<string, unknown>>,
  }
  const eventStreams: Array<QueueStream<unknown>> = []
  const providers =
    options.providers ??
    ([
      {
        id: "p1",
        name: "Provider One",
        models: {
          m1: { id: "m1", name: "Model One", status: "ready", catalogState: "live", providerID: "p1" },
          "m-retained": {
            id: "m-retained",
            name: "Retained",
            status: "ready",
            catalogState: "retained",
            providerID: "p1",
          },
        },
      },
    ] as Array<Record<string, unknown>>)
  const agents = options.agents ?? [{ name: "synergy", mode: "primary", description: "Primary agent", hidden: false }]
  const sdk = {
    controlProfile: {
      effective: async () => ({ data: {} }),
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        calls.sessionCreate.push(input)
        return { data: { id: `session-${input.directory}` } }
      },
      get: async (input: Record<string, unknown>) => ({ data: { id: input.sessionID, time: { created: 1234 } } }),
      messages: async () => ({ data: options.messages ?? [] }),
      message: async () => ({ data: options.messageData }),
      prompt: async (input: Record<string, unknown>) => {
        calls.sessionPrompt.push(input)
        return { data: {} }
      },
      command: async (input: Record<string, unknown>) => {
        calls.sessionCommand.push(input)
        return { data: {} }
      },
      summarize: async (input: Record<string, unknown>) => {
        calls.sessionSummarize.push(input)
        return { data: {} }
      },
      abort: async (input: Record<string, unknown>) => {
        calls.sessionAbort.push(input)
        return { data: {} }
      },
    },
    config: {
      global: async () => ({ data: {} }),
      providers: async () => ({ data: { providers } }),
    },
    app: {
      agents: async () => ({ data: agents }),
    },
    command: {
      list: async () => ({ data: [] as Array<{ name: string; description?: string }> }),
    },
    mcp: {
      add: async () => ({ data: {} }),
    },
    permission: {
      reply: async (input: Record<string, unknown>) => {
        calls.permissionReply.push(input)
        return { data: {} }
      },
    },
    event: {
      subscribe: async () => {
        const queue = eventQueue<unknown>()
        eventStreams.push(queue)
        return queue
      },
    },
  }
  return { sdk, calls, eventStreams }
}

async function runAgent(
  options: {
    config?: Record<string, unknown>
    messages?: Array<Record<string, unknown>>
    messageData?: unknown
    providers?: Array<Record<string, unknown>>
  },
  fn: (agent: ACP.Agent, harness: AgentHarness) => Promise<void>,
): Promise<AgentHarness> {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const built = makeSdk(options)
  const sessionUpdates: SessionUpdateCall[] = []
  const connection = {
    sessionUpdate: (update: unknown) => {
      sessionUpdates.push(update as Record<string, unknown>)
      return Promise.resolve()
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  } as unknown as AgentSideConnection
  const agent = new ACP.Agent(connection, { sdk: built.sdk as never, ...options.config } as never)
  const harness: AgentHarness = { calls: built.calls, eventStreams: built.eventStreams, sessionUpdates }
  await ScopeContext.provide({
    scope,
    fn: () => fn(agent, harness),
  })
  return harness
}

function newSessionArgs() {
  return { cwd: "/tmp/acp", mcpServers: [] } as never
}

describe("ACP agent lifecycle", () => {
  test("initialize advertises capabilities and a terminal-auth method", async () => {
    await runAgent({}, async (agent) => {
      const plain = await agent.initialize({ protocolVersion: 1 })
      expect(plain.protocolVersion).toBe(1)
      expect(plain.agentCapabilities!.loadSession).toBe(true)
      expect(plain.authMethods![0]).toEqual({
        description: "Run `synergy auth login` in the terminal",
        name: "Login with Synergy",
        id: "synergy-login",
      })

      const terminal = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { _meta: { "terminal-auth": true } },
      })
      expect(terminal.authMethods![0]?._meta).toEqual({
        "terminal-auth": { command: "synergy", args: ["auth", "login"], label: "Synergy Login" },
      })
    })
  })

  test("authenticate is not implemented", async () => {
    await runAgent({}, async (agent) => {
      await expect(agent.authenticate({} as never)).rejects.toThrow("Authentication not implemented")
    })
  })

  test("newSession resolves the default model, registers MCP servers and reports modes", async () => {
    await runAgent({}, async (agent, harness) => {
      const result = await agent.newSession({
        cwd: "/tmp/acp",
        mcpServers: [
          {
            name: "http-server",
            type: "http",
            url: "https://example.com/mcp",
            headers: [{ name: "authorization", value: "token" }],
          },
          {
            name: "stdio-server",
            command: "node",
            args: ["server.js"],
            env: [{ name: "NODE_ENV", value: "test" }],
          },
        ],
      } as never)

      expect(result.sessionId).toBe("session-/tmp/acp")
      expect(result.models.availableModels).toEqual([{ modelId: "p1/m1", name: "Provider One/Model One" }])
      expect(result.models.currentModelId).toBe("p1/m1")
      expect(result.modes.availableModes).toEqual([{ id: "synergy", name: "synergy", description: "Primary agent" }])
      expect(result.modes.currentModeId).toBe("synergy")
      expect(harness.calls.sessionCreate[0]).toMatchObject({ directory: "/tmp/acp" })
    })
  })

  test("loadSession replays tool, text and reasoning history to the connection", async () => {
    const harness = await runAgent(
      {
        messages: [
          {
            info: { role: "assistant", sessionID: "loaded" },
            parts: [
              { type: "tool", tool: "read", callID: "c1", state: { status: "pending", input: {}, output: "" } },
              {
                type: "tool",
                tool: "edit",
                callID: "c2",
                state: { status: "running", input: { filePath: "/a.ts" }, output: "" },
              },
              {
                type: "tool",
                tool: "edit",
                callID: "c3",
                state: {
                  status: "completed",
                  input: { filePath: "/a.ts", oldString: "old", newString: "new" },
                  output: "done",
                  title: "edit",
                  metadata: {},
                },
              },
              {
                type: "tool",
                tool: "todowrite",
                callID: "c4",
                state: {
                  status: "completed",
                  input: {},
                  output: JSON.stringify([{ id: "t1", content: "task", status: "completed", priority: "high" }]),
                  title: "todos",
                },
              },
              {
                type: "tool",
                tool: "dagwrite",
                callID: "c5",
                state: {
                  status: "completed",
                  input: {},
                  output: JSON.stringify({ nodes: [{ id: "n1", content: "node", status: "running", deps: [] }] }),
                  title: "dag",
                },
              },
              {
                type: "tool",
                tool: "bash",
                callID: "c6",
                state: { status: "error", input: {}, error: "boom", output: "" },
              },
              { type: "text", text: "assistant text" },
              { type: "reasoning", text: "thinking" },
            ],
          },
          {
            info: { role: "user", sessionID: "loaded" },
            parts: [{ type: "text", text: "user text" }],
          },
          {
            info: { role: "system", sessionID: "loaded" },
            parts: [{ type: "text", text: "system note" }],
          },
        ],
      },
      async (agent) => {
        const result = await agent.loadSession({ cwd: "/tmp/acp", sessionId: "loaded", mcpServers: [] } as never)
        expect(result.sessionId).toBe("loaded")
      },
    )

    const kinds = harness.sessionUpdates.map(
      (u) => (u as { update?: { sessionUpdate?: string } }).update?.sessionUpdate,
    )
    expect(kinds).toContain("tool_call")
    expect(kinds).toContain("tool_call_update")
    expect(kinds).toContain("agent_message_chunk")
    expect(kinds).toContain("user_message_chunk")
    expect(kinds).toContain("agent_thought_chunk")
    const planUpdates = harness.sessionUpdates.filter(
      (u) => (u as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "plan",
    )
    expect(planUpdates.length).toBe(2)
    expect((planUpdates[0]! as { update: { entries?: unknown } }).update.entries).toEqual([
      { priority: "medium", status: "completed", content: "task" },
    ])
    expect((planUpdates[1]! as { update: { entries?: unknown } }).update.entries).toEqual([
      { priority: "medium", status: "in_progress", content: "node" },
    ])
    const completedEdit = harness.sessionUpdates.find(
      (u) =>
        (u as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "tool_call_update" &&
        (u as { update?: { toolCallId?: string } }).update?.toolCallId === "c3",
    )
    expect((completedEdit! as { update: { content?: unknown[] } }).update.content).toEqual([
      { type: "content", content: { type: "text", text: "done" } },
      { type: "diff", path: "/a.ts", oldText: "old", newText: "new" },
    ])
  })

  test("setSessionModel and setSessionMode mutate session state", async () => {
    await runAgent({}, async (agent) => {
      await agent.newSession(newSessionArgs())
      const result = await agent.setSessionModel({ sessionId: "session-/tmp/acp", modelId: "p1/m1" } as never)
      expect(result._meta).toEqual({})
      await agent.setSessionMode({ sessionId: "session-/tmp/acp", modeId: "synergy" } as never)
      const session = (
        agent as never as { sessionManager: { get: (id: string) => { model: unknown; modeId: string } } }
      ).sessionManager.get("session-/tmp/acp")
      expect(session.model).toEqual({ providerID: "p1", modelID: "m1" })
      expect(session.modeId).toBe("synergy")
    })
  })

  test("prompt sends plain text through the session API", async () => {
    const harness = await runAgent({}, async (agent) => {
      await agent.newSession(newSessionArgs())
      const done = await agent.prompt({
        sessionId: "session-/tmp/acp",
        prompt: [{ type: "text", text: "hello" }],
      } as never)
      expect(done.stopReason).toBe("end_turn")
    })
    expect(harness.calls.sessionPrompt).toHaveLength(1)
    expect(harness.calls.sessionPrompt[0]).toMatchObject({
      sessionID: "session-/tmp/acp",
      model: { providerID: "p1", modelID: "m1" },
      parts: [{ type: "text", text: "hello" }],
    })
    expect(harness.calls.sessionPrompt[0]).toMatchObject({ agent: expect.any(String) })
  })

  test("prompt converts image, resource_link and resource blocks", async () => {
    const harness = await runAgent({}, async (agent) => {
      await agent.newSession(newSessionArgs())
      await agent.prompt({
        sessionId: "session-/tmp/acp",
        prompt: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "image", uri: "http://example.com/pic.png", mimeType: "image/png" },
          { type: "resource_link", uri: "file:///tmp/acp/notes.md", name: "notes" },
          { type: "resource_link", uri: "https://example.com/page", name: "page" },
          { type: "resource", resource: { text: "inline resource" } },
        ],
      } as never)
    })
    const parts = harness.calls.sessionPrompt[0]!.parts as Array<Record<string, unknown>>
    expect(parts).toContainEqual({
      type: "attachment",
      url: "data:image/png;base64,aGVsbG8=",
      filename: "image",
      mime: "image/png",
      model: { mode: "provider-file", summary: "image (image/png)" },
    })
    expect(parts).toContainEqual({
      type: "attachment",
      url: "http://example.com/pic.png",
      filename: "image",
      mime: "image/png",
      model: { mode: "provider-file", summary: "image (image/png)" },
    })
    expect(parts).toContainEqual({
      type: "attachment",
      url: "file:///tmp/acp/notes.md",
      filename: "notes.md",
      mime: "text/plain",
      model: { mode: "content" },
    })
    expect(parts).toContainEqual({ type: "text", text: "https://example.com/page" })
    expect(parts).toContainEqual({ type: "text", text: "inline resource" })
  })

  test("prompt routes slash commands through the command API and compacts", async () => {
    const harness = await runAgent({}, async (agent) => {
      await agent.newSession(newSessionArgs())
      await agent.prompt({ sessionId: "session-/tmp/acp", prompt: [{ type: "text", text: "/compact" }] } as never)
      await agent.prompt({
        sessionId: "session-/tmp/acp",
        prompt: [{ type: "text", text: "/unknown-command arg" }],
      } as never)
    })
    expect(harness.calls.sessionSummarize).toHaveLength(1)
    expect(harness.calls.sessionSummarize[0]).toMatchObject({ sessionID: "session-/tmp/acp" })
    expect(harness.calls.sessionPrompt).toHaveLength(0)
    expect(harness.calls.sessionCommand).toHaveLength(0)
  })

  test("prompt rejects sessions with no resolvable model", async () => {
    await runAgent({ providers: [] }, async (agent) => {
      await agent.newSession(newSessionArgs())
      await expect(
        agent.prompt({ sessionId: "session-/tmp/acp", prompt: [{ type: "text", text: "x" }] } as never),
      ).rejects.toThrow("No model available")
    })
  })

  test("cancel aborts the session through the SDK", async () => {
    const harness = await runAgent({}, async (agent) => {
      await agent.newSession(newSessionArgs())
      await agent.cancel({ sessionId: "session-/tmp/acp" } as never)
    })
    expect(harness.calls.sessionAbort).toEqual([{ sessionID: "session-/tmp/acp", directory: "/tmp/acp" }])
  })
})

describe("ACP event subscriptions", () => {
  test("permission.asked with a cancelled outcome replies reject", async () => {
    const harness = await runAgent({}, async (agent, h) => {
      await agent.newSession(newSessionArgs())
      h.eventStreams[0]!.push({
        type: "permission.asked",
        properties: { id: "perm-2", permission: "bash", metadata: {}, sessionID: "session-/tmp/acp" },
      })
      await Bun.sleep(30)
    })
    expect(harness.calls.permissionReply).toHaveLength(1)
    expect(harness.calls.permissionReply[0]).toEqual({
      requestID: "perm-2",
      reply: "reject",
      directory: "/tmp/acp",
    })
  })

  test("message.part.updated streams text deltas to the connection", async () => {
    const harness = await runAgent(
      {
        messageData: { info: { role: "assistant", sessionID: "session-/tmp/acp" } },
      },
      async (agent, h) => {
        await agent.newSession(newSessionArgs())
        h.eventStreams[0]!.push({
          type: "message.part.updated",
          properties: {
            part: { sessionID: "session-/tmp/acp", messageID: "msg-1", type: "text", text: "full" },
            delta: "chunk",
          },
        })
        await Bun.sleep(30)
      },
    )
    expect(
      harness.sessionUpdates.some(
        (u) =>
          (u.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk" &&
          (u.update as { content?: { text?: string } }).content?.text === "chunk",
      ),
    ).toBe(true)
  })
})
