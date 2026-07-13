import { describe, expect, test } from "bun:test"
import { pluginTaskSnapshotFromSession, pluginTaskSnapshotFromTask } from "../../src/cortex/plugin-task"
import type { CortexTypes } from "../../src/cortex/types"
import type { CortexDelegationInfo } from "../../src/session/types"

const owner = {
  pluginId: "example-plugin",
  pluginGeneration: "generation-a",
  scopeId: "scope-a",
  correlationId: "stage-run-a",
}

describe("public plugin task snapshots", () => {
  test("live and durable task state produce the same complete snapshot", () => {
    const durable: CortexDelegationInfo = {
      taskID: "cortex_task_a",
      parentSessionID: "parent-session",
      parentMessageID: "parent-message",
      description: "Delegate a stage",
      agent: "analysis-agent",
      status: "completed",
      model: { providerID: "provider-a", modelID: "model-a" },
      startedAt: 100,
      completedAt: 250,
      timeoutMs: 10_000,
      owner,
      outputConfig: { mode: "final_response" },
      output: { mode: "final_response", value: "done" },
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        cost: 0.25,
      },
    }
    const task: CortexTypes.Task = {
      id: durable.taskID,
      sessionID: "child-session",
      parentSessionID: durable.parentSessionID,
      parentMessageID: durable.parentMessageID,
      description: durable.description,
      prompt: "prompt",
      agent: durable.agent,
      status: durable.status,
      model: durable.model,
      startedAt: durable.startedAt,
      completedAt: durable.completedAt,
      timeoutMs: durable.timeoutMs,
      owner: durable.owner,
      outputConfig: durable.outputConfig,
      output: durable.output,
      usage: durable.usage,
    }
    const live = pluginTaskSnapshotFromTask(task)
    const restored = pluginTaskSnapshotFromSession({ taskId: task.id, sessionId: task.sessionID }, durable)
    expect(live).toEqual(restored)
    expect(restored).toMatchObject({
      owner,
      agent: "analysis-agent",
      model: { providerID: "provider-a", modelID: "model-a" },
      startedAt: 100,
      completedAt: 250,
      usage: { cost: 0.25 },
    })
  })

  test("does not expose non-plugin Cortex tasks", () => {
    const task = {
      id: "cortex_task_a",
      sessionID: "child-session",
      parentSessionID: "parent-session",
      parentMessageID: "parent-message",
      description: "ordinary Cortex task",
      prompt: "prompt",
      agent: "analysis-agent",
      status: "running",
      startedAt: 100,
    } satisfies CortexTypes.Task
    expect(pluginTaskSnapshotFromTask(task)).toBeUndefined()
  })
})
