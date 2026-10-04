import { useSessionTransition } from "@/context/session-transition"
import { submissionForRoot } from "./session-submission-status"
import { useFileRestore } from "./file-restore-dialog-loader"
import { useSDK } from "@/context/sdk"
import { useSessionDataView } from "@/context/session-data-view"
import type { PluginComponentProps, PluginConversationService } from "@ericsanchezok/synergy-plugin"
import { Dynamic } from "solid-js/web"
import { For, Show, createEffect, createMemo, createSignal, createResource, onCleanup, onMount } from "solid-js"
import { VirtualConversationRows } from "./virtual-conversation-rows"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import type { UserMessage, AssistantMessage, Message } from "@ericsanchezok/synergy-sdk"
import { buildConversationTimelineSnapshot } from "./conversation-timeline"
import { ConversationViewport } from "./conversation-viewport"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import { PendingTimelineItem } from "./pending-timeline-item"
import { useExecution } from "@/context/execution"

export function SessionConversation(input: PluginComponentProps<PluginConversationService>) {
  const transitions = useSessionTransition()
  const props = input.context
  const submissionFor = (rootID: string) => submissionForRoot(transitions.get(props.sessionID), rootID)
  const execution = useExecution()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const sdk = useSDK()
  const restoreFiles = useFileRestore(() => props.sessionID)
  const data = useSessionDataView()
  let stateRequest: AbortController | undefined
  const executionRequest = createMemo(
    () => {
      const roots = (props.timeline() ?? []).filter((message) => message.role === "user").map((message) => message.id)
      const latest = props.lastUserMessage()
      const last = latest ? props.turnProjection().turnMessagesFor(latest).at(-1) : undefined
      const status = data().statusFor(props.sessionID)
      return roots.length
        ? {
            server: sdk.url,
            scope: sdk.scopeKey,
            sessionID: props.sessionID,
            rootIDs: roots.slice(-64),
            revision: `${status?.type}:${last?.id}:${last?.role === "assistant" ? last.time.completed : ""}`,
          }
        : undefined
    },
    undefined,
    {
      equals: (a, b) =>
        a?.server === b?.server &&
        a?.scope === b?.scope &&
        a?.sessionID === b?.sessionID &&
        a?.revision === b?.revision &&
        a?.rootIDs.join() === b?.rootIDs.join(),
    },
  )
  const [executions, { refetch: refreshExecutions }] = createResource(
    executionRequest,
    async (request) => {
      stateRequest?.abort()
      const controller = new AbortController()
      stateRequest = controller
      const result = await sdk.client.session.turnExecution(
        { sessionID: request.sessionID, rootIDs: request.rootIDs },
        { signal: controller.signal, throwOnError: true },
      )
      if (
        controller.signal.aborted ||
        sdk.url !== request.server ||
        sdk.scopeKey !== request.scope ||
        props.sessionID !== request.sessionID
      )
        return undefined
      return { request, states: result.data ?? [] }
    },
    { initialValue: undefined },
  )
  createEffect(() => {
    if (!executionRequest()) stateRequest?.abort()
  })
  onCleanup(() => stateRequest?.abort())
  onCleanup(
    sdk.event.on("session.execution.updated", (event) => {
      if (event.properties.sessionID === props.sessionID) void refreshExecutions()
    }),
  )
  onCleanup(
    sdk.event.on("permission.asked", (event) => {
      if (event.properties.sessionID === props.sessionID) void refreshExecutions()
    }),
  )
  onCleanup(
    sdk.event.on("permission.replied", (event) => {
      if (event.properties.sessionID === props.sessionID) void refreshExecutions()
    }),
  )
  const executionFor = (rootID: string) => {
    const result = executions.error ? undefined : executions.latest
    return result?.request.sessionID === props.sessionID &&
      result.request.server === sdk.url &&
      result.request.scope === sdk.scopeKey
      ? result.states.find((state) => state.rootID === rootID)
      : undefined
  }
  const lastTimelineID = createMemo(() => props.timeline()?.at(-1)?.id)
  const turnProjection = props.turnProjection
  const [scrollRef, setScrollRef] = createSignal<HTMLDivElement>()
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
      setScrollRef={(element, releaseOf) => {
        if (element || !releaseOf || scrollRef() === releaseOf) setScrollRef(element)
        props.setScrollRef(element, releaseOf)
      }}
      onScrollToBottom={props.onClearHash}
      onScrollContainer={(el) => {
        if (props.isDesktop()) props.onScheduleScrollSpy(el)
      }}
      contentClass="session-conversation-content session-content-column flex flex-col items-start justify-start gap-5"
      contentClassList={{
        "pb-6 md:pb-[calc(var(--prompt-height,10rem)+32px)]": true,
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
      <Show
        when={props.content}
        fallback={
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
                  >
                    <MessageSlotOutlet
                      slot="message.before"
                      sessionId={props.sessionID}
                      messageId={key}
                      role="assistant"
                    />
                    <Dynamic
                      component={isCommand() ? CommandResultOutput : MailboxMessage}
                      message={assistantMessage()}
                      classes={{
                        root: "min-w-0 w-full relative",
                        container: "w-full min-w-0 max-w-full pb-1",
                      }}
                    />
                    <MessageSlotOutlet
                      slot="message.actions"
                      sessionId={props.sessionID}
                      messageId={key}
                      role="assistant"
                    />
                    <MessageSlotOutlet
                      slot="message.after"
                      sessionId={props.sessionID}
                      messageId={key}
                      role="assistant"
                    />
                  </div>
                )
              }

              return (
                <div
                  id={props.anchor(key)}
                  data-message-id={key}
                  data-message-role="user"
                  class="min-w-0 w-full max-w-full"
                >
                  <SessionTurn
                    sessionID={props.sessionID}
                    messageID={key}
                    rootMessage={rootMessage()}
                    messages={turnMessages()}
                    compactionParentIDs={turnProjection().compactionParentIDs}
                    activityDisplay={props.activityDisplay()}
                    activityView={props.activityView}
                    submission={submissionFor(key)}
                    executionState={executionFor(key)}
                    following={!props.scrolledUp()}
                    onRestoreChanges={(messageID) => void restoreFiles({ messageID })}
                    lastUserMessageID={props.lastUserMessage()?.id}
                    compactReasoning={props.compactReasoning()}
                    onRewind={props.canRewind(rootMessage()) ? () => props.onRewind?.(rootMessage()) : undefined}
                    rollbackActive={props.rollbackActive}
                    onReviewChanges={props.onReviewChanges}
                    onForkMessage={props.onForkMessage}
                    executionSummary={execution.available() ? execution.round(key) : undefined}
                    onExecutionDetails={execution.available() ? () => void execution.open(key) : undefined}
                    classes={{
                      root: "min-w-0 w-full relative",
                      content: "flex flex-col justify-between !overflow-visible",
                      container: "w-full min-w-0 max-w-full pb-1",
                    }}
                  />
                </div>
              )
            }}
          </For>
        }
      >
        <VirtualConversationRows
          context={props}
          scrollRef={scrollRef()}
          submissionFor={submissionFor}
          executionFor={executionFor}
          onRestoreChanges={(messageID) => void restoreFiles({ messageID })}
        />
      </Show>
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
