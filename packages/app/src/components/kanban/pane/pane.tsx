import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import type {
  Agent,
  AssistantMessage,
  CortexTask,
  FileDiff,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  UserMessage,
} from "@ericsanchezok/synergy-sdk/client"
import { DataProvider } from "@ericsanchezok/synergy-ui/context"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { buildSessionTurnProjection } from "@ericsanchezok/synergy-ui/session-turn-projection"
import type { ActivityDisplayMode } from "@ericsanchezok/synergy-ui/session-turn-activity"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import { ConversationViewport } from "@/components/session/conversation-viewport"
import { buildConversationTimelineSnapshot } from "@/components/session/conversation-timeline"
import { messagesFrom, selectMessagesInCanonicalOrder } from "@/components/session/session-message-order"
import { resolveSessionVisualState, type SessionVisualStore } from "@/components/sidebar/session-visual-state"
import { hasMessageWindowSnapshot, type MessageWindowMetadata } from "@/context/session-message-window"
import { useLocale } from "@/context/locale"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { kanbanPage } from "@/locales/messages"
import type { BoardPane } from "../model/pane-selection"
import { KANBAN_REORDER_MIME } from "@/utils/session-drag"
import { KanbanPaneComposer, type BoardWorkflowKind } from "./composer"
import type { ControlProfileId } from "@/context/input"
import "../kanban.css"

export type BoardPaneData = {
  message: Record<string, Message[]>
  messageWindow: Record<string, MessageWindowMetadata>
  part: Record<string, Part[]>
  session_diff: Record<string, FileDiff[]>
  session_status: Record<string, SessionStatus>
  permission?: Record<string, PermissionRequest[]>
  question?: Record<string, QuestionRequest[]>
  cortex: CortexTask[]
  session: Session[]
  agent: Agent[]
}

export type BoardPaneLoadState = {
  phase: string
  hasSnapshot: boolean
  error?: string
}

/** Latest-mode turn window cap per pane, mirroring the session surface. */
const MAX_RENDERED_TURNS = 40

function isActionCommandMessage(message: Message): boolean {
  const metadata = message.metadata as
    | { command?: { kind?: string; promptVisible?: boolean }; promptVisible?: boolean }
    | undefined
  if (metadata?.command?.kind !== "action") return false
  if (message.includeInContext !== undefined) return message.includeInContext === false
  return metadata.promptVisible === false
}

export function KanbanPane(props: {
  pane: BoardPane
  data: BoardPaneData
  serverUrl: string
  directory: string
  follow: () => boolean
  onToggleFollow: () => void
  onOpen: () => void
  onPinToggle?: () => void
  onRemove?: () => void
  compact?: boolean
  activityDisplay: () => ActivityDisplayMode
  compactReasoning: () => boolean
  loadState?: () => BoardPaneLoadState | undefined
  onRetry?: () => void
  onSend: (text: string, options?: { agent?: string }) => Promise<void>
  onUpdateProfile: (profile: ControlProfileId) => Promise<void>
  onSetWorkflow: (kind: BoardWorkflowKind) => Promise<void>
}) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const [scrolledUp, setScrolledUp] = createSignal(false)

  const messages = createMemo(() => props.data.message[props.pane.sessionID] ?? [])
  const hasSnapshot = createMemo(() =>
    hasMessageWindowSnapshot(props.data.message[props.pane.sessionID], props.data.messageWindow[props.pane.sessionID]),
  )
  const working = createMemo(() => props.data.session_status[props.pane.sessionID]?.type !== "idle")
  // Autoscroll follows only while the pane's follow toggle is enabled, so
  // "Paused" actually stops the stream from scrolling; the viewport's manual
  // scroll-to-bottom button still forces a jump.
  const autoScroll = createAutoScroll({ working: () => props.follow() && working() })
  const visualStore: SessionVisualStore | undefined = props.pane.entry
    ? {
        session_status: props.data.session_status,
        permission: (props.data.permission ?? {}) as Record<string, unknown[] | undefined>,
        question: (props.data.question ?? {}) as Record<string, unknown[] | undefined>,
        cortex: props.data.cortex,
        session: props.data.session,
      }
    : undefined
  const visual = createMemo(() =>
    props.pane.entry ? resolveSessionVisualState(visualStore, props.pane.entry) : undefined,
  )

  // Localized relative activity label with a one-minute update cadence so an
  // idle pinned pane keeps advancing while mounted.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(timer))
  })
  const lastActivity = createMemo(() => {
    const at = props.pane.entry?.lastActivityAt
    if (!at) return ""
    return fmt.relative(at, new Date(now()))
  })

  // Turn projection + latest-mode trimming (mirrors the session conversation):
  // roots render as SessionTurn rows, mailbox/action assistants render as
  // standalone rows, and ordinary turn members render only inside their turn.
  const projection = createMemo(() => buildSessionTurnProjection(messages()))
  const trimmedRoots = createMemo(() => {
    const roots = projection().roots
    return roots.length > MAX_RENDERED_TURNS ? roots.slice(roots.length - MAX_RENDERED_TURNS) : roots
  })
  const lastRoot = createMemo(() => projection().roots.at(-1))
  const firstRenderedID = createMemo(() => trimmedRoots()[0]?.id)
  const canonical = createMemo(() => (firstRenderedID() ? messagesFrom(messages(), firstRenderedID()!) : messages()))
  const timeline = createMemo(() => {
    const mailbox: Message[] = []
    const actionCommands: Message[] = []
    for (const msg of canonical()) {
      if (isActionCommandMessage(msg)) {
        actionCommands.push(msg)
        continue
      }
      if (msg.role !== "assistant") continue
      if (!(msg as AssistantMessage).metadata?.mailbox) continue
      mailbox.push(msg)
    }
    return selectMessagesInCanonicalOrder(messages(), [...trimmedRoots(), ...mailbox, ...actionCommands])
  })
  // Key rows by stable message id so window reloads / part deltas never
  // destroy and recreate the whole SessionTurn tree (see conversation-timeline).
  const timelineSnapshot = createMemo(() => buildConversationTimelineSnapshot(timeline()))

  const loadError = createMemo(() => {
    const load = props.loadState?.()
    return load?.phase === "error" && !load.hasSnapshot ? (load.error ?? "") : ""
  })

  onCleanup(() => {
    autoScroll.scrollRef(undefined)
  })

  // Session-level data for the full composer (agent picker / profile /
  // workflow menu / status bar). Live panes only.
  const liveSession = createMemo(() =>
    props.pane.kind === "live" ? props.data.session.find((s) => s.id === props.pane.sessionID) : undefined,
  )

  return (
    <div
      data-component="kanban-pane"
      data-pane-kind={props.pane.kind}
      data-pane-pinned={props.pane.pinned || undefined}
      data-compact={props.compact || undefined}
      class="kanban-pane"
    >
      <div class="kanban-pane-head">
        <Show when={props.pane.kind === "live" && props.pane.entry}>
          <span
            class={`kanban-dot kanban-dot-${visual()?.tone ?? "default"}`}
            data-pulse={visual()?.pulse || undefined}
            aria-hidden="true"
          />
        </Show>
        <button class="kanban-pane-title" onClick={props.onOpen} title={_(kanbanPage.openSession)}>
          <Show
            when={props.pane.kind === "live" && props.pane.entry}
            fallback={<span class="kanban-pane-title-text">{_(kanbanPage.unavailable)}</span>}
          >
            <span class="kanban-pane-title-text">{props.pane.entry!.title}</span>
          </Show>
        </button>
        <span class="kanban-pane-scope">
          {props.pane.entry?.scopeType === "home" ? "HOME" : props.pane.entry?.scopeID}
        </span>
        <span class="kanban-pane-time">{lastActivity()}</span>
        <div class="kanban-pane-actions">
          <Show when={props.pane.kind === "live"}>
            <button
              class="kanban-pane-action"
              data-active={props.follow() || undefined}
              onClick={props.onToggleFollow}
              title={props.follow() ? _(kanbanPage.follow) : _(kanbanPage.unfollow)}
            >
              <Icon
                name={props.follow() ? getSemanticIcon("session.running") : getSemanticIcon("session.idle")}
                size="small"
              />
            </button>
          </Show>
          <Show when={props.onPinToggle}>
            <button
              class="kanban-pane-action"
              data-active={props.pane.pinned || undefined}
              onClick={props.onPinToggle}
              title={props.pane.pinned ? _(kanbanPage.unpinPane) : _(kanbanPage.pinPane)}
            >
              <Icon
                name={props.pane.pinned ? getSemanticIcon("action.unpin") : getSemanticIcon("action.pin")}
                size="small"
              />
            </button>
          </Show>
          <Show when={props.pane.kind === "live"}>
            <span
              class="kanban-pane-grip"
              draggable="true"
              data-locked={!props.pane.pinned || undefined}
              title={props.pane.pinned ? _(kanbanPage.dragReorder) : _(kanbanPage.pinToReorderHint)}
              aria-label={props.pane.pinned ? _(kanbanPage.dragReorder) : _(kanbanPage.pinToReorderHint)}
              onDragStart={(event) => {
                if (!props.pane.pinned) {
                  event.preventDefault()
                  showToast({ type: "info", title: _(kanbanPage.pinToReorderHint) })
                  return
                }
                event.dataTransfer?.setData(KANBAN_REORDER_MIME, props.pane.key)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
              }}
            >
              <Icon name={getSemanticIcon("action.grip")} size="small" />
            </span>
          </Show>
          <Show when={props.onRemove}>
            <button class="kanban-pane-action" onClick={props.onRemove} title={_(kanbanPage.removePane)}>
              <Icon name={getSemanticIcon("action.clear")} size="small" />
            </button>
          </Show>
        </div>
      </div>
      <div class="kanban-pane-body">
        <Show
          when={props.pane.kind === "live" && props.pane.entry}
          fallback={
            <div class="kanban-pane-empty">
              <Icon name={getSemanticIcon("session.default")} size="small" />
              <span>{_(kanbanPage.unavailable)}</span>
            </div>
          }
        >
          <Show
            when={hasSnapshot()}
            fallback={
              <Show when={loadError()} fallback={<div class="kanban-pane-empty">{_(kanbanPage.loading)}</div>}>
                <div class="kanban-pane-error">
                  <span>{_(kanbanPage.loadError)}</span>
                  <Show when={props.onRetry}>
                    <button class="kanban-pane-action kanban-pane-retry" onClick={props.onRetry}>
                      <Icon name={getSemanticIcon("action.refresh")} size="small" />
                      <span>{_(kanbanPage.retry)}</span>
                    </button>
                  </Show>
                </div>
              </Show>
            }
          >
            <DataProvider
              data={props.data}
              directory={props.directory}
              serverUrl={props.serverUrl}
              onNavigateToSession={props.onOpen}
            >
              <ConversationViewport
                scrolledUp={scrolledUp()}
                onScrolledUpChange={setScrolledUp}
                autoScroll={autoScroll}
                setScrollRef={(el) => autoScroll.scrollRef(el)}
                scrollButtonOffsetClass="bottom-3"
                contentClass="px-2 py-2 flex flex-col items-start gap-3 text-sm"
              >
                <For each={timelineSnapshot().keys}>
                  {(key) => {
                    const message = () => timelineSnapshot().map.get(key)
                    const row = (content: JSX.Element) => (
                      <div
                        data-message-id={key}
                        data-message-role={message()?.role}
                        class="kanban-pane-msg w-full min-w-0"
                      >
                        {content}
                      </div>
                    )
                    if (message()?.role === "assistant") {
                      const assistant = () => message() as AssistantMessage
                      const isCommand = () => assistant().metadata?.source === "command"
                      return row(
                        <Dynamic
                          component={isCommand() ? CommandResultOutput : MailboxMessage}
                          message={assistant()}
                          classes={{ root: "min-w-0 w-full relative", container: "w-full min-w-0 max-w-full" }}
                        />,
                      )
                    }
                    const root = () => message() as UserMessage
                    return row(
                      <SessionTurn
                        sessionID={props.pane.sessionID}
                        messageID={key}
                        rootMessage={root()}
                        messages={projection().turnMessagesFor(root())}
                        lastUserMessageID={lastRoot()?.id}
                        activityDisplay={props.activityDisplay()}
                        compactReasoning={props.compactReasoning()}
                        classes={{ root: "min-w-0 w-full relative", container: "w-full min-w-0 max-w-full" }}
                      />,
                    )
                  }}
                </For>
              </ConversationViewport>
            </DataProvider>
          </Show>
        </Show>
      </div>
      <Show when={props.pane.kind === "live" && !props.compact}>
        <KanbanPaneComposer
          sessionID={props.pane.sessionID}
          agents={props.data.agent}
          session={liveSession()}
          status={props.data.session_status[props.pane.sessionID]}
          onSend={props.onSend}
          onUpdateProfile={props.onUpdateProfile}
          onSetWorkflow={props.onSetWorkflow}
        />
      </Show>
    </div>
  )
}
