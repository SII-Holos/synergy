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

async function addRunningRead(sessionID: string, messageID: string, id: string) {
  await Session.updatePart({
    id,
    messageID,
    sessionID,
    type: "tool",
    callID: `call-${id}`,
    tool: "read",
    state: {
      status: "running",
      input: { filePath: `/workspace/${id}.ts` },
      title: id,
      metadata: {},
      time: { start: 1 },
    },
  })
}

async function addCompletedRead(sessionID: string, messageID: string, id: string) {
  await Session.updatePart({
    id,
    messageID,
    sessionID,
    type: "tool",
    callID: `call-${id}`,
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: `/workspace/${id}.ts` },
      output: "done",
      title: id,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  })
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
          return {
            text: JSON.stringify({
              groups: [{ steps: [0, 0], summary: "Inspected the relevant files" }],
            }),
            model: {} as never,
          }
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

  test("keeps dedicated presentation tools out of the nano grouping manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const prompts: string[] = []
        ;(AgentCall.text as typeof AgentCall.text) = mock(async (input: AgentCall.TextInput) => {
          prompts.push(String(input.messages[0]?.content))
          return {
            text: JSON.stringify({
              groups: [
                { steps: [0, 0], summary: "Inspected the first file" },
                { steps: [1, 1], summary: "Inspected the second file" },
              ],
            }),
            model: {} as never,
          }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        for (const [id, tool, metadata] of [
          ["read-before", "read", {}],
          ["hidden-card", "plugin_tool", { display: { toolCard: "hidden" } }],
          ["render-preview", "render", {}],
          ["read-after", "read", {}],
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
              input: { filePath: `${tmp.path}/src/${id}.ts` },
              output: "done",
              title: id,
              metadata,
              time: { start: 1, end: 2 },
            },
          })
        }
        await Session.updatePart({
          id: "answer-boundaries",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        expect(prompts).toHaveLength(1)
        expect(prompts[0]).not.toContain("plugin_tool")
        expect(prompts[0]).not.toContain("render-preview")
        const storedGroups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { signature?: string }[]
        const signatures = storedGroups.map((group) => group.signature)
        expect(signatures.sort()).toEqual(["read-after", "read-before"])
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
          return {
            text: JSON.stringify({
              groups: [{ steps: [0, 1], summary: "Updated the UI package" }],
            }),
            model: {} as never,
          }
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

  test("uses nano segmentation to group adjacent mixed-family steps by shared intent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const prompts: string[] = []
        ;(AgentCall.text as typeof AgentCall.text) = mock(async (input: AgentCall.TextInput) => {
          prompts.push(String(input.messages[0]?.content))
          return {
            text: JSON.stringify({
              groups: [{ steps: [0, 2], summary: "Implemented and verified the activity trace" }],
            }),
            model: {} as never,
          }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        for (const [id, tool, input] of [
          ["read-flow", "read", { filePath: `${tmp.path}/packages/ui/src/components/session-turn-activity.tsx` }],
          [
            "edit-flow",
            "revise_file",
            { filePath: `${tmp.path}/packages/ui/src/components/session-turn-activity.tsx` },
          ],
          [
            "test-flow",
            "bash",
            {
              command:
                "PRIVATE_TOKEN=value /workspace/private/bin/bun test test/components/session-turn-activity.test.ts",
            },
          ],
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
              input,
              output: "done",
              title: id,
              metadata: {},
              time: { start: 1, end: 2 },
            },
          })
        }
        await Session.updatePart({
          id: "answer-semantic",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toContain('"i":0')
        expect(prompts[0]).toContain('"family":"inspect-local"')
        expect(prompts[0]).toContain('"family":"modify-files"')
        expect(prompts[0]).toContain('"family":"execute"')
        expect(prompts[0]).not.toContain(tmp.path)
        expect(prompts[0]).not.toContain("PRIVATE_TOKEN")
        expect(prompts[0]).not.toContain("/workspace/private")
        const groups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { signature?: string; text?: string; state?: string }[]
        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({
          state: "stable",
          text: "Implemented and verified the activity trace",
        })
        expect(groups[0]?.signature?.split(":").sort()).toEqual(["edit-flow", "read-flow", "test-flow"])
      },
    })
  })

  test("falls back for the whole tail when nano returns invalid semantic membership", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => ({
          text: JSON.stringify({
            groups: [{ steps: [1, 1], summary: "Skipped the first step" }],
          }),
          model: {} as never,
        }))
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        for (const [id, tool, input] of [
          ["read-invalid", "read", { filePath: `${tmp.path}/src/activity.ts` }],
          ["test-invalid", "bash", { command: "bun test" }],
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
              input,
              output: "done",
              title: id,
              metadata: {},
              time: { start: 1, end: 2 },
            },
          })
        }
        await Session.updatePart({
          id: "answer-invalid",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Done",
        })
        await ActivitySummary.idle(session.id)

        const groups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { state?: string; text?: string }[]
        expect(groups).toHaveLength(2)
        expect(groups.every((group) => group.state === "fallback" && group.text === undefined)).toBe(true)
      },
    })
  })

  test("sends only uncovered tool steps when a later tail settles", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        const prompts: string[] = []
        ;(AgentCall.text as typeof AgentCall.text) = mock(async (input: AgentCall.TextInput) => {
          prompts.push(String(input.messages[0]?.content))
          return {
            text: JSON.stringify({
              groups: [
                { steps: [0, 0], summary: prompts.length === 1 ? "Inspected the first file" : "Inspected the tail" },
              ],
            }),
            model: {} as never,
          }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)

        await addCompletedRead(session.id, assistant.id, "read-covered")
        await Session.updatePart({
          id: "boundary-first",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "First phase complete",
        })
        await ActivitySummary.idle(session.id)

        await addCompletedRead(session.id, assistant.id, "read-tail")
        await Session.updatePart({
          id: "boundary-tail",
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Tail complete",
        })
        await ActivitySummary.idle(session.id)

        expect(prompts).toHaveLength(2)
        expect(prompts[1]).toContain("read-tail")
        expect(prompts[1]).not.toContain("read-covered")
        const signatures = (
          Object.values((await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {}) as {
            signature?: string
          }[]
        ).map((group) => group.signature)
        expect(signatures.sort()).toEqual(["read-covered", "read-tail"])
      },
    })
  })

  test("rejects nano membership that crosses a hard boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          return {
            text: JSON.stringify({ groups: [{ steps: [0, 1], summary: "Inspected both files" }] }),
            model: {} as never,
          }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        const errorPartID = Identifier.ascending("part")
        const afterPartID = Identifier.ascending("part")
        await addRunningRead(session.id, assistant.id, errorPartID)
        await addRunningRead(session.id, assistant.id, afterPartID)
        await Session.updatePart({
          id: errorPartID,
          messageID: assistant.id,
          sessionID: session.id,
          type: "tool",
          callID: `call-${errorPartID}`,
          tool: "read",
          state: {
            status: "error",
            input: { filePath: "/workspace/read-error-boundary.ts" },
            error: "failed",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        await addCompletedRead(session.id, assistant.id, afterPartID)
        await Bus.publish(SessionEvent.Idle, { sessionID: session.id })
        await ActivitySummary.idle(session.id)

        const groups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { signature?: string; state?: string; text?: string }[]
        expect(calls).toBe(1)
        expect(groups).toHaveLength(2)
        expect(groups.every((group) => group.state === "fallback" && group.text === undefined)).toBe(true)
        expect(groups.map((group) => group.signature).sort()).toEqual([afterPartID, errorPartID].sort())
      },
    })
  })

  test("rejects nano groups larger than 24 steps", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          return {
            text: JSON.stringify({ groups: [{ steps: [0, 24], summary: "Inspected every file" }] }),
            model: {} as never,
          }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        const ids = Array.from({ length: 25 }, (_, index) => `read-limit-${index}`)
        for (const id of ids) await addRunningRead(session.id, assistant.id, id)
        for (const id of ids) await addCompletedRead(session.id, assistant.id, id)
        await Bus.publish(SessionEvent.Idle, { sessionID: session.id })
        await ActivitySummary.idle(session.id)

        const groups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { signature?: string; state?: string; text?: string }[]
        expect(calls).toBe(1)
        expect(groups).toHaveLength(2)
        expect(groups.every((group) => group.state === "fallback" && group.text === undefined)).toBe(true)
        expect(groups.map((group) => group.signature?.split(":").length).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
          1, 24,
        ])
      },
    })
  })

  test("falls back without invoking nano when a tool manifest exceeds 48 steps", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        setDisplay("balanced")
        let calls = 0
        ;(AgentCall.text as typeof AgentCall.text) = mock(async () => {
          calls++
          return { text: "Should not run", model: {} as never }
        })
        ActivitySummary.init()
        const { session, assistant } = await createTurn(tmp.path)
        const ids = Array.from({ length: 49 }, (_, index) => `read-manifest-${index}`)
        for (const id of ids) await addRunningRead(session.id, assistant.id, id)
        for (const id of ids) await addCompletedRead(session.id, assistant.id, id)
        await Bus.publish(SessionEvent.Idle, { sessionID: session.id })
        await ActivitySummary.idle(session.id)

        const groups = Object.values(
          (await storedAssistant(session.id, assistant.id))?.metadata?.activity?.groups ?? {},
        ) as { signature?: string; state?: string; text?: string }[]
        expect(calls).toBe(0)
        expect(groups).toHaveLength(3)
        expect(groups.every((group) => group.state === "fallback" && group.text === undefined)).toBe(true)
        expect(groups.map((group) => group.signature?.split(":").length).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
          1, 24, 24,
        ])
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
          return {
            text: JSON.stringify({
              groups: [
                { steps: [0, 0], summary: "Inspected the input" },
                { steps: [1, 1], summary: "Ran the tests" },
              ],
            }),
            model: {} as never,
          }
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
        expect(calls).toBe(1)
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
