import { For, Show, createMemo, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import type { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import type { UserMessage, AssistantMessage, Message, SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import { SessionTimeline } from "./session-timeline"
import { ConversationViewport } from "./conversation-viewport"
import { navMark } from "@/utils/perf"
import { BrowserViewEffects } from "@/components/workspace/browser/browser-view-effects"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionTransitionActions, SessionTransitionProgress } from "./session-transition-progress"
import { SessionTransitionCard } from "./session-transition-card"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import { pendingTimelineItemView } from "./conversation-pending"

export function SessionConversation(props: {
  sessionID: string
  paramsDir: string
  timeline: Accessor<Message[]>
  pendingTimeline?: Accessor<SessionInboxItem[]>
  sessionTransition?: Accessor<SessionTransitionProgress | null>
  sessionTransitionActions?: Accessor<SessionTransitionActions | undefined>
  visibleUserMessages: Accessor<UserMessage[]>
  lastUserMessage: Accessor<UserMessage | undefined>
  activeMessage: Accessor<UserMessage | undefined>
  workspaceOpen?: Accessor<boolean>
  isWorking: Accessor<boolean>
  turnStart: number
  turnBatch: number
  onSetTurnStart: (start: number) => void
  historyMore: Accessor<boolean>
  historyLoading: Accessor<boolean>
  historyMode: Accessor<"latest" | "history">
  historyPendingLatest: Accessor<boolean>
  onReturnLatest: () => void
  onLoadMore: () => void
  scrolledUp: Accessor<boolean>
  onScrolledUpChange: (val: boolean) => void
  autoScroll: ReturnType<typeof createAutoScroll>
  onClearHash: () => void
  onScheduleScrollSpy: (container: HTMLDivElement) => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  isDesktop: Accessor<boolean>
  scrollToMessage: (msg: UserMessage, behavior?: ScrollBehavior) => void
  anchor: (id: string) => string
  terminalHeight: Accessor<number>
  onRewind?: (message: UserMessage) => void
  onReviewChanges?: (input: { messageID: string; file?: string }) => void
  onPendingGuide?: (item: SessionInboxItem) => void
  onPendingRemove?: (item: SessionInboxItem) => void
  rollbackActive?: boolean
}) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const workspaceOpen = createMemo(() => props.workspaceOpen?.() ?? false)
  return (
    <ConversationViewport
      scrolledUp={props.scrolledUp()}
      onScrolledUpChange={props.onScrolledUpChange}
      autoScroll={props.autoScroll}
      setScrollRef={props.setScrollRef}
      onScrollToBottom={props.onClearHash}
      onScrollContainer={(el) => {
        if (props.isDesktop()) props.onScheduleScrollSpy(el)
      }}
      overlay={
        <Show when={props.isDesktop() && !workspaceOpen()}>
          <div class="absolute inset-0 pointer-events-none z-10">
            <SessionTimeline
              messages={props.visibleUserMessages}
              currentMessage={props.activeMessage}
              onMessageSelect={props.scrollToMessage}
              bottomOffset={props.terminalHeight}
              compressed={workspaceOpen}
            />
          </div>
        </Show>
      }
      contentClass="mx-auto flex w-full min-w-0 flex-col items-start justify-start gap-5 px-4 text-sm md:text-base transition-[margin] md:px-5"
      contentClassList={{
        "max-w-full": true,
        "md:max-w-[60rem]": true,
        "pb-4 md:pb-[calc(var(--prompt-height,10rem)+96px)]": true,
      }}
    >
      <MessageSlotOutlet slot="message.above-conversation" sessionId={props.sessionID} />
      <BrowserViewEffects timeline={props.timeline} />
      <Show when={props.turnStart > 0}>
        <div class="w-full flex justify-center">
          <Button
            variant="ghost"
            size="large"
            class="text-12-medium opacity-50"
            onClick={() => props.onSetTurnStart(Math.max(0, props.turnStart - props.turnBatch))}
          >
            {_(S.convRenderEarlier)}
          </Button>
        </div>
      </Show>
      <Show when={props.historyMore() || props.historyMode() === "history" || props.historyPendingLatest()}>
        <div class="w-full flex flex-wrap justify-center gap-2">
          <Show when={props.historyMore()}>
            <Button
              variant="ghost"
              size="large"
              class="text-12-medium opacity-50"
              disabled={props.historyLoading()}
              onClick={props.onLoadMore}
            >
              {props.historyLoading() ? _(S.convLoadingEarlier) : _(S.convLoadEarlier)}
            </Button>
          </Show>
          <Show when={props.historyMode() === "history" || props.historyPendingLatest()}>
            <Button
              variant="secondary"
              size="large"
              class="text-12-medium"
              disabled={props.historyLoading()}
              onClick={props.onReturnLatest}
            >
              {props.historyPendingLatest() ? _(S.convNewMessagesReturnLatest) : _(S.convReturnLatest)}
            </Button>
          </Show>
        </div>
      </Show>
      <For each={props.timeline()}>
        {(msg, index) => {
          onMount(() => {
            navMark({ dir: props.paramsDir, to: props.sessionID, name: "session:first-turn-mounted" })
          })

          const isLast = () => index() === (props.timeline()?.length ?? 0) - 1

          if (msg.role === "assistant") {
            const assistantMsg = msg as AssistantMessage
            const source = assistantMsg.metadata?.source as string | undefined
            const isCommand = source === "command"
            const Component = isCommand ? CommandResultOutput : MailboxMessage

            return (
              <div
                id={props.anchor(msg.id)}
                data-message-id={msg.id}
                class="min-w-0 w-full max-w-full"
                style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
              >
                <MessageSlotOutlet
                  slot="message.before"
                  sessionId={props.sessionID}
                  messageId={msg.id}
                  role="assistant"
                />
                <Component
                  message={assistantMsg}
                  classes={{
                    root: "min-w-0 w-full relative",
                    container: "w-full min-w-0 max-w-full px-3 md:px-1 pb-1",
                  }}
                />
                <MessageSlotOutlet
                  slot="message.actions"
                  sessionId={props.sessionID}
                  messageId={msg.id}
                  role="assistant"
                />
                <MessageSlotOutlet
                  slot="message.after"
                  sessionId={props.sessionID}
                  messageId={msg.id}
                  role="assistant"
                />
              </div>
            )
          }

          return (
            <div
              id={props.anchor(msg.id)}
              data-message-id={msg.id}
              class="min-w-0 w-full max-w-full"
              style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
            >
              <SessionTurn
                sessionID={props.sessionID}
                messageID={msg.id}
                lastUserMessageID={props.lastUserMessage()?.id}
                onRewind={() => props.onRewind?.(msg as UserMessage)}
                rollbackActive={props.rollbackActive}
                onReviewChanges={props.onReviewChanges}
                classes={{
                  root: "min-w-0 w-full relative",
                  content: "flex flex-col justify-between !overflow-visible",
                  container: "w-full min-w-0 max-w-full px-3 md:px-1 pb-1 md:max-w-[60rem] md:mx-auto",
                }}
              />
            </div>
          )
        }}
      </For>
      <Show when={props.sessionTransition?.()}>
        {(progress) => (
          <div class="w-full min-w-0 px-3 md:px-1">
            <SessionTransitionCard
              progress={progress()}
              onRetry={props.sessionTransitionActions?.()?.retry}
              onDismiss={props.sessionTransitionActions?.()?.dismiss}
            />
          </div>
        )}
      </Show>
      <Show when={props.pendingTimeline?.()?.length}>
        <div class="w-full flex flex-col items-start gap-2 opacity-50">
          <For each={props.pendingTimeline?.() ?? []}>
            {(item) => {
              const view = () => pendingTimelineItemView(item.mode, props.rollbackActive === true)
              const label = () =>
                item.message?.parts?.[0]?.type === "text"
                  ? (item.message.parts[0] as { text: string }).text
                  : (item.summary?.title ?? _(S.convPending))
              return (
                <div
                  data-slot="pending-timeline-item"
                  data-mode={item.mode}
                  data-frozen={view().frozen}
                  class="flex w-full items-center gap-2 rounded-lg bg-background-weak px-3 py-2 text-sm text-text-weak"
                  style={{ animation: "fadeUp 0.3s ease-out both" }}
                >
                  <Show when={view().frozen} fallback={<Icon name={getSemanticIcon("agenda.main")} size="small" />}>
                    <span class="inline-flex items-center gap-1 text-11-medium" title={_(S.convPausedTooltip)}>
                      <Icon name={getSemanticIcon("agenda.main")} size="small" />
                      {_(S.convPaused)}
                    </span>
                  </Show>
                  <div class="min-w-0 flex-1 text-14-regular line-clamp-2">{label()}</div>
                  <div class="ml-auto flex shrink-0 items-center gap-1">
                    <Show when={view().primaryAction}>
                      {(primaryAction) => (
                        <button
                          type="button"
                          class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-11-medium hover:bg-background-base hover:text-text-base"
                          title={primaryAction() === "queue" ? _(S.convMoveToQueueTitle) : _(S.convGuideRunTitle)}
                          onClick={() => props.onPendingGuide?.(item)}
                        >
                          <Icon
                            name={getSemanticIcon(primaryAction() === "queue" ? "prompt.submit" : "command.start")}
                            size="small"
                          />
                          <span>{primaryAction() === "queue" ? _(S.convQueue) : _(S.convGuide)}</span>
                        </button>
                      )}
                    </Show>
                    <Show when={view().canWithdraw}>
                      <button
                        type="button"
                        class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-11-medium hover:bg-background-base hover:text-text-base"
                        title={_(S.convRemovePendingTitle)}
                        onClick={() => props.onPendingRemove?.(item)}
                      >
                        <Icon name={getSemanticIcon("action.close")} size="small" />
                        <span>{_(S.convWithdraw)}</span>
                      </button>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
      <MessageSlotOutlet slot="message.footer" sessionId={props.sessionID} />
    </ConversationViewport>
  )
}
