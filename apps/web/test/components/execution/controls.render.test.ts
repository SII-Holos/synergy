import { afterEach, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal, onCleanup, Suspense, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { EventAgendaItemDeleted, EventExecutionUpdated, ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"

await plugin({
  name: "execution-controls-render",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (await transformAsync(await Bun.file(path).text(), {
        filename: path,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          [import.meta.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
        ],
        sourceMaps: "inline",
      }))!.code!,
      loader: "js",
    }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
  },
})

const i18n = setupI18n({ locale: "en", messages: { en: {} } })
mock.module("@lingui/solid", () => ({ useLingui: () => ({ _: i18n._.bind(i18n), i18n: () => i18n }) }))
mock.module("@ericsanchezok/synergy-ui/context/dialog", () => ({ useDialog: () => ({ show: () => {} }) }))
mock.module("../../../src/context/locale", () => ({ useLocale: () => ({ i18n }) }))
mock.module("../../../src/components/dialog/dialog-workspace", () => ({ DialogWorkspace: () => null }))
mock.module("../../../src/components/dialog/dialog-environment", () => ({ DialogEnvironment: () => null }))

const [sessionID, setSessionID] = createSignal("root")
const [enabled, setEnabled] = createSignal(true)
const [workflows, setWorkflows] = createSignal(false)
const [connected, setConnected] = createSignal(true)
const initialResource = {
  id: "root",
  scope: { id: "project", type: "project", name: "Fixture project", local: { vcs: "git", directory: "/workspace" } },
  workspace: { type: "git_worktree", path: "/workspace", bindingState: "bound", lifecycle: "active" },
  environmentID: "env-a",
}
type ResourceFixture = Omit<typeof initialResource, "workspace" | "environmentID"> & {
  workspace: typeof initialResource.workspace | null
  environmentID: string | null
}
const [resource, setResource] = createSignal<ResourceFixture>(initialResource)
const resources: Array<{
  kind: "environment" | "branch" | "agenda" | "inbox"
  signal?: AbortSignal
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}> = []
const deferResource = (kind: "environment" | "branch" | "agenda" | "inbox", signal?: AbortSignal) =>
  new Promise((resolve, reject) => resources.push({ kind, signal, resolve: (data) => resolve({ data }), reject }))
mock.module("../../../src/context/sync", () => ({
  useSync: () => ({
    data: { workspaces: [], inbox: {}, session: [], message: {}, part: {} },
    session: { get: resource },
  }),
}))
mock.module("../../../src/context/session-data-view", () => ({
  useSessionDataView: () => () => ({ inboxFor: () => [], messagesFor: () => [] }),
}))
const pending: Array<{
  sessionID: string
  signal?: AbortSignal
  resolve: (summary: ExecutionSummary) => void
  reject: (error: Error) => void
}> = []
type Notice =
  | {
      type: EventExecutionUpdated["type"]
      properties: Pick<EventExecutionUpdated["properties"], "sessionID" | "revision" | "summary">
    }
  | EventAgendaItemDeleted
const listeners = new Map<string, Set<(notice: Notice) => void>>()
const opened: Array<{ id: string; options: unknown }> = []
mock.module("@solidjs/router", () => ({
  useParams: () => ({
    get id() {
      return sessionID()
    },
  }),
}))
mock.module("../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    capabilities: { has: (capability: string) => (capability === "workflows" ? workflows() : enabled()) },
  }),
}))
mock.module("../../../src/context/workbench", () => ({
  useWorkbenchPanels: () => ({ openPanel: (id: string, options: unknown) => opened.push({ id, options }) }),
}))
mock.module("../../../src/context/sdk", () => ({
  useSDK: () => ({
    connected,
    event: {
      on: (type: string, listener: (notice: Notice) => void) => {
        const group = listeners.get(type) ?? new Set<(notice: Notice) => void>()
        listeners.set(type, group)
        group.add(listener)
        return () => {
          group.delete(listener)
          if (!group.size) listeners.delete(type)
        }
      },
    },
    client: {
      environment: {
        get: (_input: unknown, options: { signal?: AbortSignal }) => deferResource("environment", options.signal),
      },
      worktree: {
        list: (_input: unknown, options: { signal?: AbortSignal }) => deferResource("branch", options.signal),
      },
      session: {
        agenda: (_input: unknown, options: { signal?: AbortSignal }) => deferResource("agenda", options.signal),
        inboxRemoved: (_input: unknown, options: { signal?: AbortSignal }) => deferResource("inbox", options.signal),
        executionSummary: (input: { sessionID: string }, options: { signal?: AbortSignal }) =>
          new Promise<{ data: ExecutionSummary }>((resolve, reject) => {
            pending.push({ ...input, signal: options.signal, resolve: (data) => resolve({ data }), reject })
          }),
      },
    },
  }),
}))

const { ExecutionProvider, useExecution } = await import("../../../src/context/execution")
const { TaskDetailsPopover } = await import("../../../src/components/execution/popover")
const { SessionTaskDetails } = await import("../../../src/components/execution/session-task-details")
const { EvidenceBlock } = await import("../../../src/components/execution/block")
const { configureClipboard } = await import("@ericsanchezok/synergy-ui/clipboard")

function summary(revision = 1, id = "root"): ExecutionSummary {
  const metric = () => ({ known: 0, unknown: 0, total: 0 })
  const accounting: ExecutionSummary["accounting"] = {
    version: 1,
    calls: 1,
    localCalls: 0,
    importedCalls: 0,
    attempts: 1,
    unobservedCalls: 0,
    journalGaps: 0,
    legacy: { cost: 0, messages: 0 },
    tokens: {
      input: metric(),
      uncached: metric(),
      cacheRead: metric(),
      cacheWrite: metric(),
      output: metric(),
      reasoning: metric(),
      total: { known: 1000, unknown: 0, total: 1000 },
    },
    apiEstimate: metric(),
    subscriptionEquivalent: metric(),
    unclassifiedEquivalent: metric(),
    reported: { currencies: {}, unreported: 0 },
    units: {},
    cacheWrites: {},
  }
  const rate = () => ({ value: null, tokens: 0, milliseconds: 0, samples: 0, excluded: 0 })
  return {
    sessionID: id,
    revision,
    computedAt: 1000,
    status: "completed",
    elapsedMs: 8000,
    elapsedActive: false,
    accounting,
    own: accounting,
    descendants: accounting,
    cost: {
      state: "estimated",
      reported: [],
      estimates: [{ basis: "api", currency: "USD", known: 0.0076, maximum: 0.0076, unknown: 0 }],
      equivalent: null,
      missing: 0,
      historical: 0,
      knownUSD: 0.0076,
    },
    rates: { generation: rate(), endToEnd: rate() },
    cache: { ratio: null, observedRatio: null, read: 0, input: 0, samples: 0, excluded: 0 },
    context: null,
    contextDistribution: null,
    tasks: [
      {
        sessionID: "child",
        nodeID: "child-node",
        parentID: id,
        title: "Read project notes",
        status: "completed",
        elapsedMs: 3000,
        elapsedActive: false,
        tokens: { known: 500, unknown: 0, total: 500 },
        runs: ["child-round"],
      },
    ],
    rounds: [{ id: "round-1", title: "Task", started: 1000, status: "completed", elapsedMs: 8000 }],
    coverage: { recorded: 1, messages: 0, gaps: 0, partial: false },
    lanes: [],
    activityTotal: 0,
    humanInputs: 1,
    taskInstructions: 1,
  }
}

const disposals: Array<() => void> = []
let execution: ReturnType<typeof useExecution>
function mount(view: () => JSX.Element = () => null) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(ExecutionProvider, {
        get children() {
          execution = useExecution()
          return view()
        },
      }),
    root,
  )
  disposals.push(() => {
    dispose()
    root.remove()
  })
  return root
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
const emit = (value: ExecutionSummary) => {
  for (const listener of listeners.get("execution.updated") ?? [])
    listener({
      type: "execution.updated",
      properties: { sessionID: value.sessionID, revision: value.revision, summary: value },
    })
}
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  expect(listeners.size).toBe(0)
  pending.length = 0
  opened.length = 0
  setSessionID("root")
  setEnabled(true)
  setWorkflows(false)
  setConnected(true)
  setResource(initialResource)
  resources.length = 0
})

test("snapshots cannot overwrite newer events, and reconnect cancels the previous request", async () => {
  mount()
  expect(pending).toHaveLength(1)
  const first = pending[0]!
  emit(summary(3))
  first.resolve(summary(1))
  await flush()
  expect(execution.state.summary?.revision).toBe(3)
  expect(execution.round("round-1")?.status).toBe("completed")
  emit(summary(2))
  emit(summary(9, "unrelated"))
  expect(execution.state.summary?.revision).toBe(3)
  setConnected(false)
  setConnected(true)
  expect(first.signal?.aborted).toBe(true)
  expect(pending).toHaveLength(2)
  pending[1]!.resolve(summary(4))
  await flush()
  expect(execution.state.summary?.revision).toBe(4)
  expect(execution.connectionVersion()).toBe(2)
  expect(execution.state.loading).toBe(false)
})

test("navigation clears the old round, ignores its late response, and disposal aborts work", async () => {
  mount()
  const first = pending[0]!
  emit(summary())
  setSessionID("next")
  expect(execution.round("round-1")).toBeUndefined()
  expect(first.signal?.aborted).toBe(true)
  first.resolve(summary(8))
  await flush()
  expect(execution.state.summary).toBeUndefined()
  const next = pending[1]!
  next.resolve(summary(2, "next"))
  await flush()
  expect(execution.state.summary?.sessionID).toBe("next")
  void execution.refresh()
  const last = pending[2]!
  disposals.splice(0).forEach((dispose) => dispose())
  expect(last.signal?.aborted).toBe(true)
  last.resolve(summary(9, "next"))
  await flush()
  expect(execution.state.summary?.revision).toBe(2)
})

test("task details remain reachable without execution support; supported summaries open retained child evidence", async () => {
  setEnabled(false)
  mount(() => createComponent(TaskDetailsPopover, {}))
  expect(pending).toHaveLength(0)
  expect(document.querySelector(".execution-trigger")).not.toBeNull()
  setEnabled(true)
  expect(pending).toHaveLength(1)
  pending[0]!.resolve(summary())
  await flush()
  document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  expect(document.querySelector(".execution-popover")?.textContent).toContain("US$0.0076")
  expect(document.querySelector(".execution-task-row")?.textContent).toContain("Read project notes")
  document.querySelector<HTMLButtonElement>(".execution-task-row")!.click()
  expect(opened).toEqual([{ id: "context", options: { init: { state: { runID: undefined, nodeID: "child-node" } } } }])
  expect(document.querySelector(".execution-trigger")?.getAttribute("aria-expanded")).toBe("false")
  document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  document.querySelector<HTMLButtonElement>(".execution-full-link")!.click()
  expect(opened.at(-1)).toEqual({ id: "context", options: undefined })
})

test("summary load failures expose a working retry rather than a success placeholder", async () => {
  mount(() => createComponent(TaskDetailsPopover, {}))
  pending[0]!.reject(new Error("fixture unavailable"))
  await flush()
  expect(execution.state.error).toBe(true)
  document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  pending.at(-1)!.reject(new Error("fixture unavailable"))
  await flush()
  const retry = document.querySelector<HTMLButtonElement>(".execution-feedback button")!
  expect(retry).not.toBeNull()
  retry.click()
  pending.at(-1)!.resolve(summary())
  await flush()
  expect(execution.state.error).toBe(false)
  expect(document.querySelector(".execution-task-row")?.textContent).toContain("Read project notes")
})

test("evidence blocks copy complete current text and keep empty content explicit", async () => {
  const copied: string[] = []
  const restoreClipboard = configureClipboard({
    writer: (text) => {
      copied.push(text)
    },
  })
  const [text, setText] = createSignal('{"content":"证据\\n完整"}')
  const root = mount(() =>
    createComponent(EvidenceBlock, {
      label: "Saved input",
      language: "json",
      get text() {
        return text()
      },
    }),
  )
  try {
    expect(root.querySelector("code")?.textContent).toBe(text())
    root.querySelector<HTMLButtonElement>("button")!.click()
    await flush()
    expect(copied).toEqual([text()])
    setText("updated evidence")
    expect(root.querySelector("code")?.textContent).toBe("updated evidence")
    setText("")
    expect(root.querySelector("code")).toBeNull()
    expect(root.querySelector(".execution-help")?.textContent).toBeTruthy()
  } finally {
    restoreClipboard()
  }
})

test("task details retain inbox ownership while navigating and survive summary failure", async () => {
  const states: Array<() => boolean> = []
  let disposed = 0
  const content = document.createElement("p")
  content.textContent = "Queued follow-up"
  mount(() =>
    createComponent(TaskDetailsPopover, {
      inboxCount: 2,
      context: (active) => {
        states.push(active)
        const location = document.createElement("p")
        location.textContent = "Project workspace"
        return location
      },
      inbox: (active) => {
        states.push(active)
        onCleanup(() => disposed++)
        return content
      },
    }),
  )
  pending[0]!.reject(new Error("summary unavailable"))
  await flush()
  const trigger = document.querySelector<HTMLButtonElement>(".execution-trigger")!
  expect(trigger.querySelector(".execution-trigger-count")?.textContent).toBe("2")
  trigger.click()
  await flush()
  expect(states.map((active) => active())).toEqual([true, false])
  expect(document.querySelector(".execution-popover")?.textContent).toContain("Project workspace")
  const entry = document.querySelector<HTMLButtonElement>(".execution-inbox-entry")!
  entry.click()
  expect(states.map((active) => active())).toEqual([false, true])
  const back = document.querySelector<HTMLButtonElement>(".execution-inbox-back")!
  expect(document.activeElement).toBe(back)
  back.click()
  expect(document.activeElement).toBe(entry)
  expect(states.map((active) => active())).toEqual([true, false])
  entry.click()
  trigger.click()
  await flush()
  expect(states.map((active) => active())).toEqual([false, false])
  expect(disposed).toBe(0)
  trigger.click()
  await flush()
  entry.click()
  expect(document.querySelector(".execution-inbox p")).toBe(content)
})

test("session task details load actual resources on demand and reject superseded workspace results", async () => {
  setEnabled(false)
  mount(() => createComponent(SessionTaskDetails, {}))
  expect(resources).toHaveLength(0)
  document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  expect(resources.map((request) => request.kind).sort()).toEqual(["branch", "environment"])
  expect(document.querySelector(".execution-location-path")?.textContent).toBe("/workspace")

  setResource({
    ...initialResource,
    workspace: { ...initialResource.workspace, path: "/next" },
    environmentID: "env-b",
  })
  await flush()
  expect(resources).toHaveLength(4)
  expect(resources.slice(0, 2).every((request) => request.signal?.aborted)).toBe(true)
  for (const request of resources.slice(2))
    request.resolve(
      request.kind === "environment"
        ? { provider: "Current runtime", state: "ready" }
        : [{ path: "/next", branch: "current-branch" }],
    )
  await flush()
  for (const request of resources.slice(0, 2))
    request.resolve(
      request.kind === "environment"
        ? { provider: "Stale runtime", state: "ready" }
        : [{ path: "/workspace", branch: "stale-branch" }],
    )
  await flush()
  const overlay = document.querySelector(".execution-popover")!
  expect(overlay.textContent).toContain("Fixture project")
  expect(overlay.textContent).toContain("Current runtime")
  expect(overlay.textContent).not.toContain("Stale runtime")
  expect(document.querySelector(".execution-location-branch")?.textContent).toBe("current-branch")
  expect(document.querySelector(".execution-location-path")?.textContent).toBe("/next")

  setResource({
    ...initialResource,
    scope: { ...initialResource.scope, id: "another-project" },
    workspace: { ...initialResource.workspace, path: "/next" },
    environmentID: "env-b",
  })
  await flush()
  expect(document.querySelector(".execution-location-branch")).toBeNull()

  document.querySelector<HTMLButtonElement>(".execution-inbox-entry")!.click()
  await flush()
  expect(document.querySelector(".session-inbox-panel")).not.toBeNull()
  disposals.splice(0).forEach((dispose) => dispose())
  expect(resources.every((request) => request.signal?.aborted)).toBe(true)
})

test.each([false, true])(
  "task detail opening and dismissal keep the conversation visible with workflows=%s",
  async (scheduled) => {
    setEnabled(false)
    setWorkflows(scheduled)
    const conversation = document.createElement("article")
    conversation.textContent = "Retained conversation"
    const composer = document.createElement("textarea")
    composer.value = "Unsent draft"
    const fallback = document.createElement("div")
    fallback.textContent = "Page loading"
    let fallbackMounts = 0
    const root = mount(() =>
      createComponent(Suspense, {
        get fallback() {
          fallbackMounts++
          return fallback
        },
        get children() {
          return [conversation, composer, createComponent(SessionTaskDetails, {})]
        },
      }),
    )
    const retained = () => {
      expect(root.contains(fallback)).toBe(false)
      expect(root.contains(conversation)).toBe(true)
      expect(root.contains(composer)).toBe(true)
      expect(composer.value).toBe("Unsent draft")
      expect(fallbackMounts).toBe(0)
    }
    const trigger = root.querySelector<HTMLButtonElement>(".execution-trigger")!
    retained()
    trigger.click()
    await flush()
    expect(resources).toHaveLength(scheduled ? 3 : 2)
    retained()
    trigger.click()
    await flush()
    retained()
    expect(resources.every((request) => request.signal?.aborted)).toBe(true)
    for (const request of resources)
      request.resolve(
        request.kind === "environment"
          ? { provider: "Local runtime", state: "ready" }
          : request.kind === "agenda"
            ? { hasActiveAgenda: false, items: [] }
            : [],
      )
    await flush()
    retained()
    trigger.click()
    await flush()
    retained()
    document.querySelector<HTMLButtonElement>(".execution-inbox-entry")!.click()
    await flush()
    retained()
    expect(resources.at(-1)?.kind).toBe("inbox")
    document.querySelector<HTMLButtonElement>(".execution-inbox-back")!.click()
    await flush()
    retained()
    document.querySelector<HTMLButtonElement>("[data-slot=popover-close-button]")!.click()
    await flush()
    retained()
    expect(resources.every((request) => request.signal?.aborted)).toBe(true)
    const count = resources.length
    trigger.click()
    await flush()
    for (const request of resources.slice(count)) request.reject(new Error("Resource unavailable"))
    await flush()
    retained()
    const retry = document.querySelector<HTMLButtonElement>(".execution-location-state button")!
    expect(retry).not.toBeNull()
    retry.click()
    await flush()
    retained()
    resources.at(-1)!.resolve({ provider: "Recovered runtime", state: "ready" })
    await flush()
    retained()
    expect(document.querySelector(".execution-popover")?.textContent).toContain("Recovered runtime")
  },
)

test("task details cancel cleared resource targets and reject their late results", async () => {
  setEnabled(false)
  mount(() => createComponent(SessionTaskDetails, {}))
  document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  const abandoned = [...resources]
  expect(abandoned).toHaveLength(2)
  setResource({ ...initialResource, workspace: null, environmentID: null })
  await flush()
  expect(abandoned.every((request) => request.signal?.aborted)).toBe(true)
  expect(document.querySelector(".execution-location-branch")).toBeNull()
  setResource(initialResource)
  await flush()
  const current = resources.slice(abandoned.length)
  expect(current).toHaveLength(2)
  for (const request of abandoned)
    request.resolve(
      request.kind === "environment"
        ? { provider: "Abandoned runtime", state: "ready" }
        : [{ path: "/workspace", branch: "abandoned-branch" }],
    )
  await flush()
  expect(document.querySelector(".execution-popover")?.textContent).not.toContain("Abandoned runtime")
  expect(document.querySelector(".execution-location-branch")).toBeNull()
  for (const request of current)
    request.resolve(
      request.kind === "environment"
        ? { provider: "Current runtime", state: "ready" }
        : [{ path: "/workspace", branch: "current-branch" }],
    )
  await flush()
  expect(document.querySelector(".execution-popover")?.textContent).toContain("Current runtime")
  expect(document.querySelector(".execution-location-branch")?.textContent).toBe("current-branch")
})

test.each([false, true])("session navigation releases pending task detail reads with inbox=%s", async (inbox) => {
  setEnabled(false)
  setWorkflows(true)
  const conversation = document.createElement("article")
  conversation.textContent = "Retained conversation"
  const fallback = document.createElement("div")
  fallback.textContent = "Page loading"
  const root = mount(() =>
    createComponent(Suspense, {
      fallback,
      get children() {
        return [conversation, createComponent(SessionTaskDetails, {})]
      },
    }),
  )
  root.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  if (inbox) {
    document.querySelector<HTMLButtonElement>(".execution-inbox-entry")!.click()
    await flush()
  }
  const abandoned = [...resources]
  expect(abandoned).toHaveLength(inbox ? 4 : 3)
  setSessionID("next")
  await flush()
  expect(abandoned.every((request) => request.signal?.aborted)).toBe(true)
  expect(document.querySelector(".execution-popover")).toBeNull()
  expect(root.querySelector(".execution-trigger")?.getAttribute("aria-expanded")).toBe("false")
  root.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  const current = resources.slice(abandoned.length)
  expect(current).toHaveLength(3)
  for (const request of abandoned)
    request.resolve(
      request.kind === "environment"
        ? { provider: "Previous session runtime", state: "ready" }
        : request.kind === "branch"
          ? [{ path: "/workspace", branch: "previous-session-branch" }]
          : request.kind === "agenda"
            ? { hasActiveAgenda: false, items: [] }
            : [],
    )
  await flush()
  expect(document.querySelector(".execution-popover")?.textContent).not.toContain("Previous session runtime")
  expect(document.querySelector(".execution-location-branch")).toBeNull()
  for (const request of current)
    request.resolve(
      request.kind === "environment"
        ? { provider: "Current session runtime", state: "ready" }
        : request.kind === "branch"
          ? [{ path: "/workspace", branch: "current-session-branch" }]
          : { hasActiveAgenda: false, items: [] },
    )
  await flush()
  expect(document.querySelector(".execution-popover")?.textContent).toContain("Current session runtime")
  expect(document.querySelector(".execution-location-branch")?.textContent).toBe("current-session-branch")
  expect(root.contains(conversation)).toBe(true)
  expect(root.contains(fallback)).toBe(false)
})

test("scheduled activity event refresh stays local and stops while task details are closed", async () => {
  setEnabled(false)
  setWorkflows(true)
  const conversation = document.createElement("article")
  const fallback = document.createElement("div")
  const root = mount(() =>
    createComponent(Suspense, {
      fallback,
      get children() {
        return [conversation, createComponent(SessionTaskDetails, {})]
      },
    }),
  )
  const trigger = root.querySelector<HTMLButtonElement>(".execution-trigger")!
  trigger.click()
  await flush()
  for (const request of resources)
    request.resolve(
      request.kind === "environment"
        ? { provider: "Runtime", state: "ready" }
        : request.kind === "agenda"
          ? { hasActiveAgenda: false, items: [] }
          : [],
    )
  await flush()
  const deleted = () => {
    for (const listener of listeners.get("agenda.item.deleted") ?? [])
      listener({ type: "agenda.item.deleted", properties: { id: "scheduled-item", scopeID: "project" } })
  }
  deleted()
  await flush()
  expect(resources).toHaveLength(4)
  const refresh = resources.at(-1)!
  expect(refresh.kind).toBe("agenda")
  expect(root.contains(conversation)).toBe(true)
  expect(root.contains(fallback)).toBe(false)
  trigger.click()
  await flush()
  expect(refresh.signal?.aborted).toBe(true)
  deleted()
  await flush()
  expect(resources).toHaveLength(4)
  refresh.resolve({ hasActiveAgenda: false, items: [] })
  await flush()
  expect(root.contains(conversation)).toBe(true)
  expect(root.contains(fallback)).toBe(false)
})
