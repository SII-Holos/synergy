import { describe, expect, test, mock } from "bun:test"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionProcessor } from "../../src/session/processor"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { ToolResolver } from "../../src/session/tool-resolver"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { GenesisChannel } from "../../src/channel/genesis"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/scope/instance"
import { Cortex } from "../../src/cortex/manager"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"

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
    const originalDefinitions = ToolResolver.definitions
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
      ;(ToolResolver.definitions as any) = mock(async () => [])
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

      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ endpoint: GenesisChannel.endpoint() })
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
      ;(ToolResolver.definitions as any) = originalDefinitions
      ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
      ;(PromptBudgeter.decide as any) = originalDecide
      ;(SessionProcessor.create as any) = originalProcessorCreate
      ;(Session.updatePart as any) = originalUpdatePart
      ;(Cortex.list as any) = originalCortexList
      ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
    }
  })
})
