import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { describe, expect, mock, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { PromptBudgeter } from "@ericsanchezok/synergy-harness/test/internal/session/prompt-budgeter"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { ExperienceEncoder } from "@ericsanchezok/synergy-library/experience-encoder"
import { abandonSession, continueSession } from "@ericsanchezok/synergy-runtime-local/session-api"

runtime.run(() => Log.init({ print: false }))

const model = {
  id: "test-model",
  providerID: "test-provider",
  name: "Test Model",
  limit: { context: 100_000, output: 8_192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/openai" },
  options: {},
}

/** A turn that streams a little and then holds, so the abort lands on a
 *  genuinely busy turn instead of on an already-finished one. */
async function* stalledTurn(signal: AbortSignal, started: { resolve: () => void }) {
  yield { type: "start" }
  yield { type: "start-step" }
  yield { type: "text-start", id: "txt_stalled" }
  yield { type: "text-delta", id: "txt_stalled", text: "Half a reply" }
  started.resolve()
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

/** A turn that finishes normally, so a resumed session reaches a terminal
 *  assistant the ordinary way. */
async function* completedTurn() {
  yield { type: "start" }
  yield { type: "start-step" }
  yield { type: "text-start", id: "txt_resumed" }
  yield { type: "text-delta", id: "txt_resumed", text: "Finished reply" }
  yield { type: "text-end", id: "txt_resumed" }
  yield {
    type: "finish-step",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }
  yield { type: "finish" }
}

/**
 * Drive the real invoke loop and the real SessionProcessor, mocking only the
 * provider transport.
 *
 * Every other harness in this package replaces `SessionProcessor.create`, which
 * writes `finish` itself and never exercises the processor's abort flattening —
 * so it cannot observe whether a live stop terminalizes the in-flight message.
 * That is exactly the bug this file exists to pin.
 */
function installLiveTurnMocks() {
  const originalGetModel = Provider.getModel
  const originalGetAgent = Agent.get
  const originalConfigCurrent = Config.current
  const originalAvailability = ToolResolver.availability
  const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
  const originalBuildPlan = PromptBudgeter.buildPlan
  const originalDecide = PromptBudgeter.decide
  const originalStream = AgentTurn.stream
  const originalPluginTrigger = Plugin.trigger
  const originalExperienceComplete = ExperienceEncoder.onComplete
  const originalSnapshotTrack = Snapshot.track
  const firstTurnStarted = Promise.withResolvers<void>()
  let turnCalls = 0

  ;(Provider.getModel as any) = mock(async () => model)
  ;(Agent.get as any) = mock(async (name: string) => ({
    name,
    mode: "primary",
    permission: PermissionNext.fromConfig({ "*": "allow" }),
    options: {},
  }))
  ;(Config.current as any) = mock(async () => ({
    ...(await originalConfigCurrent()),
    compaction: { auto: true, maxHistoryImages: 8 },
    library: { memory: { enabled: false }, experience: { retrieve: false } },
  }))
  ;(ToolResolver.availability as any) = mock(async () => ({
    visible: [],
    diagnostics: new Map(),
    autoExpandable: new Set(),
  }))
  ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({
    definitions: [],
    executionTools: {},
    executorKinds: {},
    activeToolIDs: [],
  }))
  ;(PromptBudgeter.buildPlan as any) = mock(async (input: Parameters<typeof PromptBudgeter.buildPlan>[0]) => ({
    system: input.system,
    systemCacheBreakpoint: input.systemCacheBreakpoint,
    lateSystem: input.lateSystem,
    messages: input.messages,
    toolDefinitions: input.toolDefinitions,
  }))
  ;(PromptBudgeter.decide as any) = mock(async () => ({
    budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
    measure: { system: 10, messages: 10, tools: 0, total: 20 },
    shouldCompact: false,
  }))
  ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
  ;(ExperienceEncoder.onComplete as any) = mock(() => {})
  ;(Snapshot.track as any) = mock(async () => undefined)
  ;(AgentTurn.stream as any) = mock(async (input: { agent?: { name?: string }; abort: AbortSignal }) => {
    if (input.agent?.name !== "synergy") {
      return {
        fullStream: (async function* () {})(),
        usage: Promise.resolve(undefined),
        async dispose() {},
      }
    }
    turnCalls++
    return {
      fullStream: turnCalls === 1 ? stalledTurn(input.abort, firstTurnStarted) : completedTurn(),
      usage: Promise.resolve(undefined),
      async dispose() {},
    }
  })

  return {
    firstTurnStarted: firstTurnStarted.promise,
    turnCalls: () => turnCalls,
    restore() {
      ;(Provider.getModel as any) = originalGetModel
      ;(Agent.get as any) = originalGetAgent
      ;(Config.current as any) = originalConfigCurrent
      ;(ToolResolver.availability as any) = originalAvailability
      ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
      ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
      ;(PromptBudgeter.decide as any) = originalDecide
      ;(AgentTurn.stream as any) = originalStream
      ;(Plugin.trigger as any) = originalPluginTrigger
      ;(ExperienceEncoder.onComplete as any) = originalExperienceComplete
      ;(Snapshot.track as any) = originalSnapshotTrack
    },
  }
}

async function createSessionWithRoot(options?: { interaction?: SessionInteraction.Info }) {
  const session = await Session.create({ title: "Live pause", interaction: options?.interaction })
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    isRoot: true,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text: "Run the task",
  })
  return session
}

async function latestAssistant(sessionID: string) {
  const messages = await SessionHistory.modelMessages({ sessionID })
  return messages.findLast((message) => message.info.role === "assistant")?.info as MessageV2.Assistant | undefined
}

describe("a live user stop preserves the resume breakpoint", () => {
  test("the interrupted assistant stays non-terminal and Continue issues a model call", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const harness = installLiveTurnMocks()
      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await createSessionWithRoot()
            try {
              const turn = SessionInvoke.loop.force(session.id)
              await harness.firstTurnStarted

              const stop = await SessionAbort.abort(session.id)
              await turn

              expect(stop.paused).toBe(true)
              expect(harness.turnCalls()).toBe(1)

              // The breakpoint `session.continue` resumes from. `finish:"error"`
              // and `time.completed` here make needsModelCall false, so Continue
              // would be the silent no-op this whole design exists to prevent.
              const interrupted = await latestAssistant(session.id)
              expect(interrupted).toBeDefined()
              expect(SessionProgress.isTerminalAssistant(interrupted!)).toBe(false)
              expect(interrupted!.time.completed).toBeUndefined()

              // No queued work: the resume below is driven by the breakpoint
              // alone, not by an inbox item the stop happened to leave behind.
              expect(await SessionInbox.list(session.id)).toHaveLength(0)

              expect(await continueSession(session.id)).toBe(true)
              expect(harness.turnCalls()).toBe(2)

              const resumed = await latestAssistant(session.id)
              expect(SessionProgress.isTerminalAssistant(resumed!)).toBe(true)
              expect(resumed!.finish).toBe("stop")
            } finally {
              SessionManager.unregisterRuntime(session.id)
            }
          },
        })
      } finally {
        harness.restore()
      }
    }))

  test("the abandon path still terminalizes the interrupted turn", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const harness = installLiveTurnMocks()
      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await createSessionWithRoot()
            try {
              const turn = SessionInvoke.loop.force(session.id).catch(() => undefined)
              await harness.firstTurnStarted

              await abandonSession(session.id)
              // The terminal error on the message propagates out of the loop as
              // the abnormal end it is; the persisted state below is the contract.
              await turn.catch(() => undefined)

              const abandoned = await latestAssistant(session.id)
              expect(abandoned).toBeDefined()
              expect(abandoned!.finish).toBe("error")
              expect(SessionProgress.isTerminalAssistant(abandoned!)).toBe(true)
              expect(abandoned!.time.completed).toBeNumber()
              expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
            } finally {
              SessionManager.unregisterRuntime(session.id)
            }
          },
        })
      } finally {
        harness.restore()
      }
    }))

  test("an internal cancellation settles the turn without latching a pause", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const harness = installLiveTurnMocks()
      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await createSessionWithRoot()
            try {
              const turn = SessionInvoke.loop.force(session.id)
              await harness.firstTurnStarted

              // Lattice and Light Loop withdraw work they own. That is not the
              // user asking the session to hold still, so no pause is latched and
              // the turn keeps its ordinary abnormal-end record.
              const state = await SessionAbort.abort(session.id, { internalCancel: true })
              await turn.catch(() => undefined)

              expect(state.paused).toBe(false)
              expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
              const settled = await latestAssistant(session.id)
              expect(SessionProgress.isTerminalAssistant(settled!)).toBe(true)
            } finally {
              SessionManager.unregisterRuntime(session.id)
            }
          },
        })
      } finally {
        harness.restore()
      }
    }))
  test("a stop on a session the pause latch cannot hold still settles the turn", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const harness = installLiveTurnMocks()
      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await createSessionWithRoot({ interaction: { mode: "unattended", source: "test" } })
            try {
              const turn = SessionInvoke.loop.force(session.id)
              await harness.firstTurnStarted

              const stop = await SessionAbort.abort(session.id)
              await turn.catch(() => undefined)

              // An unattended session is driven by a domain that reconciles its
              // own work, so a latch would be invisible and disobeyed. Leaving the
              // turn resumable there would report the stopped task as finished, so
              // a stop that cannot pause a session still settles the turn.
              expect(stop.paused).toBe(false)
              expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
              const settled = await latestAssistant(session.id)
              expect(SessionProgress.isTerminalAssistant(settled!)).toBe(true)
            } finally {
              SessionManager.unregisterRuntime(session.id)
            }
          },
        })
      } finally {
        harness.restore()
      }
    }))
})

afterRuntimeTests(() => runtime.close())
