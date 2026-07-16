/**
 * Test fixture for Clarus provider/model behavioral tests.
 *
 * Provides mock dependency factories and sample data aligned with the
 * generated SDK types and the model contract in clarus-model.ts.
 */

import { mock } from "bun:test"
import type {
  ClarusModelDeps,
  ClarusNavigationSnapshot,
  ClarusProject,
  ClarusComposerUserItem,
  ClarusComposerProjectItem,
  ClarusComposerSubmitInput,
  ClarusComposerSubmitResponse,
} from "./clarus-model"
import type {
  ClarusNavigationProjectDto,
  ClarusNavigationTaskDto,
  ClarusNavigationResponse,
} from "@ericsanchezok/synergy-sdk"

// ---------------------------------------------------------------------------
// Navigation snapshot factories
// ---------------------------------------------------------------------------

export function makeNavTask(overrides: Partial<ClarusNavigationTaskDto> = {}): ClarusNavigationTaskDto {
  return {
    taskId: "task-1",
    projectId: "proj-1",
    sessionID: "ses-1",
    title: "Test Task",
    status: "waiting",
    resultState: "idle",
    phase: "",
    attempt: 1,
    contextHydration: "unavailable",
    runID: "run-1",
    subtaskID: "sub-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

export function makeNavTasks(n: number, prefix = "task"): ClarusNavigationTaskDto[] {
  return Array.from({ length: n }, (_, i) =>
    makeNavTask({
      taskId: `${prefix}-${i + 1}`,
      title: `Task ${i + 1}`,
      projectId: `proj-${prefix}`,
    }),
  )
}

export function makeNavProjectDto(overrides: Partial<ClarusNavigationProjectDto> = {}): ClarusNavigationProjectDto {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    projectSlug: "test-project",
    activeGroup: true,
    lastProjectActivityAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

export function makeClarusProject(
  overrides: Partial<ClarusProject> & { tasks?: ClarusNavigationTaskDto[] },
): ClarusProject {
  const { tasks, activeGroup, ...rest } = overrides
  const active = activeGroup ?? true
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    projectSlug: "test-project",
    activeGroup: active,
    lifecycle: active ? "active" : "inactive",
    lastProjectActivityAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks: tasks ?? [],
    ...rest,
  }
}

export function makeNavResponse(overrides: Partial<ClarusNavigationResponse> = {}): ClarusNavigationResponse {
  return {
    connection: {
      status: "connected",
      agentId: "agent-1",
    },
    projects: [],
    tasks: [],
    ...overrides,
  }
}

export function makeNavSnapshot(overrides: Partial<ClarusNavigationSnapshot> = {}): ClarusNavigationSnapshot {
  return {
    connection: {
      status: "connected",
      agentId: "agent-1",
    },
    projects: [],
    ...overrides,
  }
}

export function makeSnapWithProjects(projects: ClarusProject[]): ClarusNavigationSnapshot {
  return {
    connection: {
      status: "connected",
      agentId: "agent-1",
    },
    projects,
  }
}

// ---------------------------------------------------------------------------
// Composer factories
// ---------------------------------------------------------------------------

export function makeComposerUser(overrides: Partial<ClarusComposerUserItem> = {}): ClarusComposerUserItem {
  return {
    userId: "user-1",
    userName: "Test User",
    agentId: "agent-1",
    ...overrides,
  }
}

export function makeComposerUsers(n: number): ClarusComposerUserItem[] {
  return Array.from({ length: n }, (_, i) => makeComposerUser({ userId: `user-${i + 1}`, userName: `User ${i + 1}` }))
}

export function makeComposerProject(overrides: Partial<ClarusComposerProjectItem> = {}): ClarusComposerProjectItem {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    ...overrides,
  }
}

export function makeComposerProjects(n: number): ClarusComposerProjectItem[] {
  return Array.from({ length: n }, (_, i) =>
    makeComposerProject({ projectId: `proj-${i + 1}`, projectName: `Project ${i + 1}` }),
  )
}

export function makeComposerSubmitInput(overrides: Partial<ClarusComposerSubmitInput> = {}): ClarusComposerSubmitInput {
  return {
    projectId: "proj-1",
    agentId: "agent-1",
    userId: "user-1",
    content: "Hello world",
    ...overrides,
  }
}

export function makeComposerSubmitResult(
  overrides: Partial<ClarusComposerSubmitResponse> = {},
): ClarusComposerSubmitResponse {
  return {
    requestID: "req-1",
    messageId: "msg-submitted",
    projectId: "proj-1",
    senderId: "user-1",
    epoch: 1,
    generation: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

export function createMockClarusDeps(): {
  deps: ClarusModelDeps
  eventHandlers: Set<(event: { type: string; properties: Record<string, unknown> }) => void>
  fireEvent: (type: string, properties?: Record<string, unknown>) => void
  setReconnectVersion: (v: number) => void
  get eventListenCount(): number
  get navigationMock(): ReturnType<typeof mock>
  get lookupUsersMock(): ReturnType<typeof mock>
  get lookupProjectsMock(): ReturnType<typeof mock>
  get submitMock(): ReturnType<typeof mock>
} {
  const eventHandlers = new Set<(event: { type: string; properties: Record<string, unknown> }) => void>()
  const reconnectHandlers = new Set<() => void>()

  const navigationMock = mock(() => Promise.resolve({ data: makeNavResponse() }))
  const lookupUsersMock = mock(() => Promise.resolve({ data: makeComposerUsers(0) }))
  const lookupProjectsMock = mock(() => Promise.resolve({ data: makeComposerProjects(0) }))
  const submitMock = mock(() => Promise.resolve({ data: makeComposerSubmitResult() }))

  const deps: ClarusModelDeps = {
    navigation: navigationMock,
    lookupUsers: lookupUsersMock,
    lookupProjects: lookupProjectsMock,
    submit: submitMock,
    eventEmitter: {
      listen(handler: (event: { type: string; properties: Record<string, unknown> }) => void): () => void {
        eventHandlers.add(handler)
        return () => {
          eventHandlers.delete(handler)
        }
      },
    },
    onReconnectVersionChange(handler: () => void): () => void {
      reconnectHandlers.add(handler)
      return () => {
        reconnectHandlers.delete(handler)
      }
    },
  }

  return {
    deps,
    eventHandlers,
    fireEvent(type: string, properties: Record<string, unknown> = {}): void {
      for (const h of eventHandlers) h({ type, properties })
    },
    setReconnectVersion(_v: number): void {
      for (const h of reconnectHandlers) h()
    },
    get eventListenCount(): number {
      return eventHandlers.size
    },
    navigationMock,
    lookupUsersMock,
    lookupProjectsMock,
    submitMock,
  }
}
