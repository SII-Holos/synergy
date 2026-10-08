import { afterAll as afterRuntimeTests, describe, expect, test } from "bun:test"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerReactionOnlyJobs } from "../../src/channel/loop-jobs"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime({ register: registerReactionOnlyJobs })

const JOB_TYPE = "channel_reaction_only_turn_close"
const REACTION_TOOL = "channel_reaction_only"

async function assistantMessage(sessionID: string, rootID: string) {
  return (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: rootID,
    rootID,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now() },
    sessionID,
  } as MessageV2.Assistant)) as MessageV2.Assistant
}

async function reactionToolPart(sessionID: string, messageID: string, status: "completed" | "running" = "completed") {
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID,
    sessionID,
    type: "tool",
    callID: "call_reaction_only",
    tool: REACTION_TOOL,
    state:
      status === "completed"
        ? {
            status: "completed",
            input: {},
            output: "Reaction-only intent recorded",
            title: "Reaction only: SILENT",
            metadata: { intent: { type: "reaction_only", reaction: "SILENT" } },
            time: { start: Date.now(), end: Date.now() },
          }
        : { status: "running", input: {}, time: { start: Date.now() } },
  })
}

/** Post-phase collect over the shared registry, narrowed to this job. */
function collected(ctx: LoopJob.Context): LoopJob.JobInstance[] {
  return LoopJob.collect("post", ctx).filter((instance) => instance.type === JOB_TYPE)
}

function context(input: {
  sessionID: string
  rootID: string
  assistant: MessageV2.Assistant
  parts: MessageV2.Part[]
}): LoopJob.Context {
  return {
    session: { id: input.sessionID } as LoopJob.Context["session"],
    sessionID: input.sessionID,
    step: 1,
    messages: [{ info: input.assistant, parts: input.parts }],
    lastUser: {
      id: input.rootID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "synergy",
      model: { providerID: "test-provider", modelID: "test-model" },
    } as LoopJob.Context["lastUser"],
    lastUserParts: [],
    lastAssistant: input.assistant,
    abort: new AbortController().signal,
  }
}

async function inScope(fn: (sessionID: string, rootID: string) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      const rootID = Identifier.ascending("message")
      await fn(session.id, rootID)
    },
  })
}

describe("channel_reaction_only_turn_close", () => {
  test("closes the turn when the intent-bearing assistant is still non-terminal", () =>
    runtime.run(() =>
      inScope(async (sessionID, rootID) => {
        const assistant = await assistantMessage(sessionID, rootID)
        assistant.finish = "tool-calls"
        await reactionToolPart(sessionID, assistant.id)
        const parts = await MessageV2.parts({ sessionID, messageID: assistant.id })

        const instances = collected(context({ sessionID, rootID, assistant, parts }))
        expect(instances).toEqual([{ type: JOB_TYPE }])

        const result = await LoopJob.execute(instances, context({ sessionID, rootID, assistant, parts }))
        expect(result).toBe("pass")

        const persisted = await Session.messages({ sessionID })
        const closed = persisted.find((message) => message.info.id === assistant.id)
        expect(closed?.info.role).toBe("assistant")
        expect((closed?.info as MessageV2.Assistant).finish).toBe("stop")
      }),
    ))

  test("waits for a sibling tool call still in flight before closing the turn", () =>
    runtime.run(() =>
      inScope(async (sessionID, rootID) => {
        const assistant = await assistantMessage(sessionID, rootID)
        assistant.finish = "tool-calls"
        await reactionToolPart(sessionID, assistant.id)
        const siblingID = Identifier.ascending("part")
        await Session.updatePart({
          id: siblingID,
          messageID: assistant.id,
          sessionID,
          type: "tool",
          callID: "call_sibling",
          tool: "bash",
          state: { status: "running", input: {}, time: { start: Date.now() } },
        })
        const inFlight = await MessageV2.parts({ sessionID, messageID: assistant.id })
        expect(collected(context({ sessionID, rootID, assistant, parts: inFlight }))).toEqual([])

        // Once the sibling settles, the job fires again and closes the turn.
        await Session.updatePart({
          id: siblingID,
          messageID: assistant.id,
          sessionID,
          type: "tool",
          callID: "call_sibling",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "bash",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        const settled = await MessageV2.parts({ sessionID, messageID: assistant.id })
        expect(collected(context({ sessionID, rootID, assistant, parts: settled }))).toEqual([{ type: JOB_TYPE }])
      }),
    ))

  test("does not fire without a completed reaction-only tool part", () =>
    runtime.run(() =>
      inScope(async (sessionID, rootID) => {
        const assistant = await assistantMessage(sessionID, rootID)
        assistant.finish = "tool-calls"
        await reactionToolPart(sessionID, assistant.id, "running")
        const parts = await MessageV2.parts({ sessionID, messageID: assistant.id })

        const instances = collected(context({ sessionID, rootID, assistant, parts }))
        expect(instances).toEqual([])
      }),
    ))

  test("does not fire when the intent-bearing assistant is already terminal", () =>
    runtime.run(() =>
      inScope(async (sessionID, rootID) => {
        const assistant = await assistantMessage(sessionID, rootID)
        assistant.finish = "stop"
        await reactionToolPart(sessionID, assistant.id)
        const parts = await MessageV2.parts({ sessionID, messageID: assistant.id })

        const instances = collected(context({ sessionID, rootID, assistant, parts }))
        expect(instances).toEqual([])
      }),
    ))
})

afterRuntimeTests(() => runtime.close())
