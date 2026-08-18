import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import type {
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
import { SessionTurn, collectMessagesForTurnDisplay } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import { ConversationViewport } from "@/components/session/conversation-viewport"
import { resolveSessionVisualState, type SessionVisualStore } from "@/components/sidebar/session-visual-state"
import { hasMessageWindowSnapshot, type MessageWindowMetadata } from "@/context/session-message-window"
import { kanbanPage } from "@/locales/messages"
import type { BoardPane } from "../model/pane-selection"
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
  /** Waterfall variant: render a timestamp above every message for time-aligned comparison. */
  timeAlign?: boolean
}) {
  const { _ } = useLingui()
  const [scrolledUp, setScrolledUp] = createSignal(false)
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>()

  const messages = createMemo(() => props.data.message[props.pane.sessionID] ?? [])
  const hasSnapshot = createMemo(() =>
    hasMessageWindowSnapshot(props.data.message[props.pane.sessionID], props.data.messageWindow[props.pane.sessionID]),
  )
  const working = createMemo(() => props.data.session_status[props.pane.sessionID]?.type !== "idle")
  const autoScroll = createAutoScroll({ working })
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
  const lastActivity = createMemo(() => {
    const at = props.pane.entry?.lastActivityAt
    if (!at) return ""
    const minutes = Math.max(1, Math.round((Date.now() - at) / 60000))
    if (minutes < 60) return `${minutes}m`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.round(hours / 24)}d`
  })
  onCleanup(() => {
    autoScroll.scrollRef(undefined)
  })

  const formatMsgTime = (created: number) =>
    new Date(created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

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
              <Icon name={getSemanticIcon("action.pin")} size="small" />
            </button>
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
          <Show when={hasSnapshot()} fallback={<div class="kanban-pane-empty">{_(kanbanPage.loading)}</div>}>
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
                setScrollRef={(el) => setScrollEl(el)}
                scrollButtonOffsetClass="bottom-3"
                contentClass="px-2 py-2 flex flex-col items-start gap-3 text-sm"
              >
                <For each={messages()}>
                  {(message) => {
                    const row = (content: JSX.Element) => (
                      <div
                        data-message-id={message.id}
                        data-message-role={message.role}
                        class="kanban-pane-msg w-full min-w-0"
                      >
                        {props.timeAlign ? (
                          <span class="kanban-msg-time">{formatMsgTime(message.time.created)}</span>
                        ) : null}
                        {content}
                      </div>
                    )
                    if (message.role === "assistant") {
                      const assistant = message as AssistantMessage
                      const isCommand = assistant.metadata?.source === "command"
                      return row(
                        <Dynamic
                          component={isCommand ? CommandResultOutput : MailboxMessage}
                          message={assistant}
                          classes={{ root: "min-w-0 w-full relative", container: "w-full min-w-0 max-w-full" }}
                        />,
                      )
                    }
                    if (message.role === "user" && (message as UserMessage).isRoot) {
                      return row(
                        <SessionTurn
                          sessionID={props.pane.sessionID}
                          messageID={message.id}
                          rootMessage={message as UserMessage}
                          messages={collectMessagesForTurnDisplay(messages(), message.id)}
                          activityDisplay="minimal"
                          classes={{ root: "min-w-0 w-full relative", container: "w-full min-w-0 max-w-full" }}
                        />,
                      )
                    }
                    return null
                  }}
                </For>
              </ConversationViewport>
            </DataProvider>
          </Show>
        </Show>
      </div>
    </div>
  )
}
