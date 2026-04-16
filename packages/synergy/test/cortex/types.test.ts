import { describe, expect, test } from "bun:test"
import { CortexTypes } from "../../src/cortex/types"

describe("CortexTypes", () => {
  describe("TaskStatus", () => {
    test("accepts valid status values", () => {
      expect(CortexTypes.TaskStatus.parse("pending")).toBe("pending")
      expect(CortexTypes.TaskStatus.parse("queued")).toBe("queued")
      expect(CortexTypes.TaskStatus.parse("running")).toBe("running")
      expect(CortexTypes.TaskStatus.parse("completed")).toBe("completed")
      expect(CortexTypes.TaskStatus.parse("error")).toBe("error")
      expect(CortexTypes.TaskStatus.parse("cancelled")).toBe("cancelled")
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
        lastUpdate: Date.now(),
        lastMessage: "Running tests...",
      }
      const result = CortexTypes.TaskProgress.parse(progress)
      expect(result.toolCalls).toBe(5)
      expect(result.lastTool).toBe("bash")
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
        agent: "master",
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
        agent: "master",
        category: "visual-engineering",
        status: "completed" as const,
        startedAt: Date.now(),
        completedAt: Date.now() + 1000,
        result: "Task completed successfully",
        progress: {
          toolCalls: 3,
          lastUpdate: Date.now(),
        },
      }
      const result = CortexTypes.Task.parse(task)
      expect(result.category).toBe("visual-engineering")
      expect(result.result).toBe("Task completed successfully")
    })

    test("rejects task with invalid id prefix", () => {
      const task = {
        id: "invalid_01234567890abcdef",
        sessionID: "ses_01234567890abcdef",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
        description: "Test task",
        prompt: "Do something",
        agent: "master",
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
        agent: "master",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
      }
      const result = CortexTypes.LaunchInput.parse(input)
      expect(result.description).toBe("Run tests")
      expect(result.agent).toBe("master")
    })

    test("accepts launch input with optional model", () => {
      const input = {
        description: "Run tests",
        prompt: "Execute the test suite",
        agent: "master",
        parentSessionID: "ses_parent01234567890",
        parentMessageID: "msg_parent01234567890",
        category: "most-capable",
        model: {
          providerID: "anthropic",
          modelID: "claude-3-opus",
        },
      }
      const result = CortexTypes.LaunchInput.parse(input)
      expect(result.category).toBe("most-capable")
      expect(result.model?.providerID).toBe("anthropic")
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
