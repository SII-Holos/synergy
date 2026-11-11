import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type {
  OrganizationReadProtocol as Read,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationTaskDirectory } from "../../src/organization/task-directory"
const binding = {
  schemaVersion: 1,
  orgID: "org-one",
  projectID: "project-one",
  creatorID: "account-one",
  driverRuntimeID: "runtime-one",
  bindingEpoch: 1,
} as const
const task = (id: string): Sync.TaskSummary => ({
  sessionID: id,
  taskID: `task-${id}`,
  parentSessionID: "session-one",
  parentMessageID: "message-one",
  status: "running",
  description: `Inspect ${id}`,
  startedAt: 1,
})
const page = (items: Sync.TaskSummary[], cursor?: string): Read.Result => ({
  operation: "tasks",
  rootSessionID: "session-one",
  sourceSessionID: "session-one",
  binding,
  items,
  total: Math.max(1, items.length),
  cursor,
})
test("private tasks reuse the supplied captured dispatcher and its canonical root/source query", async () => {
  const queries: Read.Input[] = []
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationTaskDirectory({
      sessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      async read(query) {
        queries.push(query)
        return page([task("child-one")])
      },
    }),
  }))
  try {
    await scope.directory.load()
    expect(queries).toEqual([
      { operation: "tasks", rootSessionID: "session-one", sourceSessionID: "session-one", limit: 32 },
    ])
    expect(scope.directory.state.items[0]?.sessionID).toBe("child-one")
  } finally {
    scope.dispose()
  }
})
test("empty continuation pages remain reachable and polling cannot reset the last task window", async () => {
  const queries: Read.Input[] = []
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationTaskDirectory({
      sessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      async read(query) {
        queries.push(query)
        return page(
          query.operation === "tasks" && query.cursor ? [task("tail-child")] : [],
          query.operation === "tasks" && query.cursor ? undefined : "next-page",
        )
      },
    }),
  }))
  try {
    await scope.directory.load()
    expect(scope.directory.state.items).toHaveLength(0)
    expect(scope.directory.cursor()).toBe("next-page")
    await scope.directory.load(true)
    expect(scope.directory.state.items[0]?.sessionID).toBe("tail-child")
    await scope.directory.load(false, true)
    expect(queries).toHaveLength(2)
    expect(scope.directory.state.items[0]?.sessionID).toBe("tail-child")
    expect(scope.directory.earlier()).toBe(true)
    await scope.directory.load()
    expect(queries).toHaveLength(3)
    expect(scope.directory.earlier()).toBe(false)
    expect(scope.directory.cursor()).toBe("next-page")
  } finally {
    scope.dispose()
  }
})
test("a shared task page cannot cross its source, generation or immutable page watermark", async () => {
  for (const changed of [{ sourceSessionID: "foreign-source" }, { shareGeneration: 2 }]) {
    const scope = createRoot((dispose) => ({
      dispose,
      directory: createOrganizationTaskDirectory({
        sessionID: "session-one",
        binding,
        signal: new AbortController().signal,
        async read() {
          throw new Error("A shared panel must not acquire private history")
        },
        shared: {
          generation: 1,
          async load() {
            return {
              sessionID: "session-one",
              sourceSessionID: "session-one",
              shareGeneration: 1,
              watermark: 40,
              items: [task("child-one")],
              ...changed,
            }
          },
        },
      }),
    }))
    try {
      await scope.directory.load()
      expect(scope.directory.state.items).toHaveLength(0)
      expect(scope.directory.error()).toMatchObject({ code: "invalid_response" })
    } finally {
      scope.dispose()
    }
  }
  const queries: Sync.TaskQuery[] = []
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationTaskDirectory({
      sessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      async read() {
        throw new Error("A shared panel must not acquire private history")
      },
      shared: {
        generation: 1,
        async load(query) {
          queries.push(query)
          return {
            sessionID: "session-one",
            sourceSessionID: "session-one",
            shareGeneration: 1,
            watermark: query.cursor ? 41 : 40,
            cursor: "more",
            items: [task(query.cursor ? "child-two" : "child-one")],
          }
        },
      },
    }),
  }))
  try {
    await scope.directory.load()
    await scope.directory.load(true)
    expect(queries[1]?.watermark).toBe(40)
    expect(scope.directory.state.items[0]?.sessionID).toBe("child-one")
    expect(scope.directory.error()).toMatchObject({ code: "invalid_response" })
  } finally {
    scope.dispose()
  }
})
test("a task row must belong to the queried parent and cannot name the source as its child", async () => {
  for (const item of [{ ...task("child-one"), parentSessionID: "foreign-parent" }, task("session-one")]) {
    const scope = createRoot((dispose) => ({
      dispose,
      directory: createOrganizationTaskDirectory({
        sessionID: "session-one",
        binding,
        signal: new AbortController().signal,
        async read() {
          return page([item])
        },
      }),
    }))
    try {
      await scope.directory.load()
      expect(scope.directory.state.items).toHaveLength(0)
      expect(scope.directory.error()).toMatchObject({ code: "invalid_response" })
    } finally {
      scope.dispose()
    }
  }
})
test("owner loss clears task metadata while an aborted late reply cannot restore it or notify a new view", async () => {
  const pending = Promise.withResolvers<Read.Result>()
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  let notifications = 0
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationTaskDirectory({
      sessionID: "session-one",
      binding,
      signal: controller.signal,
      async read() {
        entered.resolve()
        return pending.promise
      },
      invalidated() {
        notifications++
      },
    }),
  }))
  try {
    const loading = scope.directory.load()
    await entered.promise
    controller.abort()
    pending.resolve(page([task("old-child")]))
    await loading
    expect(scope.directory.state.items).toHaveLength(0)
    expect(notifications).toBe(0)
  } finally {
    scope.dispose()
  }
  const denied = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationTaskDirectory({
      sessionID: "session-one",
      binding,
      signal: new AbortController().signal,
      async read() {
        throw { code: "permission_denied" }
      },
      invalidated() {
        notifications++
      },
    }),
  }))
  try {
    await denied.directory.load()
    expect(denied.directory.state.items).toHaveLength(0)
    expect(notifications).toBe(1)
  } finally {
    denied.dispose()
  }
})
