import { describe, expect, test, mock } from "bun:test"
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

Log.init({ print: false })

class CompactionIntercept extends Error {
  constructor() {
    super("compaction part injected")
  }
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
      ;(Config.current as any) = mock(async () => ({
        ...(await originalConfigCurrent()),
        compaction: { auto: true, maxHistoryImages: 8 },
      }))
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

          await expect(SessionInvoke.loop.force(sessionID)).rejects.toBeInstanceOf(CompactionIntercept)

          expect(interceptedCompactionParts).toHaveLength(1)
          const [compactionPart] = interceptedCompactionParts
          expect(compactionPart.sessionID).toBe(sessionID)
          expect(compactionPart.auto).toBe(true)
          expect(compactionPart.messageID).not.toBe(user.id)

          const boundary = await MessageV2.get({ sessionID, messageID: compactionPart.messageID })
          expect(boundary.info?.role).toBe("user")
          if (boundary.info?.role !== "user") throw new Error("expected compaction boundary user")
          expect(boundary.info.summary?.title).toBe("Compaction requested")
          expect(boundary.info.metadata?.synthetic).toBe(true)
          expect(boundary.info.metadata?.compactionBoundary).toBe(true)
          expect(boundary.info.metadata?.compactionParentID).toBe(user.id)
          expect(boundary.parts).toEqual([
            expect.objectContaining({
              type: "compaction",
              auto: true,
              messageID: compactionPart.messageID,
            }),
          ])
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
      ;(Config.current as any) = mock(async () => ({
        ...(await originalConfigCurrent()),
        compaction: { auto: true, maxHistoryImages: 8 },
      }))
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
      ;(Config.current as any) = mock(async () => ({
        ...(await originalConfigCurrent()),
        compaction: { auto: true, maxHistoryImages: 8 },
      }))
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

  test("resolves the compaction anchor from the real user before a synthetic boundary", () => {
    const sessionID = "ses_test"
    const realUser = testUser({
      id: "msg_real_user",
      sessionID,
      created: 1,
      text: "Polish the account settings UI.",
    })
    const boundary = testUser({
      id: "msg_boundary",
      sessionID,
      created: 2,
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

    const anchor = SessionCompaction.resolveAnchor([realUser, boundary], boundary.info.id)

    expect(anchor).toEqual({
      text: "Polish the account settings UI.",
      sourceMessageID: realUser.info.id,
    })
  })
})
