import { For, Show, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import type { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import type { UserMessage, AssistantMessage, Message } from "@ericsanchezok/synergy-sdk"
import { SessionTimeline } from "./session-timeline"
import { ConversationViewport } from "./conversation-viewport"
import { navMark } from "@/utils/perf"

export function SessionConversation(props: {
  sessionID: string
  paramsDir: string
  timeline: Accessor<Message[]>
  visibleUserMessages: Accessor<UserMessage[]>
  lastUserMessage: Accessor<UserMessage | undefined>
  activeMessage: Accessor<UserMessage | undefined>
  cortexRunning: Accessor<number>
  expanded: Record<string, boolean>
  onToggleExpanded: (id: string) => void
  showTabs: Accessor<boolean>
  isWorking: Accessor<boolean>
  turnStart: number
  turnBatch: number
  onSetTurnStart: (start: number) => void
  historyMore: Accessor<boolean>
  historyLoading: Accessor<boolean>
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
}) {
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
        <Show when={props.isDesktop()}>
          <div class="absolute inset-0 pointer-events-none z-10">
            <SessionTimeline
              messages={props.visibleUserMessages}
              currentMessage={props.activeMessage}
              onMessageSelect={props.scrollToMessage}
              bottomOffset={props.terminalHeight}
            />
          </div>
        </Show>
      }
      contentClass="flex flex-col gap-4 items-start justify-start pb-[calc(var(--prompt-height,8rem)+64px)] md:pb-[calc(var(--prompt-height,10rem)+64px)] transition-[margin]"
      contentClassList={{
        "mt-0.5": !props.showTabs(),
        "mt-0": props.showTabs(),
      }}
    >
      <Show when={props.turnStart > 0}>
        <div class="w-full flex justify-center">
          <Button
            variant="ghost"
            size="large"
            class="text-12-medium opacity-50"
            onClick={() => props.onSetTurnStart(Math.max(0, props.turnStart - props.turnBatch))}
          >
            Render earlier messages
          </Button>
        </div>
      </Show>
      <Show when={props.historyMore()}>
        <div class="w-full flex justify-center">
          <Button
            variant="ghost"
            size="large"
            class="text-12-medium opacity-50"
            disabled={props.historyLoading()}
            onClick={props.onLoadMore}
          >
            {props.historyLoading() ? "Loading earlier messages..." : "Load earlier messages"}
          </Button>
        </div>
      </Show>
      <For each={props.timeline()}>
        {(msg, index) => {
          if (import.meta.env.DEV) {
            onMount(() => {
              navMark({ dir: props.paramsDir, to: props.sessionID, name: "session:first-turn-mounted" })
            })
          }

          const isLast = () => index() === (props.timeline()?.length ?? 0) - 1

          if (msg.role === "assistant") {
            return (
              <div
                id={props.anchor(msg.id)}
                data-message-id={msg.id}
                class="min-w-0 w-full max-w-full"
                style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
              >
                <MailboxMessage
                  message={msg as AssistantMessage}
                  classes={{
                    root: "min-w-0 w-full relative",
                    container:
                      "px-3 md:px-1 pb-1 " +
                      (index() > 0 ? "border-t border-border-base pt-2 " : "") +
                      (!props.showTabs()
                        ? "md:max-w-200 md:mx-auto"
                        : (props.visibleUserMessages()?.length ?? 0) > 1
                          ? "md:pr-6 md:pl-18"
                          : ""),
                  }}
                />
              </div>
            )
          }

          return (
            <div
              id={props.anchor(msg.id)}
              data-message-id={msg.id}
              classList={{
                "min-w-0 w-full max-w-full": true,
                "last:min-h-[calc(100vh-5.5rem-var(--prompt-height,8rem)-64px)] md:last:min-h-[calc(100vh-4.5rem-var(--prompt-height,10rem)-64px)]": true,
              }}
              style={isLast() ? { animation: "fadeUp 0.3s ease-out both" } : undefined}
            >
              <SessionTurn
                sessionID={props.sessionID}
                messageID={msg.id}
                lastUserMessageID={props.lastUserMessage()?.id}
                cortexRunning={props.cortexRunning()}
                stepsExpanded={props.expanded[msg.id] ?? true}
                onStepsExpandedToggle={() => props.onToggleExpanded(msg.id)}
                classes={{
                  root: "min-w-0 w-full relative",
                  content: "flex flex-col justify-between !overflow-visible",
                  container:
                    "px-3 md:px-1 pb-1 " +
                    (index() > 0 ? "border-t border-border-base pt-2 " : "") +
                    (!props.showTabs()
                      ? "md:max-w-200 md:mx-auto"
                      : (props.visibleUserMessages()?.length ?? 0) > 1
                        ? "md:pr-6 md:pl-18"
                        : ""),
                }}
              />
            </div>
          )
        }}
      </For>
    </ConversationViewport>
  )
}
