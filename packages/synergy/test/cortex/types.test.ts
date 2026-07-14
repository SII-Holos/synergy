import { describe, expect, test } from "bun:test"
import { CortexTypes } from "../../src/cortex/types"

describe("CortexTypes", () => {
  test("requires complete workflow task ownership", () => {
    expect(CortexTypes.WorkflowTaskOwner.safeParse({ kind: "workflow_run" }).success).toBe(false)
    expect(
      CortexTypes.WorkflowTaskOwner.safeParse({
        kind: "workflow_run",
        runID: "wfr_owner",
        entityID: "wfe_owner",
        correlationID: "effect-owner",
      }).success,
    ).toBe(true)
  })

  test("rejects legacy task ownership after migration", () => {
    expect(() =>
      CortexTypes.taskOwnerFromStored({
        pluginId: "legacy-plugin",
        pluginGeneration: "generation-one",
        scopeId: "scope-one",
        correlationId: "correlation-one",
      }),
    ).toThrow()
  })

  describe("TaskStatus", () => {
    test("accepts valid status values", () => {
      expect(CortexTypes.TaskStatus.safeParse("pending").success).toBe(false)
      expect(CortexTypes.TaskStatus.parse("queued")).toBe("queued")
      expect(CortexTypes.TaskStatus.parse("running")).toBe("running")
      expect(CortexTypes.TaskStatus.parse("completed")).toBe("completed")
      expect(CortexTypes.TaskStatus.parse("error")).toBe("error")
      expect(CortexTypes.TaskStatus.parse("cancelled")).toBe("cancelled")
      expect(CortexTypes.TaskStatus.parse("interrupted")).toBe("interrupted")
    })

    test("rejects invalid status values", () => {
      expect(() => CortexTypes.TaskStatus.parse("invalid")).toThrow()
      expect(() => CortexTypes.TaskStatus.parse("")).toThrow()
      expect(() => CortexTypes.TaskStatus.parse(123)).toThrow()
    })
  })

  describe("TaskProgress", () => {
    test("accepts valid progress object", () => {
      const progress = {
        toolCalls: 5,
        lastTool: "bash",
        lastToolStatus: "completed",
        lastTitle: "Ran tests",
        lastPartId: "part_01234567890abcdef",
        lastUpdate: Date.now(),
        lastMessage: "Running tests...",
        recentTools: [
          {
            id: "part_01234567890abcdef",
            tool: "bash",
            status: "completed",
            title: "Ran tests",
            updatedAt: Date.now(),
          },
        ],
      }
      const result = CortexTypes.TaskProgress.parse(progress)
      expect(result.toolCalls).toBe(5)
      expect(result.lastTool).toBe("bash")
      expect(result.recentTools?.[0]?.tool).toBe("bash")
    })

    test("accepts minimal progress object", () => {
      const progress = {
        toolCalls: 0,
        lastUpdate: Date.now(),
      }
      const result = CortexTypes.TaskProgress.parse(progress)
      expect(result.toolCalls).toBe(0)
      expect(result.lastTool).toBeUndefined()
    })

    test("rejects invalid progress object", () => {
      expect(() => CortexTypes.TaskProgress.parse({})).toThrow()
      expect(() => CortexTypes.TaskProgress.parse({ toolCalls: "five" })).toThrow()
    })
  })

  describe("Task", () => {
    test("accepts valid task object", () => {
      const task = {
        id: "ctx_01234567890abcdef",
        sessionID: "ses_01234567890abcdef",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
        description: "Test task",
        prompt: "Do something",
        agent: "developer",
        status: "running" as const,
        startedAt: Date.now(),
      }
      const result = CortexTypes.Task.parse(task)
      expect(result.id).toBe(task.id)
      expect(result.description).toBe("Test task")
      expect(result.status).toBe("running")
    })

    test("accepts task with optional fields", () => {
      const task = {
        id: "ctx_01234567890abcdef",
        sessionID: "ses_01234567890abcdef",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
        description: "Test task",
        prompt: "Do something",
        agent: "developer",
        category: "visual-engineering",
        status: "completed" as const,
        startedAt: Date.now(),
        completedAt: Date.now() + 1000,
        outputConfig: { mode: "summary" },
        output: { mode: "summary", value: "Task completed successfully" },
        notifyParentOnComplete: false,
        owner: {
          kind: "plugin",
          pluginId: "truthward",
          pluginGeneration: "generation-one",
          scopeId: "scope-one",
          correlationId: "stage-one",
        },
        timeoutMs: 1_800_000,
        progress: {
          toolCalls: 3,
          lastUpdate: Date.now(),
        },
      }
      const result = CortexTypes.Task.parse(task)
      expect(result.category).toBe("visual-engineering")
      expect(result.output).toEqual({ mode: "summary", value: "Task completed successfully" })
      expect(result.notifyParentOnComplete).toBe(false)
      expect(result.owner?.kind).toBe("plugin")
      if (result.owner?.kind !== "plugin") throw new Error("expected plugin task owner")
      expect(result.owner.correlationId).toBe("stage-one")
      expect(result.timeoutMs).toBe(1_800_000)
    })

    test("rejects task with invalid id prefix", () => {
      const task = {
        id: "invalid_01234567890abcdef",
        sessionID: "ses_01234567890abcdef",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
        description: "Test task",
        prompt: "Do something",
        agent: "developer",
        status: "running",
        startedAt: Date.now(),
      }
      expect(() => CortexTypes.Task.parse(task)).toThrow()
    })
  })

  describe("LaunchInput", () => {
    test("accepts valid launch input", () => {
      const input = {
        description: "Run tests",
        prompt: "Execute the test suite",
        agent: "developer",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
      }
      const result = CortexTypes.LaunchInput.parse(input)
      expect(result.description).toBe("Run tests")
      expect(result.agent).toBe("developer")
    })

    test("accepts launch input with optional model", () => {
      const input = {
        description: "Run tests",
        prompt: "Execute the test suite",
        agent: "developer",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
        category: "most-capable",
        notifyParentOnComplete: false,
        model: {
          providerID: "anthropic",
          modelID: "claude-3-opus",
        },
      }
      const result = CortexTypes.LaunchInput.parse(input)
      expect(result.category).toBe("most-capable")
      expect(result.model?.providerID).toBe("anthropic")
      expect(result.notifyParentOnComplete).toBe(false)
    })

    test("rejects invalid launch input", () => {
      expect(() => CortexTypes.LaunchInput.parse({})).toThrow()
      expect(() =>
        CortexTypes.LaunchInput.parse({
          description: "Test",
        }),
      ).toThrow()
    })
  })
})
