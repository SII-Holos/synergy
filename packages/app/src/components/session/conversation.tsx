import { For, Show, createMemo, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import type { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import type { UserMessage, AssistantMessage, Message, SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import { SessionTimeline } from "./session-timeline"
import { ConversationViewport } from "./conversation-viewport"
import { navMark } from "@/utils/perf"
import { BrowserViewEffects } from "@/components/workspace/browser/browser-view-effects"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

export function SessionConversation(props: {
  sessionID: string
  paramsDir: string
  timeline: Accessor<Message[]>
  pendingTimeline?: Accessor<SessionInboxItem[]>
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
  rollbackActive?: boolean
}) {
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
      contentClass="mx-auto flex w-full min-w-0 flex-col items-start justify-start gap-5 px-4 pb-[calc(var(--prompt-height,8rem)+96px)] transition-[margin] md:px-5 md:pb-[calc(var(--prompt-height,10rem)+96px)]"
      contentClassList={{
        "max-w-full": true,
        "md:max-w-[60rem]": !props.showTabs(),
        "mt-0": props.showTabs(),
      }}
    >
      <BrowserViewEffects timeline={props.timeline} />
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
      <Show when={props.pendingTimeline?.()?.length}>
        <div class="w-full flex flex-col items-start gap-2 opacity-50">
          <For each={props.pendingTimeline?.() ?? []}>
            {(item) => {
              const isTask = () => item.mode === "task"
              const label = () =>
                item.message?.parts?.[0]?.type === "text"
                  ? (item.message!.parts[0] as { text: string }).text
                  : (item.summary?.title ?? "Pending…")
              return (
                <div
                  data-slot="pending-timeline-item"
                  data-mode={item.mode}
                  data-frozen={props.rollbackActive === true}
                  class="flex items-center gap-2 px-3 py-2 rounded-lg bg-background-weak text-text-weak text-sm"
                >
                  <Show
                    when={props.rollbackActive && item.mode !== "task"}
                    fallback={<Icon name="clock" size="small" />}
                  >
                    <span
                      class="text-xs opacity-70"
                      title="Delivery paused during rollback. Will resume on redo or new task."
                    >
                      <Icon name="clock" size="small" /> Paused
                    </span>
                  </Show>
                  <Show when={isTask()} fallback={<span class="text-xs">{label()}</span>}>
                    <span class="text-xs">{label()}</span>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </ConversationViewport>
  )
}
