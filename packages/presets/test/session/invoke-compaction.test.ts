import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { afterAll, beforeAll, describe, expect, test, mock, spyOn } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionProcessor } from "@ericsanchezok/synergy-harness/test/support/internals"
import { SessionMessageCache } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { PromptBudgeter } from "@ericsanchezok/synergy-harness/test/internal/session/prompt-budgeter"
import { ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex/manager"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionCompaction } from "@ericsanchezok/synergy-harness/test/internal/session/compaction"
import { modelWorkingSetForPrompt } from "@ericsanchezok/synergy-harness/test/support/internals"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { TimeoutConfig } from "@ericsanchezok/synergy-harness/util/timeout-config"
import { Embedding } from "@ericsanchezok/synergy-library/vector/embedding"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { CodexProvider } from "@ericsanchezok/synergy-harness/provider/codex"
import { RolloutTransport } from "@ericsanchezok/synergy-harness/session/rollout/transport"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Turn } from "@ericsanchezok/synergy-harness/session/turn"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

const originalEmbeddingGenerate = Embedding.generate

beforeAll(() =>
  runtime.run(() => {
    ;(Embedding.generate as any) = mock(async (input: Parameters<typeof Embedding.generate>[0]) => ({
      id: input.id,
      vector: [],
      model: "test-embedding",
    }))
  }),
)

afterAll(() =>
  runtime.run(() => {
    ;(Embedding.generate as any) = originalEmbeddingGenerate
  }),
)

class CompactionIntercept extends Error {
  constructor() {
    super("compaction part injected")
  }
}

function isCompactionIntercept(error: unknown): boolean {
  if (error instanceof CompactionIntercept) return true
  if (!error || typeof error !== "object") return false
  const nested = error as { error?: unknown; suppressed?: unknown }
  return nested.error instanceof CompactionIntercept || nested.suppressed instanceof CompactionIntercept
}

function testModel(limit: { context: number; output: number } = { context: 100_000, output: 8_192 }) {
  return {
    id: "test-model",
    providerID: "test-provider",
    name: "Test Model",
    limit,
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: "test-model-wire", npm: "@ai-sdk/openai" },
    options: {},
  }
}

function primaryAgent() {
  return {
    name: "synergy",
    mode: "primary",
    permission: PermissionNext.fromConfig({ "*": "allow" }),
    options: {},
  }
}

async function fastLoopTestConfig(originalConfigCurrent: typeof Config.current) {
  const config = await originalConfigCurrent()
  return {
    ...config,
    library: {
      ...config.library,
      memory: {
        ...config.library?.memory,
        enabled: false,
      },
      experience: {
        ...config.library?.experience,
        retrieve: false,
      },
    },
    compaction: { auto: true, maxHistoryImages: 8 },
  }
}

function testUser(input: {
  id: string
  sessionID: string
  created: number
  text?: string
  summaryTitle?: string
  metadata?: Record<string, unknown>
  parts?: MessageV2.Part[]
}): MessageV2.WithParts {
  const info: MessageV2.User = {
    id: input.id,
    role: "user",
    sessionID: input.sessionID,
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: input.created },
    ...(input.summaryTitle ? { summary: { title: input.summaryTitle, diffs: [] } } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
  return {
    info,
    parts:
      input.parts ??
      (input.text
        ? [
            {
              id: `${input.id}_text`,
              sessionID: input.sessionID,
              messageID: input.id,
              type: "text",
              text: input.text,
            },
          ]
        : []),
  }
}

function testAssistant(input: {
  id: string
  sessionID: string
  parentID: string
  created: number
  completed?: number
  summary?: boolean
  finish?: string
  parts?: MessageV2.Part[]
}): MessageV2.WithParts {
  const info: MessageV2.Assistant = {
    id: input.id,
    role: "assistant",
    sessionID: input.sessionID,
    parentID: input.parentID,
    modelID: "test-model",
    providerID: "test-provider",
    mode: input.summary ? "compaction" : "synergy",
    agent: input.summary ? "compaction" : "synergy",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: input.created, ...(input.completed !== undefined ? { completed: input.completed } : {}) },
    ...(input.summary
      ? { summary: true, compaction: { coveredThrough: { created: input.created, messageID: input.id } } }
      : {}),
    ...(input.finish ? { finish: input.finish } : {}),
  }
  return { info, parts: input.parts ?? [] }
}

async function filterNewestFirst(messages: MessageV2.WithParts[]) {
  return MessageV2.filterCompacted(
    (async function* () {
      for (let i = messages.length - 1; i >= 0; i--) yield messages[i]
    })(),
  )
}

function compactionDeadline() {
  const invokeMs = 12_345
  const realTimeout = globalThis.setTimeout
  let expire: (() => void) | undefined
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(realTimeout, {
      apply(target, receiver, args) {
        if (args[1] === invokeMs) {
          expire = () => args[0]()
          return Reflect.apply(target, receiver, [() => {}, invokeMs])
        }
        return Reflect.apply(target, receiver, args)
      },
    }) as typeof setTimeout,
  )
  return {
    invokeMs,
    expire() {
      expect(expire).toBeDefined()
      expire!()
    },
    [Symbol.dispose]() {
      timer.mockRestore()
    },
  }
}

async function runCompactionProcessCase(input: {
  providerID?: string
  replayModelID?: string
  beforeLocal?: (request: SessionProcessor.ProcessInput) => Promise<void>
  auto?: boolean
  error?: MessageV2.Assistant["error"]
  text?: string
  thrownError?: Error
  variant?: string
  modelLimit?: { context: number; output: number }
  native?: boolean
  abort?: AbortController
  toolOutput?: boolean
  historyText?: string
  historyChunks?: string[]
  rounds?: number
  overflowAttempts?: number
  finish?: string
  cold?: boolean
  invokeMs?: number
  beforePrepare?: (request: AgentTurn.Input) => Promise<void>
  beforeCompacting?: () => Promise<void>
  afterProcess?: () => Promise<void>
  beforeProcessorCreate?: () => void
  onProcessorSettled?: () => void
  preparedMessages?: AgentTurn.Input["messages"]
  beforeSummaryCommit?: () => Promise<void>
  afterSummaryCommit?: () => void
  beforeHistoryTransform?: (signal?: AbortSignal) => Promise<void>
  assistantMessageID?: string
  beforeProcess?: () => void
  beforeAttemptWrite?: (message: MessageV2.Assistant) => Promise<void>
  beforeProviderLookup?: () => void
  cachedHistory?: boolean
  prepareHistory?: (user: MessageV2.User) => Promise<void>
}) {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()

  const originalGetModel = Provider.getModel
  const originalGetProvider = Provider.getProvider
  const originalGetAgent = Agent.get
  const originalGetAvailableModel = Agent.getAvailableModel
  const originalProcessorCreate = SessionProcessor.create
  const originalPluginTrigger = Plugin.trigger
  const originalUpdateMessage = Session.updateMessage
  const originalResolveTimeout = TimeoutConfig.resolve
  const prepared: NonNullable<AgentTurn.Input["prepared"]> = {
    system: ["stable final system"],
    baseSystemLength: 1,
    provider: { options: {}, timeouts: { ttfbMs: 1_000, idleMs: false, wallMs: false } },
    params: { options: { reasoningEffort: "high" } },
  }
  using prepare = spyOn(AgentTurn, "prepare").mockImplementation(async (request) => {
    await input.beforePrepare?.(request)
    return { ...request, messages: input.preparedMessages ?? request.messages, prepared }
  })
  using timeout = spyOn(TimeoutConfig, "resolve").mockImplementation(async () => {
    const config = await originalResolveTimeout()
    return { ...config, invokeMs: input.invokeMs ?? config.invokeMs }
  })

  let initialSummary: boolean | undefined
  let initialIncludeInContext: boolean | undefined
  let initialVisible: boolean | undefined
  const attemptStates: Array<unknown> = []
  let processUserVariant: string | undefined
  let processMaxOutputTokens: number | undefined
  let processInput: SessionProcessor.ProcessInput | undefined
  const processInputs: SessionProcessor.ProcessInput[] = []

  try {
    ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => ({
      ...testModel(input.modelLimit),
      providerID,
      id: modelID,
    }))
    ;(Provider.getProvider as any) = mock(async (providerID: string) => {
      input.beforeProviderLookup?.()
      return {
        profileID:
          providerID === CodexProvider.PROVIDER_ID || providerID === "codex-work"
            ? CodexProvider.PROVIDER_ID
            : "test-provider",
      }
    })
    ;(Agent.get as any) = mock(async () => primaryAgent())
    ;(Agent.getAvailableModel as any) = mock(async () => ({
      providerID: "test-provider",
      modelID: "test-model",
    }))
    ;(Plugin.trigger as any) = mock(
      async (name: string, _context: unknown, value: unknown, options?: { signal?: AbortSignal }) => {
        if (name === "experimental.session.compacting") await input.beforeCompacting?.()
        if (name === "experimental.chat.messages.transform") await input.beforeHistoryTransform?.(options?.signal)
        return value
      },
    )
    ;(Session.updateMessage as any) = mock(async (message: MessageV2.Info) => {
      if (message.role === "assistant" && message.mode === "compaction") {
        attemptStates.push(message.metadata?.compactionAttempt)
      }
      if (message.role === "assistant" && message.mode === "compaction" && message.summary) {
        await input.beforeSummaryCommit?.()
      }
      if (message.role === "assistant" && message.mode === "compaction") await input.beforeAttemptWrite?.(message)
      const persisted = await originalUpdateMessage(message)
      if (message.role === "assistant" && message.mode === "compaction" && message.summary) input.afterSummaryCommit?.()
      return persisted
    })
    ;(SessionProcessor.create as any) = mock((processorInput: Parameters<typeof SessionProcessor.create>[0]) => {
      initialSummary = processorInput.assistantMessage.summary
      initialIncludeInContext = processorInput.assistantMessage.includeInContext
      initialVisible = processorInput.assistantMessage.visible
      input.beforeProcessorCreate?.()
      return {
        message: processorInput.assistantMessage,
        partFromToolCall: () => undefined,
        modelInputFromToolCall: () => undefined,
        trackExecution: () => {},
        process: mock(async (request: SessionProcessor.ProcessInput) => {
          processInput = request
          processInputs.push(request)
          processUserVariant = request.user.variant
          processMaxOutputTokens = request.maxOutputTokens
          await input.beforeLocal?.(request)
          if (processInputs.length <= (input.overflowAttempts ?? 0)) {
            processorInput.assistantMessage.error = new MessageV2.APIError({
              message: "context_length_exceeded",
              isRetryable: false,
            }).toObject()
            await Session.updateMessage(processorInput.assistantMessage)
            return "stop" as const
          }
          if (input.thrownError) throw input.thrownError
          if (input.text) {
            const now = Date.now()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: processorInput.assistantMessage.id,
              sessionID: processorInput.sessionID,
              type: "text",
              text: input.text,
              time: { start: now, end: now },
            })
          }
          if (input.toolOutput) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: processorInput.assistantMessage.id,
              sessionID: processorInput.sessionID,
              type: "tool",
              tool: "fixture_tool",
              callID: "forbidden_call",
              state: {
                status: "completed",
                input: {},
                output: "prohibited",
                title: "Forbidden",
                metadata: {},
                time: { start: 0, end: 1 },
              },
            })
          }
          if (input.error) processorInput.assistantMessage.error = input.error
          else processorInput.assistantMessage.finish = input.finish ?? "stop"
          processorInput.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(processorInput.assistantMessage)
          input.onProcessorSettled?.()
          return "stop" as const
        }),
      }
    })

    return await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        using cache = {
          [Symbol.dispose]() {
            if (input.cachedHistory) SessionMessageCache.disable(session.id)
          },
        }
        if (input.cachedHistory) {
          SessionMessageCache.enable(session.id)
          await SessionHistory.modelMessages({ sessionID: session.id })
        }
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: PrimaryAgentIdentity.names.general,
          model: { providerID: input.providerID ?? "test-provider", modelID: "test-model" },
          time: { created: Date.now() },
          ...(input.variant ? { variant: input.variant } : {}),
        })
        if (user.role !== "user") throw new Error("Expected a user message")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: input.historyText ?? "Continue this task after compaction.",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "compaction",
          auto: input.auto ?? false,
        })

        if (input.assistantMessageID) {
          await originalUpdateMessage(
            testAssistant({
              id: input.assistantMessageID,
              sessionID: session.id,
              parentID: user.id,
              created: Date.now(),
            }).info,
          )
        }
        for (const text of input.historyChunks ?? [
          "Observed history with implementation details and user constraints. ".repeat(600),
        ]) {
          const history = testAssistant({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            parentID: user.id,
            created: Date.now(),
          })
          await originalUpdateMessage(history.info)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: history.info.id,
            type: "text",
            text,
          })
        }
        await input.prepareHistory?.(user)
        const before = input.cachedHistory
          ? await SessionHistory.modelMessages({ sessionID: session.id })
          : await Session.messages({ sessionID: session.id })
        let result: Awaited<ReturnType<typeof SessionCompaction.process>> | undefined
        let thrown: unknown
        input.beforeProcess?.()
        try {
          for (let round = 0; round < (input.rounds ?? 1); round++) {
            if (round > 0)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: user.id,
                type: "compaction",
                auto: input.auto ?? false,
              })
            const current = round === 0 ? before : await SessionHistory.modelMessages({ sessionID: session.id })
            result = await SessionCompaction.process({
              parentID: user.id,
              messages: current,
              sessionID: session.id,
              abort: input.abort?.signal ?? new AbortController().signal,
              auto: input.auto ?? false,
              assistantMessageID: input.assistantMessageID,
              request: input.native
                ? {
                    user,
                    model: await Provider.getModel(user.model.providerID, user.model.modelID),
                    agent: await Agent.get(user.agent),
                    system: ["stable system"],
                    systemCacheBreakpoint: 1,
                    lateSystem: ["runtime context"],
                    ...(await MessageV2.projectModelMessages(modelWorkingSetForPrompt(current))),
                    toolDefinitions: [{ id: "fixture_tool", description: "Fixture", inputSchema: { type: "object" } }],
                    activeToolIDs: ["fixture_tool"],
                    ...(input.cold ? {} : { prepared }),
                  }
                : undefined,
            })
          }
        } catch (error) {
          thrown = error
        }
        await input.afterProcess?.()
        const after = await Session.messages({ sessionID: session.id })
        const attempt = after.findLast(
          (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
            message.info.role === "assistant" && message.info.mode === "compaction",
        )
        if (!attempt) throw new Error("compaction attempt was not persisted")
        const root = after.find((message) => message.info.id === user.id)
        if (!root) throw new Error("compaction root was not persisted")

        const calls =
          input.providerID === CodexProvider.PROVIDER_ID || input.providerID === "codex-work"
            ? await RolloutLedger.calls({ kind: "session", scopeID: scope.id, sessionID: session.id }, user.id)
            : []
        const replayPlan = input.replayModelID
          ? await SessionCompaction.codexReplayPlan({
              messages: after,
              providerID: input.providerID ?? "test-provider",
              modelID: input.replayModelID,
              profileID: CodexProvider.PROVIDER_ID,
              apiModelID: "test-model-wire",
            })
          : undefined
        return {
          workingSet: await SessionHistory.modelMessages({ sessionID: session.id }),
          processInputs,
          before,
          replayPlan,
          calls,
          messages: after,
          result,
          thrown,
          attempt,
          root,
          initialSummary,
          initialIncludeInContext,
          initialVisible,
          processUserVariant,
          processMaxOutputTokens,
          processInput,
          attemptStates,
          prepareCalls: prepare.mock.calls,
        }
      },
    })
  } finally {
    ;(Provider.getModel as any) = originalGetModel
    ;(Provider.getProvider as any) = originalGetProvider
    ;(Agent.get as any) = originalGetAgent
    ;(Agent.getAvailableModel as any) = originalGetAvailableModel
    ;(SessionProcessor.create as any) = originalProcessorCreate
    ;(Plugin.trigger as any) = originalPluginTrigger
    ;(Session.updateMessage as any) = originalUpdateMessage
  }
}

async function expectPreflightCompaction(input: { shouldCompact: boolean; contextExceeded: boolean }) {
  await using tmp = await tmpdir({ git: true })

  const originalGetModel = Provider.getModel
  const originalGetAgent = Agent.get
  const originalConfigCurrent = Config.current
  const originalAvailability = ToolResolver.availability
  const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
  const originalBuildPlan = PromptBudgeter.buildPlan
  const originalDecide = PromptBudgeter.decide
  const originalProcessorCreate = SessionProcessor.create
  const originalUpdatePart = Session.updatePart
  const originalCortexList = Cortex.list
  const originalCortexGetRunningTasks = Cortex.getRunningTasks

  const processCalled = mock(async () => "stop" as const)
  const interceptedCompactionParts: Array<{ messageID: string; sessionID: string; auto: boolean }> = []
  const hardOverflowBelowSoft = input.contextExceeded && !input.shouldCompact

  try {
    ;(Provider.getModel as any) = mock(async () =>
      testModel(hardOverflowBelowSoft ? { context: 10_000, output: 10_000 } : undefined),
    )
    ;(Agent.get as any) = mock(async () => primaryAgent())
    ;(Config.current as any) = mock(async () => fastLoopTestConfig(originalConfigCurrent))
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
    ;(PromptBudgeter.buildPlan as any) = mock(async (input: PromptBudgeter.PromptPlanInput) => ({
      system: ["stub system"],
      messages: input.messages,
      messageSources: input.messageSources,
      toolDefinitions: [],
    }))
    ;(PromptBudgeter.decide as any) = mock(async () => ({
      budget: hardOverflowBelowSoft
        ? {
            context: 10_000,
            usable: 10_000,
            output: 1,
            margin: 2_048,
            inputEnvelope: 10_000,
            threshold: 0.85,
            soft: 8_500,
          }
        : {
            context: 100_000,
            usable: 100_000,
            output: 8_192,
            margin: 5_000,
            inputEnvelope: 86_808,
            threshold: 0.99,
            soft: 85_939,
          },
      measure: {
        system: 10,
        messages: 10,
        tools: 0,
        total: hardOverflowBelowSoft ? 8_200 : 95_000,
      },
      shouldCompact: input.shouldCompact,
      contextExceeded: input.contextExceeded,
    }))
    ;(SessionProcessor.create as any) = mock((createInput: Parameters<typeof SessionProcessor.create>[0]) => ({
      message: createInput.assistantMessage,
      partFromToolCall: () => undefined,
      modelInputFromToolCall: () => undefined,
      trackExecution: () => {},
      process: processCalled,
    }))
    ;(Session.updatePart as any) = mock(async (partInput: Parameters<typeof Session.updatePart>[0]) => {
      if ("type" in partInput && partInput.type === "compaction") {
        await originalUpdatePart(partInput as any)
        interceptedCompactionParts.push({
          messageID: partInput.messageID,
          sessionID: partInput.sessionID,
          auto: partInput.auto,
        })
        throw new CompactionIntercept()
      }
      return await originalUpdatePart(partInput as any)
    })
    ;(Cortex.list as any) = mock(() => [])
    ;(Cortex.getRunningTasks as any) = mock(() => [])

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id

        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: PrimaryAgentIdentity.names.general,
          model: {
            providerID: "test-provider",
            modelID: "test-model",
          },
          time: {
            created: Date.now(),
          },
        })

        await originalUpdatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID,
          type: "text",
          text: "Please continue with next steps.",
        })

        let intercepted: unknown
        try {
          await SessionInvoke.loop.force(sessionID)
        } catch (error) {
          intercepted = error
        }

        expect(isCompactionIntercept(intercepted)).toBe(true)
        expect(interceptedCompactionParts).toHaveLength(1)
        const [compactionPart] = interceptedCompactionParts
        expect(compactionPart.sessionID).toBe(sessionID)
        expect(compactionPart.auto).toBe(true)
        expect(compactionPart.messageID).toBe(user.id)

        const root = await MessageV2.get({ sessionID, messageID: compactionPart.messageID })
        expect(root.info?.role).toBe("user")
        expect(root.parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "compaction", auto: true, messageID: user.id })]),
        )
        expect(processCalled).not.toHaveBeenCalled()
      },
    })
  } finally {
    ;(Provider.getModel as any) = originalGetModel
    ;(Agent.get as any) = originalGetAgent
    ;(Config.current as any) = originalConfigCurrent
    ;(ToolResolver.availability as any) = originalAvailability
    ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
    ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
    ;(PromptBudgeter.decide as any) = originalDecide
    ;(SessionProcessor.create as any) = originalProcessorCreate
    ;(Session.updatePart as any) = originalUpdatePart
    ;(Cortex.list as any) = originalCortexList
    ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
  }
}

describe.serial("SessionInvoke preflight compaction", () => {
  test("opaque reasoning size cannot remove an early user constraint from compaction input", () =>
    runtime.run(async () => {
      const constraint = "Do not edit files until the user approves. "
      const chunks = [constraint, "Later observations. ", "Recent observations. "].map(
        (text) => text + "recorded facts ".repeat(800),
      )
      for (const size of [32, 300_000]) {
        const observed = await runCompactionProcessCase({
          native: true,
          cold: true,
          historyChunks: chunks,
          text: "The user has not approved editing files.",
          preparedMessages: [
            { role: "user", content: "Continue this task after compaction." },
            ...chunks.map((text, index) => ({
              role: "assistant" as const,
              content: [
                ...(index === 0
                  ? [
                      {
                        type: "reasoning" as const,
                        text: "",
                        providerOptions: {
                          openai: { itemId: "rs_opaque", reasoningEncryptedContent: "x".repeat(size) },
                        },
                      },
                    ]
                  : []),
                { type: "text" as const, text },
              ],
            })),
          ],
        })
        expect(observed.thrown).toBeUndefined()
        expect(observed.attempt.info.summary).toBe(true)
        expect(observed.processInputs).toHaveLength(1)
        expect(JSON.stringify(observed.processInput?.messages)).toContain(constraint)
        expect(
          observed.workingSet.some((message) =>
            message.parts.some((part) => part.type === "text" && part.text === chunks[2]),
          ),
        ).toBe(true)
      }
    }))

  test("commits unchanged cached attachment history from an earlier task", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        native: true,
        cachedHistory: true,
        text: "The earlier task supplied an image. Continue the current task.",
        prepareHistory: async (user) => {
          const earlierID = Identifier.ascending("message")
          const earlier = await Session.updateMessage({
            ...user,
            id: earlierID,
            rootID: earlierID,
            time: { created: user.time.created - 1 },
          })
          const asset = await Asset.write(Buffer.from("retained fixture image"), "image/png", "fixture.png")
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: user.sessionID,
            messageID: earlier.id,
            type: "attachment",
            mime: "image/png",
            url: `asset://${asset}`,
            filename: "fixture.png",
            presentation: { renderer: "image", size: "small" },
            model: { mode: "summary", summary: "An image from the earlier task." },
          })
        },
      })
      expect(observed.thrown).toBeUndefined()
      expect(observed.attempt.info).toMatchObject({
        summary: true,
        includeInContext: true,
        metadata: { compactionAttempt: { state: "committed" } },
      })
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(true)
      expect(
        observed.messages.flatMap((message) => message.parts).find((part) => part.type === "attachment"),
      ).toMatchObject({ filename: "fixture.png", presentation: { renderer: "image", size: "small" } })
    }))

  test("rejects a summary when its source changes before the commit", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        native: true,
        text: "stale summary",
        beforeLocal: async (request) => {
          const history = await Session.messages({ sessionID: request.sessionID })
          const source = history.find(
            (message) => message.info.role === "assistant" && message.info.mode !== "compaction",
          )!
          const part = source.parts.find((part): part is MessageV2.TextPart => part.type === "text")!
          await Session.updatePart({ ...part, text: "newly corrected fact" })
        },
      })
      expect(observed.thrown).toMatchObject({ message: "Compaction source history changed before commit" })
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.info.compaction).toBeUndefined()
      expect(
        observed.workingSet.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "newly corrected fact"),
        ),
      ).toBe(true)
    }))

  for (const change of ["cursor", "insert"] as const) {
    test(`rejects a summary when the source interval changes by ${change}`, () =>
      runtime.run(async () => {
        const observed = await runCompactionProcessCase({
          native: true,
          text: "stale summary",
          beforeLocal: async (request) => {
            const history = await Session.messages({ sessionID: request.sessionID })
            const source = history.find(
              (message) => message.info.role === "assistant" && message.info.mode !== "compaction",
            )!
            const updated = await Session.updateMessage({
              ...source.info,
              id: change === "insert" ? Identifier.ascending("message") : source.info.id,
              time: { created: source.info.time.created - 1 },
            })
            if (change === "insert") {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: updated.id,
                sessionID: request.sessionID,
                type: "text",
                text: "new fact inserted into the candidate interval",
              })
            }
          },
        })
        expect(observed.thrown).toMatchObject({ message: "Compaction source history changed before commit" })
        expect(observed.attempt.info.compaction).toBeUndefined()
        expect(observed.workingSet.filter((message) => message.info.role === "assistant").length).toBeGreaterThan(0)
      }))
  }

  test("provider normalization during a failed candidate cannot mutate the retry snapshot", () =>
    runtime.run(async () => {
      let calls = 0
      const chunks = Array.from({ length: 4 }, (_, i) => `source-${i} ${"evidence ".repeat(4000)}`)
      const observed = await runCompactionProcessCase({
        native: true,
        text: "valid summary",
        modelLimit: { context: 40_000, output: 2_000 },
        historyChunks: chunks,
        overflowAttempts: 1,
        beforeLocal: async (request) => {
          const first = request.messages.find((message) => message.role === "assistant")!
          if (!Array.isArray(first.content)) throw new Error("Expected projected assistant content")
          const text = first.content.find((part) => part.type === "text")!
          if (calls++ === 0) text.text = "provider-normalized attempt"
          else expect(text.text).toBe(chunks[0])
        },
      })
      expect(observed.thrown).toBeUndefined()
      expect(observed.attempt.info.summary).toBe(true)
      expect(calls).toBe(2)
    }))

  test("shrinks a provider-overflowing prefix and preserves every unprocessed message", () =>
    runtime.run(async () => {
      const chunks = Array.from(
        { length: 4 },
        (_, index) => `history-${index}: Do not edit until approved. ${"observed details ".repeat(2400)}`,
      )
      const observed = await runCompactionProcessCase({
        native: true,
        cold: true,
        modelLimit: { context: 40_000, output: 2_000 },
        historyChunks: chunks,
        overflowAttempts: 1,
        text: "The user asked for analysis and has not authorized edits.",
      })
      expect(observed.thrown).toBeUndefined()
      expect(observed.prepareCalls).toHaveLength(1)
      expect(observed.processInputs).toHaveLength(2)
      const [failed, succeeded] = observed.processInputs
      expect(succeeded.messages.length).toBeLessThan(failed.messages.length)
      expect(JSON.stringify(succeeded.messages)).toContain("history-0:")
      expect(observed.attempt.info.summary).toBe(true)
      const covered = observed.attempt.info.compaction!.coveredThrough
      for (const message of observed.before.filter((message) => message.info.id !== observed.root.info.id)) {
        const text = message.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        const wasSummarized = JSON.stringify(succeeded.messages).includes(text)
        const remaining = observed.workingSet.find((item) => item.info.id === message.info.id)
        if (wasSummarized) expect(remaining).toBeUndefined()
        else expect(remaining?.parts).toEqual(message.parts)
      }
      expect(observed.before.some((message) => message.info.id === covered.messageID)).toBe(true)
      expect(
        observed.messages.filter(
          (message) => message.info.role === "assistant" && message.info.mode === "compaction" && !message.info.summary,
        ),
      ).toHaveLength(1)
    }))

  test("does not commit a truncated summary or a replacement without compression benefit", () =>
    runtime.run(async () => {
      for (const result of [
        { text: "Truncated summary", finish: "length" },
        { text: "replacement larger than its source ".repeat(10_000) },
      ]) {
        const observed = await runCompactionProcessCase({ native: true, ...result })
        expect(observed.attempt.info.summary).toBeUndefined()
        expect(observed.attempt.info.compaction).toBeUndefined()
        expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
        for (const source of observed.before)
          expect(observed.workingSet.find((message) => message.info.id === source.info.id)?.parts).toEqual(source.parts)
      }
    }))

  test("injects a compaction part before main inference when the soft prompt budget is exceeded", () =>
    runtime.run(async () => {
      await expectPreflightCompaction({ shouldCompact: true, contextExceeded: false })
    }))

  test("injects compaction for hard overflow even below the configured soft threshold", () =>
    runtime.run(async () => {
      await expectPreflightCompaction({ shouldCompact: false, contextExceeded: true })
    }))

  test("continues progressive compaction until the recovered prompt fits", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const originalGetModel = Provider.getModel
      const originalGetAgent = Agent.get
      const originalGetAvailableModel = Agent.getAvailableModel
      const originalConfigCurrent = Config.current
      const originalAvailability = ToolResolver.availability
      const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
      const originalBuildPlan = PromptBudgeter.buildPlan
      const originalDecide = PromptBudgeter.decide
      const originalProcessorCreate = SessionProcessor.create
      const originalPluginTrigger = Plugin.trigger
      const originalCortexList = Cortex.list
      const originalCortexGetRunningTasks = Cortex.getRunningTasks

      let decideCount = 0
      let mainProcessCount = 0

      try {
        ;(Provider.getModel as any) = mock(async () => testModel())
        ;(Agent.get as any) = mock(async () => primaryAgent())
        ;(Agent.getAvailableModel as any) = mock(async () => ({
          providerID: "test-provider",
          modelID: "test-model",
        }))
        ;(Config.current as any) = mock(async () => fastLoopTestConfig(originalConfigCurrent))
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
        ;(PromptBudgeter.buildPlan as any) = mock(async (input: PromptBudgeter.PromptPlanInput) => ({
          system: ["stub system"],
          messages: input.messages,
          messageSources: input.messageSources,
          toolDefinitions: [],
        }))
        ;(PromptBudgeter.decide as any) = mock(async () => {
          decideCount++
          return {
            budget: {
              context: 100_000,
              usable: 100_000,
              output: 8_192,
              margin: 5_000,
              inputEnvelope: 86_808,
              threshold: 0.99,
              soft: 85_939,
            },
            measure: { system: 10, messages: 10, tools: 0, total: 95_000 },
            shouldCompact: false,
            contextExceeded: decideCount <= 2,
          }
        })
        ;(SessionProcessor.create as any) = mock((createInput: Parameters<typeof SessionProcessor.create>[0]) => ({
          message: createInput.assistantMessage,
          partFromToolCall: () => undefined,
          modelInputFromToolCall: () => undefined,
          trackExecution: () => {},
          process: mock(async () => {
            if (createInput.assistantMessage.mode !== "compaction") {
              mainProcessCount++
              createInput.assistantMessage.finish = "stop"
              createInput.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(createInput.assistantMessage)
              return "stop" as const
            }
            const now = Date.now()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: createInput.assistantMessage.id,
              sessionID: createInput.sessionID,
              type: "text",
              text: "## Goal\n\nContinue after compaction.",
              time: { start: now, end: now },
            })
            createInput.assistantMessage.finish = "stop"
            createInput.assistantMessage.time.completed = now
            await Session.updateMessage(createInput.assistantMessage)
            return "stop" as const
          }),
        }))
        ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
        ;(Cortex.list as any) = mock(() => [])
        ;(Cortex.getRunningTasks as any) = mock(() => [])

        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            const past = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID: session.id,
              agent: PrimaryAgentIdentity.names.general,
              model: { providerID: "test-provider", modelID: "test-model" },
              time: { created: Date.now() },
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: past.id,
              type: "text",
              text: "Earlier task constraints",
            })
            for (let index = 0; index < 3; index++) {
              const history = testAssistant({
                id: Identifier.ascending("message"),
                sessionID: session.id,
                parentID: past.id,
                created: Date.now(),
              })
              await Session.updateMessage(history.info)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: history.info.id,
                type: "text",
                text: `history-${index} ` + "observed implementation details ".repeat(2400),
              })
            }
            const user = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID: session.id,
              agent: PrimaryAgentIdentity.names.general,
              model: { providerID: "test-provider", modelID: "test-model" },
              time: { created: Date.now() },
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: user.id,
              sessionID: session.id,
              type: "text",
              text: "Compress progressively, then continue the task.",
            })

            let thrown: unknown
            try {
              await SessionInvoke.loop.force(session.id)
            } catch (error) {
              thrown = error
            }

            const root = await MessageV2.get({ sessionID: session.id, messageID: user.id })
            const messages = await Session.messages({ sessionID: session.id })
            const terminal = messages.findLast(
              (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
                message.info.role === "assistant" && message.info.parentID === user.id && !!message.info.error,
            )
            expect(root.parts.filter((part) => part.type === "compaction")).toHaveLength(2)
            expect(
              messages.filter((message) => message.info.role === "assistant" && message.info.summary),
            ).toHaveLength(2)
            expect(decideCount).toBe(4)
            expect(mainProcessCount).toBe(1)
            expect(terminal).toBeUndefined()
            expect(thrown).toBeUndefined()
          },
        })
      } finally {
        ;(Provider.getModel as any) = originalGetModel
        ;(Agent.get as any) = originalGetAgent
        ;(Agent.getAvailableModel as any) = originalGetAvailableModel
        ;(Config.current as any) = originalConfigCurrent
        ;(ToolResolver.availability as any) = originalAvailability
        ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
        ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
        ;(PromptBudgeter.decide as any) = originalDecide
        ;(SessionProcessor.create as any) = originalProcessorCreate
        ;(Plugin.trigger as any) = originalPluginTrigger
        ;(Cortex.list as any) = originalCortexList
        ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
      }
    }))

  test("stops locally when automatic compaction is disabled and no response space remains", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const originalGetModel = Provider.getModel
      const originalGetAgent = Agent.get
      const originalConfigCurrent = Config.current
      const originalAvailability = ToolResolver.availability
      const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
      const originalBuildPlan = PromptBudgeter.buildPlan
      const originalDecide = PromptBudgeter.decide
      const originalProcessorCreate = SessionProcessor.create
      const originalCortexList = Cortex.list
      const originalCortexGetRunningTasks = Cortex.getRunningTasks

      const processCalled = mock(async () => "stop" as const)

      try {
        ;(Provider.getModel as any) = mock(async () => testModel())
        ;(Agent.get as any) = mock(async () => primaryAgent())
        ;(Config.current as any) = mock(async () => {
          const config = await fastLoopTestConfig(originalConfigCurrent)
          return { ...config, compaction: { ...config.compaction, auto: false } }
        })
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
        ;(PromptBudgeter.buildPlan as any) = mock(async (input: PromptBudgeter.PromptPlanInput) => ({
          system: ["stub system"],
          messages: input.messages,
          messageSources: input.messageSources,
          toolDefinitions: [],
        }))
        ;(PromptBudgeter.decide as any) = mock(async () => ({
          budget: {
            context: 100_000,
            usable: 100_000,
            output: 8_192,
            margin: 5_000,
            inputEnvelope: 86_808,
            threshold: 0.85,
            soft: 73_786,
          },
          measure: { system: 0, messages: 98_000, tools: 0, total: 98_000 },
          shouldCompact: true,
          contextExceeded: true,
        }))
        ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
          message: input.assistantMessage,
          partFromToolCall: () => undefined,
          modelInputFromToolCall: () => undefined,
          trackExecution: () => {},
          process: processCalled,
        }))
        ;(Cortex.list as any) = mock(() => [])
        ;(Cortex.getRunningTasks as any) = mock(() => [])

        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            const user = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID: session.id,
              agent: PrimaryAgentIdentity.names.general,
              model: { providerID: "test-provider", modelID: "test-model" },
              time: { created: Date.now() },
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: user.id,
              sessionID: session.id,
              type: "text",
              text: "Continue without compaction.",
            })

            let thrown: unknown
            try {
              await SessionInvoke.loop.force(session.id)
            } catch (error) {
              thrown = error
            }

            const messages = await Session.messages({ sessionID: session.id })
            const assistant = messages.find(
              (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
                message.info.role === "assistant" && message.info.parentID === user.id,
            )
            expect(assistant?.info.error?.name).toBe("UnknownError")
            expect(JSON.stringify(assistant?.info.error)).toContain("leaves no room for a model response")
            expect(thrown).toBeInstanceOf(MessageV2.SessionTerminalError)
            expect(processCalled).not.toHaveBeenCalled()
          },
        })
      } finally {
        ;(Provider.getModel as any) = originalGetModel
        ;(Agent.get as any) = originalGetAgent
        ;(Config.current as any) = originalConfigCurrent
        ;(ToolResolver.availability as any) = originalAvailability
        ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
        ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
        ;(PromptBudgeter.decide as any) = originalDecide
        ;(SessionProcessor.create as any) = originalProcessorCreate
        ;(Cortex.list as any) = originalCortexList
        ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
      }
    }))

  test("refreshes session state between model steps", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const originalGetModel = Provider.getModel
      const originalGetAgent = Agent.get
      const originalConfigCurrent = Config.current
      const originalAvailability = ToolResolver.availability
      const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
      const originalBuildPlan = PromptBudgeter.buildPlan
      const originalDecide = PromptBudgeter.decide
      const originalProcessorCreate = SessionProcessor.create
      const originalCortexList = Cortex.list
      const originalCortexGetRunningTasks = Cortex.getRunningTasks

      const definitionToolStates: Array<Session.Info["toolState"]> = []
      let processCount = 0
      const processMaxOutputTokens: Array<number | undefined> = []

      try {
        ;(Provider.getModel as any) = mock(async () => testModel())
        ;(Agent.get as any) = mock(async () => primaryAgent())
        ;(Config.current as any) = mock(async () => fastLoopTestConfig(originalConfigCurrent))
        ;(ToolResolver.availability as any) = mock(async (input: Parameters<typeof ToolResolver.availability>[0]) => {
          definitionToolStates.push(input.session?.toolState)
          return { visible: [], diagnostics: new Map(), autoExpandable: new Set() }
        })
        ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({
          definitions: [],
          executionTools: {},
          executorKinds: {},
          activeToolIDs: [],
        }))
        ;(PromptBudgeter.buildPlan as any) = mock(async (input: PromptBudgeter.PromptPlanInput) => ({
          system: ["stub system"],
          messages: input.messages,
          messageSources: input.messageSources,
          toolDefinitions: [],
        }))
        ;(PromptBudgeter.decide as any) = mock(async () => ({
          budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
          measure: { system: 10, messages: 10, tools: 0, total: 20 },
          shouldCompact: false,
          maxOutputTokens: 7_000,
        }))
        ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
          message: input.assistantMessage,
          partFromToolCall: () => undefined,
          modelInputFromToolCall: () => undefined,
          trackExecution: () => {},
          process: mock(async (processInput: SessionProcessor.ProcessInput) => {
            processMaxOutputTokens.push(processInput.maxOutputTokens)
            processCount++
            input.assistantMessage.finish = processCount === 1 ? "tool-calls" : "stop"
            input.assistantMessage.time.completed = Date.now()
            await Session.updateMessage(input.assistantMessage)
            if (processCount === 1) {
              await Session.update(input.sessionID, (draft) => {
                draft.toolState = { expandedGroups: ["note"] }
              })
              return "continue" as const
            }
            return "stop" as const
          }),
        }))
        ;(Cortex.list as any) = mock(() => [])
        ;(Cortex.getRunningTasks as any) = mock(() => [])

        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            const sessionID = session.id

            const user = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID,
              agent: PrimaryAgentIdentity.names.general,
              model: {
                providerID: "test-provider",
                modelID: "test-model",
              },
              time: {
                created: Date.now(),
              },
            })

            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: user.id,
              sessionID,
              type: "text",
              text: "Expand a deferred tool group, then continue.",
            })

            await SessionInvoke.loop.force(sessionID)

            expect(processCount).toBe(2)
            expect(definitionToolStates[0]).toBeUndefined()
            expect(definitionToolStates[1]?.expandedGroups).toEqual(["note"])
            expect(processMaxOutputTokens).toEqual([7_000, 7_000])
          },
        })
      } finally {
        ;(Provider.getModel as any) = originalGetModel
        ;(Agent.get as any) = originalGetAgent
        ;(Config.current as any) = originalConfigCurrent
        ;(ToolResolver.availability as any) = originalAvailability
        ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
        ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
        ;(PromptBudgeter.decide as any) = originalDecide
        ;(SessionProcessor.create as any) = originalProcessorCreate
        ;(Cortex.list as any) = originalCortexList
        ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
      }
    }))

  test("does not reuse token calibration across a completed compaction boundary", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })

      const originalGetModel = Provider.getModel
      const originalGetAgent = Agent.get
      const originalConfigCurrent = Config.current
      const originalAvailability = ToolResolver.availability
      const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
      const originalBuildPlan = PromptBudgeter.buildPlan
      const originalDecide = PromptBudgeter.decide
      const originalProcessorCreate = SessionProcessor.create
      const originalUpdatePart = Session.updatePart
      const originalCortexList = Cortex.list
      const originalCortexGetRunningTasks = Cortex.getRunningTasks

      const decideOptions: Array<Parameters<typeof PromptBudgeter.decide>[3]> = []
      const interceptedCompactionParts: Array<{ messageID: string; sessionID: string; auto: boolean }> = []
      let processCount = 0

      try {
        ;(Provider.getModel as any) = mock(async () => testModel())
        ;(Agent.get as any) = mock(async () => primaryAgent())
        ;(Config.current as any) = mock(async () => fastLoopTestConfig(originalConfigCurrent))
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
        ;(PromptBudgeter.buildPlan as any) = mock(async (input: PromptBudgeter.PromptPlanInput) => ({
          system: ["stub system"],
          messages: input.messages,
          messageSources: input.messageSources,
          toolDefinitions: [],
        }))
        ;(PromptBudgeter.decide as any) = mock(
          async (
            _plan: Parameters<typeof PromptBudgeter.decide>[0],
            _limits: Parameters<typeof PromptBudgeter.decide>[1],
            _modelID: Parameters<typeof PromptBudgeter.decide>[2],
            options: Parameters<typeof PromptBudgeter.decide>[3],
          ) => {
            decideOptions.push(options)
            const shouldCompact = !!options?.calibration
            return {
              budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
              measure: {
                system: 10,
                messages: shouldCompact ? 90_000 : 10,
                tools: 0,
                total: shouldCompact ? 90_000 : 20,
              },
              shouldCompact,
            }
          },
        )
        ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
          message: input.assistantMessage,
          partFromToolCall: () => undefined,
          modelInputFromToolCall: () => undefined,
          trackExecution: () => {},
          process: mock(async () => {
            processCount++
            input.assistantMessage.finish = "stop"
            input.assistantMessage.time.completed = Date.now()
            await Session.updateMessage(input.assistantMessage)
            return "stop" as const
          }),
        }))
        ;(Cortex.list as any) = mock(() => [])
        ;(Cortex.getRunningTasks as any) = mock(() => [])

        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({})
            const sessionID = session.id
            const created = Date.now()

            const user = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID,
              agent: PrimaryAgentIdentity.names.general,
              model: {
                providerID: "test-provider",
                modelID: "test-model",
              },
              time: {
                created,
              },
            })

            await originalUpdatePart({
              id: Identifier.ascending("part"),
              messageID: user.id,
              sessionID,
              type: "text",
              text: "Analyze the status bar content.",
            })
            await originalUpdatePart({
              id: Identifier.ascending("part"),
              messageID: user.id,
              sessionID,
              type: "compaction",
              auto: true,
            })

            await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "assistant",
              parentID: user.id,
              sessionID,
              modelID: "test-model",
              providerID: "test-provider",
              mode: PrimaryAgentIdentity.names.general,
              agent: PrimaryAgentIdentity.names.general,
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              cost: 0,
              tokens: {
                input: 91_000,
                output: 6_000,
                reasoning: 1_000,
                cache: { read: 0, write: 0 },
              },
              finish: "stop",
              time: {
                created: created + 1,
                completed: created + 2,
              },
            })

            await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "assistant",
              parentID: user.id,
              sessionID,
              modelID: "test-model",
              providerID: "test-provider",
              mode: "compaction",
              agent: "compaction",
              summary: true,
              path: {
                cwd: tmp.path,
                root: tmp.path,
              },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              finish: "stop",
              time: {
                created: created + 3,
                completed: created + 4,
              },
            })

            const continueUser = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID,
              agent: PrimaryAgentIdentity.names.general,
              model: {
                providerID: "test-provider",
                modelID: "test-model",
              },
              summary: { title: "Compaction complete", diffs: [] },
              time: {
                created: created + 5,
              },
            })

            await originalUpdatePart({
              id: Identifier.ascending("part"),
              messageID: continueUser.id,
              sessionID,
              type: "text",
              synthetic: true,
              text: "Continue if you have next steps",
            })
            ;(Session.updatePart as any) = mock(async (input: Parameters<typeof Session.updatePart>[0]) => {
              if ("type" in input && input.type === "compaction") {
                interceptedCompactionParts.push({
                  messageID: input.messageID,
                  sessionID: input.sessionID,
                  auto: input.auto,
                })
                throw new CompactionIntercept()
              }
              return await originalUpdatePart(input as any)
            })

            await SessionInvoke.loop.force(sessionID)

            expect(decideOptions).toHaveLength(2)
            expect(decideOptions.every((options) => options?.calibration === undefined)).toBe(true)
            expect(interceptedCompactionParts).toEqual([])
            expect(processCount).toBe(1)
          },
        })
      } finally {
        ;(Provider.getModel as any) = originalGetModel
        ;(Agent.get as any) = originalGetAgent
        ;(Config.current as any) = originalConfigCurrent
        ;(ToolResolver.availability as any) = originalAvailability
        ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
        ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
        ;(PromptBudgeter.decide as any) = originalDecide
        ;(SessionProcessor.create as any) = originalProcessorCreate
        ;(Session.updatePart as any) = originalUpdatePart
        ;(Cortex.list as any) = originalCortexList
        ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
      }
    }))

  test("filters compacted history from the synthetic auto-compaction boundary", () =>
    runtime.run(async () => {
      const sessionID = "ses_test"
      const realUser = testUser({
        id: "msg_real_user",
        sessionID,
        created: 1,
        text: "Polish the account settings UI.",
      })
      const oldAssistant = testAssistant({
        id: "msg_old_assistant",
        sessionID,
        parentID: realUser.info.id,
        created: 2,
        completed: 3,
        finish: "tool-calls",
        parts: [
          {
            id: "prt_old_text",
            sessionID,
            messageID: "msg_old_assistant",
            type: "text",
            text: "Large pre-compaction tool trajectory.",
          },
        ],
      })
      const boundary = testUser({
        id: "msg_boundary",
        sessionID,
        created: 4,
        summaryTitle: "Compaction requested",
        metadata: {
          synthetic: true,
          compactionBoundary: true,
          compactionParentID: realUser.info.id,
        },
        parts: [
          {
            id: "prt_boundary_compaction",
            sessionID,
            messageID: "msg_boundary",
            type: "compaction",
            auto: true,
          },
        ],
      })
      const summary = testAssistant({
        id: "msg_summary",
        sessionID,
        parentID: boundary.info.id,
        created: 5,
        completed: 6,
        summary: true,
        finish: "stop",
      })
      const continuation = testUser({
        id: "msg_continue",
        sessionID,
        created: 7,
        summaryTitle: "Compaction complete",
        parts: [
          {
            id: "prt_continue",
            sessionID,
            messageID: "msg_continue",
            type: "text",
            synthetic: true,
            text: "Continue if you have next steps",
          },
        ],
      })

      const compacted = await filterNewestFirst([realUser, oldAssistant, boundary, summary, continuation])

      expect(compacted.map((msg) => msg.info.id)).toEqual(["msg_boundary", "msg_summary", "msg_continue"])
    }))

  test("filters repeated root-anchored auto-compactions to the latest summary", () =>
    runtime.run(async () => {
      const sessionID = "ses_test"
      const root = testUser({
        id: "msg_root",
        sessionID,
        created: 1,
        parts: [
          {
            id: "prt_root_text",
            sessionID,
            messageID: "msg_root",
            type: "text",
            text: "Implement the compact boundary fix.",
          },
          {
            id: "prt_compact_1",
            sessionID,
            messageID: "msg_root",
            type: "compaction",
            auto: true,
          },
          {
            id: "prt_compact_2",
            sessionID,
            messageID: "msg_root",
            type: "compaction",
            auto: true,
          },
        ],
      })
      const oldAssistant = testAssistant({
        id: "msg_old_assistant",
        sessionID,
        parentID: root.info.id,
        created: 2,
        completed: 3,
        finish: "tool-calls",
        parts: [
          {
            id: "prt_old_text",
            sessionID,
            messageID: "msg_old_assistant",
            type: "text",
            text: "Large pre-compaction trajectory.",
          },
        ],
      })
      const summary1 = testAssistant({
        id: "msg_summary_1",
        sessionID,
        parentID: root.info.id,
        created: 4,
        completed: 5,
        summary: true,
        finish: "stop",
      })
      const continue1 = testUser({
        id: "msg_continue_1",
        sessionID,
        created: 6,
        summaryTitle: "Compaction complete",
        parts: [
          {
            id: "prt_continue_1",
            sessionID,
            messageID: "msg_continue_1",
            type: "text",
            synthetic: true,
            text: "Continue if you have next steps",
          },
        ],
      })
      const middleAssistant = testAssistant({
        id: "msg_middle_assistant",
        sessionID,
        parentID: root.info.id,
        created: 7,
        completed: 8,
        finish: "tool-calls",
        parts: [
          {
            id: "prt_middle_text",
            sessionID,
            messageID: "msg_middle_assistant",
            type: "text",
            text: "Large trajectory after the first compaction.",
          },
        ],
      })
      const summary2 = testAssistant({
        id: "msg_summary_2",
        sessionID,
        parentID: root.info.id,
        created: 9,
        completed: 10,
        summary: true,
        finish: "stop",
      })
      const continue2 = testUser({
        id: "msg_continue_2",
        sessionID,
        created: 11,
        summaryTitle: "Compaction complete",
        parts: [
          {
            id: "prt_continue_2",
            sessionID,
            messageID: "msg_continue_2",
            type: "text",
            synthetic: true,
            text: "Continue if you have next steps",
          },
        ],
      })

      const compacted = await filterNewestFirst([
        root,
        oldAssistant,
        summary1,
        continue1,
        middleAssistant,
        summary2,
        continue2,
      ])

      expect(compacted.map((msg) => msg.info.id)).toEqual([
        "msg_root",
        "msg_summary_1",
        "msg_summary_2",
        "msg_continue_2",
      ])
      expect(compacted.find((msg) => msg.info.id === "msg_summary_1")?.info.includeInContext).toBe(false)
      expect(compacted.find((msg) => msg.info.id === "msg_summary_2")?.info.includeInContext).toBeUndefined()
      expect(SessionCompaction.hasPendingCompaction(root.parts, compacted, root.info.id)).toBe(false)
      const projection = await MessageV2.projectModelMessages(compacted)
      expect(projection.provenance.categories.userMessages.map((item) => item.text)).toEqual([
        "Implement the compact boundary fix.",
      ])
      expect(projection.provenance.categories.injectedContext.map((item) => item.text)).toEqual([
        "Continue if you have next steps",
      ])
      expect(JSON.stringify(projection.provenance)).not.toContain("Large pre-compaction trajectory.")
      expect(JSON.stringify(projection.provenance)).not.toContain("Large trajectory after the first compaction.")
    }))

  test("resolves the compaction anchor from the task root by id", () =>
    runtime.run(() => {
      const sessionID = "ses_test"
      const realUser = testUser({
        id: "msg_real_user",
        sessionID,
        created: 1,
        text: "Polish the account settings UI.",
      })
      // The compaction part now lives on the root itself, so the loop passes the
      // root id as parentID and the anchor is that root's text (issue #281 §7).
      const anchor = SessionCompaction.resolveAnchor([realUser], realUser.info.id)

      expect(anchor).toEqual({
        text: "Polish the account settings UI.",
        sourceMessageID: realUser.info.id,
      })
    }))
  test("isolates auto-compaction from the task root variant", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        auto: true,
        text: "## Goal\n\nContinue the implementation.",
        variant: "high",
      })

      expect(observed.root.info.role === "user" && observed.root.info.variant).toBe("high")
      expect(observed.processUserVariant).toBeUndefined()
    }))

  test("native compaction retains the task variant and schemas without execution callbacks", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({ native: true, variant: "high", text: "Native summary" })
      expect(observed.processUserVariant).toBe("high")
      expect(observed.processInput).toMatchObject({
        toolChoice: "none",
        executionTools: {},
        executorKinds: {},
        activeToolIDs: ["fixture_tool"],
        systemCacheBreakpoint: 1,
        lateSystem: ["runtime context"],
        prepared: { params: { options: { reasoningEffort: "high" } } },
      })
      expect(observed.processInput?.toolDefinitions.map((definition) => definition.id)).toEqual(["fixture_tool"])
      expect(observed.processInput?.promptSuffix).toContain("Write the compaction continuation summary now.")
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "committed" })
      expect(observed.prepareCalls).toHaveLength(0)
    }))

  test("persists compacting hook failures on the handed-off compaction attempt", () =>
    runtime.run(async () => {
      const error = new Error("compacting hook failed")
      const assistantMessageID = Identifier.ascending("message")
      const observed = await runCompactionProcessCase({
        native: true,
        auto: true,
        assistantMessageID,
        beforeCompacting: async () => {
          throw error
        },
      })
      expect(observed.thrown).toBe(error)
      expect(observed.processInput).toBeUndefined()
      expect(observed.attempt.info).toMatchObject({
        id: assistantMessageID,
        agent: "compaction",
        mode: "compaction",
        parentID: observed.root.info.id,
        rootID: observed.root.info.id,
        finish: "error",
        visible: true,
        includeInContext: false,
        metadata: { compactionAttempt: { state: "failed" } },
      })
      expect(observed.attempt.info.time.completed).toBeNumber()
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attemptStates).toEqual([{ state: "running" }, { state: "failed" }])
      expect(observed.messages).toHaveLength(3)
    }))

  for (const stage of ["budget", "processor creation"] as const) {
    test(`settles native compaction ${stage} failures without dispatch or continuation`, () =>
      runtime.run(async () => {
        const error = new Error(`${stage} failed`)
        using measure = spyOn(PromptBudgeter, "measure")
        if (stage === "budget") measure.mockRejectedValue(error)
        const observed = await runCompactionProcessCase({
          native: true,
          auto: true,
          beforeProcessorCreate:
            stage === "processor creation"
              ? () => {
                  throw error
                }
              : undefined,
        })
        expect(observed.thrown).toBe(error)
        expect(observed.processInput).toBeUndefined()
        expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
        expect(observed.attemptStates).toEqual([{ state: "running" }, { state: "failed" }])
        expect(observed.messages).toHaveLength(3)
      }))
  }

  for (const stage of ["session lookup", "attempt persistence", "provider lookup"] as const) {
    test(`owns a handed-off native compaction failure during ${stage}`, () =>
      runtime.run(async () => {
        const error = new Error(`${stage} failed`)
        const assistantMessageID = Identifier.ascending("message")
        using sessionLookup = spyOn(SessionManager, "requireSession")
        let shouldRejectWrite = true
        const observed = await runCompactionProcessCase({
          native: true,
          auto: true,
          assistantMessageID,
          beforeProcess: () => {
            if (stage === "session lookup") sessionLookup.mockRejectedValueOnce(error)
          },
          beforeProviderLookup:
            stage === "provider lookup"
              ? () => {
                  throw error
                }
              : undefined,
          beforeAttemptWrite: async () => {
            if (stage === "attempt persistence" && shouldRejectWrite) {
              shouldRejectWrite = false
              throw error
            }
          },
        })
        expect(observed.thrown).toBe(error)
        expect(observed.processInput).toBeUndefined()
        expect(observed.attempt.info).toMatchObject({
          id: assistantMessageID,
          agent: "compaction",
          mode: "compaction",
          finish: "error",
          includeInContext: false,
          metadata: { compactionAttempt: { state: "failed" } },
        })
        expect(observed.messages).toHaveLength(3)
      }))
  }

  test("prepares a cold native request exactly once inside the compaction owner", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        native: true,
        cold: true,
        text: "Cold summary",
        preparedMessages: [
          { role: "user", content: "materialized root" },
          { role: "assistant", content: "materialized history ".repeat(600) },
        ],
      })
      expect(observed.prepareCalls).toHaveLength(1)
      expect(observed.prepareCalls[0][0]).toMatchObject({
        toolChoice: "none",
        sessionID: observed.root.info.sessionID,
      })
      expect(observed.processInput?.prepared?.system).toEqual(["stable final system"])
      expect(observed.processInput?.messages).toEqual([
        { role: "user", content: "materialized root" },
        { role: "assistant", content: "materialized history ".repeat(600) },
      ])
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "committed" })
    }))

  for (const stage of ["preparation", "compacting hook"] as const) {
    test(`bounds a non-cooperative native ${stage} and rejects its late completion`, () =>
      runtime.run(async () => {
        const release = Promise.withResolvers<void>()
        using deadline = compactionDeadline()
        try {
          const observed = await runCompactionProcessCase({
            native: true,
            cold: stage === "preparation",
            auto: true,
            invokeMs: deadline.invokeMs,
            text: "Late summary must not commit",
            beforePrepare:
              stage === "preparation"
                ? () => {
                    deadline.expire()
                    return release.promise
                  }
                : undefined,
            beforeCompacting:
              stage === "compacting hook"
                ? () => {
                    deadline.expire()
                    return release.promise
                  }
                : undefined,
            afterProcess: async () => {
              release.resolve()
              await Bun.sleep(0)
            },
          })
          expect(observed.thrown).toMatchObject({ name: "AbortError" })
          expect(String(observed.thrown)).toContain(`timed out after ${deadline.invokeMs}ms`)
          expect(observed.processInput).toBeUndefined()
          expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
          expect(observed.attempt.info.finish).toBe("error")
          expect(observed.attempt.info.summary).toBeUndefined()
          expect(observed.attempt.info.includeInContext).toBe(false)
          expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
          expect(observed.messages).toHaveLength(3)
          if (stage === "preparation") expect(observed.prepareCalls[0][0].abort.aborted).toBe(true)
        } finally {
          release.resolve()
        }
      }))
  }

  test("restores the failed deadline attempt after a non-cooperative processor writes late", () =>
    runtime.run(async () => {
      const release = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      using deadline = compactionDeadline()
      try {
        const observed = await runCompactionProcessCase({
          native: true,
          auto: true,
          invokeMs: deadline.invokeMs,
          text: "Late processor output",
          beforeLocal: () => {
            deadline.expire()
            return release.promise
          },
          onProcessorSettled: () => settled.resolve(),
          afterProcess: async () => {
            release.resolve()
            await settled.promise
            await Bun.sleep(0)
          },
        })
        expect(observed.thrown).toMatchObject({ name: "AbortError" })
        expect(observed.processInput?.abort.aborted).toBe(true)
        expect(observed.attempt.info).toMatchObject({
          finish: "error",
          metadata: { compactionAttempt: { state: "failed" } },
          includeInContext: false,
        })
        expect(observed.attempt.info.summary).toBeUndefined()
        expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
        expect(observed.messages).toHaveLength(3)
      } finally {
        release.resolve()
      }
    }))

  test("propagates session cancellation through a hanging native hook with invoke deadline disabled", () =>
    runtime.run(async () => {
      const abort = new AbortController()
      const release = Promise.withResolvers<void>()
      const observed = await runCompactionProcessCase({
        native: true,
        auto: true,
        invokeMs: 0,
        abort,
        beforeCompacting: async () => {
          abort.abort(new DOMException("Session cancelled", "AbortError"))
          await release.promise
        },
        afterProcess: async () => {
          release.resolve()
          await Bun.sleep(0)
        },
      })
      expect(observed.result).toBe("stop")
      expect(observed.processInput).toBeUndefined()
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
      expect(observed.messages).toHaveLength(3)
    }))

  test("disables the native invoke deadline at zero", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        native: true,
        auto: true,
        invokeMs: 0,
        beforeCompacting: () => Bun.sleep(25),
        text: "Summary with no deadline",
      })
      expect(observed.thrown).toBeUndefined()
      expect(observed.result).toBe("continue")
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "committed" })
    }))

  test("does not commit a native summary when its final storage write crosses the deadline", () =>
    runtime.run(async () => {
      using deadline = compactionDeadline()
      const observed = await runCompactionProcessCase({
        native: true,
        auto: true,
        invokeMs: deadline.invokeMs,
        text: "Summary that misses finalization deadline",
        beforeSummaryCommit: async () => deadline.expire(),
      })
      expect(observed.thrown).toMatchObject({ name: "AbortError" })
      expect(observed.attempt.info.finish).toBe("error")
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
      expect(observed.messages).toHaveLength(3)
    }))

  for (const scenario of ["cancelled", "tool output"] as const) {
    test(`does not commit native compaction with ${scenario}`, () =>
      runtime.run(async () => {
        const abort = new AbortController()
        const observed = await runCompactionProcessCase({
          native: true,
          auto: true,
          abort,
          text: "Unusable summary",
          toolOutput: scenario === "tool output",
          beforeLocal: scenario === "cancelled" ? async () => abort.abort() : undefined,
        })
        expect(observed.result).toBe("stop")
        expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
        expect(observed.attempt.info.summary).toBeUndefined()
        expect(observed.attempt.info.includeInContext).toBe(false)
        expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
        expect(observed.messages.some((message) => message.info.role === "user" && !message.info.isRoot)).toBe(false)
      }))
  }

  test("preserves history when the fixed envelope cannot fit", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        native: true,
        modelLimit: { context: 16_000, output: 8_192 },
        historyText: "oversized recent message ".repeat(10_000),
      })
      expect(observed.processInput).toBeUndefined()
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
    }))

  test("bounds compaction output instead of requesting the model long-output maximum", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({ text: "## Goal\n\nContinue the implementation." })

      expect(observed.processMaxOutputTokens).toBe(8_192)
    }))

  test("caps compaction output at 32k for long-output models", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({
        text: "## Goal\n\nContinue the implementation.",
        modelLimit: { context: 1_048_576, output: 384_000 },
      })

      expect(observed.processMaxOutputTokens).toBe(32_000)
    }))

  test("keeps provider failures as uncommitted compaction attempts", () =>
    runtime.run(async () => {
      const apiKey = ["s", "k-test-secret-12345678"].join("")
      const responseApiKey = ["s", "k-body-secret-12345678"].join("")
      const error = new MessageV2.APIError({
        message: `Incorrect API key provided: ${apiKey}`,
        isRetryable: false,
        responseHeaders: { "set-cookie": "session=secret" },
        responseBody: JSON.stringify({ api_key: responseApiKey }),
      }).toObject()

      const observed = await runCompactionProcessCase({ error })

      expect(observed.result).toBe("stop")
      expect(observed.initialSummary).toBeUndefined()
      expect(observed.initialIncludeInContext).toBe(false)
      expect(observed.initialVisible).toBe(false)
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.info.includeInContext).toBe(false)
      expect(observed.attempt.info.visible).toBe(true)
      expect(observed.attempt.info.finish).toBe("error")
      expect(observed.attempt.info.time.completed).toBeNumber()
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
      expect(observed.attemptStates).toEqual([{ state: "running" }, { state: "running" }, { state: "failed" }])
      expect(observed.attempt.info.error).toEqual(
        new MessageV2.APIError({
          message: "Incorrect API key provided: [redacted]",
          isRetryable: false,
        }).toObject(),
      )
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
      expect(
        SessionCompaction.hasPendingCompaction(observed.root.parts, [observed.attempt], observed.root.info.id),
      ).toBe(true)
      expect(Turn.collect([observed.root, observed.attempt])[0]?.assistants).toEqual([observed.attempt])
      expect(Turn.collect([observed.root, observed.attempt], { skipSynthetic: true })[0]?.assistants).toEqual([])
    }))

  test("marks unexpected processor exceptions as failed before propagating them", () =>
    runtime.run(async () => {
      const apiKey = ["s", "k-unexpected-secret-12345678"].join("")
      const error = new Error(`processor crashed: ${apiKey}`)

      const observed = await runCompactionProcessCase({ thrownError: error })

      expect(observed.thrown).toBe(error)
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.info.includeInContext).toBe(false)
      expect(observed.attempt.info.visible).toBe(true)
      expect(observed.attempt.info.finish).toBe("error")
      expect(observed.attempt.info.time.completed).toBeNumber()
      expect(observed.attempt.info.error).toMatchObject({
        name: "UnknownError",
        data: { message: "Error: processor crashed: [redacted]" },
      })
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
      expect(observed.attemptStates).toEqual([{ state: "running" }, { state: "failed" }])
    }))

  test("does not commit an empty compaction response", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({})

      expect(observed.result).toBe("stop")
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.info.includeInContext).toBe(false)
      expect(observed.attempt.info.visible).toBe(false)
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "empty" })
      expect(observed.attemptStates).toEqual([{ state: "running" }, { state: "running" }, { state: "empty" }])
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
      expect(
        SessionCompaction.hasPendingCompaction(observed.root.parts, [observed.attempt], observed.root.info.id),
      ).toBe(true)
    }))

  test("promotes a completed LLM compaction to a summary boundary", () =>
    runtime.run(async () => {
      const observed = await runCompactionProcessCase({ text: "## Goal\n\nContinue the implementation." })

      expect(observed.result).toBe("stop")
      expect(observed.initialSummary).toBeUndefined()
      expect(observed.initialIncludeInContext).toBe(false)
      expect(observed.attempt.info.summary).toBe(true)
      expect(observed.attempt.info.finish).toBe("stop")
      expect(observed.attempt.info.visible).toBe(true)
      expect(observed.attempt.info.includeInContext).toBe(true)
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "committed" })
      expect(observed.attemptStates).toEqual([{ state: "running" }, { state: "running" }, { state: "committed" }])
      expect(observed.attempt.info.error).toBeUndefined()
      expect(observed.attempt.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "compaction_recovery",
            summary: "## Goal\n\nContinue the implementation.",
            mechanical: false,
            validated: true,
          }),
        ]),
      )
      expect(
        SessionCompaction.hasPendingCompaction(observed.root.parts, [observed.attempt], observed.root.info.id),
      ).toBe(false)
    }))

  test("retains history when even the smallest prefix exceeds provider context", () =>
    runtime.run(async () => {
      const error = new MessageV2.APIError({ message: "context_length_exceeded", isRetryable: false }).toObject()
      const observed = await runCompactionProcessCase({ error })
      expect(observed.result).toBe("stop")
      expect(observed.attempt.info.summary).toBeUndefined()
      expect(observed.attempt.info.includeInContext).toBe(false)
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "failed" })
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
    }))
})

describe("remote compaction rollout", () => {
  test("cancels an obsolete remote range before attaching a smaller successful candidate", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      const started = Promise.withResolvers<void>()
      let calls = 0
      let cancelled = false
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockImplementation(async (request) => {
        if (++calls === 1) {
          started.resolve()
          try {
            await new Promise<never>((_resolve, reject) => {
              if (request.signal?.aborted) return reject(request.signal.reason)
              request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
            })
          } finally {
            cancelled = true
          }
        }
        expect(cancelled).toBe(true)
        return { compactionItem: { type: "compaction", encrypted_content: "smaller-prefix" } }
      })
      const observed = await runCompactionProcessCase({
        providerID: CodexProvider.PROVIDER_ID,
        native: true,
        modelLimit: { context: 40_000, output: 2_000 },
        historyChunks: Array.from({ length: 4 }, (_, index) => `history-${index}: ${"observed details ".repeat(2400)}`),
        overflowAttempts: 1,
        beforeLocal: () => started.promise,
        text: "Valid smaller summary",
      })
      expect(observed.thrown).toBeUndefined()
      expect(remote).toHaveBeenCalledTimes(2)
      expect(remote.mock.calls[1][0].items.length).toBeLessThan(remote.mock.calls[0][0].items.length)
      expect(observed.calls.map((call) => call.status)).toEqual(["cancelled", "completed"])
      expect(observed.attempt.info.metadata?.remoteCompaction).toMatchObject({
        coveredThrough: observed.attempt.info.compaction?.coveredThrough,
        replacementHistory: expect.arrayContaining([{ type: "compaction", encrypted_content: "smaller-prefix" }]),
      })
    }))

  test("chains a remote artifact with retained messages that precede its local summary", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockResolvedValue({
        compactionItem: { type: "compaction", encrypted_content: "covered-prefix" },
      })
      const chunks = Array.from({ length: 4 }, (_, index) => `history-${index}: ${"observed details ".repeat(2400)}`)
      const observed = await runCompactionProcessCase({
        providerID: CodexProvider.PROVIDER_ID,
        native: true,
        rounds: 2,
        historyChunks: chunks,
        text: "Local prefix summary",
      })
      expect(observed.thrown).toBeUndefined()
      expect(remote).toHaveBeenCalledTimes(2)
      const second = JSON.stringify(remote.mock.calls[1][0].items)
      expect(second).toContain("covered-prefix")
      expect(second).toContain("history-1:")
      expect(second).not.toContain("history-2:")
      expect(second).not.toContain("Continue this task after compaction.")
      expect(observed.attempt.info.metadata?.remoteCompaction.coveredThrough).toEqual(
        observed.attempt.info.compaction?.coveredThrough,
      )
      expect(
        observed.workingSet.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === chunks[2]),
        ),
      ).toBe(true)
    }))

  test("awaits remote evidence and attributes the call to the source root", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      let finished = false
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockImplementation(async (input) => {
        const response = await RolloutTransport.fetch(
          async (request) => {
            await (request as Request).text()
            return Response.json({ summary: "opaque" })
          },
          "https://provider.test/compact",
          { method: "POST", body: JSON.stringify(input.items) },
        )
        await response.json()
        finished = true
        return {
          compactionItem: { type: "compaction", encrypted_content: "opaque" },
          usage: { input: 5, output: 2, cacheRead: 0, totalTokens: 7 },
        }
      })
      const observed = await runCompactionProcessCase({ providerID: CodexProvider.PROVIDER_ID, text: "Local summary" })
      expect(observed.thrown).toBeUndefined()
      expect(finished).toBe(true)
      expect(observed.calls).toHaveLength(1)
      expect(observed.calls[0]).toMatchObject({
        runID: observed.root.info.id,
        purpose: "remote_compaction",
        status: "completed",
        transportCaptured: true,
      })
      expect(observed.attempt.info.metadata?.remoteCompaction).toMatchObject({
        summaryText: "Local summary",
        providerID: CodexProvider.PROVIDER_ID,
        modelID: "test-model",
        profileID: CodexProvider.PROVIDER_ID,
        apiModelID: "test-model-wire",
      })
      expect(observed.attempt.info.metadata?.remoteCompaction?.replacementHistory.at(-1)).toEqual({
        type: "compaction",
        encrypted_content: "opaque",
      })
      expect(
        observed.messages.filter((message) => message.info.role === "assistant" && message.info.mode === "compaction"),
      ).toHaveLength(1)
    }))

  test("persists named connection identity and replays through a compatible catalog alias", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockResolvedValue({
        compactionItem: { type: "compaction", encrypted_content: "named-opaque" },
      })
      const observed = await runCompactionProcessCase({
        providerID: "codex-work",
        replayModelID: "compatible-alias",
        text: "Local summary",
      })
      expect(observed.thrown).toBeUndefined()
      expect(remote).toHaveBeenCalledWith(
        expect.objectContaining({ providerID: "codex-work", modelID: "test-model-wire" }),
      )
      expect(observed.calls).toHaveLength(1)
      expect(observed.attempt.info.metadata?.remoteCompaction).toMatchObject({
        modelKey: "codex-work/test-model",
        providerID: "codex-work",
        modelID: "test-model",
        profileID: CodexProvider.PROVIDER_ID,
        apiModelID: "test-model-wire",
        summaryText: "Local summary",
      })
      expect(observed.attempt.info.metadata?.remoteCompaction?.replacementHistory.at(-1)).toEqual({
        type: "compaction",
        encrypted_content: "named-opaque",
      })
      expect(observed.replayPlan).toMatchObject({
        summaryText: "Local summary",
        replacementHistory: expect.arrayContaining([{ type: "compaction", encrypted_content: "named-opaque" }]),
      })
    }))

  test("cancels and drains remote work when the local summary fails", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      const started = Promise.withResolvers<void>()
      let settled = false
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockImplementation(async (input) => {
        started.resolve()
        try {
          await new Promise<never>((_resolve, reject) => {
            if (input.signal?.aborted) return reject(input.signal.reason)
            input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true })
          })
          throw new Error("unreachable")
        } finally {
          settled = true
        }
      })
      const error = new Error("local summary failed")
      const observed = await runCompactionProcessCase({
        providerID: CodexProvider.PROVIDER_ID,
        beforeLocal: () => started.promise,
        thrownError: error,
      })
      expect(observed.thrown).toBe(error)
      expect(settled).toBe(true)
      expect(observed.calls[0].status).toBe("cancelled")
    }))

  test("cancels a hanging remote history transform without dispatching a late provider call", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      using deadline = compactionDeadline()
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2")
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let released = false
      let returnedBeforeRelease = false
      let hookSignal: AbortSignal | undefined
      const rescue = setTimeout(() => {
        released = true
        release.resolve()
      }, 1_000)
      try {
        const observed = await runCompactionProcessCase({
          native: true,
          auto: true,
          invokeMs: deadline.invokeMs,
          providerID: CodexProvider.PROVIDER_ID,
          beforeHistoryTransform: (signal) => {
            hookSignal = signal
            started.resolve()
            return release.promise
          },
          beforeLocal: () => started.promise,
          text: "Committed before remote preparation cancellation",
          afterSummaryCommit: () => setTimeout(() => deadline.expire(), 0),
          afterProcess: async () => {
            returnedBeforeRelease = !released
            release.resolve()
            await Bun.sleep(0)
          },
        })
        expect(returnedBeforeRelease).toBe(true)
        expect(observed.thrown).toMatchObject({ name: "AbortError" })
        expect(hookSignal?.aborted).toBe(true)
        expect(remote).not.toHaveBeenCalled()
        expect(observed.calls).toHaveLength(0)
        expect(observed.attempt.info).toMatchObject({
          summary: true,
          includeInContext: true,
          metadata: { compactionAttempt: { state: "committed" } },
        })
        expect(observed.messages).toHaveLength(3)
      } finally {
        clearTimeout(rescue)
        release.resolve()
      }
    }))

  test("keeps the committed summary but omits continuation when the operation deadline expires waiting for remote work", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      using deadline = compactionDeadline()
      const started = Promise.withResolvers<void>()
      let isDrained = false
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockImplementation(async (request) => {
        started.resolve()
        try {
          await new Promise<never>((_resolve, reject) => {
            if (request.signal?.aborted) return reject(request.signal.reason)
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
          })
          throw new Error("unreachable")
        } finally {
          isDrained = true
        }
      })
      const observed = await runCompactionProcessCase({
        native: true,
        auto: true,
        invokeMs: deadline.invokeMs,
        providerID: CodexProvider.PROVIDER_ID,
        beforeLocal: () => started.promise,
        text: "Authoritative committed summary",
        afterSummaryCommit: () => setTimeout(() => deadline.expire(), 0),
      })
      expect(observed.thrown).toMatchObject({ name: "AbortError" })
      expect(String(observed.thrown)).toContain(`timed out after ${deadline.invokeMs}ms`)
      expect(isDrained).toBe(true)
      expect(observed.calls[0].status).toBe("cancelled")
      expect(observed.attempt.info).toMatchObject({
        summary: true,
        finish: "stop",
        includeInContext: true,
        metadata: { compactionAttempt: { state: "committed" } },
      })
      expect(observed.attempt.info.error).toBeUndefined()
      expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(true)
      expect(observed.messages).toHaveLength(3)
    }))

  test("keeps a committed local summary when optional remote provider work fails", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockRejectedValue(
        new Error("remote unavailable"),
      )
      const observed = await runCompactionProcessCase({
        native: true,
        auto: true,
        providerID: CodexProvider.PROVIDER_ID,
        text: "Authoritative local summary",
      })
      expect(observed.thrown).toBeUndefined()
      expect(observed.result).toBe("continue")
      expect(observed.attempt.info.summary).toBe(true)
      expect(observed.attempt.info.error).toBeUndefined()
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "committed" })
      expect(observed.attempt.info.metadata?.remoteCompaction).toBeUndefined()
      expect(observed.messages).toHaveLength(4)
    }))

  test("does not downgrade a remote recording failure to optional metadata", () =>
    runtime.run(async () => {
      using config = spyOn(Config, "current").mockResolvedValue({ compaction: { codexRemote: true } } as Config.Info)
      using write = spyOn(Storage, "prepareBinary").mockRejectedValue(new Error("disk full"))
      using remote = spyOn(CodexProvider, "requestRemoteCompactionV2").mockImplementation(async () => {
        throw new Error("must not issue request")
      })
      const observed = await runCompactionProcessCase({ providerID: CodexProvider.PROVIDER_ID, text: "Local summary" })
      expect(observed.thrown).toMatchObject({ name: "RolloutRecordingError" })
      expect(write).toHaveBeenCalled()
      expect(remote).not.toHaveBeenCalled()
      expect(observed.result).toBeUndefined()
      expect(observed.attempt.info.metadata?.compactionAttempt).toEqual({ state: "committed" })
      expect(observed.attempt.info.summary).toBe(true)
      expect(observed.attempt.info.finish).toBe("stop")
    }))
})

afterRuntimeTests(() => runtime.close())
