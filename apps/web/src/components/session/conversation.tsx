import { draftTransitionKey, useSessionTransition } from "@/context/session-transition"
import { useSessionPreparation } from "./session-preparation"
import { isOptimisticMessagePending } from "@/context/session-optimistic-message"
import { isSessionSubmissionContentReady } from "./session-transition-handoff"
import { useSync } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { ConversationMotionProvider } from "@ericsanchezok/synergy-ui/conversation-motion"
import { submissionForRoot } from "./session-submission-status"
import { useFileRestore } from "./file-restore-dialog-loader"
import { useSDK } from "@/context/sdk"
import { useSessionDataView } from "@/context/session-data-view"
import type { PluginComponentProps, PluginConversationService } from "@ericsanchezok/synergy-plugin"
import { Dynamic } from "solid-js/web"
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { VirtualConversationRows } from "./virtual-conversation-rows"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SessionTurn } from "@ericsanchezok/synergy-ui/session-turn"
import { MailboxMessage } from "@ericsanchezok/synergy-ui/mailbox-message"
import { MessageSlotOutlet } from "@ericsanchezok/synergy-ui/message-slots"
import { CommandResultOutput } from "@ericsanchezok/synergy-ui/command-result-output"
import type { UserMessage, AssistantMessage, TurnExecutionState } from "@ericsanchezok/synergy-sdk"
import { buildConversationTimelineSnapshot } from "./conversation-timeline"
import { ConversationViewport } from "./conversation-viewport"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import { PendingTimelineItem } from "./pending-timeline-item"
import { useExecution } from "@/context/execution"

type SessionConversationProps = PluginComponentProps<PluginConversationService> & {
  initialScrollSettled?: () => boolean
  onAdmitted?: (sessionID: string) => void
}

export function SessionConversation(input: SessionConversationProps) {
  const sdk = useSDK()
  const identity = createMemo(() => JSON.stringify([sdk.url, sdk.scopeKey, input.context.sessionID]))
  return (
    <Show when={identity()} keyed>
      {(_identity) => (
        <SessionConversationView
          context={mergeProps(input.context, { sessionID: untrack(() => input.context.sessionID) })}
          initialScrollSettled={input.initialScrollSettled}
          onAdmitted={input.onAdmitted}
        />
      )}
    </Show>
  )
}

function SessionConversationView(input: SessionConversationProps) {
  const transitions = useSessionTransition()
  const props = input.context
  const [contentReady, setContentReady] = createSignal(false)
  const [admitted, setAdmitted] = createSignal(!input.initialScrollSettled)
  createEffect(() => {
    if (!input.initialScrollSettled || admitted()) return
    if (!input.initialScrollSettled() || (props.content && !contentReady())) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        input.onAdmitted?.(props.sessionID)
        setAdmitted(true)
      })
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  const preparation = useSessionPreparation()
  const execution = useExecution()
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const sdk = useSDK()
  const animateAdmission = !untrack(
    () => transitions.get(props.sessionID)?.draft ?? transitions.get(draftTransitionKey(sdk.url, sdk.scopeKey))?.draft,
  )
  const globalSync = useGlobalSync()
  const [arrivalView, setArrivalView] = createSignal<ReturnType<typeof globalSync.partArrival.open>>()
  createEffect(() => {
    const view = globalSync.partArrival.open([sdk.url, sdk.scopeKey, props.sessionID])
    setArrivalView(view)
    onCleanup(() => view.release())
  })
  createEffect(() => {
    const view = arrivalView()
    const root = props.lastUserMessage()
    const latest = root ? (props.turnProjection().turnMessagesFor(root).at(-1) ?? root) : undefined
    const snapshot = globalSync.peekScopeState(sdk.scopeKey)?.[0].messageWindow[props.sessionID]
    if (snapshot && (!latest || !props.content || props.content.page(latest.id))) view?.ready(true)
  })
  const takePartArrival = (partID: string) => {
    const arrival = arrivalView()?.take(partID) ?? false
    return document.visibilityState === "visible" && arrival
  }
  const takeUserArrival = (messageID: string) =>
    transitions.messageArrival.take([sdk.url, sdk.scopeKey, props.sessionID], messageID)
  const messageKey = (messageID: string) =>
    transitions.messageIdentity.key([sdk.url, sdk.scopeKey, props.sessionID], messageID)
  const restoreFiles = useFileRestore(() => props.sessionID)
  const data = useSessionDataView()
  const sync = useSync()
  const submissionFor = (rootID: string) =>
    submissionForRoot(
      transitions.get(props.sessionID) ?? transitions.get(draftTransitionKey(sdk.url, sdk.scopeKey)),
      rootID,
      data().statusFor(props.sessionID),
    )
  let stateRequest: AbortController | undefined
  const executionRequest = createMemo(
    () => {
      if (!preparation.ready() || !data().sessionFor(props.sessionID)) return undefined
      const roots = (props.timeline() ?? []).filter((message) => message.role === "user").map((message) => message.id)
      const latest = props.lastUserMessage()
      const last = latest ? props.turnProjection().turnMessagesFor(latest).at(-1) : undefined
      const status = data().statusFor(props.sessionID)
      return roots.length
        ? {
            server: sdk.url,
            scope: sdk.scopeKey,
            client: sdk.client,
            sessionID: props.sessionID,
            rootIDs: roots.slice(-64),
            latestRootID: latest?.id,
            revision: `${status?.type}:${last?.id}:${last?.role === "assistant" ? last.time.completed : ""}`,
            reconnect: globalSync.reconnectVersion(),
          }
        : undefined
    },
    undefined,
    {
      equals: (a, b) =>
        a === b ||
        (!!a &&
          !!b &&
          a.server === b.server &&
          a.scope === b.scope &&
          a.sessionID === b.sessionID &&
          a.client === b.client &&
          a.latestRootID === b.latestRootID &&
          a.reconnect === b.reconnect &&
          a.revision === b.revision &&
          a.rootIDs.length === b.rootIDs.length &&
          a.rootIDs.every((rootID, index) => rootID === b.rootIDs[index])),
    },
  )
  const [executionStates, setExecutionStates] = createStore<Record<string, TurnExecutionState | undefined>>({})
  let baseline: ReturnType<typeof executionRequest>
  let identityEpoch = 0
  let rootVersion = 0
  let disposed = false
  let queued = false
  const versions = new Map<string, number>()
  const dirtyRoots = new Set<string>()
  const scheduleExecutions = () => {
    if (disposed || queued || stateRequest || !dirtyRoots.size) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (disposed || stateRequest || !baseline) return
      const request = baseline
      const rootIDs = request.rootIDs.filter((rootID) => dirtyRoots.has(rootID))
      if (!rootIDs.length) return
      const capturedVersions = new Map(rootIDs.map((rootID) => [rootID, versions.get(rootID)]))
      for (const rootID of rootIDs) dirtyRoots.delete(rootID)
      const epoch = identityEpoch
      const controller = new AbortController()
      stateRequest = controller
      const isCurrent = () =>
        !disposed &&
        !controller.signal.aborted &&
        identityEpoch === epoch &&
        sdk.url === request.server &&
        sdk.scopeKey === request.scope &&
        sdk.client === request.client &&
        props.sessionID === request.sessionID
      void (async () => {
        try {
          const response = await request.client.session.turnExecution(
            { sessionID: request.sessionID, rootIDs },
            { signal: controller.signal, throwOnError: true },
          )
          if (!isCurrent()) return
          const states = new Map((response.data ?? []).map((state) => [state.rootID, state]))
          batch(() => {
            for (const rootID of rootIDs) {
              if (!versions.has(rootID) || versions.get(rootID) !== capturedVersions.get(rootID)) continue
              const state = states.get(rootID)
              setExecutionStates(rootID, state ? reconcile(state) : undefined)
            }
          })
        } catch {
          if (!isCurrent()) return
          batch(() => {
            for (const rootID of rootIDs) {
              if (versions.has(rootID) && versions.get(rootID) === capturedVersions.get(rootID))
                setExecutionStates(rootID, undefined)
            }
          })
        } finally {
          if (stateRequest === controller) {
            stateRequest = undefined
            scheduleExecutions()
          }
        }
      })()
    })
  }
  const invalidateExecution = (rootID: unknown) => {
    if (typeof rootID !== "string" || !versions.has(rootID)) return
    versions.set(rootID, ++rootVersion)
    dirtyRoots.add(rootID)
    scheduleExecutions()
  }
  const invalidateWindow = () => {
    for (const rootID of versions.keys()) invalidateExecution(rootID)
  }
  createEffect(() => {
    const request = executionRequest()
    untrack(() => {
      const previous = baseline
      const hasChangedIdentity =
        !previous ||
        !request ||
        previous.server !== request.server ||
        previous.scope !== request.scope ||
        previous.client !== request.client ||
        previous.sessionID !== request.sessionID
      baseline = request
      if (hasChangedIdentity) {
        identityEpoch++
        stateRequest?.abort()
        stateRequest = undefined
        versions.clear()
        dirtyRoots.clear()
        setExecutionStates(reconcile({}))
      }
      if (!request) return
      const roots = new Set(request.rootIDs)
      for (const rootID of versions.keys()) {
        if (roots.has(rootID)) continue
        versions.delete(rootID)
        dirtyRoots.delete(rootID)
        setExecutionStates(rootID, undefined)
      }
      for (const rootID of request.rootIDs) {
        if (versions.has(rootID)) continue
        versions.set(rootID, ++rootVersion)
        dirtyRoots.add(rootID)
      }
      if (!hasChangedIdentity && previous) {
        if (previous.reconnect !== request.reconnect) invalidateWindow()
        else if (previous.revision !== request.revision) invalidateExecution(request.latestRootID)
      }
      scheduleExecutions()
    })
  })
  onCleanup(() => {
    disposed = true
    identityEpoch++
    stateRequest?.abort()
    dirtyRoots.clear()
  })
  onCleanup(
    sdk.event.on("session.execution.updated", (event) => {
      if (event.properties.sessionID === props.sessionID) invalidateExecution(event.properties.rootID)
    }),
  )
  onCleanup(
    sdk.event.on("permission.asked", (event) => {
      if (event.properties.sessionID === props.sessionID) invalidateWindow()
    }),
  )
  onCleanup(
    sdk.event.on("permission.replied", (event) => {
      if (event.properties.sessionID === props.sessionID) invalidateWindow()
    }),
  )
  const executionFor = (rootID: string) => {
    const request = executionRequest()
    const executionState = executionStates[rootID]
    return request &&
      baseline?.server === request.server &&
      baseline.scope === request.scope &&
      baseline.client === request.client &&
      baseline.sessionID === request.sessionID &&
      request.rootIDs.includes(rootID)
      ? executionState
      : undefined
  }
  createEffect(() => {
    const handoff = transitions.get(props.sessionID)?.handoff
    if (!handoff || !executionFor(handoff.messageID)) return
    const root = data()
      .messagesFor(props.sessionID)
      .find((message) => message.id === handoff.messageID)
    if (
      root &&
      !isOptimisticMessagePending(root) &&
      isSessionSubmissionContentReady({
        ready:
          preparation.ready() &&
          globalSync.ready &&
          globalSync.reconnectVersion() > 0 &&
          !globalSync.scopeRecoveryPending(sdk.scopeKey) &&
          sdk.connected(),
        message: root,
        captured: transitions.get(props.sessionID)?.draft?.parts,
        summaries: sync.data.partSummary[handoff.messageID],
        parts: sync.data.part[handoff.messageID],
        versions: sync.data.partVersion,
      })
    )
      transitions.completeHandoff(props.sessionID, handoff.messageID)
  })
  const lastTimelineID = createMemo(() => props.timeline()?.at(-1)?.id)
  const turnProjection = props.turnProjection
  const [scrollRef, setScrollRef] = createSignal<HTMLDivElement>()
  // Rows below are keyed by the stable message id (see conversation-timeline):
  // message objects are replaced in place by window reload, reconnect replay,
  // rollback copies, and message.updated reconcile. Reference-keyed rows would
  // destroy and recreate the whole SessionTurn tree on every replacement while
  // the abandoned tree stayed alive in the Solid owner graph — the renderer
  // heap grew to the 4 GiB V8 limit after ~33h of a long session.
  const timelineSnapshot = createMemo(() => buildConversationTimelineSnapshot(props.timeline() ?? [], messageKey))
  return (
    <ConversationMotionProvider takeArrival={takePartArrival} liveRevision={() => arrivalView()?.revision() ?? 0}>
      <ConversationViewport
        ready={admitted()}
        animateAdmission={animateAdmission && !input.onAdmitted}
        scrolledUp={props.scrolledUp()}
        onScrolledUpChange={props.onScrolledUpChange}
        autoScroll={props.autoScroll}
        setScrollRef={(element, releaseOf) => {
          if (element || !releaseOf || scrollRef() === releaseOf) setScrollRef(element)
          props.setScrollRef(element, releaseOf)
        }}
        onScrollToBottom={() => {
          props.onClearHash?.()
          if (props.onReturnLatest) props.onReturnLatest()
          else props.autoScroll.forceScrollToBottom()
        }}
        onScrollContainer={(el) => {
          if (props.isDesktop() && !props.content) props.onScheduleScrollSpy(el)
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
                onClick={(event: MouseEvent) => {
                  event.stopPropagation()
                  props.onReturnLatest()
                }}
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
                const isLast = () => message()?.id === lastTimelineID()
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
                      takeUserArrival={takeUserArrival}
                      sessionID={props.sessionID}
                      messageID={key}
                      rootMessage={rootMessage()}
                      messages={turnMessages()}
                      compactionParentIDs={turnProjection().compactionParentIDs}
                      activityDisplay={props.activityDisplay()}
                      activityView={props.activityView}
                      submission={submissionFor(key)}
                      executionState={executionFor(rootMessage().id)}
                      connected={sdk.connected()}
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
            layoutOwner={[sdk.url, sdk.scopeKey, props.sessionID]}
            onReady={setContentReady}
            onReadingMessage={(messageID) => {
              const element = scrollRef()
              if (element && props.isDesktop()) props.onScheduleScrollSpy(element, messageID)
            }}
            messageKey={messageKey}
            takePartArrival={takePartArrival}
            liveRevision={() => arrivalView()?.revision() ?? 0}
            connected={sdk.connected}
            takeUserArrival={takeUserArrival}
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
    </ConversationMotionProvider>
  )
}
