import { batch, createMemo, createSignal, Show, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import type { PluginConversationService, PluginConversationViewport } from "@ericsanchezok/synergy-plugin"
import type { Part, SessionStatus, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { DataProvider, type Data } from "@ericsanchezok/synergy-ui/context/data"
import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { buildSessionTurnProjection } from "@ericsanchezok/synergy-ui/session-turn-projection"
import { useTheme } from "@ericsanchezok/synergy-ui/theme/context"
import { createSessionTransitionState } from "../../../src/context/session-transition"
import { createSessionSubmissionView, submissionPartPage } from "../../../src/context/session-submission-view"
import { createOptimisticUserMessage } from "../../../src/components/prompt-input/optimistic-user-message"
import {
  createSubmissionPartIDs,
  createSubmissionParts,
  optimisticPartSummaries,
} from "../../../src/components/prompt-input/submission-parts"
import { ConversationViewport } from "../../../src/components/session/conversation-viewport"
import { VirtualConversationRows } from "../../../src/components/session/virtual-conversation-rows"
import { SessionSubmissionStatus, submissionForRoot } from "../../../src/components/session/session-submission-status"
import {
  createNewSessionTransitionProgress,
  createSessionTransitionHandoffErrorProgress,
} from "../../../src/components/session/session-transition-progress"
import { createNewSessionWorkspaceProgress } from "../../../src/components/session/worktree-session"

export function SubmissionFixture(props: { locale(): void }) {
  const theme = useTheme()
  const state = createSessionTransitionState()
  const lease = state.prepareDraft("draft")
  const [route, setRoute] = createSignal(false)
  const entry = () => state.get(route() ? "session" : "draft")
  const [status, setStatus] = createSignal<SessionStatus>({ type: "idle" })
  const [scroll, setScroll] = createSignal<HTMLDivElement>()
  const [data, setData] = createStore<Data>({ session: [], message: {}, part: {}, session_diff: {} })
  const [ready, setReady] = createSignal(!new URL(location.href).searchParams.has("preparing"))
  const runtime = { statusFor: status, permissionsFor: () => [], questionsFor: () => [], cortexTasks: () => [] }
  const view = createSessionSubmissionView(createSessionDataView(data, runtime), () => entry()?.draft, ready)
  const prompt = [{ type: "text" as const, content: "Inspect this project", start: 0, end: 20 }]
  const message = createOptimisticUserMessage({
    id: "message",
    sessionID: "session",
    created: 1,
    agent: "general",
    model: { providerID: "test", modelID: "test" },
  })
  const parts = createSubmissionParts({
    id: createSubmissionPartIDs(),
    prompt,
    context: [],
    notes: [],
    sessions: [],
    attachments: new URL(location.href).searchParams.has("image")
      ? Array.from({ length: new URL(location.href).searchParams.has("many") ? 8 : 1 }, (_, index) => ({
          type: "attachment",
          id: `upload-${index}`,
          filename: index ? `sample-${index}.svg` : "sample.svg",
          mime: "image/svg+xml",
          url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='88' height='88'%3E%3Crect width='88' height='88' fill='gray'/%3E%3C/svg%3E",
        }))
      : [],
  }).map((part) => ({ ...part, sessionID: "session", messageID: "message" })) as Part[]
  lease.submit({ text: prompt[0].content, messageID: message.id, prompt, message, parts })
  lease.progress(createNewSessionWorkspaceProgress({ selection: { mode: "create" }, stage: "workspace" }))
  const projection = createMemo(() => buildSessionTurnProjection(view.messagesFor("session")))
  const [pageReady, setPageReady] = createSignal(true)
  let contentLoads = 0
  let contentLoad: Promise<void> | undefined
  const context: Partial<PluginConversationService> = {
    sessionID: "session",
    timeline: () => view.messagesFor("session"),
    lastUserMessage: () => view.messagesFor("session").at(-1) as UserMessage,
    turnProjection: projection,
    activityDisplay: () => "balanced",
    isWorking: () => status().type === "busy",
    scrolledUp: () => false,
    compactReasoning: () => false,
    canRewind: () => false,
    anchor: (id) => "message-" + id,
    onFirstTurnMounted() {},
    registerMessageLocator: () => () => {},
    content: {
      summaries: (id) => optimisticPartSummaries(view.partsFor(id)),
      page: (id) =>
        submissionPartPage({
          ready: true,
          captured: entry()?.draft?.message?.id === id,
          message: data.message.session?.find((message) => message.id === id),
          page: pageReady() ? { hasMore: false, hasEarlier: false, nextCursor: null, previousCursor: null } : undefined,
        }),
      load: (id) => {
        if (pageReady()) return Promise.resolve()
        return (contentLoad ??= new Promise<void>((resolve) => setTimeout(resolve, 300)).then(() => {
          contentLoads++
          batch(() => {
            setData(
              "part",
              id,
              parts.map((part) => ({ ...part, messageID: id })),
            )
            setPageReady(true)
          })
          contentLoad = undefined
        }))
      },
      text: async () => prompt[0].content,
      retain: () => ({ ready: Promise.resolve(), release() {} }),
    },
  }
  const owner = ["server", "scope", "session"]
  state.messageArrival.add(owner, message.id)
  let retries = 0
  const fixture = {
    locale: props.locale,
    theme: (mode: "light" | "dark") => theme.setColorScheme(mode),
    submitting: () => lease.progress(createNewSessionTransitionProgress()),
    handoff: () =>
      startTransition(() => {
        lease.handoff("session", createNewSessionTransitionProgress())
        void startTransition(() => setRoute(true))
      }),
    canonical: (id = "message", binary = false) =>
      batch(() => {
        state.messageIdentity.handoff(owner, message.id, id)
        state.handoffMessage("session", id)
        setData("message", "session", [{ ...message, id, rootID: id, metadata: {} }])
        setData(
          "part",
          id,
          parts.map((part) => ({
            ...part,
            messageID: id,
            ...(binary && part.type === "attachment" ? { metadata: { fixtureOpaque: "x".repeat(128 * 1024) } } : {}),
          })),
        )
      }),
    evict: (id = "message") =>
      batch(() => {
        setData("part", id, [])
        setPageReady(false)
      }),
    contentLoads: () => contentLoads,
    ready: () => setReady(true),
    history: () =>
      batch(() => {
        setData("message", "session", [
          { ...message, id: "history", rootID: "history", time: { created: 0 }, metadata: {} },
        ])
        setData("part", "history", [
          { id: "history-text", messageID: "history", sessionID: "session", type: "text", text: "Unchecked history" },
        ])
      }),
    waiting: (id = "message") =>
      batch(() => {
        setStatus({ type: "busy", activity: { phase: "waiting_model", rootID: id, startedAt: 1 } })
        state.clear("session")
      }),
    lateReceipt: () =>
      state.set("session", createNewSessionTransitionProgress(), undefined, {
        messageID: "message",
        success: { ...createNewSessionTransitionProgress(), phase: "success" },
      }),
    fail: () =>
      lease.progress(
        createSessionTransitionHandoffErrorProgress({
          kind: "new-session",
          error: { code: "InputMaterializationError", message: "Execution configuration unavailable" },
        }),
        { retry: () => retries++ },
      ),
    retries: () => retries,
  }
  ;(window as unknown as { fixture: typeof fixture }).fixture = fixture
  const autoScroll: PluginConversationViewport = {
    readingAnchorOwner: () => undefined,
    forceScrollToBottom() {},
    handleScroll() {},
    handleInteraction() {},
    contentRef() {},
  } as PluginConversationViewport
  const resource = {
    open: async () => ({ status: "cancelled" as const }),
  }
  return (
    <DialogProvider>
      <ResourceOpenProvider value={resource}>
        <MarkedProvider>
          <DiffComponentProvider component={() => null}>
            <DataProvider data={data} view={view} directory="/project" serverUrl="http://localhost">
              <div style="height:600px;width:100%">
                <ConversationViewport
                  scrolledUp={false}
                  onScrolledUpChange={() => {}}
                  autoScroll={autoScroll}
                  setScrollRef={(el) => {
                    setScroll(el)
                    if (el) {
                      el.dataset.testScroller = ""
                      el.style.height = "600px"
                      el.style.overflowY = "auto"
                    }
                  }}
                  contentClass="session-content-column"
                >
                  <VirtualConversationRows
                    layoutOwner={["http://localhost", "/project", "session"]}
                    context={context as PluginConversationService}
                    scrollRef={scroll()}
                    messageKey={(id) => state.messageIdentity.key(owner, id)}
                    takeUserArrival={(id) => state.messageArrival.take(owner, id)}
                    submissionFor={(id) => submissionForRoot(entry(), id, status())}
                  />
                  <Show when={entry()}>{(value) => <SessionSubmissionStatus entry={value()} hideLoading />}</Show>
                </ConversationViewport>
              </div>
            </DataProvider>
          </DiffComponentProvider>
        </MarkedProvider>
      </ResourceOpenProvider>
    </DialogProvider>
  )
}
