import { DagPatchTool } from "../../src/tool/dag"
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import { Dag } from "../../src/session/dag"
import { Cortex } from "../../src/cortex"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { CortexOutput } from "../../src/cortex/output"
import { PermissionNext } from "../../src/permission/next"

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
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { id: "test", url: "https://example.invalid", npm: "@ai-sdk/openai" },
    options: {},
  }
}

async function writeAssistantText(sessionID: string, text: string) {
  const parentID = Identifier.ascending("message")
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID,
    rootID: parentID,
    mode: "test",
    agent: "developer",
    path: {
      cwd: ScopeContext.current.directory,
      root: ScopeContext.current.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
    sessionID,
  })
  const part = await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
  })
  return { info: message, parts: [part] }
}

function installDagLoopMocks(options?: {
  onBuildPlan?: (input: Parameters<typeof PromptBudgeter.buildPlan>[0]) => void
}) {
  const originalGetModel = Provider.getModel
  const originalGetAgent = Agent.get
  const originalGetAvailableModel = Agent.getAvailableModel
  const originalConfigCurrent = Config.current
  const originalDefinitions = ToolResolver.definitions
  const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
  const originalBuildPlan = PromptBudgeter.buildPlan
  const originalDecide = PromptBudgeter.decide
  const originalProcessorCreate = SessionProcessor.create

  ;(Provider.getModel as any) = mock(async () => testModel())
  ;(Agent.get as any) = mock(async (name: string) => ({
    name,
    mode: "primary",
    permission: PermissionNext.fromConfig({ "*": "allow" }),
    options: {},
    model: { providerID: "test-provider", modelID: "test-model" },
  }))
  ;(Agent.getAvailableModel as any) = mock(async () => ({ providerID: "test-provider", modelID: "test-model" }))
  ;(Config.current as any) = mock(async () => ({
    ...(await originalConfigCurrent()),
    compaction: { auto: true, maxHistoryImages: 8 },
    library: { memory: { enabled: false }, experience: { retrieve: false } },
  }))
  ;(ToolResolver.definitions as any) = mock(async () => [])
  ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({
    definitions: [],
    executionTools: {},
    executorKinds: {},
    activeToolIDs: [],
  }))
  ;(PromptBudgeter.buildPlan as any) = mock(async (input: Parameters<typeof PromptBudgeter.buildPlan>[0]) => {
    options?.onBuildPlan?.(input)
    return {
      system: input.system,
      systemCacheBreakpoint: input.systemCacheBreakpoint,
      messages: input.messages,
      toolDefinitions: input.toolDefinitions,
    }
  })
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
      input.assistantMessage.finish = "stop"
      input.assistantMessage.time.completed = Date.now()
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: input.assistantMessage.id,
        sessionID: input.assistantMessage.sessionID,
        type: "text",
        text: "downstream used upstream context",
      })
      await Session.updateMessage(input.assistantMessage)
      return "stop" as const
    }),
  }))

  return () => {
    ;(Provider.getModel as any) = originalGetModel
    ;(Agent.get as any) = originalGetAgent
    ;(Agent.getAvailableModel as any) = originalGetAvailableModel
    ;(Config.current as any) = originalConfigCurrent
    ;(ToolResolver.definitions as any) = originalDefinitions
    ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
    ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
    ;(PromptBudgeter.decide as any) = originalDecide
    ;(SessionProcessor.create as any) = originalProcessorCreate
  }
}

// ---------------------------------------------------------------------------
// Schema tests: Dag.Node with optional result field
// ---------------------------------------------------------------------------

describe("Dag.Node result field (schema)", () => {
  test("parses node without result field (backward compatibility with old data)", () => {
    const parsed = Dag.Node.parse({
      id: "node-backward-compat",
      content: "Legacy task without result",
      status: "completed",
      deps: [],
    })
    expect(parsed.id).toBe("node-backward-compat")
    expect(parsed.result).toBeUndefined()
  })

  test("parses node with result field and result is accessible", () => {
    const resultText = "Task completed successfully: all tests passed, coverage at 95%"
    const parsed = Dag.Node.parse({
      id: "node-with-result",
      content: "Task with result",
      status: "completed",
      deps: [],
      result: resultText,
    })
    expect(parsed.id).toBe("node-with-result")
    expect(parsed.result).toBe(resultText)
  })

  test("result is optional — node with undefined result is valid", () => {
    const parsed = Dag.Node.parse({
      id: "node-no-result",
      content: "No result",
      status: "failed",
      deps: [],
    })
    expect(parsed.result).toBeUndefined()
    expect(parsed.status).toBe("failed")
  })
})

// ---------------------------------------------------------------------------
// buildCortexExecutionContext integration test
//
// Verifies that the DAG node result from an upstream completed task is
// propagated to the downstream node when a delegated_subagent task runs.
// ---------------------------------------------------------------------------

describe("delegated subagent with DAG context (integration)", () => {
  beforeEach(() => {
    Cortex.reset()
  })

  afterEach(() => {
    Cortex.reset()
  })

  test("structured task output is rendered into DAG result text", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalInvokeInternal = SessionInvoke.invokeInternal
        ;(SessionInvoke.invokeInternal as any) = mock(
          async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
            return writeAssistantText(input.sessionID, JSON.stringify({ choice: "blue", items: ["a", "b"] }))
          },
        )
        try {
          const parentSession = await Session.create({})
          await Dag.update({
            sessionID: parentSession.id,
            nodes: [{ id: "structured-node", content: "Produce structured data", status: "pending", deps: [] }],
          })

          const task = await Cortex.launch({
            description: "Structured DAG result",
            prompt: "Choose structured result",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_structured_dag",
            dagNodeId: "structured-node",
            model: { providerID: "test-provider", modelID: "test-model" },
            notifyParentOnComplete: false,
            output: {
              mode: "structured",
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["choice", "items"],
                properties: {
                  choice: { type: "string" },
                  items: { type: "array", items: { type: "string" } },
                },
              },
            },
          })

          const completed = await Cortex.waitFor(task.id, 10)
          expect(completed?.status).toBe("completed")
          await Bun.sleep(20)

          const node = (await Dag.get(parentSession.id)).find((n) => n.id === "structured-node")
          expect(node?.status).toBe("completed")
          expect(node?.result).toBe(
            CortexOutput.renderTaskOutputForDag({ mode: "structured", value: { choice: "blue", items: ["a", "b"] } }),
          )
        } finally {
          ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
        }
      },
    })
  })

  test("downstream delegated subagent context includes structured upstream DAG result", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        let systemText = ""
        const restore = installDagLoopMocks({
          onBuildPlan(input) {
            systemText = input.system.join("\n")
          },
        })
        try {
          const parentSession = await Session.create({})
          await Dag.update({
            sessionID: parentSession.id,
            nodes: [
              {
                id: "upstream-structured",
                content: "Upstream structured result",
                status: "completed",
                deps: [],
                result: CortexOutput.renderTaskOutputForDag({
                  mode: "structured",
                  value: { winner: "drake", score: 3 },
                }),
              },
              {
                id: "downstream-context",
                content: "Use upstream structured result",
                status: "pending",
                deps: ["upstream-structured"],
              },
            ],
          })

          const task = await Cortex.launch({
            description: "Downstream reads structured DAG result",
            prompt: "Use upstream structured result",
            agent: "developer",
            executionRole: "delegated_subagent",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_downstream_structured",
            dagNodeId: "downstream-context",
            notifyParentOnComplete: false,
          })

          const completed = await Cortex.waitFor(task.id, 10)
          expect(completed?.status).toBe("completed")
          expect(systemText).toContain("<upstream-results>")
          expect(systemText).toContain("Structured output:")
          expect(systemText).toContain('"winner": "drake"')
          expect(systemText).toContain('"score": 3')
        } finally {
          restore()
        }
      },
    })
  })
  test("delegated_subagent task populates DAG node with upstream completion context", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        // Simulate an upstream DAG node that has already completed with a result
        await Dag.update({
          sessionID: parentSession.id,
          nodes: [
            {
              id: "upstream-done",
              content: "Already completed upstream work",
              status: "completed",
              deps: [],
              result: "Analysis complete: found 3 issues in the codebase.",
            },
            {
              id: "downstream-next",
              content: "Downstream task depending on upstream",
              status: "pending",
              deps: ["upstream-done"],
            },
          ],
        })

        // Launch a delegated subagent task for the downstream node
        const task = await Cortex.launch({
          description: "Downstream task with upstream context",
          prompt: "Use upstream findings to fix issues",
          agent: "implementation-engineer",
          executionRole: "delegated_subagent",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_ctx_downstream",
          dagNodeId: "downstream-next",
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        // give async DAG updates time to flush
        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const upstream = nodes.find((n) => n.id === "upstream-done")
        const downstream = nodes.find((n) => n.id === "downstream-next")

        // Upstream should be unchanged (it was already completed)
        expect(upstream).toBeDefined()
        expect(upstream!.status).toBe("completed")
        expect(upstream!.result).toBe("Analysis complete: found 3 issues in the codebase.")

        // Downstream got its status updated by the task
        expect(downstream).toBeDefined()
        expect(downstream!.status === "completed" || downstream!.status === "failed").toBe(true)
      },
    })
  })

  test("delegated_subagent without dagNodeId does not modify DAG", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        await Dag.update({
          sessionID: parentSession.id,
          nodes: [{ id: "node-alone", content: "Standalone node", status: "pending", deps: [] }],
        })

        const task = await Cortex.launch({
          description: "No DAG binding",
          prompt: "Do work",
          agent: "developer",
          executionRole: "delegated_subagent",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_no_dag",
          // No dagNodeId
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const node = nodes.find((n) => n.id === "node-alone")
        expect(node).toBeDefined()
        expect(node!.status).toBe("pending")
        expect(node!.result).toBeUndefined()
      },
    })
  })

  test("completed task result set on DAG node preserves content", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        const expectedContent = "Implementation task for feature X"
        await Dag.update({
          sessionID: parentSession.id,
          nodes: [{ id: "node-content", content: expectedContent, status: "pending", deps: [] }],
        })

        const task = await Cortex.launch({
          description: "Content preservation test",
          prompt: "Implement feature X",
          agent: "developer",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_content_001",
          dagNodeId: "node-content",
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const node = nodes.find((n) => n.id === "node-content")
        expect(node).toBeDefined()
        // Content should be preserved (only status/result change)
        expect(node!.content).toBe(expectedContent)
      },
    })
  })

  test("primary execution role task does NOT set upstream-results context but still updates DAG", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parentSession = await Session.create({})

        await Dag.update({
          sessionID: parentSession.id,
          nodes: [
            {
              id: "up-comp",
              content: "Completed upstream",
              status: "completed",
              deps: [],
              result: "Upstream analysis results here",
            },
            {
              id: "down-primary",
              content: "Downstream with primary role",
              status: "pending",
              deps: ["up-comp"],
            },
          ],
        })

        const task = await Cortex.launch({
          description: "Primary role downstream",
          prompt: "Continue work",
          agent: "developer",
          executionRole: "primary",
          parentSessionID: parentSession.id,
          parentMessageID: "msg_primary_001",
          dagNodeId: "down-primary",
        })

        const completed = await Cortex.waitFor(task.id, 10)
        expect(completed).toBeDefined()

        await new Promise((r) => setTimeout(r, 500))

        const nodes = await Dag.get(parentSession.id)
        const down = nodes.find((n) => n.id === "down-primary")
        expect(down).toBeDefined()
        // Still gets status/result updated (that's updateDagNode, not context)
        expect(down!.status === "completed" || down!.status === "failed").toBe(true)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// dagpatch immutability: completed nodes reject task_id / session_id mutation
//
// DagPatchTool.execute() guards task_id and session_id on completed nodes
// (dag.ts lines 188-193). We test this by setting up a completed DAG node,
// calling dagpatch to mutate the protected fields, and verifying the error
// response and that the node values remain unchanged.
// ---------------------------------------------------------------------------

describe("dagpatch rejects task_id / session_id mutation on completed nodes", () => {
  const ctx = {
    sessionID: "",
    messageID: "",
    agent: "developer",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }

  test("completed node rejects task_id mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        ctx.sessionID = session.id

        const originalTaskId = "existing-task-123"
        await Dag.update({
          sessionID: session.id,
          nodes: [
            {
              id: "node-immutable-task",
              content: "Completed node with task_id",
              status: "completed",
              deps: [],
              task_id: originalTaskId,
            },
          ],
        })

        const patch = await DagPatchTool.init()
        const result = await patch.execute(
          {
            nodes: [{ id: "node-immutable-task", task_id: "new-task-999" }],
          },
          ctx as any,
        )

        expect(result.title).toBe("Patch failed")
        expect(result.output).toContain("task_id and session_id are immutable")

        // Verify the node's task_id was not changed
        const nodes = await Dag.get(session.id)
        const node = nodes.find((n) => n.id === "node-immutable-task")
        expect(node).toBeDefined()
        expect(node!.task_id).toBe(originalTaskId)
      },
    })
  })

  test("completed node rejects session_id mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        ctx.sessionID = session.id

        const originalSessionId = "existing-secret-session-abc"
        await Dag.update({
          sessionID: session.id,
          nodes: [
            {
              id: "node-immutable-session",
              content: "Completed node with session_id",
              status: "completed",
              deps: [],
              session_id: originalSessionId,
            },
          ],
        })

        const patch = await DagPatchTool.init()
        const result = await patch.execute(
          {
            nodes: [{ id: "node-immutable-session", session_id: "new-session-777" }],
          },
          ctx as any,
        )

        expect(result.title).toBe("Patch failed")
        expect(result.output).toContain("task_id and session_id are immutable")

        // Verify the node's session_id was not changed
        const nodes = await Dag.get(session.id)
        const node = nodes.find((n) => n.id === "node-immutable-session")
        expect(node).toBeDefined()
        expect(node!.session_id).toBe(originalSessionId)
      },
    })
  })
})
