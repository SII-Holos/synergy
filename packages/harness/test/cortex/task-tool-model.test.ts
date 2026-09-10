import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
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

async function runTaskTool(input: { parentSessionID: string; messageID: string }) {
  const launched = { model: undefined as unknown }
  const resolved = defer<LaunchResult>()
  const launchMock = mock(async (input: { model?: unknown; sessionID?: string; description: string }) => {
    launched.model = input.model
    return resolved.promise
  })
  ;(Cortex as any).launch = launchMock

  try {
    const tool = await TaskTool.init({})
    const executing = tool.execute(
      { description: "Model resolution probe", prompt: "probe", subagent_type: "developer", background: true },
      {
        sessionID: input.parentSessionID,
        messageID: input.messageID,
        agent: "synergy",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
    )
    await waitFor(() => launched.model !== undefined)
    resolved.resolve({ id: "cortex_task_probe", sessionID: "ses_child_probe", description: "probe" } as LaunchResult)
    await executing
    return launched.model
  } finally {
    ;(Cortex as any).launch = originalLaunch
  }
}

const originalLaunch = Cortex.launch
type LaunchResult = Awaited<ReturnType<typeof Cortex.launch>>

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("task tool delegated model resolution", () => {
  beforeEach(() => {
    Cortex.reset()
  })

  afterEach(() => {
    mock.restore()
  })

  test("inherits the parent session model over the subagent-default when it is available", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalGetAvailableModel = Agent.getAvailableModel
        const originalIsModelAvailable = Provider.isModelAvailable
        ;(Agent.getAvailableModel as any) = mock(async (agent: Agent.Info) =>
          agent.name === "developer" ? SUBAGENT : undefined,
        )
        // The test runtime has no providers configured; treat the parent model
        // as the only available one.
        ;(Provider.isModelAvailable as any) = mock(
          async (model: { providerID: string; modelID: string }) => model.modelID === PARENT.modelID,
        )
        try {
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({
            sessionID: parent.id,
            agent: "synergy",
            model: PARENT,
          })

          const model = await runTaskTool({ parentSessionID: parent.id, messageID })
          expect(model).toEqual(PARENT)
        } finally {
          ;(Agent.getAvailableModel as any) = originalGetAvailableModel
          ;(Provider.isModelAvailable as any) = originalIsModelAvailable
        }
      },
    })
  })

  test("falls back to the subagent-default model when the parent model is no longer available", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalGetAvailableModel = Agent.getAvailableModel
        const originalIsModelAvailable = Provider.isModelAvailable
        ;(Agent.getAvailableModel as any) = mock(async (agent: Agent.Info) =>
          agent.name === "developer" ? SUBAGENT : undefined,
        )
        ;(Provider.isModelAvailable as any) = mock(async () => false)
        try {
          const parent = await Session.create({})
          const messageID = await writeAssistantMessage({
            sessionID: parent.id,
            agent: "synergy",
            model: PARENT,
          })

          const model = await runTaskTool({ parentSessionID: parent.id, messageID })
          expect(model).toEqual(SUBAGENT)
        } finally {
          ;(Agent.getAvailableModel as any) = originalGetAvailableModel
          ;(Provider.isModelAvailable as any) = originalIsModelAvailable
        }
      },
    })
  })
})
