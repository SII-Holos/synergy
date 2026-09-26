import type { PluginComponentProps, PluginConversationService } from "@ericsanchezok/synergy-plugin"
import { Dynamic } from "solid-js/web"
import { For, Show, createMemo, onMount } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import type { UserMessage, AssistantMessage, Message } from "@ericsanchezok/synergy-sdk"
import { SessionTimeline } from "./session-timeline"
import { buildConversationTimelineSnapshot } from "./conversation-timeline"
import { ConversationViewport } from "./conversation-viewport"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import { PendingTimelineItem } from "./pending-timeline-item"

export function SessionConversation(input: PluginComponentProps<PluginConversationService>) {
  const props = input.context
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const workspaceOpen = createMemo(() => props.workspaceOpen?.() ?? false)
  const lastTimelineID = createMemo(() => props.timeline()?.at(-1)?.id)
  const turnProjection = props.turnProjection
  // Rows below are keyed by the stable message id (see conversation-timeline):
  // message objects are replaced in place by window reload, reconnect replay,
  // rollback copies, and message.updated reconcile. Reference-keyed rows would
  // destroy and recreate the whole SessionTurn tree on every replacement while
  // the abandoned tree stayed alive in the Solid owner graph — the renderer
  // heap grew to the 4 GiB V8 limit after ~33h of a long session.
  const timelineSnapshot = createMemo(() => buildConversationTimelineSnapshot(props.timeline() ?? []))
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
        "pb-6 md:pb-[calc(var(--prompt-height,10rem)+96px)]": true,
      }}
    >
      <MessageSlotOutlet slot="message.above-conversation" sessionId={props.sessionID} />
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
      <For each={timelineSnapshot().keys}>
        {(key) => {
          onMount(() => {
            props.onFirstTurnMounted()
          })

          // Reading the current snapshot through getters keeps the row mounted
          // across object replacement while updated message data flows through.
          const message = () => timelineSnapshot().map.get(key)
          const rootMessage = () => message() as UserMessage
          const isLast = () => key === lastTimelineID()
          const turnMessages = () => {
            const root = rootMessage()
            return root ? turnProjection().turnMessagesFor(root) : []
          }
          if (!message()) return null

          if (message()?.role === "assistant") {
            const assistantMessage = () => message() as AssistantMessage
            const source = () => assistantMessage().metadata?.source as string | undefined
            const isCommand = () => source() === "command"

            return (
              <div
                id={props.anchor(key)}
                data-message-id={key}
                data-message-role="assistant"
                class="min-w-0 w-full max-w-full"
                style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
              >
                <MessageSlotOutlet slot="message.before" sessionId={props.sessionID} messageId={key} role="assistant" />
                <Dynamic
                  component={isCommand() ? CommandResultOutput : MailboxMessage}
                  message={assistantMessage()}
                  classes={{
                    root: "min-w-0 w-full relative",
                    container: "w-full min-w-0 max-w-full px-3 md:px-1 pb-1",
                  }}
                />
                <MessageSlotOutlet
                  slot="message.actions"
                  sessionId={props.sessionID}
                  messageId={key}
                  role="assistant"
                />
                <MessageSlotOutlet slot="message.after" sessionId={props.sessionID} messageId={key} role="assistant" />
              </div>
            )
          }

          return (
            <div
              id={props.anchor(key)}
              data-message-id={key}
              data-message-role="user"
              class="min-w-0 w-full max-w-full"
              style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
            >
              <SessionTurn
                sessionID={props.sessionID}
                messageID={key}
                rootMessage={rootMessage()}
                messages={turnMessages()}
                compactionParentIDs={turnProjection().compactionParentIDs}
                activityDisplay={props.activityDisplay()}
                lastUserMessageID={props.lastUserMessage()?.id}
                compactReasoning={props.compactReasoning()}
                onRewind={props.canRewind(rootMessage()) ? () => props.onRewind?.(rootMessage()) : undefined}
                rollbackActive={props.rollbackActive}
                onReviewChanges={props.onReviewChanges}
                onForkMessage={props.onForkMessage}
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
      {props.transition?.()}
      <Show when={props.pendingTimeline?.()?.length}>
        <div class="w-full flex flex-col items-start gap-2">
          <For each={(props.pendingTimeline?.() ?? []).map((item) => item.id)}>
            {(id) => {
              const item = () => props.pendingTimeline?.()?.find((item) => item.id === id)
              return (
                <Show when={item()}>
                  <PendingTimelineItem
                    item={item()!}
                    rollbackActive={props.rollbackActive === true}
                    hasCanonicalRoot={props.hasCanonicalRoot()}
                    onGuide={props.onPendingGuide}
                    onRemove={props.onPendingRemove}
                  />
                </Show>
              )
            }}
          </For>
        </div>
      </Show>
      <MessageSlotOutlet slot="message.footer" sessionId={props.sessionID} />
    </ConversationViewport>
  )
}
