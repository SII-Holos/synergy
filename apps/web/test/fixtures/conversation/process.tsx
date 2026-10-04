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
import { createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { DataProvider } from "@ericsanchezok/synergy-ui/context/data"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { VirtualConversationRows } from "../../../src/components/session/virtual-conversation-rows"
import { createPartMaterializer } from "../../../src/context/part-materializer"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

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
const [activity, setActivity] = createSignal<SessionActivity>({ phase: "waiting_model", startedAt: 1, rootID: "root" })
const [submission, setSubmission] = createSignal<{ activity?: SessionActivity; failed: boolean }>()
const [reading, setReading] = createSignal(false)
const [mode, setMode] = createSignal<"balanced" | "full" | "minimal">("balanced")
const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
const [scroll, setScroll] = createSignal<HTMLDivElement>()
const [versions, setVersions] = createStore<Record<string, string>>({})
const [hasPage, setHasPage] = createSignal(true)
const scenario = new URL(location.href).searchParams.get("content")
const faults = new Map<string, "denied" | "conflict" | "stalled" | "pending" | "malformed">()
const reads = new Map<string, number>()
const completions = new Map<string, (response: Response) => void>()
if (scenario) {
  setData("part", "root", 0, reconcile(part("root", "request", "text", "Literal message: [object Object]")))
  setData("part", "work", [
    part("work", "thought", "reasoning", "Check evidence"),
    part("work", "progress", "text", "I will check the project first."),
    part("work", "progress-2", "text", "Second paragraph stays readable."),
    part("work", "command-0", "tool"),
  ])
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
const client = createSynergyClient({
  baseUrl: "http://fixture.local",
  fetch: Object.assign(
    async (request: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      const id = url.pathname.split("/").at(-2)!
      reads.set(id, (reads.get(id) ?? 0) + 1)
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
        return new Promise((resolve) => {
          completions.set(id, resolve)
        })
      const body = Object.values(data.part)
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
    const index = data.part[body.messageID].findIndex((item) => item.id === body.id)
    setData("part", body.messageID, index, reconcile(body))
  },
  evict: () => {},
})
let retained = 0
let locate: ((messageID: string, behavior?: ScrollBehavior, partID?: string) => Promise<boolean>) | undefined
const context: Partial<PluginConversationService> = {
  sessionID: "session",
  timeline: () => [data.message.session[0]],
  lastUserMessage: () => root,
  turnProjection: () => ({
    roots: [],
    byRoot: new Map(),
    memberIndex: new Map(),
    turnMessagesFor: () => data.message.session.slice(1),
    compactionParentIDs: new Set<string>(),
  }),
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
    summaries: (id) =>
      data.part[id].map((p) => ({
        ...p,
        preview: "",
        status: p.type === "tool" ? p.state.status : undefined,
        content: { version: versions[p.id] ?? "v1", bytes: 64 },
      })),
    page: () => (hasPage() ? { hasMore: false } : undefined),
    load: async () => {
      await Promise.resolve()
      setHasPage(true)
    },
    text: async () => "Final answer stays mounted.",
    retain: (summary) => {
      retained++
      const lease = scenario ? materializer.retain(summary) : undefined
      return {
        ready: lease?.ready ?? Promise.resolve(),
        release: () => {
          retained--
          lease?.release()
        },
      }
    },
  },
}
window.__conversationProcess = {
  prepare() {
    setData("message", "session", [root])
    setStatus("preparing")
    setSubmission({ activity: { phase: "submitting_input", startedAt: 1 }, failed: false })
  },
  phase(value: SessionActivity) {
    setSubmission(undefined)
    setStatus("running")
    setActivity(value)
  },
  respond() {
    setSubmission(undefined)
    setStatus("running")
    setActivity({ phase: "responding", startedAt: 1, rootID: "root" })
    setData("part", "final", [part("final", "answer", "text", "Final answer stays mounted.")])
    setData("message", "session", [root, final])
  },
  stream() {
    setData("part", "final", [part("final", "answer", "text", "Final answer stays mounted.")])
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
    setData(
      "part",
      "more",
      Array.from({ length: count }, (_, i) => part("more", "many-" + i, "tool")),
    )
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
    setData("part", "root", [
      { id: "compact-request", sessionID: "session", messageID: "root", type: "compaction", auto: false },
    ])
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
  contentRecover(id) {
    faults.delete(id)
    setVersions(id, `${versions[id] ?? "v1"}-recovered`)
  },
  contentPending(id) {
    faults.set(id, "pending")
  },
  contentFinish(id) {
    faults.delete(id)
    const body = Object.values(data.part)
      .flat()
      .find((item) => item.id === id)!
    completions.get(id)?.(Response.json({ part: body, version: versions[id] ?? "v1" }))
    completions.delete(id)
  },
  contentReads: (id) => reads.get(id) ?? 0,
  contentReconnect() {
    materializer.invalidate("work")
    setHasPage(false)
  },
}
const runtime = {
  statusFor: (): SessionStatus => (status() === "running" ? { type: "busy", activity: activity() } : { type: "idle" }),
  permissionsFor: () => [],
  questionsFor: () => [],
  cortexTasks: () => [],
}
const resource = {
  openToolActivity: () => true,
  openActivityDetail: (target: unknown) => {
    window.__processSelection = target
    return true
  },
  open: () => false,
  openAttachment: () => false,
  resolveWorkspacePath: (v: string) => v,
  openWorkspaceSource: () => false,
}
render(
  () => (
    <I18nProvider i18n={setupI18n({ locale: "en", messages: { en: {} } })}>
      <DialogProvider>
        <ResourceOpenProvider value={resource}>
          <MarkedProvider>
            <DiffComponentProvider component={() => null}>
              <DataProvider data={data} runtime={runtime} directory="/project" serverUrl="http://localhost">
                <div ref={setScroll} style="height:600px;overflow:auto;width:700px" data-scroller>
                  <VirtualConversationRows
                    context={context as PluginConversationService}
                    scrollRef={scroll()}
                    submissionFor={() => submission()}
                    executionFor={() => ({ rootID: "root", status: status(), startedAt: 1, stoppedAt: [] })}
                  />
                  <button type="button" data-outside-control>
                    Outside conversation
                  </button>
                </div>
              </DataProvider>
            </DiffComponentProvider>
          </MarkedProvider>
        </ResourceOpenProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
