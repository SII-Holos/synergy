import { describe, expect, test } from "bun:test"

describe("Clarus hierarchy model: task priority sorting", () => {
  test("sortTasksByPriority orders tasks by priority then latest activity tie-break", async () => {
    const { sortTasksByPriority } = await import("../clarus/hierarchy")

    const tasks = [
      { taskId: "t1", sessionID: "s1", title: "Z", status: "submitted", resultState: "idle", updatedAt: 100 },
      { taskId: "t2", sessionID: "s2", title: "A", status: "running", resultState: "idle", updatedAt: 50 },
      { taskId: "t3", sessionID: "s3", title: "M", status: "failed", resultState: "idle", updatedAt: 999 },
      { taskId: "t4", sessionID: "s4", title: "B", status: "needs_attention", resultState: "idle", updatedAt: 10 },
      { taskId: "t5", sessionID: "s5", title: "X", status: "cancelled", resultState: "idle", updatedAt: 50 },
    ]

    const sorted = sortTasksByPriority(tasks)

    expect(sorted[0]!.taskId).toBe("t4") // needs_attention — highest priority
    expect(sorted[1]!.taskId).toBe("t2") // running
    expect(sorted[4]!.taskId).toBe("t5") // cancelled — lowest priority
  })

  test("sortTasksByPriority uses updatedAt to break ties within the same status", async () => {
    const { sortTasksByPriority } = await import("../clarus/hierarchy")

    const tasks = [
      { taskId: "a", sessionID: "s1", title: "older", status: "running", resultState: "idle", updatedAt: 10 },
      { taskId: "b", sessionID: "s2", title: "newer", status: "running", resultState: "idle", updatedAt: 200 },
    ]

    const sorted = sortTasksByPriority(tasks)

    // Same priority band — later updatedAt wins (more recent activity first)
    expect(sorted[0]!.taskId).toBe("b")
    expect(sorted[1]!.taskId).toBe("a")
  })

  test("sortTasksByPriority is a pure function — does not mutate input", async () => {
    const { sortTasksByPriority } = await import("../clarus/hierarchy")

    const tasks = [
      { taskId: "t1", sessionID: "s1", title: "X", status: "running", resultState: "idle", updatedAt: 100 },
    ]
    const original = [...tasks]

    sortTasksByPriority(tasks)

    expect(tasks[0]).toBe(original[0]) // same reference, no mutation side-effect
  })
})

describe("Clarus hierarchy model: buildHierarchy grouping", () => {
  test("groups projects into active and inactive with history", async () => {
    const { buildHierarchy } = await import("../clarus/hierarchy")

    const projects = [
      {
        projectId: "p1",
        projectName: "Active Project",
        lifecycle: "active" as const,
        desiredSubscription: true,
        lastProjectActivityAt: 1000,
      },
      {
        projectId: "p2",
        projectName: "Done Project",
        lifecycle: "inactive" as const,
        desiredSubscription: false,
        lastProjectActivityAt: 500,
      },
    ]

    const projectTasks: Record<
      string,
      Array<{
        taskId: string
        sessionID: string
        title: string
        status: string
        resultState: string
        updatedAt: number
      }>
    > = {
      p2: [
        { taskId: "t9", sessionID: "s9", title: "Old task", status: "completed", resultState: "idle", updatedAt: 100 },
      ],
    }

    const hierarchy = buildHierarchy(projects, projectTasks, "connected")

    expect(hierarchy.activeProjects).toHaveLength(1)
    expect(hierarchy.activeProjects[0]!.projectId).toBe("p1")
    expect(hierarchy.inactiveProjectsWithHistory).toHaveLength(1)
    expect(hierarchy.inactiveProjectsWithHistory[0]!.projectId).toBe("p2")
  })

  test("omits inactive projects that have no durable task history", async () => {
    const { buildHierarchy } = await import("../clarus/hierarchy")

    const projects = [
      {
        projectId: "ghost",
        projectName: "Forgotten",
        lifecycle: "inactive" as const,
        desiredSubscription: false,
        lastProjectActivityAt: 0,
      },
      {
        projectId: "active",
        projectName: "Current",
        lifecycle: "active" as const,
        desiredSubscription: true,
        lastProjectActivityAt: 10,
      },
    ]

    // No tasks for ghost project
    const projectTasks: Record<
      string,
      Array<{
        taskId: string
        sessionID: string
        title: string
        status: string
        resultState: string
        updatedAt: number
      }>
    > = {}

    const hierarchy = buildHierarchy(projects, projectTasks, "connected")

    expect(hierarchy.activeProjects).toHaveLength(1)
    expect(hierarchy.activeProjects[0]!.projectId).toBe("active")
    expect(hierarchy.inactiveProjectsWithHistory).toHaveLength(0)
  })

  test("active project with zero tasks is still in the active group", async () => {
    const { buildHierarchy } = await import("../clarus/hierarchy")

    const projects = [
      {
        projectId: "empty-active",
        projectName: "Just Created",
        lifecycle: "active" as const,
        desiredSubscription: true,
        lastProjectActivityAt: 1,
      },
    ]

    const projectTasks: Record<
      string,
      Array<{
        taskId: string
        sessionID: string
        title: string
        status: string
        resultState: string
        updatedAt: number
      }>
    > = {}

    const hierarchy = buildHierarchy(projects, projectTasks, "connected")

    expect(hierarchy.activeProjects).toHaveLength(1)
    expect(hierarchy.activeProjects[0]!.projectId).toBe("empty-active")
    expect(hierarchy.inactiveProjectsWithHistory).toHaveLength(0)
  })

  test("records the connection status on the hierarchy", async () => {
    const { buildHierarchy } = await import("../clarus/hierarchy")

    const projects: Array<{
      projectId: string
      projectName: string
      lifecycle: "active" | "inactive"
      desiredSubscription: boolean
      lastProjectActivityAt: number
    }> = []
    const projectTasks: Record<
      string,
      Array<{
        taskId: string
        sessionID: string
        title: string
        status: string
        resultState: string
        updatedAt: number
      }>
    > = {}

    for (const status of ["disabled", "connected", "reconnecting", "sign_in_required", "sync_failed"] as const) {
      const hierarchy = buildHierarchy(projects, projectTasks, status)
      expect(hierarchy.connectionStatus).toBe(status)
    }
  })
})

describe("Clarus hierarchy model: empty project text", () => {
  test("EMPTY_PROJECT_TASKS_TEXT is 'No tasks yet'", async () => {
    const { EMPTY_PROJECT_TASKS_TEXT } = await import("../clarus/hierarchy")
    expect(EMPTY_PROJECT_TASKS_TEXT).toBe("No tasks yet")
  })
})

describe("Clarus hierarchy model: task route construction", () => {
  test("buildTaskRoute uses HOME_SCOPE_KEY and sessionID only — no directory or path", async () => {
    const { buildTaskRoute } = await import("../clarus/hierarchy")

    const route = buildTaskRoute("ses_abc123")

    expect(route.scopeType).toBe("home")
    expect(route.sessionID).toBe("ses_abc123")
    expect(route).not.toHaveProperty("directory")
    expect(route).not.toHaveProperty("path")
    expect(route).not.toHaveProperty("worktree")
  })

  test("buildTaskRoute rejects empty sessionID", async () => {
    const { buildTaskRoute } = await import("../clarus/hierarchy")

    expect(() => buildTaskRoute("")).toThrow()
  })
})

describe("Clarus hierarchy model: stale data retention", () => {
  test("retainStaleHierarchy returns previous when current is null and previous exists", async () => {
    const { retainStaleHierarchy, buildHierarchy } = await import("../clarus/hierarchy")

    const previous = buildHierarchy(
      [
        {
          projectId: "p1",
          projectName: "Last Known",
          lifecycle: "active",
          desiredSubscription: true,
          lastProjectActivityAt: 1,
        },
      ],
      {},
      "connected",
    )

    const result = retainStaleHierarchy(null, previous)
    expect(result).not.toBeNull()
    expect(result!.activeProjects).toHaveLength(1)
    expect(result!.activeProjects[0]!.projectId).toBe("p1")
  })

  test("retainStaleHierarchy returns current when available", async () => {
    const { retainStaleHierarchy, buildHierarchy } = await import("../clarus/hierarchy")

    const current = buildHierarchy(
      [
        {
          projectId: "fresh",
          projectName: "Fresh",
          lifecycle: "active",
          desiredSubscription: true,
          lastProjectActivityAt: 1,
        },
      ],
      {},
      "connected",
    )

    const previous = buildHierarchy(
      [
        {
          projectId: "stale",
          projectName: "Stale",
          lifecycle: "active",
          desiredSubscription: true,
          lastProjectActivityAt: 1,
        },
      ],
      {},
      "connected",
    )

    const result = retainStaleHierarchy(current, previous)
    expect(result).toBe(current) // same reference — current wins
  })

  test("retainStaleHierarchy returns null when both current and previous are null", async () => {
    const { retainStaleHierarchy } = await import("../clarus/hierarchy")

    const result = retainStaleHierarchy(null, null)
    expect(result).toBeNull()
  })
})

describe("Clarus hierarchy model: connection status constants", () => {
  test("exactly five public connection statuses match the navigation contract", async () => {
    const { CLARUS_CONNECTION_STATUSES } = await import("../clarus/hierarchy")

    // Must be a defined array of exactly 5 strings
    expect(Array.isArray(CLARUS_CONNECTION_STATUSES)).toBe(true)
    expect(CLARUS_CONNECTION_STATUSES).toHaveLength(5)

    // All five states from the authoritative public contract
    expect(CLARUS_CONNECTION_STATUSES).toContain("disabled")
    expect(CLARUS_CONNECTION_STATUSES).toContain("connected")
    expect(CLARUS_CONNECTION_STATUSES).toContain("reconnecting")
    expect(CLARUS_CONNECTION_STATUSES).toContain("sign_in_required")
    expect(CLARUS_CONNECTION_STATUSES).toContain("sync_failed")
  })
})

describe("Clarus hierarchy model: task priority ordering constants", () => {
  test("TASK_PRIORITY_ORDER defines all eight task statuses with numeric weights", async () => {
    const { TASK_PRIORITY_ORDER } = await import("../clarus/hierarchy")

    const expectedStatuses = [
      "needs_attention",
      "running",
      "submitting",
      "waiting",
      "submitted",
      "failed",
      "expired",
      "cancelled",
    ]

    expect(typeof TASK_PRIORITY_ORDER).toBe("object")
    expect(TASK_PRIORITY_ORDER).not.toBeNull()

    for (const status of expectedStatuses) {
      expect(TASK_PRIORITY_ORDER).toHaveProperty(status)
      expect(typeof TASK_PRIORITY_ORDER[status]).toBe("number")
    }
  })

  test("TASK_PRIORITY_ORDER is monotonic — higher priority means lower weight", async () => {
    const { TASK_PRIORITY_ORDER } = await import("../clarus/hierarchy")

    // needs_attention is the most urgent — smallest weight
    expect(TASK_PRIORITY_ORDER["needs_attention"]).toBeLessThan(TASK_PRIORITY_ORDER["running"])
    expect(TASK_PRIORITY_ORDER["running"]).toBeLessThan(TASK_PRIORITY_ORDER["submitting"])
    expect(TASK_PRIORITY_ORDER["submitting"]).toBeLessThan(TASK_PRIORITY_ORDER["waiting"])
    expect(TASK_PRIORITY_ORDER["waiting"]).toBeLessThan(TASK_PRIORITY_ORDER["submitted"])
    expect(TASK_PRIORITY_ORDER["submitted"]).toBeLessThan(TASK_PRIORITY_ORDER["failed"])
    expect(TASK_PRIORITY_ORDER["failed"]).toBeLessThan(TASK_PRIORITY_ORDER["expired"])
    expect(TASK_PRIORITY_ORDER["expired"]).toBeLessThan(TASK_PRIORITY_ORDER["cancelled"])
  })
})
