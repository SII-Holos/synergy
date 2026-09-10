import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Tool as AITool } from "ai"
import { Identifier } from "../../src/id/id"
import type { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { createUserMessage } from "../../src/session/input"
import { SessionManager } from "../../src/session/manager"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { ToolScheduler } from "../../src/session/tool-scheduler"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"

afterAll(async () => {
  // executeToolCall dispatches through the module-level ToolScheduler
  // singleton; stop and re-arm it so sibling suites in this shard process are
  // neither rejected with "Tool scheduler is stopping" nor blocked by
  // "cannot be reconfigured after it has started", even if a test above
  // failed mid-execution.
  await ToolScheduler.stop()
  ToolScheduler.configure()
})

function testModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    api: { id: "test-model", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 4_096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as unknown as Provider.Model
}

async function createTurn() {
  const session = await Session.create({})
  const user = await createUserMessage({
    sessionID: session.id,
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: "run a tool" }],
  })
  const messageID = Identifier.ascending("message")
  const assistantMessage: MessageV2.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: user.info.id,
    modelID: "test-model",
    providerID: "test",
    mode: "test",
    agent: "test",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  await Session.updateMessage(assistantMessage)
  const processor = SessionProcessor.create({
    assistantMessage,
    sessionID: session.id,
    model: testModel(),
    abort: new AbortController().signal,
  })
  const readDurableToolPart = async (callID: string): Promise<MessageV2.ToolPart> => {
    const stored = await MessageV2.get({ sessionID: session.id, messageID })
    const part = stored.parts.find(
      (candidate): candidate is MessageV2.ToolPart => candidate.type === "tool" && candidate.callID === callID,
    )
    expect(part).toBeDefined()
    const scopeID = Identifier.asScopeID(await SessionManager.resolveScopeID(session.id))
    // Read the persisted record directly: the contract under test is the
    // durable part, not any in-memory or cached view.
    return Storage.read<MessageV2.ToolPart>(
      StoragePath.messagePart(
        scopeID,
        Identifier.asSessionID(session.id),
        Identifier.asMessageID(messageID),
        Identifier.asPartID(part!.id),
      ),
    )
  }
  return { processor, readDurableToolPart }
}

function gateUpdatePart(callID: string) {
  const events: string[] = []
  let holding = false
  let releaseFlush!: () => void
  const flushReleased = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  let flushArrived!: () => void
  const flushWriteHeld = new Promise<void>((resolve) => {
    flushArrived = resolve
  })

  const realUpdatePart = Session.updatePart
  spyOn(Session, "updatePart").mockImplementation((async (input: any) => {
    const isTarget = input?.type === "tool" && input?.callID === callID
    if (holding && isTarget && input.state.status === "running") {
      holding = false
      flushArrived()
      await flushReleased
      events.push("flush:commit")
    }
    if (isTarget && (input.state.status === "completed" || input.state.status === "error")) {
      events.push("terminal:enter")
    }
    return realUpdatePart(input)
  }) as unknown as typeof Session.updatePart)
  return {
    events,
    arm: () => {
      holding = true
    },
    release: releaseFlush,
    flushWriteHeld,
  }
}

// Deterministic scheduling barrier: macrotask turns give any unqueued async
// write chain room to start without a wall-clock timeout.
async function pumpMacrotasks(turns: number) {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
describe("tool settlement vs late state flushes", () => {
  afterEach(() => {
    mock.restore()
  })

  test("a completed settlement is not overwritten by an in-flight running write", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { processor, readDurableToolPart } = await createTurn()
        const callID = Identifier.ascending("part")
        const gate = gateUpdatePart(callID)
        const execution = processor
          .executeToolCall({
            callID,
            toolName: "probe",
            args: { command: "printf ok" },
            tool: {
              async execute(args: unknown) {
                gate.arm()
                // Mirrors Bash flushMetadata(): a fire-and-forget metadata
                // write still in flight when the tool result settles.
                void processor
                  .updateToolCallState(callID, {
                    input: args as Record<string, any>,
                    metadata: { output: "streamed" },
                  })
                  .catch(() => {})
                processor.beginExecution(callID).complete(args, { title: "probe", output: "done", metadata: {} })
                return { title: "probe", output: "done", metadata: {} }
              },
            } as unknown as AITool,
          })
          .then(
            (result) => ({ ok: true as const, result }),
            (error: unknown) => ({ ok: false as const, error }),
          )

        await gate.flushWriteHeld
        // The terminal settlement must serialize behind the in-flight flush.
        // A fixed number of macrotask turns is a deterministic barrier: an
        // unqueued terminal write would have started long before they run
        // out, so its absence here is not a timing accident.
        await pumpMacrotasks(20)
        try {
          expect(gate.events).not.toContain("terminal:enter")
        } finally {
          gate.release()
        }
        const outcome = await execution
        expect(outcome.ok).toBe(true)
        expect(gate.events.indexOf("flush:commit")).toBeGreaterThanOrEqual(0)
        expect(gate.events.indexOf("terminal:enter")).toBeGreaterThan(gate.events.indexOf("flush:commit"))

        const durable = await readDurableToolPart(callID)
        const state = durable.state
        if (state.status !== "completed") throw new Error(`expected completed, got ${state.status}`)
        expect(state.output).toBe("done")
        expect(state.time.end).toBeNumber()
      },
    })
  })

  test("an error settlement is not overwritten by an in-flight running write", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { processor, readDurableToolPart } = await createTurn()
        const callID = Identifier.ascending("part")
        const gate = gateUpdatePart(callID)
        const execution = processor
          .executeToolCall({
            callID,
            toolName: "probe",
            args: { command: "printf ok" },
            tool: {
              async execute(args: unknown) {
                gate.arm()
                void processor
                  .updateToolCallState(callID, {
                    input: args as Record<string, any>,
                    metadata: { output: "streamed" },
                  })
                  .catch(() => {})
                throw new Error("tool boom")
              },
            } as unknown as AITool,
          })
          .then(
            (result) => ({ ok: true as const, result }),
            (error: unknown) => ({ ok: false as const, error }),
          )

        await gate.flushWriteHeld
        await pumpMacrotasks(20)
        try {
          expect(gate.events).not.toContain("terminal:enter")
        } finally {
          gate.release()
        }
        const outcome = await execution
        expect(outcome.ok).toBe(false)
        expect(gate.events.indexOf("flush:commit")).toBeGreaterThanOrEqual(0)
        expect(gate.events.indexOf("terminal:enter")).toBeGreaterThan(gate.events.indexOf("flush:commit"))

        const durable = await readDurableToolPart(callID)
        const state = durable.state
        if (state.status !== "error") throw new Error(`expected error, got ${state.status}`)
        expect(state.time.end).toBeNumber()
      },
    })
  })

  test("state updates queued after settlement leave the terminal part untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { processor, readDurableToolPart } = await createTurn()
        const callID = Identifier.ascending("part")
        const outcome = await processor.executeToolCall({
          callID,
          toolName: "probe",
          args: { command: "printf ok" },
          tool: {
            async execute(args: unknown) {
              processor.beginExecution(callID).complete(args, { title: "probe", output: "done", metadata: {} })
              return { title: "probe", output: "done", metadata: {} }
            },
          } as unknown as AITool,
        })
        expect(outcome.output).toBe("done")

        await processor.updateToolCallState(callID, {
          input: { command: "printf ok" },
          metadata: { output: "late arrival" },
        })

        const durable = await readDurableToolPart(callID)
        const state = durable.state
        if (state.status !== "completed") throw new Error(`expected completed, got ${state.status}`)
        expect(state.output).toBe("done")
      },
    })
  })

  test("a genuine running tool still persists metadata flushes while executing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { processor, readDurableToolPart } = await createTurn()
        const callID = Identifier.ascending("part")
        let finishTool!: () => void
        const toolMayFinish = new Promise<void>((resolve) => {
          finishTool = resolve
        })
        let metadataApplied!: () => void
        const metadataWriteResolved = new Promise<void>((resolve) => {
          metadataApplied = resolve
        })

        const execution = processor
          .executeToolCall({
            callID,
            toolName: "probe",
            args: { command: "sleep" },
            tool: {
              async execute(args: unknown) {
                await processor.updateToolCallState(callID, {
                  input: args as Record<string, any>,
                  metadata: { output: "progress" },
                })
                metadataApplied()
                await toolMayFinish
                processor.beginExecution(callID).complete(args, { title: "probe", output: "done", metadata: {} })
                return { title: "probe", output: "done", metadata: {} }
              },
            } as unknown as AITool,
          })
          .then(
            (result) => ({ ok: true as const, result }),
            (error: unknown) => ({ ok: false as const, error }),
          )

        await metadataWriteResolved
        const running = await readDurableToolPart(callID)
        const runningState = running.state
        if (runningState.status !== "running") throw new Error(`expected running, got ${runningState.status}`)
        expect(runningState.metadata?.output).toBe("progress")

        finishTool()
        const outcome = await execution
        expect(outcome.ok).toBe(true)
        const durable = await readDurableToolPart(callID)
        const state = durable.state
        if (state.status !== "completed") throw new Error(`expected completed, got ${state.status}`)
        expect(state.output).toBe("done")
      },
    })
  })
})
