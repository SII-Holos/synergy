import { afterEach, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { setupI18n } from "@lingui/core"
import { createComponent, createSignal, onCleanup, Suspense, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"

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
const [connected, setConnected] = createSignal(true)
const initialResource = {
  id: "root",
  scope: { id: "project", type: "project", name: "Fixture project", local: { vcs: "git", directory: "/workspace" } },
  workspace: { type: "git_worktree", path: "/workspace", bindingState: "bound", lifecycle: "active" },
  environmentID: "env-a",
}
const [resource, setResource] = createSignal<
  Omit<typeof initialResource, "workspace"> & {
    workspace: typeof initialResource.workspace | null
  }
>(initialResource)
const resources: Array<{
  kind: "environment" | "branch"
  signal?: AbortSignal
  resolve: (data: unknown) => void
}> = []
const deferResource = (kind: "environment" | "branch", signal?: AbortSignal) =>
  new Promise((resolve) => resources.push({ kind, signal, resolve: (data) => resolve({ data }) }))
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
type Notice = { properties: { sessionID: string; revision: number; summary: ExecutionSummary } }
const listeners = new Set<(notice: Notice) => void>()
const opened: Array<{ id: string; options: unknown }> = []
mock.module("@solidjs/router", () => ({
  useParams: () => ({
    get id() {
      return sessionID()
    },
  }),
}))
mock.module("../../../src/context/global-sdk", () => ({
  useGlobalSDK: () => ({ capabilities: { has: (capability: string) => capability !== "workflows" && enabled() } }),
}))
mock.module("../../../src/context/workbench", () => ({
  useWorkbenchPanels: () => ({ openPanel: (id: string, options: unknown) => opened.push({ id, options }) }),
}))
mock.module("../../../src/context/sdk", () => ({
  useSDK: () => ({
    connected,
    event: {
      on: (_type: string, listener: (notice: Notice) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
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
        inboxRemoved: async () => ({ data: [] }),
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
  const latency = { samples: 0, excluded: 0, totalMs: 0, meanMs: null, p50Ms: null, p95Ms: null }
  return {
    sessionID: id,
    revision,
    clockID: "test",
    sampledAt: 0,
    computedAt: 1000,
    status: "completed",
    elapsedMs: 8000,
    elapsedActive: false,
    elapsedLowerBound: false,
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
    latency: { headers: latency, firstByte: latency, ttft: latency, request: latency, generation: latency },
    outcomes: {
      completed: 1,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      running: 0,
      retries: 0,
      logicalRetries: 0,
      transportRetries: 0,
      rootTasks: 1,
    },
    tools: [],
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
        elapsedLowerBound: false,
        tokens: { known: 500, unknown: 0, total: 500 },
        runs: ["child-round"],
      },
    ],
    rounds: [
      {
        id: "round-1",
        title: "Task",
        started: 1000,
        status: "completed",
        elapsedMs: 8000,
        elapsedActive: false,
        elapsedLowerBound: false,
      },
    ],
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
  for (const listener of listeners)
    listener({ properties: { sessionID: value.sessionID, revision: value.revision, summary: value } })
}
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  expect(listeners.size).toBe(0)
  pending.length = 0
  opened.length = 0
  setSessionID("root")
  setEnabled(true)
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
  document.querySelector<HTMLButtonElement>(".execution-task-row .execution-row-main")!.click()
  expect(opened).toEqual([{ id: "context", options: { init: { state: { runID: undefined, nodeID: "child-node" } } } }])
  expect(document.querySelector(".execution-trigger")?.getAttribute("aria-expanded")).toBe("false")
  document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
  await flush()
  document.querySelector<HTMLButtonElement>(".execution-identity-action")!.click()
  await flush()
  document.querySelector<HTMLButtonElement>(".execution-options .execution-menu-action")!.click()
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

test("task details retain direct inbox ownership while navigating history and survive summary failure", async () => {
  const states: Array<() => boolean> = []
  let disposed = 0
  const content = document.createElement("p")
  content.textContent = "Queued follow-up"
  mount(() =>
    createComponent(TaskDetailsPopover, {
      inboxCount: 2,
      context: (active) => {
        states[0] = active
        const location = document.createElement("p")
        location.textContent = "Project workspace"
        return location
      },
      inbox: (active) => {
        states[1] = active
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
  expect(states.map((active) => active())).toEqual([true, true])
  expect(document.querySelector(".execution-popover")?.textContent).toContain("Project workspace")
  expect(document.querySelector(".execution-popover p")?.textContent).toContain("Project workspace")
  const openHistory = async () => {
    document.querySelector<HTMLButtonElement>(".execution-identity-action")!.click()
    await flush()
    Array.from(document.querySelectorAll<HTMLButtonElement>(".execution-menu-action"))
      .find((button) => button.textContent?.includes("Inbox history"))!
      .click()
    await flush()
  }
  await openHistory()
  expect(states.map((active) => active())).toEqual([false, true])
  const back = document.querySelector<HTMLButtonElement>(".execution-inbox-back")!
  expect(document.activeElement).toBe(back)
  back.click()
  await flush()
  expect(document.activeElement).toBe(document.querySelector(".execution-identity-action"))
  expect(states.map((active) => active())).toEqual([true, true])
  await openHistory()
  trigger.click()
  await flush()
  expect(states.map((active) => active())).toEqual([false, false])
  expect(disposed).toBe(0)
  trigger.click()
  await flush()
  expect(document.querySelector(".execution-popover")?.contains(content)).toBe(true)
})

test("pending workspace reads preserve the conversation and cancel on close, cleared targets and navigation", async () => {
  setEnabled(false)
  const conversation = document.createElement("article")
  conversation.textContent = "Retained conversation"
  const composer = document.createElement("textarea")
  composer.value = "Unsent draft"
  const fallback = document.createElement("div")
  fallback.textContent = "Page loading"
  const root = mount(() =>
    createComponent(Suspense, {
      fallback,
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
  }
  const trigger = root.querySelector<HTMLButtonElement>(".execution-trigger")!
  trigger.click()
  await flush()
  retained()
  expect(resources).toHaveLength(1)
  trigger.click()
  await flush()
  expect(resources[0].signal?.aborted).toBe(true)
  retained()
  trigger.click()
  await flush()
  expect(resources).toHaveLength(2)
  setResource({ ...initialResource, workspace: null })
  await flush()
  expect(resources[1].signal?.aborted).toBe(true)
  retained()
  setResource(initialResource)
  await flush()
  expect(resources).toHaveLength(3)
  setSessionID("next")
  await flush()
  expect(resources[2].signal?.aborted).toBe(true)
  for (const request of resources) request.resolve([{ path: "/workspace", branch: "abandoned-branch" }])
  await flush()
  retained()
  expect(document.querySelector(".execution-popover")).toBeNull()
})

test("workspace identity copies its current path, rejects stale branch reads and never queries runtime labels", async () => {
  setEnabled(false)
  const copied: string[] = []
  const restoreClipboard = configureClipboard({
    writer: (text) => {
      copied.push(text)
    },
  })
  try {
    mount(() => createComponent(SessionTaskDetails, {}))
    expect(resources).toHaveLength(0)
    document.querySelector<HTMLButtonElement>(".execution-trigger")!.click()
    await flush()
    expect(resources.map((request) => request.kind)).toEqual(["branch"])
    expect(document.querySelector(".execution-popover")?.textContent).not.toContain("/workspace")
    setResource({
      ...initialResource,
      workspace: { ...initialResource.workspace, path: "/next" },
      environmentID: "env-b",
    })
    await flush()
    expect(resources).toHaveLength(2)
    expect(resources[0]!.signal?.aborted).toBe(true)
    resources[1]!.resolve([{ path: "/next", branch: "current-branch" }])
    await flush()
    resources[0]!.resolve([{ path: "/workspace", branch: "stale-branch" }])
    await flush()
    const identity = document.querySelector<HTMLButtonElement>(".execution-location-heading")!
    identity.focus()
    await flush()
    expect(document.querySelector('[data-component="tooltip"]')?.textContent).toContain("current-branch")
    expect(document.querySelector('[data-component="tooltip"]')?.textContent).not.toContain("stale-branch")
    identity.click()
    await flush()
    expect(copied).toEqual(["/next"])
    expect(document.querySelector(".execution-popover")?.textContent).not.toContain("env-b")
    disposals.splice(0).forEach((dispose) => dispose())
    expect(resources.every((request) => request.signal?.aborted)).toBe(true)
  } finally {
    restoreClipboard()
  }
})
