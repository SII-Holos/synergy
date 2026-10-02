import { KanbanReorderMenu, type KanbanReorderAction } from "./reorder-menu"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { translateDescriptor } from "@/locales/translate"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import type {
  AgentSummary,
  AssistantMessage,
  FileDiff,
  Message,
  Part,
  Session,
  UserMessage,
} from "@ericsanchezok/synergy-sdk/client"
import { DataProvider } from "@ericsanchezok/synergy-ui/context"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { buildSessionTurnProjection } from "@ericsanchezok/synergy-ui/session-turn-projection"
import type { ActivityDisplayMode } from "@ericsanchezok/synergy-ui/session-turn-activity"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import { ConversationViewport } from "@/components/session/conversation-viewport"
import { buildConversationTimelineSnapshot } from "@/components/session/conversation-timeline"
import {
  isActionCommandMessage,
  messagesFrom,
  selectMessagesInCanonicalOrder,
} from "@/components/session/session-message-order"
import { resolveSessionVisualState } from "@/components/sidebar/session-visual-state"
import { paneDisplayState, paneHeadStatusFromVisual } from "../model/head-status"
import { hasMessageWindowSnapshot, type MessageWindowMetadata } from "@/context/session-message-window"
import { useLocale } from "@/context/locale"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { kanbanPage } from "@/locales/messages"
import { useGlobalSync } from "@/context/global-sync"
import { createSessionDataRuntime } from "@/context/session-data-view"
import { isWorkingStatus } from "@/utils/session-status"
import type { BoardPane } from "../model/pane-selection"
import { KANBAN_REORDER_MIME } from "@/utils/session-drag"
import { KanbanPaneComposer, type BoardWorkflowKind } from "./composer"
import type { ControlProfileId } from "@/context/input"
import "../kanban.css"
import "@ericsanchezok/synergy-ui/menu-field"

export type BoardPaneData = {
  message: Record<string, Message[]>
  messageWindow: Record<string, MessageWindowMetadata>
  part: Record<string, Part[]>
  session_diff: Record<string, FileDiff[]>
  session: Session[]
  agent: AgentSummary[]
}

export type BoardPaneLoadState = {
  phase: string
  hasSnapshot: boolean
  error?: string
}

/** Latest-mode turn window cap per pane, mirroring the session surface. */
const MAX_RENDERED_TURNS = 40

export function KanbanPane(props: {
  draft?: string
  onDraftChange?: (value: string) => void
  reorderActions?: KanbanReorderAction[]
  onReorder?: (key: string) => void
  pane: BoardPane
  data: BoardPaneData
  serverUrl: string
  directory: string
  follow: () => boolean
  onToggleFollow: () => void
  onOpen: () => void
  onActivate?: () => void
  onPinToggle?: () => void
  /** Reactive pinned flag: must be an accessor because Solid's keyed For
   *  does not re-invoke pane rows on flag-only changes. */
  pinned: () => boolean
  compact?: boolean
  activityDisplay: () => ActivityDisplayMode
  compactReasoning: () => boolean
  loadState?: () => BoardPaneLoadState | undefined
  onRetry?: () => void
  onSend: (text: string, options?: { agent?: string }) => Promise<void>
  onUpdateProfile: (profile: ControlProfileId) => Promise<void>
  onSetWorkflow: (kind: BoardWorkflowKind) => Promise<void>
}) {
  const { _, i18n } = useLingui()
  const { fmt } = useLocale()
  const globalSync = useGlobalSync()
  const runtime = createSessionDataRuntime(globalSync)
  const [scrolledUp, setScrolledUp] = createSignal(false)

  const messages = createMemo(() => props.data.message[props.pane.sessionID] ?? [])
  const hasSnapshot = createMemo(() =>
    hasMessageWindowSnapshot(props.data.message[props.pane.sessionID], props.data.messageWindow[props.pane.sessionID]),
  )
  const working = createMemo(() => isWorkingStatus(globalSync.sessionStatus[props.pane.sessionID]))
  // Autoscroll follows only while the pane's follow toggle is enabled, so
  // "Paused" actually stops the stream from scrolling; the viewport's manual
  // scroll-to-bottom button still forces a jump.
  const autoScroll = createAutoScroll({
    working: () => props.follow() && working(),
    onMeasure: (distance) => setScrolledUp(distance > 100),
  })
  const visual = createMemo(() =>
    props.pane.entry
      ? resolveSessionVisualState({
          entry: props.pane.entry,
          status: globalSync.sessionStatus[props.pane.sessionID],
          waiting:
            (globalSync.permissions[props.pane.sessionID]?.length ?? 0) > 0 ||
            (globalSync.questions[props.pane.sessionID]?.length ?? 0) > 0,
          runningChildTasks: globalSync.cortex.some(
            (task) => task.parentSessionID === props.pane.sessionID && task.status === "running",
          ),
        })
      : undefined,
  )
  const headStatus = createMemo(() =>
    props.pane.entry
      ? paneHeadStatusFromVisual({
          statusType: globalSync.sessionStatus[props.pane.sessionID]?.type,
          tone: visual()?.tone,
          pulse: visual()?.pulse,
          completionUnread: visual()?.completionUnread,
        })
      : undefined,
  )
  const displayState = createMemo(() => (visual() ? paneDisplayState(visual()!) : undefined))

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
  const scopeLabel = createMemo(() => {
    if (props.pane.entry?.scopeType === "home") return _({ id: "app.sidebar.section.home", message: "Home" })
    const scope = globalSync.data.scope.find((scope) => scope.id === props.pane.entry?.scopeID)
    return (
      scope?.name ||
      scope?.local?.worktree.split(/[\\/]/).at(-1) ||
      _({ id: "app.kanban.scope.unknown", message: "Unknown scope" })
    )
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
      data-pane-pinned={props.pinned() || undefined}
      data-compact={props.compact || undefined}
      class="kanban-pane"
    >
      <div class="kanban-pane-head" data-status={headStatus() || undefined}>
        <div class="kanban-pane-heading">
          <Tooltip value={props.pane.entry?.title ?? _(kanbanPage.unavailable)}>
            <button type="button" class="kanban-pane-title" onClick={props.onOpen} title={_(kanbanPage.openSession)}>
              <Show
                when={props.pane.kind === "live" && props.pane.entry}
                fallback={<span class="kanban-pane-title-text">{_(kanbanPage.unavailable)}</span>}
              >
                <span class="kanban-pane-title-text">{props.pane.entry!.title}</span>
              </Show>
            </button>
          </Tooltip>
          <div class="kanban-pane-meta">
            <span class="kanban-pane-scope" title={scopeLabel()}>
              {scopeLabel()}
            </span>
            <Show when={displayState()}>
              {(state) => (
                <span class="kanban-pane-state" title={translateDescriptor(state().label, i18n())}>
                  <Icon name={state().icon} size="small" />
                  <span>{translateDescriptor(state().label, i18n())}</span>
                </span>
              )}
            </Show>
            <span class="kanban-pane-time">{lastActivity()}</span>
          </div>
        </div>
        <div class="kanban-pane-actions">
          <Show when={props.onActivate}>
            <button
              type="button"
              class="kanban-pane-action kanban-pane-activate"
              aria-label={_({
                id: "app.kanban.focusSession",
                message: "Focus {title}",
                values: { title: props.pane.entry?.title ?? props.pane.sessionID },
              })}
              onClick={props.onActivate}
            >
              {_(kanbanPage.layoutFocus)}
            </button>
          </Show>
          <Show when={props.pane.kind === "live"}>
            <button
              class="kanban-pane-action"
              data-active={props.follow() || undefined}
              aria-pressed={props.follow()}
              aria-label={props.follow() ? _(kanbanPage.follow) : _(kanbanPage.unfollow)}
              onClick={props.onToggleFollow}
              title={props.follow() ? _(kanbanPage.follow) : _(kanbanPage.unfollow)}
            >
              <Icon name={getSemanticIcon("session.followLatest")} size="small" />
            </button>
          </Show>
          <Show when={props.onPinToggle}>
            <button
              class="kanban-pane-action"
              data-active={props.pinned() || undefined}
              aria-pressed={props.pinned()}
              aria-label={props.pinned() ? _(kanbanPage.unpinPane) : _(kanbanPage.pinPane)}
              onClick={props.onPinToggle}
              title={props.pinned() ? _(kanbanPage.unpinPane) : _(kanbanPage.pinPane)}
            >
              <Icon
                name={props.pinned() ? getSemanticIcon("action.unpin") : getSemanticIcon("action.pin")}
                size="small"
              />
            </button>
          </Show>
          <Show when={props.pane.kind === "live"}>
            <span
              class="kanban-pane-grip"
              draggable={props.pinned()}
              data-locked={!props.pinned() || undefined}
              title={props.pinned() ? _(kanbanPage.dragReorder) : _(kanbanPage.pinToReorderHint)}
              aria-label={props.pinned() ? _(kanbanPage.dragReorder) : _(kanbanPage.pinToReorderHint)}
              onDragStart={(event) => {
                if (!props.pinned()) {
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
          <Show when={props.reorderActions}>
            <KanbanReorderMenu actions={props.reorderActions!} onReorder={props.onReorder} />
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
                <div class="kanban-pane-error" role="alert">
                  <Icon name={getSemanticIcon("state.warning")} class="text-icon-critical-base" />
                  <span>{_(kanbanPage.loadError)}</span>
                  <span class="text-12-regular text-text-weaker">{_(kanbanPage.loadErrorDescription)}</span>
                  <Show when={props.onRetry}>
                    <Button
                      type="button"
                      variant="secondary"
                      icon={getSemanticIcon("action.refresh")}
                      onClick={props.onRetry}
                    >
                      {_(kanbanPage.retry)}
                    </Button>
                  </Show>
                  <details class="max-w-full text-start">
                    <summary class="cursor-pointer text-text-interactive-base">{_(kanbanPage.errorDetails)}</summary>
                    <pre class="mt-2 whitespace-pre-wrap break-words text-12-regular">{loadError()}</pre>
                  </details>
                </div>
              </Show>
            }
          >
            <DataProvider
              data={props.data}
              runtime={runtime}
              directory={liveSession()?.workspace?.path ?? null}
              serverUrl={props.serverUrl}
              onNavigateToSession={props.onOpen}
            >
              <ConversationViewport
                scrolledUp={scrolledUp()}
                onScrolledUpChange={setScrolledUp}
                autoScroll={autoScroll}
                setScrollRef={(el, releaseOf) => autoScroll.scrollRef(el, releaseOf)}
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
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          sessionID={props.pane.sessionID}
          agents={props.data.agent}
          session={liveSession()}
          status={globalSync.sessionStatus[props.pane.sessionID]}
          onSend={props.onSend}
          onUpdateProfile={props.onUpdateProfile}
          onSetWorkflow={props.onSetWorkflow}
        />
      </Show>
    </div>
  )
}
