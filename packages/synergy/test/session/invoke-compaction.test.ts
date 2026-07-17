import { afterAll, beforeAll, describe, expect, test, mock } from "bun:test"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionProcessor } from "../../src/session/processor"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { ToolResolver } from "../../src/session/tool-resolver"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Cortex } from "../../src/cortex/manager"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"
import { Config } from "../../src/config/config"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { Embedding } from "../../src/vector/embedding"
import { Plugin } from "../../src/plugin"
import { Turn } from "../../src/session/turn"

Log.init({ print: false })

const originalEmbeddingGenerate = Embedding.generate

beforeAll(() => {
  ;(Embedding.generate as any) = mock(async (input: Parameters<typeof Embedding.generate>[0]) => ({
    id: input.id,
    vector: [],
    model: "test-embedding",
  }))
})

afterAll(() => {
  ;(Embedding.generate as any) = originalEmbeddingGenerate
})

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

function testModel() {
  return {
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
    agent: "synergy",
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
    ...(input.summary ? { summary: true } : {}),
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

async function runCompactionProcessCase(input: { error?: MessageV2.Assistant["error"]; text?: string }) {
  await using tmp = await tmpdir({ git: true })

  const originalGetModel = Provider.getModel
  const originalGetAgent = Agent.get
  const originalGetAvailableModel = Agent.getAvailableModel
  const originalProcessorCreate = SessionProcessor.create
  const originalPluginTrigger = Plugin.trigger

  let initialSummary: boolean | undefined
  let initialIncludeInContext: boolean | undefined
  let initialVisible: boolean | undefined

  try {
    ;(Provider.getModel as any) = mock(async () => testModel())
    ;(Agent.get as any) = mock(async () => primaryAgent())
    ;(Agent.getAvailableModel as any) = mock(async () => ({
      providerID: "test-provider",
      modelID: "test-model",
    }))
    ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
    ;(SessionProcessor.create as any) = mock((processorInput: Parameters<typeof SessionProcessor.create>[0]) => {
      initialSummary = processorInput.assistantMessage.summary
      initialIncludeInContext = processorInput.assistantMessage.includeInContext
      initialVisible = processorInput.assistantMessage.visible
      return {
        message: processorInput.assistantMessage,
        partFromToolCall: () => undefined,
        trackExecution: () => {},
        process: mock(async () => {
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
          if (input.error) processorInput.assistantMessage.error = input.error
          else processorInput.assistantMessage.finish = "stop"
          processorInput.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(processorInput.assistantMessage)
          return "stop" as const
        }),
      }
    })

    return await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test-provider", modelID: "test-model" },
          time: { created: Date.now() },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "Continue this task after compaction.",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
        })

        const before = await Session.messages({ sessionID: session.id })
        const result = await SessionCompaction.process({
          parentID: user.id,
          messages: before,
          sessionID: session.id,
          abort: new AbortController().signal,
          auto: false,
        })
        const after = await Session.messages({ sessionID: session.id })
        const attempt = after.find(
          (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
            message.info.role === "assistant" && message.info.mode === "compaction",
        )
        if (!attempt) throw new Error("compaction attempt was not persisted")
        const root = after.find((message) => message.info.id === user.id)
        if (!root) throw new Error("compaction root was not persisted")

        return { result, attempt, root, initialSummary, initialIncludeInContext, initialVisible }
      },
    })
  } finally {
    ;(Provider.getModel as any) = originalGetModel
    ;(Agent.get as any) = originalGetAgent
    ;(Agent.getAvailableModel as any) = originalGetAvailableModel
    ;(SessionProcessor.create as any) = originalProcessorCreate
    ;(Plugin.trigger as any) = originalPluginTrigger
  }
}

describe.serial("SessionInvoke preflight compaction", () => {
  test("injects a compaction part before main inference when prompt budget is exceeded", async () => {
    await using tmp = await tmpdir({ git: true })

    const originalGetModel = Provider.getModel
    const originalGetAgent = Agent.get
    const originalConfigCurrent = Config.current
    const originalDefinitions = ToolResolver.definitions
    const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
    const originalBuildPlan = PromptBudgeter.buildPlan
    const originalDecide = PromptBudgeter.decide
    const originalProcessorCreate = SessionProcessor.create
    const originalUpdatePart = Session.updatePart
    const originalCortexList = Cortex.list
    const originalCortexGetRunningTasks = Cortex.getRunningTasks

    const processCalled = mock(async () => "stop" as const)
    const interceptedCompactionParts: Array<{ messageID: string; sessionID: string; auto: boolean }> = []

    try {
      ;(Provider.getModel as any) = mock(async () => testModel())
      ;(Agent.get as any) = mock(async () => primaryAgent())
      ;(Config.current as any) = mock(async () => fastLoopTestConfig(originalConfigCurrent))
      ;(ToolResolver.definitions as any) = mock(async () => [])
      ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({ tools: {}, activeToolIDs: [] }))
      ;(PromptBudgeter.buildPlan as any) = mock(async () => ({
        system: ["stub system"],
        messages: [{ role: "user", content: "stub message" }],
        toolDefinitions: [],
      }))
      ;(PromptBudgeter.decide as any) = mock(async () => ({
        budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
        measure: { system: 10, messages: 10, tools: 0, total: 90_000 },
        shouldCompact: true,
      }))
      ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
        message: input.assistantMessage,
        partFromToolCall: () => undefined,
        trackExecution: () => {},
        process: processCalled,
      }))
      ;(Session.updatePart as any) = mock(async (input: Parameters<typeof Session.updatePart>[0]) => {
        if ("type" in input && input.type === "compaction") {
          await originalUpdatePart(input as any)
          interceptedCompactionParts.push({
            messageID: input.messageID,
            sessionID: input.sessionID,
            auto: input.auto,
          })
          throw new CompactionIntercept()
        }
        return await originalUpdatePart(input as any)
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
            agent: "synergy",
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
          // The compaction part is attached to the task root R (= the user
          // message here), not a separate synthetic boundary (issue #281 §7).
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
      ;(ToolResolver.definitions as any) = originalDefinitions
      ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
      ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
      ;(PromptBudgeter.decide as any) = originalDecide
      ;(SessionProcessor.create as any) = originalProcessorCreate
      ;(Session.updatePart as any) = originalUpdatePart
      ;(Cortex.list as any) = originalCortexList
      ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
    }
  })

  test("refreshes session state between model steps", async () => {
    await using tmp = await tmpdir({ git: true })

    const originalGetModel = Provider.getModel
    const originalGetAgent = Agent.get
    const originalConfigCurrent = Config.current
    const originalDefinitions = ToolResolver.definitions
    const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
    const originalBuildPlan = PromptBudgeter.buildPlan
    const originalDecide = PromptBudgeter.decide
    const originalProcessorCreate = SessionProcessor.create
    const originalCortexList = Cortex.list
    const originalCortexGetRunningTasks = Cortex.getRunningTasks

    const definitionToolStates: Array<Session.Info["toolState"]> = []
    let processCount = 0

    try {
      ;(Provider.getModel as any) = mock(async () => testModel())
      ;(Agent.get as any) = mock(async () => primaryAgent())
      ;(Config.current as any) = mock(async () => fastLoopTestConfig(originalConfigCurrent))
      ;(ToolResolver.definitions as any) = mock(async (input: Parameters<typeof ToolResolver.definitions>[0]) => {
        definitionToolStates.push(input.session?.toolState)
        return []
      })
      ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({ tools: {}, activeToolIDs: [] }))
      ;(PromptBudgeter.buildPlan as any) = mock(async () => ({
        system: ["stub system"],
        messages: [{ role: "user", content: "stub message" }],
        toolDefinitions: [],
      }))
      ;(PromptBudgeter.decide as any) = mock(async () => ({
        budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
        measure: { system: 10, messages: 10, tools: 0, total: 20 },
        shouldCompact: false,
      }))
      ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
        message: input.assistantMessage,
        partFromToolCall: () => undefined,
        trackExecution: () => {},
        process: mock(async () => {
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
            agent: "synergy",
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
        },
      })
    } finally {
      ;(Provider.getModel as any) = originalGetModel
      ;(Agent.get as any) = originalGetAgent
      ;(Config.current as any) = originalConfigCurrent
      ;(ToolResolver.definitions as any) = originalDefinitions
      ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
      ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
      ;(PromptBudgeter.decide as any) = originalDecide
      ;(SessionProcessor.create as any) = originalProcessorCreate
      ;(Cortex.list as any) = originalCortexList
      ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
    }
  })

  test("does not reuse token calibration across a completed compaction boundary", async () => {
    await using tmp = await tmpdir({ git: true })

    const originalGetModel = Provider.getModel
    const originalGetAgent = Agent.get
    const originalConfigCurrent = Config.current
    const originalDefinitions = ToolResolver.definitions
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
      ;(ToolResolver.definitions as any) = mock(async () => [])
      ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({ tools: {}, activeToolIDs: [] }))
      ;(PromptBudgeter.buildPlan as any) = mock(async () => ({
        system: ["stub system"],
        messages: [{ role: "user", content: "stub message" }],
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
            agent: "synergy",
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
            mode: "synergy",
            agent: "synergy",
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
            agent: "synergy",
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

          expect(decideOptions).toHaveLength(1)
          expect(decideOptions[0]?.calibration).toBeUndefined()
          expect(interceptedCompactionParts).toEqual([])
          expect(processCount).toBe(1)
        },
      })
    } finally {
      ;(Provider.getModel as any) = originalGetModel
      ;(Agent.get as any) = originalGetAgent
      ;(Config.current as any) = originalConfigCurrent
      ;(ToolResolver.definitions as any) = originalDefinitions
      ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
      ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
      ;(PromptBudgeter.decide as any) = originalDecide
      ;(SessionProcessor.create as any) = originalProcessorCreate
      ;(Session.updatePart as any) = originalUpdatePart
      ;(Cortex.list as any) = originalCortexList
      ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
    }
  })

  test("filters compacted history from the synthetic auto-compaction boundary", async () => {
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
  })

  test("filters repeated root-anchored auto-compactions to the latest summary", async () => {
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
    const projection = MessageV2.projectModelMessages(compacted)
    expect(projection.provenance.categories.conversation).toEqual([{ text: "Implement the compact boundary fix." }])
    expect(projection.provenance.categories.instructions).toEqual([{ text: "Continue if you have next steps" }])
    expect(JSON.stringify(projection.provenance)).not.toContain("Large pre-compaction trajectory.")
    expect(JSON.stringify(projection.provenance)).not.toContain("Large trajectory after the first compaction.")
  })

  test("resolves the compaction anchor from the task root by id", () => {
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
  })
  test("keeps provider failures as uncommitted compaction attempts", async () => {
    const error = new MessageV2.APIError({ message: "quota exhausted", isRetryable: false }).toObject()

    const observed = await runCompactionProcessCase({ error })

    expect(observed.result).toBe("stop")
    expect(observed.initialSummary).toBeUndefined()
    expect(observed.initialIncludeInContext).toBe(false)
    expect(observed.initialVisible).toBe(false)
    expect(observed.attempt.info.summary).toBeUndefined()
    expect(observed.attempt.info.includeInContext).toBe(false)
    expect(observed.attempt.info.visible).toBe(false)
    expect(observed.attempt.info.error).toEqual(error)
    expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
    expect(SessionCompaction.hasPendingCompaction(observed.root.parts, [observed.attempt], observed.root.info.id)).toBe(
      true,
    )
    expect(Turn.collect([observed.root, observed.attempt], { skipSynthetic: true })[0]?.assistants).toHaveLength(0)
  })

  test("does not commit an empty compaction response", async () => {
    const observed = await runCompactionProcessCase({})

    expect(observed.result).toBe("stop")
    expect(observed.attempt.info.summary).toBeUndefined()
    expect(observed.attempt.info.includeInContext).toBe(false)
    expect(observed.attempt.info.visible).toBe(false)
    expect(observed.attempt.parts.some((part) => part.type === "compaction_recovery")).toBe(false)
    expect(SessionCompaction.hasPendingCompaction(observed.root.parts, [observed.attempt], observed.root.info.id)).toBe(
      true,
    )
  })

  test("promotes a completed LLM compaction to a summary boundary", async () => {
    const observed = await runCompactionProcessCase({ text: "## Goal\n\nContinue the implementation." })

    expect(observed.result).toBe("stop")
    expect(observed.initialSummary).toBeUndefined()
    expect(observed.initialIncludeInContext).toBe(false)
    expect(observed.attempt.info.summary).toBe(true)
    expect(observed.attempt.info.finish).toBe("stop")
    expect(observed.attempt.info.visible).toBe(true)
    expect(observed.attempt.info.includeInContext).toBe(true)
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
    expect(SessionCompaction.hasPendingCompaction(observed.root.parts, [observed.attempt], observed.root.info.id)).toBe(
      false,
    )
  })

  test("promotes a mechanical fallback to a summary boundary", async () => {
    const error = new MessageV2.APIError({
      message: "context_length_exceeded",
      isRetryable: false,
    }).toObject()

    const observed = await runCompactionProcessCase({ error })
    expect(observed.result).toBe("stop")

    expect(observed.initialSummary).toBeUndefined()
    expect(observed.attempt.info.summary).toBe(true)
    expect(observed.attempt.info.finish).toBe("stop")
    expect(observed.attempt.info.visible).toBe(true)
    expect(observed.attempt.info.includeInContext).toBe(true)
    expect(observed.attempt.info.error).toBeUndefined()
    expect(observed.attempt.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "compaction_recovery", mechanical: true, validated: false }),
      ]),
    )
  })
})
