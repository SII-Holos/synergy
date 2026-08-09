import { afterEach, describe, expect, mock, test } from "bun:test"
import { AgentCall } from "../../src/agent/call"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { ObservabilityEvents } from "../../src/observability/events"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { ActivitySummary } from "../../src/session/activity-summary"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionEvent } from "../../src/session/event"
import { tmpdir } from "../fixture/fixture"

const originalAgentCall = AgentCall.text
const originalConfigCurrent = Config.current
const originalObservabilityEmit = ObservabilityEvents.emit

afterEach(() => {
  ;(AgentCall.text as typeof AgentCall.text) = originalAgentCall
  ;(Config.current as typeof Config.current) = originalConfigCurrent
  ObservabilityEvents.emit = originalObservabilityEmit
})

function setDisplay(mode: "full" | "balanced" | "minimal") {
  ;(Config.current as typeof Config.current) = mock(async () => ({ activityDisplay: mode }) as never)
}

async function createTurn(directory: string) {
  const session = await Session.create({ title: "Activity summary" })
  const user = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  })) as MessageV2.User
  const assistant = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    rootID: user.id,
    modelID: "test",
    providerID: "test",
    time: { created: Date.now() },
    mode: "synergy",
    agent: "synergy",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })) as MessageV2.Assistant
  return { session, user, assistant }
}

async function storedAssistant(sessionID: string, messageID: string) {
  const messages = await Session.messages({ sessionID })
  return messages.find((message) => message.info.id === messageID)?.info as MessageV2.Assistant | undefined
}

describe("ActivitySummary", () => {
  test("applies assistant activity metadata only when the expected sequence is current", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, user, assistant } = await createTurn(tmp.path)
        const first = await Session.updateActivityMetadata({
          sessionID: session.id,
          messageID: assistant.id,
          expectedSeq: 0,
          patch: {
            reasoning: {
              reasoning: { state: "live", text: "Inspecting the turn", source: "nano", updatedAt: 1 },
            },
          },
        })
        const stale = await Session.updateActivityMetadata({
          sessionID: session.id,
          messageID: assistant.id,
          expectedSeq: 0,
          patch: {
            reasoning: {
              stale: { state: "stable", text: "Stale", source: "nano", updatedAt: 2 },
            },
          },
        })

        expect(first?.metadata?.activity).toMatchObject({ v: 1, seq: 1 })
        expect(stale).toBeUndefined()
        expect((await storedAssistant(session.id, assistant.id))?.metadata?.activity).toMatchObject({
          seq: 1,
          reasoning: { reasoning: { text: "Inspecting the turn" } },
        })
        await expect(
          Session.updateActivityMetadata({
            sessionID: session.id,
            messageID: user.id,
            expectedSeq: 0,
            patch: {},
          }),
        ).rejects.toThrow("assistant")
      },
    })
  })

  test("persists a bounded stable reasoning summary and minimal now line", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const calls: AgentCall.TextInput[] = []
        ;(AgentCall.text as typeof AgentCall.text) = mock(async (input: AgentCall.TextInput) => {
          calls.push(input)
          return { text: "Tracing the activity flow", model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        const text = `${"a".repeat(1300)}MIDDLE_SECRET${"b".repeat(500)}`
        await Session.updatePart({
          id: "reasoning",
          messageID: assistant.id,
          sessionID: session.id,
          type: "reasoning",
          text,
          time: { start: Date.now() - 100, end: Date.now() },
        })
        await ActivitySummary.idle(session.id)

        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({
          agent: "activity-summary",
          modelRole: "nano",
          retries: 0,
          timeoutMs: 15_000,
          maxInputChars: 2_400,
          maxOutputChars: 280,
          small: true,
        })
        const prompt = String(calls[0]?.messages[0]?.content)
        expect(prompt).not.toContain("MIDDLE_SECRET")
        const activity = (await storedAssistant(session.id, assistant.id))?.metadata?.activity
        expect(activity).toMatchObject({
          v: 1,
          seq: 1,
          reasoning: {
            reasoning: { state: "stable", text: "Tracing the activity flow", source: "nano" },
          },
          now: { text: "Tracing the activity flow", source: "reasoning" },
        })
      },
    })
  })

  test("settles a failed terminal refresh from the latest live reasoning summary", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          if (calls === 1) return { text: "Inspecting the streaming path", model: {} as never }
          throw new Error("terminal refresh unavailable")
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        const livePart: MessageV2.ReasoningPart = {
          id: "reasoning-live",
          messageID: assistant.id,
          sessionID: session.id,
          type: "reasoning",
          text: "a".repeat(900),
          time: { start: Date.now() - 100 },
        }
        await Session.updatePartDelta(livePart, livePart.text)
        await ActivitySummary.idle(session.id)

        expect((await storedAssistant(session.id, assistant.id))?.metadata?.activity).toMatchObject({
          reasoning: {
            "reasoning-live": { state: "live", text: "Inspecting the streaming path", source: "nano" },
          },
        })

        await Session.updatePart({
          ...livePart,
          text: `${livePart.text}${"b".repeat(200)}`,
          time: { ...livePart.time, end: Date.now() },
        })
        await ActivitySummary.idle(session.id)

        expect(calls).toBe(2)
        expect((await storedAssistant(session.id, assistant.id))?.metadata?.activity).toMatchObject({
          reasoning: {
            "reasoning-live": {
              state: "stable",
              text: "Inspecting the streaming path",
              source: "partial-live",
            },
          },
          now: { text: "Inspecting the streaming path", source: "reasoning" },
        })
      },
    })
  })

  test("falls back deterministically when a terminal reasoning summary fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          throw new Error("provider unavailable")
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        await Session.updatePart({
          id: "reasoning",
          messageID: assistant.id,
          sessionID: session.id,
          type: "reasoning",
          text: "Inspect the activity pipeline",
          time: { start: Date.now() - 100, end: Date.now() },
        })
        await ActivitySummary.idle(session.id)

        expect((await storedAssistant(session.id, assistant.id))?.metadata?.activity).toMatchObject({
          reasoning: { reasoning: { state: "fallback" } },
        })
      },
    })
  })

  test("summarizes closed tool groups without exposing tool input", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const prompts: string[] = []
        ;(AgentCall.text as typeof AgentCall.text) = mock(async (input: AgentCall.TextInput) => {
          prompts.push(String(input.messages[0]?.content))
          return { text: "Inspected the relevant files", model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        await Session.updatePart({
          id: "read-a",
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool",
          callID: "call-read-a",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/private.ts", secret: "PRIVATE_TOOL_INPUT" },
            output: "PRIVATE_TOOL_OUTPUT",
            title: "Read private.ts",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        await Session.updatePart({
          id: "answer",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toContain("read")
        expect(prompts[0]).not.toContain("PRIVATE_TOOL_INPUT")
        expect(prompts[0]).not.toContain("PRIVATE_TOOL_OUTPUT")
        expect(prompts[0]).not.toContain("/workspace/private.ts")
        const groups = (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups
        expect(Object.values(groups ?? {})).toEqual([
          expect.objectContaining({ state: "stable", text: "Inspected the relevant files" }),
        ])
        expect(Object.values(groups ?? {})[0]).toMatchObject({ signature: "read-a" })
      },
    })
  })

  test("aggregates modified files across package subdirectories into one summary group", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          return { text: "Updated the UI package", model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        for (const [id, tool, filePath] of [
          ["save-source", "save_file", `${tmp.path}/packages/ui/src/components/activity-trace.tsx`],
          ["revise-test", "revise_file", `${tmp.path}/packages/ui/test/components/activity-trace.dom.test.ts`],
        ] as const) {
          await Session.updatePart({
            id,
            messageID: assistant.id,
            sessionID: session.id,
            type: "tool",
            callID: `call-${id}`,
            tool,
            state: {
              status: "completed",
              input: { filePath },
              output: "done",
              title: id,
              metadata: {},
              time: { start: 1, end: 2 },
            },
          })
        }
        await Session.updatePart({
          id: "answer-package",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        const groups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { signature?: string; text?: string }[]
        expect(calls).toBe(1)
        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({ text: "Updated the UI package" })
        expect(groups[0]?.signature?.split(":").sort()).toEqual(["revise-test", "save-source"])
      },
    })
  })

  test("commits every tool group from one flush in a single metadata update", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          return { text: `Activity ${calls}`, model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        await Session.updatePart({
          id: "read-batch",
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool",
          callID: "call-read-batch",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/input.ts" },
            output: "done",
            title: "Read input.ts",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        await Session.updatePart({
          id: "bash-batch",
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool",
          callID: "call-bash-batch",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "bun test" },
            output: "passed",
            title: "Run tests",
            metadata: {},
            time: { start: 3, end: 4 },
          },
        })
        await Session.updatePart({
          id: "answer-batch",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        const activity = (await storedAssistant(session.id, assistant.id))?.metadata?.activity
        expect(calls).toBe(2)
        expect(Object.keys(activity?.groups ?? {})).toHaveLength(2)
        expect(activity?.seq).toBe(1)
      },
    })
  })

  test("settles pending tool groups when the session becomes idle", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const prompts: string[] = []
        ;(AgentCall.text as typeof AgentCall.text) = mock(async (input: AgentCall.TextInput) => {
          prompts.push(String(input.messages[0]?.content))
          return { text: "Inspected the interrupted turn", model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        await Session.updatePart({
          id: "read-before-idle",
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool",
          callID: "call-read-before-idle",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/interrupted.ts" },
            output: "done",
            title: "Read interrupted.ts",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        await Bus.publish(SessionEvent.Idle, { sessionID: session.id })
        await ActivitySummary.idle(session.id)

        expect(prompts).toHaveLength(1)
        expect((await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups).toBeDefined()
      },
    })
  })

  test("keeps input-derived scope and raw failure messages out of degraded logs", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const records: Record<string, unknown>[] = []
        ObservabilityEvents.emit = (async (type, input) => {
          if (type === "log.record" && input?.data?.message === "tool activity summary degraded") {
            records.push(input.data)
          }
          return {} as never
        }) as typeof ObservabilityEvents.emit
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          throw new Error("provider failed at /workspace/private.ts")
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        await Session.updatePart({
          id: "read-private",
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool",
          callID: "call-read-private",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/private.ts" },
            output: "PRIVATE_TOOL_OUTPUT",
            title: "Read private.ts",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        await Session.updatePart({
          id: "answer-private",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        expect(records).toHaveLength(1)
        const serialized = JSON.stringify(records[0])
        expect(serialized).not.toContain("/workspace")
        expect(serialized).not.toContain("provider failed")
      },
    })
  })

  test("does no nano work in full mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("full")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          return { text: "Should not run", model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        await Session.updatePart({
          id: "reasoning",
          messageID: assistant.id,
          sessionID: session.id,
          type: "reasoning",
          text: "Raw reasoning",
          time: { start: 1, end: 2 },
        })
        await ActivitySummary.idle(session.id)

        expect(calls).toBe(0)
        expect((await storedAssistant(session.id, assistant.id))?.metadata?.activity).toBeUndefined()
      },
    })
  })
})
