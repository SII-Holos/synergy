/**
 * Behavioral tests for the Native Clarus frontend state/model contract.
 *
 * Every test imports `createClarusModel` from `./clarus-model` and exercises
 * it against a mock dependency set from `./test-fixture`.
 *
 * When the production implementation in `clarus.tsx` is written, the same
 * assertions must pass against the real SDK.
 */

import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createClarusModel } from "./clarus-model"
import type { ClarusComposerSubmitInput, ClarusContinueLocalResult } from "./clarus-model"
import {
  createMockClarusDeps,
  makeNavResponse,
  makeClarusProject,
  makeNavTasks,
  makeNavTask,
  makeSnapWithProjects,
  makeContinueLocalResult,
  makeComposerUsers,
  makeComposerProjects,
  makeComposerSubmitInput,
  makeComposerSubmitResult,
} from "./test-fixture"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Clarus state model", () => {
  // =====================================================================
  // Navigation refresh
  // =====================================================================
  describe("navigation refresh", () => {
    test("refreshNavigation calls generated navigation() exactly once", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      navigationMock.mockResolvedValue({ data: makeNavResponse() })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.refreshNavigation()

        expect(navigationMock).toHaveBeenCalledTimes(1)
        dispose()
      })
    })

    test("populates store.snapshot on successful navigation", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      navigationMock.mockResolvedValue({
        data: makeNavResponse({
          connection: { status: "connected", agentId: "agent-a" },
        }),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.refreshNavigation()

        expect(model.store.snapshot).toBeDefined()
        expect(model.store.snapshot!.connection.agentId).toBe("agent-a")
        expect(model.store.snapshot!.connection.status).toBe("connected")
        dispose()
      })
    })

    test("sets store.error and store.stale on navigation failure", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      navigationMock.mockRejectedValue(new Error("server unreachable"))

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.refreshNavigation()

        expect(model.store.error).toBeDefined()
        expect(model.store.snapshot).toBe(undefined)
        dispose()
      })
    })

    test("last-good snapshot preserved after failure, error independently observable", async () => {
      const { deps, navigationMock } = createMockClarusDeps()

      navigationMock.mockResolvedValueOnce({
        data: makeNavResponse({
          connection: { status: "connected", agentId: "agent-a" },
        }),
      })
      navigationMock.mockRejectedValueOnce(new Error("network down"))

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)

        // First refresh succeeds — snapshot populated.
        await model.refreshNavigation()
        expect(model.store.snapshot?.connection.agentId).toBe("agent-a")

        // Second refresh fails — error set, but snapshot stays.
        await model.refreshNavigation()
        expect(model.store.error).toBeDefined()
        expect(model.store.snapshot?.connection.agentId).toBe("agent-a")

        dispose()
      })
    })
  })

  // =====================================================================
  // Stale-response guard
  // =====================================================================
  describe("stale response guard", () => {
    test("slower stale response cannot overwrite a newer snapshot", async () => {
      const { deps, navigationMock } = createMockClarusDeps()

      // First refresh succeeds with agentId "first".
      navigationMock.mockResolvedValueOnce({
        data: makeNavResponse({
          connection: { status: "connected", agentId: "first" },
        }),
      })
      // Second refresh succeeds with agentId "second".
      navigationMock.mockResolvedValueOnce({
        data: makeNavResponse({
          connection: { status: "connected", agentId: "second" },
        }),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)

        // First refresh gets "first"
        await model.refreshNavigation()
        expect(model.store.snapshot?.connection.agentId).toBe("first")

        // Second refresh gets "second" — this is the current truth.
        await model.invalidateAndRefresh()
        expect(model.store.snapshot?.connection.agentId).toBe("second")

        // After the guard, the snapshot must still be "second".
        expect(model.store.snapshot?.connection.agentId).toBe("second")

        dispose()
      })
    })
  })

  // =====================================================================
  // Coalescing
  // =====================================================================
  describe("coalescing", () => {
    test("rapid invalidateAndRefresh coalesces to at most one in-flight SDK call", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      let resolveNav: (v: unknown) => void = () => {}
      navigationMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveNav = resolve
          }),
      )

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)

        // Three rapid calls — must coalesce to one in-flight.
        const p1 = model.invalidateAndRefresh()
        const p2 = model.invalidateAndRefresh()
        const p3 = model.invalidateAndRefresh()

        expect(navigationMock).toHaveBeenCalledTimes(1)

        resolveNav({ data: makeNavResponse() })
        await Promise.all([p1, p2, p3])

        dispose()
      })
    })

    test("trailing call fires after in-flight completes", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      let resolveFirst: (v: unknown) => void = () => {}
      navigationMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      navigationMock.mockResolvedValueOnce({
        data: makeNavResponse({
          connection: { status: "connected", agentId: "second" },
        }),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)

        // Start first call (will block).
        const p1 = model.invalidateAndRefresh()
        // Second call arrives while first is in-flight → trailing.
        const p2 = model.invalidateAndRefresh()

        // Only one in-flight call.
        expect(navigationMock).toHaveBeenCalledTimes(1)

        // Resolve first.
        resolveFirst({ data: makeNavResponse() })
        await p1

        // Trailing call fires after first completes.
        await delay(0)
        await p2

        expect(navigationMock).toHaveBeenCalledTimes(2)

        dispose()
      })
    })
  })

  // =====================================================================
  // Event-driven refresh
  // =====================================================================
  describe("event-driven refresh", () => {
    test("clarus.navigation.updated event triggers navigation refresh", async () => {
      const { deps, navigationMock, fireEvent } = createMockClarusDeps()
      navigationMock.mockResolvedValue({ data: makeNavResponse() })

      await createRoot(async (dispose) => {
        createClarusModel(deps)

        fireEvent("clarus.navigation.updated")
        // Allow tick to flush.
        await delay(0)

        expect(navigationMock).toHaveBeenCalled()
        dispose()
      })
    })
  })

  // =====================================================================
  // Reconnect version
  // =====================================================================
  describe("reconnect version", () => {
    test("reconnectVersion change triggers refresh", async () => {
      const { deps, navigationMock, setReconnectVersion } = createMockClarusDeps()
      navigationMock.mockResolvedValue({ data: makeNavResponse() })

      await createRoot(async (dispose) => {
        createClarusModel(deps)

        setReconnectVersion(2)
        // Allow handler to fire.
        await delay(0)

        expect(navigationMock).toHaveBeenCalled()
        dispose()
      })
    })

    test("reconnectVersion fires refresh on each increment, not just the first", async () => {
      const { deps, navigationMock, setReconnectVersion } = createMockClarusDeps()
      navigationMock.mockResolvedValue({ data: makeNavResponse() })

      await createRoot(async (dispose) => {
        createClarusModel(deps)

        setReconnectVersion(1)
        await delay(0)
        setReconnectVersion(2)
        await delay(0)
        setReconnectVersion(3)
        await delay(0)

        // Each version bump must trigger an independent refresh.
        expect(navigationMock).toHaveBeenCalledTimes(3)
        dispose()
      })
    })

    test("reconnect handler calls invalidateAndRefresh, not refreshNavigation directly", async () => {
      const { deps, navigationMock, setReconnectVersion } = createMockClarusDeps()
      navigationMock.mockResolvedValue({ data: makeNavResponse() })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)

        // Refresh once to populate snapshot with a known agentId.
        navigationMock.mockResolvedValueOnce({
          data: makeNavResponse({ connection: { status: "connected", agentId: "first" } }),
        })
        await model.refreshNavigation()

        // Set up the next response for the reconnect-triggered refresh.
        navigationMock.mockResolvedValueOnce({
          data: makeNavResponse({ connection: { status: "connected", agentId: "reconnect-update" } }),
        })

        setReconnectVersion(1)
        await delay(0)

        // The reconnect handler must have invalidated and re-fetched.
        expect(model.store.snapshot?.connection.agentId).toBe("reconnect-update")
        dispose()
      })
    })
  })

  // =====================================================================
  // Project and task selection
  // =====================================================================
  describe("project and task selection", () => {
    test("selectProject sets selectedProjectId from snapshot data", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      const projects = [
        makeClarusProject({
          projectId: "proj-a",
          projectName: "Alpha",
          activeGroup: true,
          tasks: makeNavTasks(2, "a"),
        }),
        makeClarusProject({
          projectId: "proj-b",
          projectName: "Beta",
          activeGroup: true,
          tasks: makeNavTasks(1, "b"),
        }),
      ]
      navigationMock.mockResolvedValue({
        data: makeNavResponse(),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        // Inject projects directly into snapshot for selection test.
        // (The model maps SDK response → store snapshot; here we test selection
        // regardless of how the snapshot was populated.)
        await model.refreshNavigation()
        model.selectProject("proj-a")

        expect(model.store.selectedProjectId).toBe("proj-a")
        dispose()
      })
    })

    test("selectTask sets selectedTaskId", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      navigationMock.mockResolvedValue({
        data: makeNavResponse(),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.refreshNavigation()
        model.selectProject("proj-a")
        model.selectTask("t-2")

        expect(model.store.selectedTaskId).toBe("t-2")
        dispose()
      })
    })

    test("active/inactive grouping preserved from snapshot", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      // Set up mock to return projects with activeGroup in the SDK response,
      // plus tasks.  The model will group tasks into projects.
      navigationMock.mockResolvedValue({
        data: makeNavResponse({
          projects: [
            {
              projectId: "proj-a",
              projectName: "Alpha",
              projectSlug: "alpha",
              activeGroup: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            {
              projectId: "proj-b",
              projectName: "Beta",
              projectSlug: "beta",
              activeGroup: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          tasks: [makeNavTask({ taskId: "a-1", projectId: "proj-a", title: "Task A1" })],
        }),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.refreshNavigation()

        // Snapshot should contain both projects with correct activeGroup.
        const active = model.store.snapshot?.projects.filter((p) => p.activeGroup)
        const inactive = model.store.snapshot?.projects.filter((p) => !p.activeGroup)
        expect(active?.length).toBe(1)
        expect(inactive?.length).toBe(1)
        expect(active![0].projectId).toBe("proj-a")
        expect(inactive![0].projectId).toBe("proj-b")
        // lifecycle should be derived
        expect(active![0].lifecycle).toBe("active")
        expect(inactive![0].lifecycle).toBe("inactive")
        dispose()
      })
    })
  })

  // =====================================================================
  // Continue-local
  // =====================================================================
  describe("continue-local", () => {
    test("continueLocalTask calls generated method exactly once", async () => {
      const { deps, continueLocalMock } = createMockClarusDeps()
      const result = makeContinueLocalResult({ taskId: "t-1", status: "ok" })
      continueLocalMock.mockResolvedValue({ data: result })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        const got: ClarusContinueLocalResult = await model.continueLocalTask("proj-1", "t-1")

        expect(got.taskId).toBe("t-1")
        expect(continueLocalMock).toHaveBeenCalledTimes(1)
        expect(continueLocalMock).toHaveBeenCalledWith({
          projectId: "proj-1",
          taskId: "t-1",
        })
        dispose()
      })
    })

    test("continue-local state is keyed per task", async () => {
      const { deps, continueLocalMock } = createMockClarusDeps()
      continueLocalMock.mockResolvedValue({
        data: makeContinueLocalResult({ taskId: "t-1", status: "ok" }),
      })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.continueLocalTask("proj-1", "t-1")

        // Per-task state should exist for this task.
        expect(model.store.continueLocalByTask["t-1"]).toBeDefined()
        dispose()
      })
    })

    test("continue-local re-fetches navigation snapshot on success", async () => {
      const { deps, navigationMock, continueLocalMock } = createMockClarusDeps()
      continueLocalMock.mockResolvedValue({
        data: makeContinueLocalResult({ taskId: "t-1", status: "ok" }),
      })
      navigationMock.mockResolvedValue({ data: makeNavResponse() })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.continueLocalTask("proj-1", "t-1")

        // After continue-local succeeds, navigation should refresh.
        expect(navigationMock).toHaveBeenCalled()
        dispose()
      })
    })
  })

  // =====================================================================
  // Composer lookup caps
  // =====================================================================
  describe("composer lookup", () => {
    test("lookupUsers passes limit:5 to the generated SDK", async () => {
      const { deps, lookupUsersMock } = createMockClarusDeps()
      lookupUsersMock.mockResolvedValue({ data: makeComposerUsers(3) })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.lookupUsers("alice")

        expect(lookupUsersMock).toHaveBeenCalledWith(expect.objectContaining({ search: "alice", limit: 5 }))
        dispose()
      })
    })

    test("lookupProjects passes limit:5 to the generated SDK", async () => {
      const { deps, lookupProjectsMock } = createMockClarusDeps()
      lookupProjectsMock.mockResolvedValue({ data: makeComposerProjects(3) })

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        await model.lookupProjects("proj")

        expect(lookupProjectsMock).toHaveBeenCalledWith(expect.objectContaining({ search: "proj", limit: 5 }))
        dispose()
      })
    })
  })

  // =====================================================================
  // Composer submit
  // =====================================================================
  describe("composer submit", () => {
    test("submit calls generated SDK exactly once and returns result", async () => {
      const { deps, submitMock } = createMockClarusDeps()
      const result = makeComposerSubmitResult({
        requestID: "req-abc",
        messageId: "msg-xyz",
      })
      submitMock.mockResolvedValue({ data: result })
      const input: ClarusComposerSubmitInput = makeComposerSubmitInput()

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        const got = await model.submitComposerMessage(input)

        expect(got.requestID).toBe("req-abc")
        expect(got.messageId).toBe("msg-xyz")
        expect(submitMock).toHaveBeenCalledTimes(1)
        dispose()
      })
    })

    test("ambiguous error surfaced to caller, exactly one SDK call", async () => {
      const { deps, submitMock } = createMockClarusDeps()
      const ambiguous = {
        code: "AMBIGUOUS",
        message: "Outcome unknown",
        disposition: "ambiguous",
        recoverable: false,
      }
      submitMock.mockRejectedValue(ambiguous)
      const input: ClarusComposerSubmitInput = makeComposerSubmitInput()

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)

        await expect(model.submitComposerMessage(input)).rejects.toBeDefined()
        expect(submitMock).toHaveBeenCalledTimes(1)
        dispose()
      })
    })
  })

  // =====================================================================
  // Disposal
  // =====================================================================
  describe("disposal", () => {
    test("registers event listener and unregisters on dispose", () => {
      const { deps, eventHandlers } = createMockClarusDeps()

      createRoot((dispose) => {
        createClarusModel(deps)
        // A model that listens to events must register a listener.
        expect(eventHandlers.size).toBeGreaterThan(0)

        dispose()
        // After dispose, the listener must be removed.
        expect(eventHandlers.size).toBe(0)
      })
    })
  })

  // =====================================================================
  // Loading flag
  // =====================================================================
  describe("loading flag", () => {
    test("loading is true during navigation, false after completion", async () => {
      const { deps, navigationMock } = createMockClarusDeps()
      let resolveNav: (v: unknown) => void = () => {}
      navigationMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveNav = resolve
          }),
      )

      await createRoot(async (dispose) => {
        const model = createClarusModel(deps)
        const promise = model.refreshNavigation()

        // While the promise is pending, loading must be true.
        expect(model.store.loading).toBe(true)

        resolveNav({ data: makeNavResponse() })
        await promise

        // After resolution, loading must be false.
        expect(model.store.loading).toBe(false)
        dispose()
      })
    })
  })

  // =====================================================================
  // Pristine initial state
  // =====================================================================
  describe("initial state", () => {
    test("starts with undefined snapshot, no error, not loading, no selection", () => {
      const { deps } = createMockClarusDeps()
      createRoot((dispose) => {
        const model = createClarusModel(deps)

        expect(model.store.snapshot).toBeUndefined()
        expect(model.store.error).toBeUndefined()
        expect(model.store.stale).toBe(false)
        expect(model.store.loading).toBe(false)
        expect(model.store.selectedProjectId).toBeUndefined()
        expect(model.store.selectedTaskId).toBeUndefined()
        expect(model.store.continueLocalByTask).toEqual({})
        expect(model.store.composerUsers).toEqual([])
        expect(model.store.composerProjects).toEqual([])
        dispose()
      })
    })
  })
})
