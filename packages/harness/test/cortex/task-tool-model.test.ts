import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
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
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

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

async function runTaskTool(input: { parentSessionID: string; messageID: string; category?: string; model?: string }) {
  using launch = spyOn(Cortex, "launch").mockImplementation(Cortex.prepare)
  const tool = await TaskTool.init({})
  await tool.execute(
    {
      taskTitle: "Model resolution probe",
      taskInstructions: "probe",
      subagent_type: "developer",
      background: true,
      category: input.category,
      model: input.model,
    },
    {
      sessionID: input.parentSessionID,
      messageID: input.messageID,
      agent: PrimaryAgentIdentity.names.general,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    },
  )
  return launch.mock.calls[0]?.[0].model
}

async function expectRejected(input: { parentSessionID: string; messageID: string; model: string }) {
  using launch = spyOn(Cortex, "launch").mockImplementation(Cortex.prepare)
  const tool = await TaskTool.init({})
  await expect(
    tool.execute(
      {
        taskTitle: "Model resolution probe",
        taskInstructions: "probe",
        subagent_type: "developer",
        background: true,
        model: input.model,
      },
      {
        sessionID: input.parentSessionID,
        messageID: input.messageID,
        agent: PrimaryAgentIdentity.names.general,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
    ),
  ).rejects.toThrow(/not available|provider\/model/)
  expect(launch).not.toHaveBeenCalled()
}

describe("task tool delegated model resolution", () => {
  beforeEach(() => runtime.run(() => Cortex.reset()))
  afterEach(() => runtime.run(() => mock.restore()))

  for (const available of [true, false]) {
    test(`inherits the parent model when available=${available}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            using agentModel = spyOn(Agent, "getAvailableModel").mockResolvedValue(SUBAGENT)
            using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(available)
            const parent = await Session.create({})
            const messageID = await writeAssistantMessage({
              sessionID: parent.id,
              agent: PrimaryAgentIdentity.names.general,
              model: PARENT,
            })
            expect(await runTaskTool({ parentSessionID: parent.id, messageID })).toEqual(available ? PARENT : SUBAGENT)
          },
        })
      }))
  }

  for (const model of [
    "category-provider/category-model",
    "model-only",
    "/model",
    "provider/",
    " /model",
    "provider/ ",
  ]) {
    test(`validates the category override ${JSON.stringify(model)}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(true)
            using category = spyOn(Category, "resolve").mockResolvedValue({ model })
            const parent = await Session.create({})
            const messageID = await writeAssistantMessage({
              sessionID: parent.id,
              agent: PrimaryAgentIdentity.names.general,
              model: PARENT,
            })
            const result = runTaskTool({ parentSessionID: parent.id, messageID, category: "probe" })
            if (model === "category-provider/category-model") {
              expect(await result).toEqual({ providerID: "category-provider", modelID: "category-model" })
            } else await expect(result).rejects.toThrow("provider/model format")
          },
        })
      }))
  }

  test("an explicit model wins over the parent and category models", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(true)
          using category = spyOn(Category, "resolve").mockResolvedValue({
            model: "category-provider/category-model",
            promptAppend: "keep the prompt",
          })
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({
            sessionID: parent.id,
            agent: PrimaryAgentIdentity.names.general,
            model: PARENT,
          })
          expect(
            await runTaskTool({
              parentSessionID: parent.id,
              messageID,
              category: "quick",
              model: "explicit-provider/explicit-model",
            }),
          ).toEqual({ providerID: "explicit-provider", modelID: "explicit-model" })
        },
      })
    }))

  test("a configured role wins over the available parent model", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: { thinking_model: "thinking-provider/reasoner" },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(true)
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({
            sessionID: parent.id,
            agent: PrimaryAgentIdentity.names.general,
            model: PARENT,
          })
          expect(await runTaskTool({ parentSessionID: parent.id, messageID, model: "thinking" })).toEqual({
            providerID: "thinking-provider",
            modelID: "reasoner",
          })
        },
      })
    }))

  test("an unavailable explicit model fails before launch", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(false)
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({
            sessionID: parent.id,
            agent: PrimaryAgentIdentity.names.general,
            model: PARENT,
          })
          await expectRejected({ parentSessionID: parent.id, messageID, model: "explicit-provider/missing" })
        },
      })
    }))

  test("the exposed tool description lists available configured models and omits vision", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          thinking_model: "thinking-provider/reasoner",
          vision_model: "vision-provider/eyes",
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using availability = spyOn(Provider, "isModelAvailable").mockResolvedValue(true)
          const tool = await TaskTool.init({ model: PARENT })
          expect(tool.description).toContain("parent: test-provider/parent-model")
          expect(tool.description).toContain("thinking: thinking-provider/reasoner")
          expect(tool.description).not.toContain("vision-provider/eyes")
          expect(tool.description).not.toContain("- vision:")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
