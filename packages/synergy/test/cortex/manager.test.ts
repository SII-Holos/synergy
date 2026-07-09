import { describe, expect, test, beforeEach, mock } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { CortexTypes } from "../../src/cortex/types"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { Identifier } from "../../src/id/id"
import { CortexOutput } from "../../src/cortex/output"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"

async function launchAndCaptureCreatedTask(
  launch: () => Promise<CortexTypes.Task>,
  predicate: (task: CortexTypes.Task) => boolean,
): Promise<{ createdTask: CortexTypes.Task; launchPromise: Promise<CortexTypes.Task> }> {
  let unsubscribe = () => {}
  let launchPromise!: Promise<CortexTypes.Task>

  const createdTask = await new Promise<CortexTypes.Task>((resolve, reject) => {
    unsubscribe = Bus.subscribe(Cortex.Event.TaskCreated, (event) => {
      const task = event.properties.task
      if (!predicate(task)) return
      unsubscribe()
      resolve(task)
    })

    launchPromise = launch().catch((error) => {
      unsubscribe()
      reject(error)
      throw error
    })
  })

  return { createdTask, launchPromise }
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
    time: {
      created: Date.now(),
      completed: Date.now(),
    },
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

async function writeStructuredToolResult(sessionID: string, input: Record<string, unknown>) {
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
    time: {
      created: Date.now(),
      completed: Date.now(),
    },
    sessionID,
  })
  const part = await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "tool",
    callID: "call_structured_task_result",
    tool: CortexOutput.STRUCTURED_TOOL_ID,
    state: {
      status: "completed",
      input,
      output: JSON.stringify(input),
      title: "Structured task result",
      metadata: {},
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    },
  })
  return { info: message, parts: [part] }
}

async function waitUntilTerminal(taskID: string) {
  for (let i = 0; i < 50; i++) {
    const task = Cortex.get(taskID)
    if (task?.status === "completed" || task?.status === "error" || task?.status === "cancelled") return task
    await Bun.sleep(10)
  }
  return Cortex.get(taskID)
}

describe.serial("Cortex", () => {
  beforeEach(() => {
    Cortex.reset()
  })

  describe("get", () => {
    test("returns undefined for non-existent task", () => {
      const task = Cortex.get("ctx_nonexistent")
      expect(task).toBeUndefined()
    })
  })

  describe("list", () => {
    test("returns empty array when no tasks", () => {
      const tasks = Cortex.list()
      expect(tasks).toEqual([])
    })
  })

  describe("getRunningTasks", () => {
    test("returns empty array when no running tasks", () => {
      const tasks = Cortex.getRunningTasks()
      expect(tasks).toEqual([])
    })
  })

  describe("getCompletedTasks", () => {
    test("returns empty array when no completed tasks", () => {
      const tasks = Cortex.getCompletedTasks()
      expect(tasks).toEqual([])
    })
  })

  describe("getTasksForSession", () => {
    test("returns empty array for session with no tasks", () => {
      const tasks = Cortex.getTasksForSession("ses_nonexistent")
      expect(tasks).toEqual([])
    })

    test("hidden delegated tasks are audited but not visible", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const rootSession = await Session.create({})
          const agent = "developer"
          const hiddenTask = await Cortex.launch({
            description: "Hidden planner",
            prompt: "Plan something",
            agent,
            executionRole: "delegated_subagent",
            parentSessionID: rootSession.id,
            parentMessageID: "msg_test01234567890abe",
            visibility: "hidden",
            tools: { "*": false, example_internal_tool: true },
            notifyParentOnComplete: false,
          })

          expect(Cortex.getTasksForSession(rootSession.id).map((task) => task.id)).toContain(hiddenTask.id)
          expect(Cortex.getVisibleTasks(rootSession.id).map((task) => task.id)).not.toContain(hiddenTask.id)
          expect(Cortex.listVisible().map((task) => task.id)).not.toContain(hiddenTask.id)
          expect(Cortex.getRunningTasks().map((task) => task.id)).not.toContain(hiddenTask.id)
          expect(hiddenTask.tools).toEqual({ "*": false, example_internal_tool: true })
          expect(hiddenTask.visibility).toBe("hidden")

          await Cortex.cancel(hiddenTask.id)
        },
      })
    })
  })

  describe("output", () => {
    test("returns not found message for non-existent task", async () => {
      const output = await Cortex.output("ctx_nonexistent")
      expect(output).toContain("not found")
      expect(output).toContain("ctx_nonexistent")
    })
  })

  describe("cancel", () => {
    test("does nothing for non-existent task", async () => {
      await Cortex.cancel("ctx_nonexistent")
    })
  })

  describe("cancelAll", () => {
    test("returns 0 for session with no tasks", async () => {
      const count = await Cortex.cancelAll("ses_nonexistent")
      expect(count).toBe(0)
    })

    test("cancels descendant tasks recursively", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const rootSession = await Session.create({})
          const agent = "developer"
          const limit = CortexConcurrency.getLimit(agent)

          for (let i = 0; i < limit; i++) {
            await CortexConcurrency.acquire(agent)
          }

          try {
            const { createdTask: task1, launchPromise: task1Promise } = await launchAndCaptureCreatedTask(
              () =>
                Cortex.launch({
                  description: "Root task",
                  prompt: "Do something",
                  agent,
                  parentSessionID: rootSession.id,
                  parentMessageID: "msg_test01234567890abc",
                }),
              (task) => task.description === "Root task",
            )
            expect(task1).toBeDefined()
            expect(Cortex.get(task1!.id)?.status).toBe("queued")

            const { createdTask: task2, launchPromise: task2Promise } = await launchAndCaptureCreatedTask(
              () =>
                Cortex.launch({
                  description: "Child task",
                  prompt: "Do something nested",
                  agent,
                  parentSessionID: task1.sessionID,
                  parentMessageID: "msg_test01234567890abd",
                }),
              (task) => task.description === "Child task",
            )
            expect(task2).toBeDefined()
            expect(Cortex.get(task2!.id)?.status).toBe("queued")

            const tasksToCancel = Cortex.getTasksForSession(rootSession.id)
            expect(tasksToCancel.length).toBeGreaterThanOrEqual(1)

            const cancelled = await Cortex.cancelAll(rootSession.id)

            expect(cancelled).toBe(2)
            expect(Cortex.get(task1!.id)?.status).toBe("cancelled")
            expect(Cortex.get(task2!.id)?.status).toBe("cancelled")

            for (let i = 0; i < limit; i++) {
              CortexConcurrency.release(agent)
            }

            await Promise.all([task1Promise, task2Promise])
            expect(Cortex.get(task1!.id)?.status).toBe("cancelled")
            expect(Cortex.get(task2!.id)?.status).toBe("cancelled")

            const statusAfterRelease = CortexConcurrency.status()[agent]
            expect(statusAfterRelease?.running).toBe(0)
            expect(statusAfterRelease?.queued).toBe(0)
          } finally {
            CortexConcurrency.reset()
          }
        },
      })
    })
  })

  describe("waitFor", () => {
    test("returns undefined for non-existent task", async () => {
      const task = await Cortex.waitFor("ctx_nonexistent", 1)
      expect(task).toBeUndefined()
    })
  })

  describe("reset", () => {
    test("clears all state", () => {
      Cortex.reset()
      expect(Cortex.list()).toEqual([])
      expect(Cortex.getRunningTasks()).toEqual([])
      expect(Cortex.getCompletedTasks()).toEqual([])
    })
  })

  describe("Event", () => {
    test("TaskCreated event is defined", () => {
      expect(Cortex.Event.TaskCreated).toBeDefined()
      expect(Cortex.Event.TaskCreated.type).toBe("cortex.task.created")
    })

    test("TaskCompleted event is defined", () => {
      expect(Cortex.Event.TaskCompleted).toBeDefined()
      expect(Cortex.Event.TaskCompleted.type).toBe("cortex.task.completed")
    })

    test("TasksUpdated event is defined", () => {
      expect(Cortex.Event.TasksUpdated).toBeDefined()
      expect(Cortex.Event.TasksUpdated.type).toBe("cortex.tasks.updated")
    })
  })

  describe("launch", () => {
    test("creates task and emits TaskCreated event", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})
          let createdTask: CortexTypes.Task | undefined

          const unsub = Bus.subscribe(Cortex.Event.TaskCreated, (event) => {
            createdTask = event.properties.task
          })

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          // Check immediately before async runTask() can error
          expect(task).toBeDefined()
          expect(task.id).toMatch(/^ctx_/)
          // Task status is set to "running" synchronously before runTask starts
          expect(task.status).toBe("running")
          expect(task.description).toBe("Test task")
          expect(task.agent).toBe("developer")
          expect(task.parentSessionID).toBe(parentSession.id)

          unsub()

          expect(createdTask).toBeDefined()
          expect(createdTask?.id).toBe(task.id)

          const listedTasks = Cortex.list()
          expect(listedTasks.length).toBeGreaterThanOrEqual(1)
          expect(listedTasks.some((t) => t.id === task.id)).toBe(true)

          await Cortex.cancel(task.id)
        },
      })
    })

    test("creates task with category", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Visual task",
            prompt: "Design something",
            agent: "developer",
            category: "visual-engineering",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          expect(task.category).toBe("visual-engineering")

          await Cortex.cancel(task.id)
        },
      })
    })

    test("creates task with custom model", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Custom model task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
            model: {
              providerID: "anthropic",
              modelID: "claude-3-opus",
            },
          })

          expect(task).toBeDefined()
          expect(task.status).toBe("running")

          await Cortex.cancel(task.id)
        },
      })
    })

    test("delegated sessions only deny recursive coordination tools when the agent profile does not allow them", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})
          const coordinationTools = [
            "task",
            "task_output",
            "task_list",
            "task_cancel",
            "dagwrite",
            "dagread",
            "dagpatch",
          ]

          const supervisorTask = await Cortex.launch({
            description: "Supervisor audit",
            prompt: "Audit work",
            agent: "supervisor",
            executionRole: "delegated_subagent",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
            visibility: "hidden",
            notifyParentOnComplete: false,
          })
          const supervisorSession = await Session.get(supervisorTask.sessionID)
          for (const tool of coordinationTools) {
            expect(
              PermissionNext.evaluate(tool, "*", PermissionNext.sessionRuleset(supervisorSession)).action,
            ).not.toBe("deny")
          }

          const ordinaryTask = await Cortex.launch({
            description: "Implementation",
            prompt: "Implement work",
            agent: "implementation-engineer",
            executionRole: "delegated_subagent",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abd",
            visibility: "hidden",
            notifyParentOnComplete: false,
          })
          const ordinarySession = await Session.get(ordinaryTask.sessionID)
          for (const tool of coordinationTools) {
            expect(PermissionNext.evaluate(tool, "*", PermissionNext.sessionRuleset(ordinarySession)).action).toBe(
              "deny",
            )
          }

          await Cortex.cancel(supervisorTask.id)
          await Cortex.cancel(ordinaryTask.id)
        },
      })
    })

    test("task appears in getTasksForSession", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          const tasksForSession = Cortex.getTasksForSession(parentSession.id)
          expect(tasksForSession.some((t) => t.id === task.id)).toBe(true)

          await Cortex.cancel(task.id)
        },
      })
    })

    test("task has progress tracking", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          expect(task.progress).toBeDefined()
          expect(task.progress?.toolCalls).toBe(0)
          expect(task.progress?.lastUpdate).toBeDefined()

          await Cortex.cancel(task.id)
        },
      })
    })

    test("task appears in getRunningTasks initially", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          // Task should initially be in running state
          const runningTasks = Cortex.getRunningTasks()
          expect(runningTasks.some((t) => t.id === task.id)).toBe(true)

          await Cortex.cancel(task.id)
        },
      })
    })
  })

  describe("cancel integration", () => {
    test("cancels running task", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task to cancel",
            prompt: "Do something slowly",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          expect(task.status).toBe("running")

          await Cortex.cancel(task.id)

          const cancelledTask = Cortex.get(task.id)
          expect(cancelledTask?.status).toBe("cancelled")
        },
      })
    })

    test("cancelAll cancels running tasks for session", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          // Launch two tasks
          const task1 = await Cortex.launch({
            description: "Task 1",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          const task2 = await Cortex.launch({
            description: "Task 2",
            prompt: "Do something else",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          // Verify both tasks exist in the list
          const tasksForSession = Cortex.getTasksForSession(parentSession.id)
          expect(tasksForSession.length).toBe(2)
          expect(tasksForSession.some((t) => t.id === task1.id)).toBe(true)
          expect(tasksForSession.some((t) => t.id === task2.id)).toBe(true)

          const tasksSnapshot = Cortex.getTasksForSession(parentSession.id)
          const runningSnapshot = tasksSnapshot.filter((t) => t.status === "running" || t.status === "queued")

          const cancelled = await Cortex.cancelAll(parentSession.id)

          expect(cancelled).toBe(runningSnapshot.length)

          // After cancelAll, no tasks should be in running state
          const runningAfter = Cortex.getRunningTasks().filter((t) => t.parentSessionID === parentSession.id)
          expect(runningAfter.length).toBe(0)
        },
      })
    })
  })

  describe("output integration", () => {
    test("returns running status for running task", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Running task",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          const output = await Cortex.output(task.id)
          expect(output).toContain("Status: running")
          expect(output).toContain(task.id)

          await Cortex.cancel(task.id)
        },
      })
    })

    test("returns cancelled status for cancelled task", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Task to cancel",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          await Cortex.cancel(task.id)

          const output = await Cortex.output(task.id)
          expect(output).toContain("Status: cancelled")
        },
      })
    })
  })

  describe("structured output", () => {
    const planSchema = {
      type: "object",
      additionalProperties: false,
      required: ["choice"],
      properties: {
        choice: { type: "string" },
      },
    }

    test("summary mode writes summary TaskOutput", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "plain answer")
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Summary output",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
            })

            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("completed")
            expect(completed?.output?.mode).toBe("summary")
            expect(completed?.output?.value).toContain("Execution Trajectory")
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("structured mode accepts hidden structured tool output", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              expect(input.tools?.[CortexOutput.STRUCTURED_TOOL_ID]).toBe(true)
              expect(input.ephemeralTools?.[0]?.id).toBe(CortexOutput.STRUCTURED_TOOL_ID)
              return writeStructuredToolResult(input.sessionID, { value: { choice: "drake" } })
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Structured output",
              prompt: "Choose one",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "structured", schema: planSchema },
            })

            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("completed")
            expect(completed?.output).toEqual({
              mode: "structured",
              value: { choice: "drake" },
            })
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("structured resolver accepts draft 2020-12 schemas", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const message = await writeStructuredToolResult(session.id, {
            value: {
              template: "kombucha",
              lines: ["first", "second"],
            },
          })

          const result = await CortexOutput.resolve({
            sessionID: session.id,
            rootMessageID: message.info.rootID!,
            output: {
              mode: "structured",
              schema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                additionalProperties: false,
                required: ["template", "lines"],
                properties: {
                  template: { type: "string", minLength: 1 },
                  lines: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          })

          expect(result).toEqual({
            ok: true,
            output: {
              mode: "structured",
              value: {
                template: "kombucha",
                lines: ["first", "second"],
              },
            },
          })
        },
      })
    })

    test("invalid structured schema fails before invoke", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const invoke = mock(async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
            return writeAssistantText(input.sessionID, "should not run")
          })
          ;(SessionInvoke.invokeInternal as any) = invoke
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Invalid schema",
              prompt: "Choose one",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "structured", schema: { type: "not-a-json-schema-type" } },
            })
            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("error")
            expect(completed?.error).toContain("Structured output schema is not valid JSON Schema")
            expect(invoke).not.toHaveBeenCalled()
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("structured mode falls back to final response JSON", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, '{"choice":"final"}')
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Structured final text",
              prompt: "Choose one",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "structured", schema: planSchema },
            })

            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("completed")
            expect(completed?.output).toEqual({ mode: "structured", value: { choice: "final" } })
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("structured mode runs repair turns until schema is valid", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          let calls = 0
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              calls++
              if (calls === 1) {
                expect(input.tools?.example_business_tool).toBe(true)
                return writeAssistantText(input.sessionID, '{"wrong":true}')
              }
              expect(input.tools).toEqual(CortexOutput.repairTools())
              return writeStructuredToolResult(input.sessionID, { value: { choice: "repaired" } })
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Structured repair",
              prompt: "Choose one",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "structured", schema: planSchema, maxRepairTurns: 3 },
              tools: { example_business_tool: true },
            })

            const completed = await waitUntilTerminal(task.id)
            expect(calls).toBe(2)
            expect(completed?.status).toBe("completed")
            expect(completed?.output).toEqual({ mode: "structured", value: { choice: "repaired" } })
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("structured mode errors after repair budget without writing a fake result", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          let calls = 0
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              calls++
              return writeAssistantText(input.sessionID, '{"wrong":true}')
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Structured failure",
              prompt: "Choose one",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "structured", schema: planSchema, maxRepairTurns: 1 },
            })

            const completed = await waitUntilTerminal(task.id)
            expect(calls).toBe(2)
            expect(completed?.status).toBe("error")
            expect(completed?.output).toBeUndefined()
            expect(completed?.error).toContain("Structured output validation failed after 1 repair turns")
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("final_response captures final assistant text without changing the summary", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "final prose")
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Final response",
              prompt: "Answer",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "final_response" },
            })

            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("completed")
            expect(completed?.output).toEqual({ mode: "final_response", value: "final prose" })
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })
  })

  describe("waitFor integration", () => {
    test("returns immediately for cancelled task", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Task to wait for",
            prompt: "Do something",
            agent: "developer",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          await Cortex.cancel(task.id)

          const result = await Cortex.waitFor(task.id, 5)

          expect(result).toBeDefined()
          expect(result?.status).toBe("cancelled")
        },
      })
    })
  })

  describe("parent completion notification", () => {
    async function waitUntilCompleted(taskID: string) {
      for (let i = 0; i < 50; i++) {
        const task = Cortex.get(taskID)
        if (task?.status === "completed" || task?.status === "error") return task
        await Bun.sleep(10)
      }
      return Cortex.get(taskID)
    }

    test("notifies parent by default when no waiter consumes the result", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const originalDeliver = SessionManager.deliver
          const deliveries: Parameters<typeof SessionManager.deliver>[0][] = []
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          ;(SessionManager.deliver as any) = mock(async (input: Parameters<typeof SessionManager.deliver>[0]) => {
            deliveries.push(input)
          })
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Notify parent",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
            })

            const completed = await waitUntilCompleted(task.id)

            expect(completed?.status).toBe("completed")
            expect(deliveries).toHaveLength(1)
            expect(deliveries[0].target).toBe(parentSession.id)
            expect(deliveries[0].mail.type).toBe("user")
            expect(deliveries[0].mail.metadata?.source).toBe("cortex")
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
            ;(SessionManager.deliver as any) = originalDeliver
          }
        },
      })
    })

    test("suppresses parent notification when notifyParentOnComplete is false", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal2 = SessionInvoke.invokeInternal
          const originalDeliver2 = SessionManager.deliver
          const deliverMock = mock(async () => {})
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          ;(SessionManager.deliver as any) = deliverMock
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Silent parent",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
            })

            const completed = await waitUntilCompleted(task.id)

            expect(completed?.status).toBe("completed")
            expect(deliverMock).not.toHaveBeenCalled()
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal2
            ;(SessionManager.deliver as any) = originalDeliver2
          }
        },
      })
    })
  })

  describe("queued cancellation", () => {
    test("cancelled queued task stays cancelled and never runs", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})
          const agent = "developer"
          const limit = CortexConcurrency.getLimit(agent)

          for (let i = 0; i < limit; i++) {
            await CortexConcurrency.acquire(agent)
          }

          try {
            const { createdTask: queuedTask, launchPromise: queuedPromise } = await launchAndCaptureCreatedTask(
              () =>
                Cortex.launch({
                  description: "Queued task",
                  prompt: "Do something later",
                  agent,
                  parentSessionID: parentSession.id,
                  parentMessageID: "msg_queued",
                }),
              (task) => task.description === "Queued task",
            )
            expect(queuedTask).toBeDefined()
            expect(queuedTask?.status).toBe("queued")

            await Cortex.cancel(queuedTask!.id)
            expect(Cortex.get(queuedTask!.id)?.status).toBe("cancelled")

            for (let i = 0; i < limit; i++) {
              CortexConcurrency.release(agent)
            }

            await queuedPromise
            const finalTask = Cortex.get(queuedTask!.id)
            expect(finalTask?.status).toBe("cancelled")

            const statusAfterSlots = CortexConcurrency.status()[agent]
            expect(statusAfterSlots?.running).toBe(0)
            expect(statusAfterSlots?.queued).toBe(0)
          } finally {
            CortexConcurrency.reset()
          }
        },
      })
    })
  })
})
