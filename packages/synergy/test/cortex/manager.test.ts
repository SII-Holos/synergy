import { describe, expect, test, beforeEach } from "bun:test"
import { Cortex, CortexConcurrency } from "../../src/cortex"
import { CortexTypes } from "../../src/cortex/types"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
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

describe("Cortex", () => {
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const rootSession = await Session.create({})
          const agent = "master"
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
      await Instance.provide({
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
            agent: "master",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          // Check immediately before async runTask() can error
          expect(task).toBeDefined()
          expect(task.id).toMatch(/^ctx_/)
          // Task status is set to "running" synchronously before runTask starts
          expect(task.status).toBe("running")
          expect(task.description).toBe("Test task")
          expect(task.agent).toBe("master")
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Visual task",
            prompt: "Design something",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Custom model task",
            prompt: "Do something",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task",
            prompt: "Do something",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Test task to cancel",
            prompt: "Do something slowly",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          // Launch two tasks
          const task1 = await Cortex.launch({
            description: "Task 1",
            prompt: "Do something",
            agent: "master",
            parentSessionID: parentSession.id,
            parentMessageID: "msg_test01234567890abc",
          })

          const task2 = await Cortex.launch({
            description: "Task 2",
            prompt: "Do something else",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Running task",
            prompt: "Do something",
            agent: "master",
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Task to cancel",
            prompt: "Do something",
            agent: "master",
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

  describe("waitFor integration", () => {
    test("returns immediately for cancelled task", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})

          const task = await Cortex.launch({
            description: "Task to wait for",
            prompt: "Do something",
            agent: "master",
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

  describe("queued cancellation", () => {
    test("cancelled queued task stays cancelled and never runs", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const parentSession = await Session.create({})
          const agent = "master"
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
