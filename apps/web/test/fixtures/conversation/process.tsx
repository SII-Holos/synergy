import type { PluginConversationService } from "@ericsanchezok/synergy-plugin"
import type {
  UserMessage,
  AssistantMessage,
  Part,
  TurnExecutionState,
  SessionStatus,
  SessionActivity,
} from "@ericsanchezok/synergy-sdk"
import type { Data } from "@ericsanchezok/synergy-ui/context/data"
import { batch, createEffect, createMemo, createSignal, on, Show, type ParentProps } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { messages as chineseMessages } from "../../../src/locales/zh-CN/messages.po"
import { DataProvider } from "@ericsanchezok/synergy-ui/context/data"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme/context"
import "@ericsanchezok/synergy-ui/styles"
import { VirtualConversationRows } from "../../../src/components/session/virtual-conversation-rows"
import { createPartMaterializer } from "../../../src/context/part-materializer"
import { createPartArrivalState } from "../../../src/context/part-arrival"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { reasoningItemKey } from "@ericsanchezok/synergy-util/reasoning-item"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import { createConversationHydration } from "../../../src/components/session/conversation-hydration"
import { RetainedSessionViews } from "../../../src/components/session/retained-session-views"
import { useViewActivity } from "../../../src/context/view-residency"
import { ConversationMotionProvider } from "@ericsanchezok/synergy-ui/conversation-motion"
import { captureConversationReadingAnchor } from "../../../src/components/session/conversation-reading-anchor"
import { buildSessionTurnProjection } from "@ericsanchezok/synergy-ui/session-turn-projection"

const [selectedSession, selectSession] = createSignal("session")
const resident = new URL(location.href).searchParams.has("resident")

const root: UserMessage = {
  id: "root",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "synergy",
  model: { providerID: "test", modelID: "test" },
  isRoot: true,
  rootID: "root",
  visible: true,
}
const assistant = (id: string, finish = "tool-calls"): AssistantMessage => ({
  id,
  sessionID: "session",
  role: "assistant",
  parentID: "root",
  rootID: "root",
  mode: "test",
  agent: "synergy",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: "test",
  providerID: "test",
  time: { created: 2, completed: finish === "stop" ? undefined : 3 },
  finish,
})
const part = (messageID: string, id: string, type: Part["type"], text = ""): Part =>
  ({
    id,
    sessionID: "session",
    messageID,
    type,
    text,
    time: { start: 2, end: 3 },
    ...(type === "tool"
      ? {
          tool: "bash",
          workBrief: "Check the project directory",
          callID: id,
          state: {
            status: "completed",
            input: { command: "pwd" },
            title: id,
            output: "/project",
            metadata: {},
            time: { start: 2, end: 3 },
          },
        }
      : {}),
  }) as Part
const work = assistant("work"),
  more = assistant("more"),
  final = assistant("final", "stop")
const [data, setData] = createStore<Data>({
  session: [],
  session_diff: { session: [] },
  message: { session: [root, work, more] },
  part: {
    root: [part("root", "request", "text", "Describe the project")],
    work: [
      part("work", "thought", "reasoning", "Check evidence"),
      part("work", "progress", "text", "I will check the project first."),
      part("work", "command-0", "tool"),
    ],
    more: [part("more", "thought-2", "reasoning", "Continue checking"), part("more", "command-1", "tool")],
    final: [],
  },
})
const [status, setStatus] = createSignal<TurnExecutionState["status"]>("running")
if (new URL(location.href).searchParams.has("empty")) setData("message", "session", [])
const [activity, setActivity] = createSignal<SessionActivity | undefined>({
  phase: "waiting_model",
  startedAt: 1,
  rootID: "root",
})
const [submission, setSubmission] = createSignal<{ activity?: SessionActivity; failed: boolean }>()
const [reading, setReading] = createSignal(false)
const [connected, setConnected] = createSignal(true)
const [mode, setMode] = createSignal<"balanced" | "full" | "minimal">("balanced")
const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
const [rowsReady, setRowsReady] = createSignal(false)
const [scroll, setScroll] = createSignal<HTMLDivElement>()
const [versions, setVersions] = createStore<Record<string, string>>({})
const [historyMode, setHistoryMode] = createSignal<"latest" | "history">("latest")
const [historyMore, setHistoryMore] = createSignal(true)
const historyControls = new URL(location.href).searchParams.has("history-controls")
const [hasPage, setHasPage] = createSignal(true)
const [pendingPage, setPendingPage] = createSignal<string>()
let continuationReady = Promise.withResolvers<void>()
const [contextPageReady, setContextPageReady] = createSignal(true)
let contextPage = Promise.withResolvers<void>()
const [backlogPages, setBacklogPages] = createStore<Record<string, boolean>>({})
const backlogReads = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
const [executionOverride, setExecutionOverride] = createSignal<"running" | "completed">()
const [pageStale, setPageStale] = createSignal(false)
const [mounted, setMounted] = createSignal(true)
const arrivals = createPartArrivalState()
const arrivalOwner = ["http://localhost", "/project", "session"]
const arrivalView = arrivals.open(arrivalOwner)
arrivalView.ready(true)
const scenario = new URL(location.href).searchParams.get("content")
if (new URL(location.href).searchParams.has("outer-paging"))
  setData("part", "work", [
    part("work", "thought", "reasoning", "Check evidence"),
    ...Array.from({ length: 60 }, (_, index) =>
      part(
        "work",
        `reading-${index}`,
        "text",
        `Reading paragraph ${index}. ${"The existing project notes remain available during historical loading. ".repeat(8)}\n\n[Project reference ${index}](https://example.com/project/${index})`,
      ),
    ),
    part("work", "progress", "text", "I will check the project first."),
    part("work", "command-0", "tool"),
  ])
const faults = new Map<string, "denied" | "conflict" | "stalled" | "pending" | "malformed">()
const reads = new Map<string, number>()
const aborts = new Map<string, number>()
const completions = new Map<string, (response: Response) => void>()
if (scenario) {
  setData("part", "root", 0, reconcile(part("root", "request", "text", "Literal message: [object Object]")))
  setData("part", "work", [
    part("work", "thought", "reasoning", "Check evidence"),
    part("work", "progress", "text", "I will check the project first."),
    part("work", "progress-2", "text", "Second paragraph stays readable."),
    part("work", "command-0", "tool"),
  ])
  if (scenario === "pending-refresh") faults.set("progress", "pending")
  else if (
    scenario !== "late-reconnect" &&
    scenario !== "tool-follow" &&
    scenario !== "background" &&
    scenario !== "long-prose" &&
    scenario !== "previous-answer" &&
    scenario !== "long-history"
  )
    faults.set(
      "progress",
      scenario === "mixed"
        ? "denied"
        : scenario === "stalled"
          ? "stalled"
          : scenario === "malformed"
            ? "malformed"
            : "conflict",
    )
  if (scenario === "mixed") faults.set("progress-2", "denied")
}
if (scenario === "background") {
  setData("part", "root", [
    part("root", "request", "text", "Describe the project"),
    ...Array.from({ length: 28 }, (_, i) => part("root", `history-${i}`, "text", `Historical section ${i}`)),
  ])
  setData(
    "part",
    "more",
    Array.from({ length: 12 }, (_, i) => part("more", `many-${i}`, "tool")),
  )
}
if (scenario === "cold-process") {
  setData("part", "more", [
    part("more", "cold-prose", "text", "Pending process prose."),
    ...Array.from({ length: 80 }, (_, index) => part("more", `cold-${index}`, "tool")),
  ])
  setData("part", "final", [part("final", "answer", "text", "Final answer stays mounted.")])
  setData("message", "session", [root, more, { ...final, time: { created: 2, completed: 10 } }])
  setStatus("completed")
  for (const item of data.part.more) faults.set(item.id, "pending")
}
if (scenario === "long-prose") {
  setData(
    "part",
    "more",
    Array.from({ length: 120 }, (_, index) =>
      part(
        "more",
        `long-${index}`,
        "text",
        `中间过程 ${index}。\n\n${"检查已有证据，保留当前阅读位置，继续分析下一处实现。".repeat(12 + (index % 6) * 7)}\n\n[证据 ${index}](https://example.com/evidence/${index})`,
      ),
    ),
  )
  if (new URL(location.href).searchParams.has("mixed-history")) {
    setData(
      "part",
      "more",
      Array.from({ length: 12 }, (_, index) => [
        part("more", `mixed-tool-${index}`, "tool"),
        part(
          "more",
          `mixed-text-${index}`,
          "text",
          `中间记录 ${index}。${"检查已有证据，继续分析下一处实现。".repeat(3 + (index % 4))}`,
        ),
      ]).flat(),
    )
    setData("part", "final", [part("final", "answer", "text", "最终结果。\n\n" + "完整的结果保持可见。".repeat(150))])
    setData("message", "session", [root, more, { ...final, time: { created: 2, completed: 10 } }])
    setStatus("completed")
    if (new URL(location.href).searchParams.has("hold-answer")) faults.set("answer", "pending")
  }
  if (new URL(location.href).searchParams.has("collapsed")) setExpanded("turn-process:root", false)
}
if (scenario === "previous-answer") {
  const previous = { ...root, id: "previous-root", rootID: "previous-root", time: { created: 0 } }
  const previousAnswer = {
    ...assistant("previous-answer", "stop"),
    rootID: previous.id,
    parentID: previous.id,
    time: { created: 0, completed: 1 },
  }
  setData("part", previous.id, [part(previous.id, "previous-request", "text", "Earlier request")])
  setData("part", previousAnswer.id, [
    part(
      previousAnswer.id,
      "previous-answer-body",
      "text",
      Array.from(
        { length: 40 },
        (_, index) => `## Evidence ${index}\n\n${"Earlier accepted evidence remains readable. ".repeat(8)}`,
      ).join("\n\n"),
    ),
  ])
  setData("part", "final", [
    part(
      "final",
      "answer",
      "text",
      "Current result remains visible.\n\n" + "Current accepted evidence remains readable. ".repeat(100),
    ),
  ])
  setData("message", "session", [previous, previousAnswer, root, { ...final, time: { created: 2, completed: 10 } }])
  setStatus("completed")
  faults.set("previous-answer-body", "pending")
}
if (scenario === "cold-user") {
  setData(
    "part",
    "root",
    Array.from({ length: 32 }, (_, index): Part => ({
      id: `file-${index}`,
      sessionID: "session",
      messageID: "root",
      type: "attachment",
      mime: "text/plain",
      filename: `Document ${index}.txt`,
      url: `https://example.com/document-${index}.txt`,
    })),
  )
  setData("part", "final", [part("final", "answer", "text", "Final answer stays mounted.")])
  setData("message", "session", [root, { ...final, time: { created: 2, completed: 10 } }])
  setStatus("completed")
  for (const item of data.part.root) faults.set(item.id, "pending")
}
if (new URL(location.href).searchParams.has("initial-page")) {
  setData("part", "root", [])
  setPendingPage("root")
}
if (scenario === "long-history") {
  setData("message", "session", [root, { ...final, time: { created: 2, completed: 3 } }])
  setData("part", "final", [
    part(
      "final",
      "history-answer",
      "text",
      "Current history anchor. " + "Keep the accepted reply readable. ".repeat(100),
    ),
  ])
  setStatus("completed")
  setActivity(undefined)
}

const canonicalParts =
  scenario === "background" ||
  scenario === "late-reconnect" ||
  scenario === "pending-refresh" ||
  scenario === "cold-process" ||
  scenario === "long-prose" ||
  scenario === "previous-answer" ||
  scenario === "long-history" ||
  scenario === "cold-user"
    ? new Map(Object.entries(data.part).map(([id, parts]) => [id, [...parts]]))
    : undefined
if (scenario === "pending-refresh") setData("part", "work", (parts) => parts.filter((part) => part.id !== "progress"))
if (scenario === "cold-process") setData("part", "more", [])
if (scenario === "long-prose") setData("part", "more", [])
if (scenario === "previous-answer") setData("part", "previous-answer", [])
if (scenario === "cold-user") setData("part", "root", [])
const scrolling = new URL(location.href).searchParams.has("scrolling")
let summaryReads = 0
const summaries = createMemo(() =>
  Object.fromEntries(
    Object.entries(data.part).map(([id, parts]) => [
      id,
      (canonicalParts?.get(id) ?? parts).map((p) => ({
        ...p,
        preview: "",
        status: p.type === "tool" ? p.state.status : undefined,
        reasoningKey: p.type === "reasoning" ? reasoningItemKey(p.metadata) : undefined,
        content: {
          version: versions[p.id] ?? "v1",
          bytes: scenario === "long-prose" ? new TextEncoder().encode(JSON.stringify(p)).length : 64,
        },
      })),
    ]),
  ),
)
let finishPage: (() => void) | undefined
let pageRefresh: Promise<void> | undefined
let finishPageRefresh: (() => void) | undefined
let pageLoads = 0
const messagePageLoads = new Map<string, number>()
const pageReady =
  scenario === "late-reconnect"
    ? new Promise<void>((resolve) => {
        finishPage = resolve
        setHasPage(false)
      })
    : Promise.resolve()
const client = createSynergyClient({
  baseUrl: "http://fixture.local",
  fetch: Object.assign(
    async (request: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      const id = url.pathname.split("/").at(-2)!
      reads.set(id, (reads.get(id) ?? 0) + 1)
      const delay = Number(new URL(location.href).searchParams.get("body-delay"))
      if (delay > 0)
        await new Promise<void>((resolve, reject) => {
          const signal = request instanceof Request ? request.signal : undefined
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort)
            resolve()
          }, delay)
          const abort = () => {
            clearTimeout(timer)
            aborts.set(id, (aborts.get(id) ?? 0) + 1)
            reject(signal?.reason)
          }
          signal?.addEventListener("abort", abort, { once: true })
          if (signal?.aborted) abort()
        })
      if (new URL(location.href).searchParams.has("body-frame"))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const fault = faults.get(id)
      if (fault === "conflict" || fault === "stalled") {
        if (fault === "conflict") faults.delete(id)
        return Response.json(
          { name: "SessionDisplayConflict", data: { message: "Part content changed; refresh its summary" } },
          { status: 409 },
        )
      }
      if (fault === "denied")
        return Response.json(
          { name: "PermissionDenied", data: { message: `Content unavailable: ${id}` } },
          { status: 403 },
        )
      if (fault === "malformed") return Response.json({ data: { message: { detail: "unavailable" } } }, { status: 500 })
      if (fault === "pending")
        return new Promise((resolve, reject) => {
          const signal = request instanceof Request ? request.signal : undefined
          const abort = () => {
            aborts.set(id, (aborts.get(id) ?? 0) + 1)
            reject(signal?.reason)
          }
          signal?.addEventListener("abort", abort, { once: true })
          completions.set(id, (response) => {
            signal?.removeEventListener("abort", abort)
            resolve(response)
          })
        })
      const body = (canonicalParts ? [...canonicalParts.values()] : Object.values(data.part))
        .flat()
        .find((item) => item.id === id)!
      return Response.json({ part: body, version: url.searchParams.get("version") })
    },
    { preconnect() {} },
  ),
})
const materializer = createPartMaterializer({
  read: async (summary, signal) => {
    const response = await client.session.partContent(
      {
        sessionID: summary.sessionID,
        messageID: summary.messageID,
        partID: summary.id,
        version: summary.content.version,
      },
      { signal, throwOnError: true },
    )
    return response.data!
  },
  refresh: async (summary) => {
    const version = `${summary.content.version}-next`
    setVersions(summary.id, version)
    return { ...summary, content: { ...summary.content, version } }
  },
  wait: async () => {},
  apply: (body) => {
    const parts = data.part[body.messageID]
    const index = parts.findIndex((item) => item.id === body.id)
    if (index >= 0) {
      setData("part", body.messageID, index, reconcile(body))
      return
    }
    const order = canonicalParts?.get(body.messageID) ?? parts
    setData(
      "part",
      body.messageID,
      [...parts, body].sort(
        (a, b) => order.findIndex((item) => item.id === a.id) - order.findIndex((item) => item.id === b.id),
      ),
    )
  },
  evict: (summary) => {
    if (!canonicalParts) return
    setData("part", summary.messageID, (parts) => parts.filter((part) => part.id !== summary.id))
  },
})
let retained = 0
let locate: ((messageID: string, behavior?: ScrollBehavior, partID?: string) => Promise<boolean>) | undefined
const turnProjection = createMemo(() => buildSessionTurnProjection(data.message.session))
const context: Partial<PluginConversationService> = {
  sessionID: "session",
  historyMode,
  timeline: () => data.message.session.filter((message) => message.role === "user" && message.isRoot) as UserMessage[],
  lastUserMessage: () => root,
  turnProjection,
  activityDisplay: mode,
  activityView: { getExpanded: (key) => expanded[key], setExpanded: (key, value) => setExpanded(key, value) },
  isWorking: () => status() === "running",
  scrolledUp: reading,
  compactReasoning: () => false,
  canRewind: () => false,
  anchor: (id) => "message-" + id,
  onFirstTurnMounted() {},
  registerMessageLocator: (value) => {
    locate = value
    return () => {}
  },
  content: {
    summaries: (id) => {
      if (scrolling) {
        summaryReads++
        return summaries()[id]
      }
      return (canonicalParts?.get(id) ?? data.part[id]).map((p) => ({
        ...p,
        preview: "",
        status: p.type === "tool" ? p.state.status : undefined,
        reasoningKey: p.type === "reasoning" ? reasoningItemKey(p.metadata) : undefined,
        content: {
          version: versions[p.id] ?? "v1",
          bytes: scenario === "long-prose" ? new TextEncoder().encode(JSON.stringify(p)).length : 64,
        },
      }))
    },
    page: (id) =>
      hasPage() &&
      pendingPage() !== id &&
      backlogPages[id] !== false &&
      (id !== "runtime-context" || contextPageReady())
        ? { hasMore: false, stale: pageStale() }
        : undefined,
    load: async (id) => {
      pageLoads++
      messagePageLoads.set(id, (messagePageLoads.get(id) ?? 0) + 1)
      if (backlogPages[id] === false) await backlogReads.get(id)!.promise
      if (id === "runtime-context" && !contextPageReady()) await contextPage.promise
      if (pendingPage() === id) {
        await continuationReady.promise
        setPendingPage(undefined)
      }
      await pageReady
      await pageRefresh
      setPageStale(false)
      setHasPage(true)
    },
    text: async () => "Final answer stays mounted.",
    retain: (summary) => {
      retained++
      const lease = scenario ? materializer.retain(summary) : undefined
      return {
        ready: lease?.ready ?? Promise.resolve(),
        isCurrent: lease?.isCurrent,
        release: () => {
          retained--
          lease?.release()
        },
      }
    },
  },
}
let toolCaseSequence = 0
window.__conversationProcess = {
  execution: setExecutionOverride,
  backlog(count, ended, delayed = false) {
    batch(() => {
      const messages = Array.from({ length: count }, (_, index) => {
        const id = `backlog-${index}`
        const message = { ...assistant(id), time: { created: 4 + index * 2, completed: 5 + index * 2 } }
        const bodies = Array.from({ length: 4 }, (_, item) => part(id, `${id}-tool-${item}`, "tool"))
        if (delayed) for (const body of bodies) faults.set(body.id, "pending")
        canonicalParts!.set(id, bodies)
        setBacklogPages(id, false)
        backlogReads.set(id, Promise.withResolvers<void>())
        setData("part", id, [])
        return message
      })
      setData("message", "session", (current) => [...current, ...messages])
      if (ended) window.__conversationProcess.background(true, false)
    })
  },
  backlogPage(index) {
    const id = `backlog-${index}`
    setBacklogPages(id, true)
    backlogReads.get(id)?.resolve()
  },
  background(ended, delayed) {
    const message = { ...assistant("background", "stop"), time: { created: 4, completed: ended ? 10 : undefined } }
    const body = part(
      message.id,
      "background-answer",
      "text",
      "Background answer.\n\n" + "More background content. ".repeat(60),
    )
    canonicalParts!.set(message.id, [body])
    if (delayed) faults.set(body.id, "pending")
    setData("part", message.id, [])
    setData("message", "session", (messages) => [...messages, message])
    if (ended) setStatus("completed")
  },
  contentStats: () => Object.fromEntries(reads),
  runtimeContext() {
    contextPage = Promise.withResolvers<void>()
    setContextPageReady(false)
    setData("part", "runtime-context", [])
    setData("message", "session", (messages) => [
      ...messages,
      {
        ...root,
        id: "runtime-context",
        isRoot: false,
        visible: false,
        origin: { type: "system", detail: "runtime-context" },
        time: { created: 4 },
      } satisfies UserMessage,
    ])
  },
  runtimeContextReady() {
    setContextPageReady(true)
    contextPage.resolve()
  },
  continuation() {
    continuationReady = Promise.withResolvers<void>()
    setData("part", "continuation", [])
    setPendingPage("continuation")
    setData("message", "session", (messages) => [
      ...messages,
      { ...assistant("continuation"), finish: undefined, time: { created: 4 } },
    ])
  },
  continuationReady() {
    continuationReady.resolve()
  },
  fragments(count: number) {
    setData("message", "session", [root, work])
    setData("part", "work", [
      ...Array.from(
        { length: count },
        (_, index) =>
          ({
            ...part("work", `summary-${index}`, "reasoning", `Summary paragraph ${index}`),
            metadata: index % 3 === 0 ? undefined : { "openai-codex": { itemId: `rs_${index}` } },
          }) as Part,
      ),
      part("work", "command-0", "tool"),
    ])
  },
  append(id: string, source: "live" | "replay" = "live") {
    arrivals.add(arrivalOwner, id, { source, render: true, previous: data.part.more.some((part) => part.id === id) })
    setData("part", "more", (parts) => [...parts.filter((part) => part.id !== id), part("more", id, "tool")])
  },
  nextTool(id: string, status?: "pending" | "generating") {
    const tool = `${id}-tool`
    if (!status) {
      setData("part", id, [
        part(
          id,
          `${id}-progress`,
          "text",
          "The readable progress stays in place while the next tool becomes ready. ".repeat(40),
        ),
      ])
      setData("message", "session", (messages) => [...messages, assistant(id)])
      return
    }
    faults.set(tool, "pending")
    setData("part", id, (parts): Part[] => [
      ...parts,
      {
        id: tool,
        sessionID: "session",
        messageID: id,
        type: "tool",
        tool: "bash",
        callID: tool,
        state:
          status === "generating" ? { status, input: {}, raw: "", charsReceived: 0 } : { status, input: {}, raw: "" },
      },
    ])
  },

  remount() {
    setMounted(false)
    queueMicrotask(() => setMounted(true))
  },
  reasoning(text: string, partID?: string) {
    setData("part", "work", (parts) =>
      parts.map((part) => (part.type === "reasoning" && (!partID || part.id === partID) ? { ...part, text } : part)),
    )
  },
  images(purpose) {
    const files = [
      [1600, 1000],
      [600, 1200],
      [1600, 200],
    ].map(([width, height], index) => ({
      id: `image-${index}`,
      sessionID: "session",
      messageID: "work",
      type: "attachment" as const,
      mime: "image/svg+xml",
      filename: `capture-${index}.svg`,
      presentation: { purpose: purpose === "evidence" ? ("evidence" as const) : ("deliverable" as const) },
      url:
        "data:image/svg+xml," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#8395a3"/></svg>`,
        ),
    }))
    const tool = part("work", "images", "tool")
    if (tool.type !== "tool" || tool.state.status !== "completed") return
    const state = tool.state
    batch(() => {
      setData("message", "session", [root, work])
      setData("part", "work", [
        part("work", "progress", "text", "Captured images are ready."),
        ...(purpose === "final"
          ? files.slice(0, 1)
          : [
              {
                ...tool,
                state: {
                  ...state,
                  attachments: purpose === "media" ? files.slice(0, 1) : files,
                  metadata:
                    purpose === "media" ? { display: { kind: "media-generation", media: { type: "image" } } } : {},
                },
              },
            ]),
      ])
      setMode("full")
    })
  },
  documents(count, purpose = "evidence") {
    const tool = part("work", "documents", "tool")
    if (tool.type !== "tool" || tool.state.status !== "completed") return
    const state = tool.state
    batch(() => {
      setData("message", "session", [root, work])
      setData("part", "work", [
        part("work", "progress", "text", "Generated documents are ready."),
        {
          ...tool,
          workBrief: "Generate HTML documents",
          state: {
            ...state,
            attachments: ["content.html", "message.html"].slice(0, count).map((filename, index) => ({
              id: `document-${index}`,
              sessionID: "session",
              messageID: "work",
              type: "attachment" as const,
              mime: "text/html",
              filename,
              presentation: { purpose },
              url: `https://example.com/${filename}`,
            })),
          },
        },
      ])
      setMode("full")
    })
  },
  toolCase(tool, input, metadata, status = "completed") {
    const base = part("work", `case-${++toolCaseSequence}`, "tool")
    if (base.type !== "tool") return
    setData("part", "work", (parts) =>
      parts.map((part, index) =>
        index === 2 ? ({ ...base, tool, state: { ...base.state, status, input, metadata } } as Part) : part,
      ),
    )
  },
  prepare() {
    setData("message", "session", [root])
    setStatus("preparing")
    setSubmission({ activity: { phase: "submitting_input", startedAt: 1 }, failed: false })
  },
  phase(value?: SessionActivity) {
    setSubmission(undefined)
    setStatus("running")
    setActivity(value)
  },
  connected: setConnected,
  approval(value: boolean) {
    setStatus(value ? "approval" : "running")
  },
  respond() {
    setSubmission(undefined)
    setStatus("running")
    setActivity({ phase: "responding", startedAt: 1, rootID: "root" })
    setData("part", "final", [part("final", "answer", "text", "Final answer stays mounted.")])
    setData("message", "session", [root, final])
  },
  stream(text = "Final answer stays mounted.") {
    setData("part", "final", [part("final", "answer", "text", text)])
    setData("message", "session", [root, work, more, final])
  },
  terminal() {
    setStatus("completed")
  },
  complete() {
    setStatus("completed")
    setData("message", "session", 3, "time", { created: 2, completed: 10 })
  },
  grow(count) {
    for (let index = 0; index < count; index++) {
      const id = `many-${index}`
      arrivals.add(arrivalOwner, id, {
        source: "live",
        render: true,
        previous: data.part.more.some((part) => part.id === id),
      })
    }
    const parts = Array.from({ length: count }, (_, i) => part("more", "many-" + i, "tool"))
    canonicalParts?.set("more", parts)
    setData("part", "more", parts)
  },
  restoreProcess(count: number) {
    setData(
      "part",
      "more",
      Array.from({ length: count }, (_, i) => part("more", "restored-" + i, "tool")),
    )
    setMounted(false)
    queueMicrotask(() => setMounted(true))
  },
  backfill(count: number) {
    context.autoScroll?.handleInteraction(new Event("history-load"))
    window.__conversationProcess.hydrateBefore(count)
  },
  hydrateBefore(count: number) {
    setData("part", "root", [
      part("root", "request", "text", "Describe the project"),
      ...Array.from({ length: count }, (_, index) =>
        part("root", `history-${index}`, "text", `Historical section ${index}`),
      ),
    ])
  },
  growReadingParagraph(id: string, count: number) {
    const index = data.part.work.findIndex((item) => item.id === id)
    const current = data.part.work[index]
    if (current?.type !== "text") return
    setData(
      "part",
      "work",
      index,
      reconcile({ ...current, text: `${current.text}\n\n${"Earlier accepted paragraph grows. ".repeat(count)}` }),
    )
  },
  growToolEvidence(id: string) {
    const index = data.part.more.findIndex((item) => item.id === id)
    const current = data.part.more[index]
    if (current?.type !== "tool" || current.state.status !== "completed") return
    const evidence: Extract<Part, { type: "attachment" }> = {
      id: `${id}-evidence`,
      sessionID: current.sessionID,
      messageID: current.messageID,
      type: "attachment",
      mime: "image/svg+xml",
      filename: "Late reading evidence.svg",
      url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><text x="10" y="20">Late body while native paging is moving</text></svg>')}`,
      presentation: { purpose: "evidence" },
    }
    setData(
      "part",
      "more",
      index,
      reconcile({
        ...current,
        state: {
          ...current.state,
          attachments: [...(current.state.attachments ?? []), evidence],
        },
      }),
    )
  },
  latest() {
    setHistoryMode("latest")
    scroll()?.dispatchEvent(new Event("conversation-location-reset"))
    context.autoScroll?.forceScrollToBottom()
  },
  prependTurns(count: number, more = false) {
    setHistoryMode("history")
    const processHistory = new URL(location.href).searchParams.get("process-history")
    if (processHistory) {
      const message = assistant("earlier-process")
      batch(() => {
        setData("part", message.id, [
          part(message.id, "earlier-thought", "reasoning", "Earlier reasoning remains available."),
          ...Array.from({ length: 30 }, (_, index) => part(message.id, `earlier-tool-${index}`, "tool")),
          ...(processHistory === "split"
            ? [part(message.id, "earlier-prose", "text", "Earlier intermediate explanation. ".repeat(80))]
            : []),
        ])
        setData("message", "session", (current) => [root, message, ...current.filter((item) => item.id !== root.id)])
        setHistoryMore(more)
      })
      return
    }
    context.autoScroll?.handleInteraction(new Event("history-load"))
    const older = Array.from({ length: count }, (_, index): UserMessage => ({
      ...root,
      id: `earlier-turn-${index}`,
      rootID: `earlier-turn-${index}`,
      time: { created: -count + index },
    }))
    const messages: (UserMessage | AssistantMessage)[] = []
    for (const [index, message] of older.entries()) {
      setData("part", message.id, [part(message.id, `${message.id}-text`, "text", `Earlier turn ${message.id}`)])
      messages.push(message)
      if (scenario !== "long-history" || index < count - 3) continue
      const reply = {
        ...assistant(`${message.id}-reply`, "stop"),
        parentID: message.id,
        rootID: message.id,
        time: { created: message.time.created + 0.1, completed: message.time.created + 0.2 },
      }
      canonicalParts!.set(reply.id, [
        part(
          reply.id,
          `${reply.id}-body`,
          "text",
          `Earlier accepted reply ${index}. ` + "Historical evidence remains readable. ".repeat(300),
        ),
      ])
      setData("part", reply.id, [])
      messages.push(reply)
    }
    setData("message", "session", (current) => [...messages, ...current])
    setHistoryMore(more)
  },
  prepend(count: number) {
    setData("part", "more", [
      ...Array.from({ length: count }, (_, i) => part("more", "older-" + i, "tool")),
      ...data.part.more,
    ])
  },
  delivery() {
    const message: UserMessage = {
      ...root,
      id: "delivery",
      isRoot: false,
      origin: { type: "cortex", sessionID: "child", label: "Check browser readiness" },
      time: { created: 50 },
    }
    setData("part", message.id, [part(message.id, "delivery-text", "text", "Captured child result")])
    setData("message", "session", (messages) => [...messages.filter((item) => item.id !== message.id), message])
  },
  manualCompaction() {
    setData("message", "session", 0, "metadata", { compactionBoundary: true })
    setData("part", "root", [])
    setData("message", "session", (messages) => [messages[0]])
  },
  compaction(state: "running" | "committed" | "failed") {
    const message: AssistantMessage = {
      ...assistant("compression"),
      mode: "compaction",
      agent: "compaction",
      metadata: { compactionAttempt: { state } },
      time: { created: 60, completed: state === "running" ? undefined : 70 },
      error: state === "failed" ? { name: "UnknownError", data: { message: "Provider unavailable" } } : undefined,
    }
    setData(
      "part",
      message.id,
      state === "committed"
        ? [
            {
              id: "recovery",
              sessionID: "session",
              messageID: message.id,
              type: "compaction_recovery",
              summary: "Compressed continuation",
              mechanical: false,
              validated: true,
            },
          ]
        : [],
    )
    setData("message", "session", (messages) => [...messages.filter((item) => item.id !== message.id), message])
  },
  mode: setMode,
  locate: (messageID: string, partID?: string) => locate?.(messageID, "auto", partID) ?? Promise.resolve(false),
  reading: setReading,
  retained: () => retained,
  summaryReads: () => summaryReads,
  contentRecover(id) {
    faults.delete(id)
    setVersions(id, `${versions[id] ?? "v1"}-recovered`)
  },
  contentPending(id) {
    faults.set(id, "pending")
  },
  contentFinish(id) {
    faults.delete(id)
    const body = (canonicalParts ? [...canonicalParts.values()] : Object.values(data.part))
      .flat()
      .find((item) => item.id === id)!
    completions.get(id)?.(Response.json({ part: body, version: versions[id] ?? "v1" }))
    completions.delete(id)
  },
  select: selectSession,
  contentReads: (id) => reads.get(id) ?? 0,
  contentAborts: (id) => aborts.get(id) ?? 0,
  contentReconnect() {
    materializer.invalidate("work")
    setHasPage(false)
  },
  contentPageFinish() {
    finishPage?.()
    finishPageRefresh?.()
    finishPageRefresh = undefined
    pageRefresh = undefined
  },
  contentStale() {
    pageRefresh = new Promise<void>((resolve) => {
      finishPageRefresh = resolve
    })
    setPageStale(true)
  },
  contentPageLoads: (id) => (id ? (messagePageLoads.get(id) ?? 0) : pageLoads),
}
if (new URL(location.href).searchParams.has("first-response")) {
  window.__conversationProcess.prepare()
  window.__conversationProcess.phase({ phase: "preparing_files", startedAt: 1, rootID: "root" })
  window.__conversationProcess.prependTurns(12)
}
const runtime = {
  statusFor: (): SessionStatus =>
    status() === "running" || status() === "approval" ? { type: "busy", activity: activity() } : { type: "idle" },
  permissionsFor: () => [],
  questionsFor: () => [],
  cortexTasks: () => [],
}
const resource = {
  openToolActivity: (target: unknown) => {
    window.__processSelection = target
    return true
  },
  openActivityDetail: (target: unknown) => {
    window.__processSelection = target
    return true
  },
  open: async (target: unknown) => {
    window.__processSelection = target
    return { status: "cancelled" as const }
  },
}
function Scroller(props: ParentProps) {
  const active = useViewActivity()
  const [motionTarget, setMotionTarget] = createSignal<HTMLElement>()
  const hydrated = createConversationHydration({ active, ready: rowsReady, surface: motionTarget, onHydrated() {} })
  const autoScroll = scrolling
    ? createAutoScroll({
        enabled: active,
        working: context.isWorking!,
        motionTarget: new URL(location.href).searchParams.has("motion")
          ? () => (!resident || hydrated() ? motionTarget() : undefined)
          : undefined,
        captureReadingAnchor: ({ reading, target }) => {
          const element = scroll()
          if (!element || !reading) return
          return captureConversationReadingAnchor(element, () => scroll() === element, target)
        },
      })
    : undefined
  context.autoScroll = autoScroll && {
    ...autoScroll,
    forceScrollToBottom: () => autoScroll.forceScrollToBottom({ untilInteraction: true }),
  }
  if (autoScroll) context.scrolledUp = () => reading() || autoScroll.userScrolled()
  createEffect(on(scroll, (element) => autoScroll?.scrollRef(element)))
  return (
    <div
      ref={setScroll}
      onScroll={() => autoScroll?.handleScroll()}
      onClick={(event) => autoScroll?.handleInteraction(event)}
      style={{
        height: new URL(location.href).searchParams.has("underflow") ? "4000px" : "600px",
        overflow: "auto",
        width: "700px",
        "max-width": "100%",
      }}
      data-scroller
      data-hydrated={hydrated()}
    >
      <div ref={(element) => autoScroll?.contentRef(element)} style={{ overflow: "clip" }}>
        <div ref={setMotionTarget} data-follow-motion>
          <Show when={historyControls && historyMore()}>
            <button
              type="button"
              data-history-load
              style="height:40px;display:block;margin-bottom:20px"
              onClick={async () => {
                await Promise.resolve()
                window.__conversationProcess.prependTurns(
                  120,
                  new URL(location.href).searchParams.has("keep-history-control"),
                )
              }}
            >
              Load earlier messages
            </button>
          </Show>
          <ConversationMotionProvider ready={hydrated}>{props.children}</ConversationMotionProvider>
        </div>
      </div>
      <button type="button" data-outside-control>
        Outside conversation
      </button>
    </div>
  )
}
function Transcript() {
  return (
    <Scroller>
      <Show when={mounted()}>
        <VirtualConversationRows
          onReady={setRowsReady}
          layoutOwner={["http://localhost", "/project", "session"]}
          takePartArrival={arrivalView.take}
          liveRevision={arrivalView.revision}
          context={context as PluginConversationService}
          scrollRef={scroll()}
          submissionFor={() => submission()}
          executionFor={() => ({
            rootID: "root",
            status: executionOverride() ?? status(),
            startedAt: 1,
            stoppedAt: [],
          })}
          connected={connected}
        />
      </Show>
    </Scroller>
  )
}
render(
  () => (
    <I18nProvider
      i18n={setupI18n({
        locale: new URL(location.href).searchParams.get("locale") ?? "en",
        messages: { en: {}, "zh-CN": chineseMessages },
      })}
    >
      <ThemeProvider>
        <DialogProvider>
          <ResourceOpenProvider value={resource}>
            <MarkedProvider>
              <DiffComponentProvider component={() => null}>
                <DataProvider data={data} runtime={runtime} directory="/project" serverUrl="http://localhost">
                  <Show when={resident} fallback={<Transcript />}>
                    <nav>
                      <button onClick={() => selectSession("peer")}>Session A</button>
                      <button onClick={() => selectSession("session")}>Session B</button>
                    </nav>
                    <RetainedSessionViews
                      owner={{
                        server: "http://localhost",
                        scopeID: "/project",
                        sessionID: selectedSession(),
                        generation: "one",
                      }}
                      render={(owner) =>
                        owner.sessionID === "session" ? (
                          <Transcript />
                        ) : (
                          <div>
                            <p>Independent session A</p>
                            <textarea aria-label="Session A draft" />
                          </div>
                        )
                      }
                    />
                  </Show>
                </DataProvider>
              </DiffComponentProvider>
            </MarkedProvider>
          </ResourceOpenProvider>
        </DialogProvider>
      </ThemeProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
