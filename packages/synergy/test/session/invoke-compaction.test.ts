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

Log.init({ print: false })

class CompactionIntercept extends Error {
  constructor() {
    super("compaction part injected")
  }
}

describe("SessionInvoke preflight compaction", () => {
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
      ;(Provider.getModel as any) = mock(async () => ({
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
      }))
      ;(Agent.get as any) = mock(async () => ({
        name: "synergy",
        mode: "primary",
        permission: PermissionNext.fromConfig({ "*": "allow" }),
        options: {},
      }))
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

          expect(interceptedCompactionParts).toEqual([
            {
              messageID: user.id,
              sessionID,
              auto: true,
            },
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
      ;(Provider.getModel as any) = mock(async () => ({
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
      }))
      ;(Agent.get as any) = mock(async () => ({
        name: "synergy",
        mode: "primary",
        permission: PermissionNext.fromConfig({ "*": "allow" }),
        options: {},
      }))
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
})
