import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Category } from "../../src/cortex/category"
import { Cortex } from "../../src/cortex"
import { TaskTool } from "../../src/cortex/tools/task"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../support/fixture"

const PARENT = { providerID: "test-provider", modelID: "parent-model" }
const SUBAGENT = { providerID: "subagent-provider", modelID: "subagent-model" }

async function writeAssistantMessage(input: {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
}) {
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id,
    role: "assistant",
    sessionID: input.sessionID,
    parentID: id,
    rootID: id,
    agent: input.agent,
    providerID: input.model.providerID,
    modelID: input.model.modelID,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    path: {
      cwd: ScopeContext.current.directory,
      root: ScopeContext.current.directory,
    },
    mode: "test",
    time: { created: Date.now(), completed: Date.now() },
  } satisfies MessageV2.Assistant)
  return id
}

async function runTaskTool(input: { parentSessionID: string; messageID: string; category?: string }) {
  using launch = spyOn(Cortex, "launch").mockImplementation(Cortex.prepare)
  const tool = await TaskTool.init({})
  await tool.execute(
    {
      description: "Model resolution probe",
      prompt: "probe",
      subagent_type: "developer",
      background: true,
      category: input.category,
    },
    {
      sessionID: input.parentSessionID,
      messageID: input.messageID,
      agent: "synergy",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    },
  )
  return launch.mock.calls[0]?.[0].model
}

describe("task tool delegated model resolution", () => {
  beforeEach(() => Cortex.reset())
  afterEach(() => mock.restore())

  for (const available of [true, false]) {
    test(`inherits the parent model when available=${available}`, async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using agentModel = spyOn(Agent, "getAvailableModel").mockResolvedValue(SUBAGENT)
          using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(available)
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({ sessionID: parent.id, agent: "synergy", model: PARENT })
          expect(await runTaskTool({ parentSessionID: parent.id, messageID })).toEqual(available ? PARENT : SUBAGENT)
        },
      })
    })
  }

  for (const model of [
    "category-provider/category-model",
    "model-only",
    "/model",
    "provider/",
    " /model",
    "provider/ ",
  ]) {
    test(`validates the category override ${JSON.stringify(model)}`, async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(true)
          using category = spyOn(Category, "resolve").mockResolvedValue({ model })
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({ sessionID: parent.id, agent: "synergy", model: PARENT })
          const result = runTaskTool({ parentSessionID: parent.id, messageID, category: "probe" })
          if (model === "category-provider/category-model") {
            expect(await result).toEqual({ providerID: "category-provider", modelID: "category-model" })
          } else await expect(result).rejects.toThrow("provider/model format")
        },
      })
    })
  }
})
