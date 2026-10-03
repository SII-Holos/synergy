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
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { DataProvider } from "@ericsanchezok/synergy-ui/context/data"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { VirtualConversationRows } from "../../../src/components/session/virtual-conversation-rows"

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
const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
const [scroll, setScroll] = createSignal<HTMLDivElement>()
let retained = 0
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
  activityDisplay: () => "balanced",
  activityView: { getExpanded: (key) => expanded[key], setExpanded: (key, value) => setExpanded(key, value) },
  isWorking: () => status() === "running",
  scrolledUp: reading,
  compactReasoning: () => false,
  canRewind: () => false,
  anchor: (id) => "message-" + id,
  onFirstTurnMounted() {},
  content: {
    summaries: (id) =>
      data.part[id].map((p) => ({
        ...p,
        preview: "",
        status: p.type === "tool" ? p.state.status : undefined,
        content: { version: "v1", bytes: 64 },
      })),
    page: () => ({ hasMore: false }),
    load: async () => {},
    text: async () => "Final answer stays mounted.",
    retain: () => {
      retained++
      return { ready: Promise.resolve(), release: () => retained-- }
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
  reading: setReading,
  retained: () => retained,
}
const runtime = {
  statusFor: (): SessionStatus => (status() === "running" ? { type: "busy", activity: activity() } : { type: "idle" }),
  permissionsFor: () => [],
  questionsFor: () => [],
  cortexTasks: () => [],
}
const resource = {
  openToolActivity: () => true,
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
