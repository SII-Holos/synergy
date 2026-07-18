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
  showTabs: Accessor<boolean>
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
        "md:max-w-[60rem]": !props.showTabs(),
        "mt-0": props.showTabs(),
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
          const hasTabs = props.showTabs() && (props.visibleUserMessages()?.length ?? 0) > 1

          if (msg.role === "assistant") {
            const assistantMsg = msg as AssistantMessage
            const source = assistantMsg.metadata?.source as string | undefined
            const isCommand = source === "command"
            const Component = isCommand ? CommandResultOutput : MailboxMessage
            const tabClass = hasTabs ? (workspaceOpen() ? "md:pr-3 md:pl-10" : "md:pr-6 md:pl-18") : ""

            return (
              <div
                id={props.anchor(msg.id)}
                data-message-id={msg.id}
                class="min-w-0 w-full max-w-full"
                style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
              >
                <Component
                  message={assistantMsg}
                  classes={{
                    root: "min-w-0 w-full relative",
                    container: "w-full min-w-0 max-w-full px-3 md:px-1 pb-1 " + tabClass,
                  }}
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
                  container:
                    "w-full min-w-0 max-w-full px-3 md:px-1 pb-1 " +
                    (!props.showTabs()
                      ? "md:max-w-[60rem] md:mx-auto"
                      : hasTabs
                        ? workspaceOpen()
                          ? "md:pr-3 md:pl-10"
                          : "md:pr-6 md:pl-18"
                        : ""),
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
              const isTask = () => item.mode === "task"
              const guideLabel = () => (item.mode === "steer" ? _(S.convQueue) : _(S.convGuide))
              const label = () =>
                item.message?.parts?.[0]?.type === "text"
                  ? (item.message!.parts[0] as { text: string }).text
                  : (item.summary?.title ?? _(S.convPending))
              return (
                <div class="w-full flex items-center gap-4" style={{ animation: "fadeUp 0.3s ease-out both" }}>
                  <div class="w-full px-3 md:px-1 max-w-[60rem] md:mx-auto flex items-center gap-6">
                    <div class="w-full flex items-center gap-6 px-2 rounded-full">
                      <div class="w-full min-w-0 text-14-regular line-clamp-2 text-text-weak">{label()}</div>
                    </div>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </ConversationViewport>
  )
}
