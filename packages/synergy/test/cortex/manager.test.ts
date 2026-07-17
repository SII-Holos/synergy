import { describe, expect, test, beforeEach, mock } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { CortexTypes } from "../../src/cortex/types"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { SessionDrive } from "../../src/session/drive"
import { ContinuationWait } from "../../src/session/continuation-wait"
import { Identifier } from "../../src/id/id"
import { CortexOutput } from "../../src/cortex/output"
import { TaskOutputTool } from "../../src/tool/task-output"
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

async function writeAssistantText(sessionID: string, text: string, cost = 0) {
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
    cost,
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

async function writeRunningToolProgress(sessionID: string) {
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
    callID: "call_progress_tool",
    tool: "bash",
    state: {
      status: "running",
      input: { cmd: "pwd" },
      title: "Running pwd",
      metadata: {},
      time: {
        start: Date.now(),
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
    SessionDrive.reset()
    ContinuationWait.reset()
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

    test("publishes cancellation while completion finalization is in progress", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const originalMessages = Session.messages
          const childMayFinish = Promise.withResolvers<void>()
          const usageReadStarted = Promise.withResolvers<void>()
          const releaseUsageRead = Promise.withResolvers<void>()
          const terminalPublished = Promise.withResolvers<CortexTypes.Task>()
          let taskID = ""
          let childSessionID = ""
          const unsubscribe = Bus.subscribe(Cortex.Event.TaskCompleted, (event) => {
            if (event.properties.task.id === taskID) terminalPublished.resolve(event.properties.task)
          })

          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              await childMayFinish.promise
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          ;(Session.messages as any) = mock(async (input: Parameters<typeof Session.messages>[0]) => {
            if (input.sessionID === childSessionID && input.raw) {
              usageReadStarted.resolve()
              await releaseUsageRead.promise
            }
            return originalMessages(input)
          })

          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Cancel during completion finalization",
              prompt: "Complete immediately",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_cancel_finalize_race",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "final_response" },
            })
            taskID = task.id
            childSessionID = task.sessionID
            childMayFinish.resolve()

            await Promise.race([
              usageReadStarted.promise,
              Bun.sleep(1_000).then(() => {
                throw new Error("Task completion did not reach usage finalization")
              }),
            ])

            await Cortex.cancel(task.id)

            expect(Cortex.get(task.id)?.status).toBe("cancelled")

            releaseUsageRead.resolve()
            const terminalTask = await Promise.race([
              terminalPublished.promise,
              Bun.sleep(1_000).then(() => {
                throw new Error("Cancelled task did not finish finalization")
              }),
            ])
            expect(terminalTask.status).toBe("cancelled")
            expect((await Session.get(task.sessionID)).cortex?.status).toBe("cancelled")
          } finally {
            childMayFinish.resolve()
            releaseUsageRead.resolve()
            await Promise.race([terminalPublished.promise, Bun.sleep(1_000)])
            unsubscribe()
            ;(Session.messages as any) = originalMessages
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
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

    test("emits visible task updates when child session progress changes", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const progressUpdates: CortexTypes.Task[] = []
          const unsubscribe = Bus.subscribe(Cortex.Event.TasksUpdated, (event) => {
            for (const task of event.properties.tasks) {
              if (task.progress?.lastTool === "bash") progressUpdates.push(task)
            }
          })
          let releaseInvoke: (() => void) | undefined
          let taskID: string | undefined
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              await writeRunningToolProgress(input.sessionID)
              await writeAssistantText(input.sessionID, "partial status")
              await new Promise<void>((resolve) => {
                releaseInvoke = resolve
              })
              return writeAssistantText(input.sessionID, "done")
            },
          )

          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Progress task",
              prompt: "Run a tool",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "final_response" },
            })
            taskID = task.id

            let progressTask: CortexTypes.Task | undefined
            for (let i = 0; i < 30; i++) {
              progressTask = progressUpdates.find((item) => item.id === task.id)
              if (progressTask) break
              await Bun.sleep(25)
            }

            expect(progressTask?.status).toBe("running")
            expect(progressTask?.progress?.toolCalls).toBe(1)
            expect(progressTask?.progress?.lastTool).toBe("bash")
            expect(progressTask?.progress?.lastToolStatus).toBe("running")
            expect(progressTask?.progress?.lastMessage).toBe("partial status")

            releaseInvoke?.()
            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("completed")
          } finally {
            releaseInvoke?.()
            if (taskID && Cortex.get(taskID)?.status === "running") await Cortex.cancel(taskID)
            unsubscribe()
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
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
    test("discards task output when actual usage exceeds the cost budget", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "over budget", 0.02)
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Cost bounded response",
              prompt: "Answer",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              notifyParentOnComplete: false,
              output: { mode: "final_response" },
              maxCost: 0.01,
            })

            const completed = await waitUntilTerminal(task.id)
            expect(completed?.status).toBe("error")
            expect(completed?.output).toBeUndefined()
            expect(completed?.usage?.cost).toBe(0.02)
            expect(completed?.error).toContain("cost budget")
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
    type TaskOutputInstance = Awaited<ReturnType<typeof TaskOutputTool.init>>
    type TaskOutputParams = Parameters<TaskOutputInstance["execute"]>[0]
    type TaskOutputContext = Parameters<TaskOutputInstance["execute"]>[1]

    async function waitUntilCompleted(taskID: string) {
      for (let i = 0; i < 50; i++) {
        const task = Cortex.get(taskID)
        if (task?.status === "completed" || task?.status === "error") return task
        await Bun.sleep(10)
      }
      return Cortex.get(taskID)
    }

    function taskOutputContext(sessionID: string): TaskOutputContext {
      return {
        sessionID,
        messageID: "msg_parent01234567890abc",
        agent: "synergy",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      }
    }

    async function persistTaskOutput(tool: TaskOutputInstance, params: TaskOutputParams, ctx: TaskOutputContext) {
      const result = await tool.execute(params, ctx)
      await tool.afterPersist?.(params, ctx, result)
      return result
    }

    async function waitForNotification(parentSessionID: string, taskID: string) {
      const deliveryKey = `cortex:taskNotification:${taskID}`
      for (let i = 0; i < 50; i++) {
        const item = (await SessionInbox.list(parentSessionID)).find(
          (candidate) => candidate.deliveryKey === deliveryKey,
        )
        if (item) return item
        await Bun.sleep(10)
      }
      return (await SessionInbox.list(parentSessionID)).find((candidate) => candidate.deliveryKey === deliveryKey)
    }

    test("persists one parent notification by default when no waiter consumes the result", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
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
            const notification = await waitForNotification(parentSession.id, task.id)

            expect(completed?.status).toBe("completed")
            expect(notification).toBeDefined()
            expect(notification?.deliveryKey).toBe(`cortex:taskNotification:${task.id}`)
            expect(notification?.mode).toBe("steer")
            expect(notification?.source.type).toBe("cortex")
            expect(notification?.message?.metadata?.source).toBe("cortex")
            expect((await Session.get(task.sessionID)).cortex?.deliveryNotifiedAt).toBeNumber()

            await Cortex.reconcileParentNotifications()

            expect(await SessionInbox.list(parentSession.id)).toHaveLength(1)
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("publishes the terminal task before an idle parent processes its completion notice", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const originalLoop = SessionInvoke.loop
          let parentSessionID = ""
          let taskID = ""
          let resolveObservedOutput!: (output: string) => void
          const observedOutput = new Promise<string>((resolve) => {
            resolveObservedOutput = resolve
          })

          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "final prose")
            },
          )
          ;(SessionInvoke.loop as any) = mock(async (sessionID: string) => {
            if (sessionID === parentSessionID && taskID) {
              resolveObservedOutput(await Cortex.output(taskID, "full"))
            }
          })

          try {
            const parentSession = await Session.create({})
            parentSessionID = parentSession.id
            const rootID = Identifier.ascending("message")
            await Session.updateMessage({
              id: rootID,
              role: "user",
              sessionID: parentSession.id,
              time: { created: Date.now() },
              agent: "synergy",
              model: { providerID: "test-provider", modelID: "test-model" },
              isRoot: true,
              rootID,
            } as any)
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: rootID,
              sessionID: parentSession.id,
              type: "text",
              text: "parent root",
            })

            const { createdTask, launchPromise } = await launchAndCaptureCreatedTask(
              () =>
                Cortex.launch({
                  description: "Notify idle parent with terminal output",
                  prompt: "Do something",
                  agent: "developer",
                  parentSessionID: parentSession.id,
                  parentMessageID: rootID,
                  model: { providerID: "test-provider", modelID: "test-model" },
                  output: { mode: "final_response" },
                }),
              (task) => task.parentSessionID === parentSession.id,
            )
            taskID = createdTask.id
            await launchPromise

            const output = await Promise.race([
              observedOutput,
              Bun.sleep(1_000).then(() => {
                throw new Error("Parent session was not woken for the Cortex completion notice")
              }),
            ])

            expect(output).toContain("Status: completed")
            expect(output).toContain("--- Result ---")
            expect(output).toContain("final prose")
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
            ;(SessionInvoke.loop as any) = originalLoop
            if (parentSessionID) SessionManager.unregisterRuntime(parentSessionID)
          }
        },
      })
    })

    test("publishes the terminal task before a concurrently starting parent observes its completion notice", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const childMayFinish = Promise.withResolvers<void>()
          const observedOutput = Promise.withResolvers<string>()
          let parentSessionID = ""
          let taskID = ""
          let parentLease: SessionManager.LoopLease | undefined
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              await childMayFinish.promise
              return writeAssistantText(input.sessionID, "final prose")
            },
          )
          const unsubscribe = Bus.subscribe(SessionInbox.Event.Updated, async (event) => {
            if (event.properties.sessionID !== parentSessionID || !taskID) return
            if (!event.properties.items.some((item) => item.message?.metadata?.source === "cortex")) return
            parentLease = SessionManager.acquire(parentSessionID)
            expect(parentLease).toBeDefined()
            observedOutput.resolve(await Cortex.output(taskID, "full"))
          })

          try {
            const parentSession = await Session.create({})
            parentSessionID = parentSession.id
            const rootID = Identifier.ascending("message")
            await Session.updateMessage({
              id: rootID,
              role: "user",
              sessionID: parentSession.id,
              time: { created: Date.now() },
              agent: "synergy",
              model: { providerID: "test-provider", modelID: "test-model" },
              isRoot: true,
              rootID,
            } as any)
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: rootID,
              sessionID: parentSession.id,
              type: "text",
              text: "parent root",
            })

            const task = await Cortex.launch({
              description: "Notify concurrently starting parent with terminal output",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: rootID,
              model: { providerID: "test-provider", modelID: "test-model" },
              output: { mode: "final_response" },
            })
            taskID = task.id
            childMayFinish.resolve()

            const output = await Promise.race([
              observedOutput.promise,
              Bun.sleep(1_000).then(() => {
                throw new Error("Cortex completion notice was not observed")
              }),
            ])
            await waitUntilTerminal(taskID)

            expect(output).toContain("Status: completed")
            expect(output).toContain("--- Result ---")
            expect(output).toContain("final prose")
          } finally {
            childMayFinish.resolve()
            unsubscribe()
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
            if (parentLease) await SessionManager.release(parentLease)
            if (parentSessionID) SessionManager.unregisterRuntime(parentSessionID)
          }
        },
      })
    })

    test("persists the parent notification while the parent is mid-turn", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          let parentLease: SessionManager.LoopLease | undefined
          let parentSessionID = ""
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          try {
            const parentSession = await Session.create({})
            parentSessionID = parentSession.id
            parentLease = SessionManager.acquire(parentSession.id)
            expect(parentLease).toBeDefined()
            const task = await Cortex.launch({
              description: "Persist mid-turn parent notification",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
            })

            expect((await waitUntilCompleted(task.id))?.status).toBe("completed")
            const notification = await waitForNotification(parentSession.id, task.id)

            expect(SessionManager.isRunning(parentSession.id)).toBe(true)
            expect(notification?.deliveryKey).toBe(`cortex:taskNotification:${task.id}`)

            await SessionManager.release(parentLease!)
            parentLease = undefined

            expect(await SessionInbox.list(parentSession.id)).toHaveLength(1)
          } finally {
            if (parentLease) await SessionManager.release(parentLease)
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
            if (parentSessionID) SessionManager.unregisterRuntime(parentSessionID)
          }
        },
      })
    })

    test("removes a terminal notification after task output is persisted", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          try {
            const parentSession = await Session.create({})
            const taskOutput = await TaskOutputTool.init()
            const ctx = taskOutputContext(parentSession.id)
            for (const mode of ["summary", "progress", "tail", "full"] as const) {
              const task = await Cortex.launch({
                description: `Consume ${mode} task result`,
                prompt: "Do something",
                agent: "developer",
                parentSessionID: parentSession.id,
                parentMessageID: "msg_test01234567890abc",
                model: { providerID: "test-provider", modelID: "test-model" },
                output: { mode: "final_response" },
              })

              expect((await waitUntilCompleted(task.id))?.status).toBe("completed")
              expect(await waitForNotification(parentSession.id, task.id)).toBeDefined()

              const result = await persistTaskOutput(taskOutput, { task_id: task.id, mode }, ctx)

              expect(result.metadata.status).toBe("completed")
              expect(await SessionInbox.list(parentSession.id)).toHaveLength(0)
              expect((await Session.get(task.sessionID)).cortex?.notifyParentOnComplete).toBe(false)
            }
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("acknowledges a persisted result after in-memory task eviction", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Consume evicted task result",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
              output: { mode: "final_response" },
            })
            expect((await waitUntilCompleted(task.id))?.status).toBe("completed")
            expect(await waitForNotification(parentSession.id, task.id)).toBeDefined()

            const taskOutput = await TaskOutputTool.init()
            const params: TaskOutputParams = { task_id: task.id, mode: "full" }
            const ctx = taskOutputContext(parentSession.id)
            const result = await taskOutput.execute(params, ctx)
            expect(result.metadata.status).toBe("completed")

            Cortex.reset()
            expect(Cortex.get(task.id)).toBeUndefined()
            await taskOutput.afterPersist?.(params, ctx, result)

            expect(await SessionInbox.list(parentSession.id)).toHaveLength(0)
            expect((await Session.get(task.sessionID)).cortex?.notifyParentOnComplete).toBe(false)
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("keeps notification enabled when task output observes only a running task", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          const childMayFinish = Promise.withResolvers<void>()
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              await childMayFinish.promise
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          try {
            const parentSession = await Session.create({})
            const task = await Cortex.launch({
              description: "Observe running task",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
            })
            const taskOutput = await TaskOutputTool.init()
            const result = await persistTaskOutput(
              taskOutput,
              { task_id: task.id, mode: "progress" },
              taskOutputContext(parentSession.id),
            )

            expect(result.metadata.status).toBe("running")
            childMayFinish.resolve()
            expect((await waitUntilCompleted(task.id))?.status).toBe("completed")

            expect(await waitForNotification(parentSession.id, task.id)).toBeDefined()
            expect((await Session.get(task.sessionID)).cortex?.notifyParentOnComplete).toBe(true)
          } finally {
            childMayFinish.resolve()
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("only acknowledges the completion notification for the task that was observed", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
          try {
            const parentSession = await Session.create({})
            const first = await Cortex.launch({
              description: "Observed task",
              prompt: "Do something",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
            })
            const second = await Cortex.launch({
              description: "Unobserved task",
              prompt: "Do something else",
              agent: "developer",
              parentSessionID: parentSession.id,
              parentMessageID: "msg_test01234567890abc",
              model: { providerID: "test-provider", modelID: "test-model" },
            })
            expect((await waitUntilCompleted(first.id))?.status).toBe("completed")
            expect((await waitUntilCompleted(second.id))?.status).toBe("completed")
            expect(await waitForNotification(parentSession.id, first.id)).toBeDefined()
            expect(await waitForNotification(parentSession.id, second.id)).toBeDefined()

            const taskOutput = await TaskOutputTool.init()
            await persistTaskOutput(
              taskOutput,
              { task_id: first.id, mode: "full" },
              taskOutputContext(parentSession.id),
            )

            const items = await SessionInbox.list(parentSession.id)
            expect(items).toHaveLength(1)
            expect(items[0].deliveryKey).toBe(`cortex:taskNotification:${second.id}`)
            expect((await Session.get(first.sessionID)).cortex?.notifyParentOnComplete).toBe(false)
            expect((await Session.get(second.sessionID)).cortex?.notifyParentOnComplete).toBe(true)
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
          }
        },
      })
    })

    test("suppresses parent notification when notifyParentOnComplete is false", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const originalInvokeInternal = SessionInvoke.invokeInternal
          ;(SessionInvoke.invokeInternal as any) = mock(
            async (input: Parameters<typeof SessionInvoke.invokeInternal>[0]) => {
              return writeAssistantText(input.sessionID, "completed")
            },
          )
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

            expect((await waitUntilCompleted(task.id))?.status).toBe("completed")

            await Cortex.reconcileParentNotifications()

            expect(await SessionInbox.list(parentSession.id)).toHaveLength(0)
            expect((await Session.get(task.sessionID)).cortex?.notifyParentOnComplete).toBe(false)
          } finally {
            ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
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
