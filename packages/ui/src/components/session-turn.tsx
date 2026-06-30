import {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  type PermissionRequest,
  ToolPart,
  type UserMessage,
} from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"

import { ResonancePopover, type InjectedContext } from "./session-resonance-popover"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, ParentProps, Show, Switch } from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Typewriter } from "./typewriter"
import { Message, Part } from "./message-part"
import { ArtifactGallery } from "./attachment-card"
import { shouldHideToolPart } from "./tool-result-presentation"
import { MediaGenerationCard } from "./media-generation-card"
import {
  collectSessionTurnNarrativeItems,
  isSessionTurnNarrativePart,
  type SessionTurnNarrativeItem,
} from "./session-turn-narrative"
import "./session-turn.css"
import "./tool-renders"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ErrorCard } from "./error-card"
import { Dynamic } from "solid-js/web"
import { Button } from "./button"
import { Spinner } from "./spinner"
import { createStore } from "solid-js/store"
import { DateTime, DurationUnit, Interval } from "luxon"
import { createAutoScroll } from "../hooks"
import {
  computeStatusFromPart,
  computeWorkingPhrase,
  extractRunningTaskSessionID,
  titlecaseStatusLabel,
} from "./session-status"
import { getSpecialUserMessageRenderer, hasSpecialUserMessageRenderer } from "./special-user-message"

function getInjectedContext(message: UserMessage | undefined): InjectedContext | undefined {
  if (!message?.metadata) return undefined
  const ctx = message.metadata.injectedContext as InjectedContext | undefined
  if (!ctx) return undefined
  if (!ctx.memory && !ctx.experience) return undefined
  return ctx
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, "0")
  const minutes = date.getMinutes().toString().padStart(2, "0")
  const seconds = date.getSeconds().toString().padStart(2, "0")
  return `${hours}:${minutes}:${seconds}`
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

const RETRY_PREVIEW_CHAR_LIMIT = 96

function AssistantMessageItem(props: { message: AssistantMessage; working: boolean }) {
  const data = useData()
  const emptyParts: PartType[] = []
  const msgParts = createMemo(() => data.store.part[props.message.id] ?? emptyParts)

  const filteredParts = createMemo(() =>
    msgParts().filter((part) => part?.type === "tool" && !isSessionTurnNarrativePart(part, props.working)),
  )

  return <Message message={props.message} parts={filteredParts()} />
}

function NarrativeItemDisplay(props: { item: SessionTurnNarrativeItem; serverUrl: string }) {
  if (props.item.kind === "part") return <Part part={props.item.part} message={props.item.message} />
  if (props.item.kind === "media-pending") return <MediaGenerationCard part={props.item.part} />
  return <ArtifactGallery files={props.item.files} serverUrl={props.serverUrl} variant="result" />
}

function MailboxSourceBadge(props: { message: UserMessage }) {
  const data = useData()
  const sourceName = createMemo(() => props.message.metadata?.sourceName as string | undefined)
  const sourceID = createMemo(() => props.message.metadata?.sourceSessionID as string | undefined)
  const label = createMemo(() => sourceName() ?? sourceID() ?? "another session")

  return (
    <div data-slot="session-turn-mailbox-source">
      <Icon name="message-square" size="small" />
      <span>
        From{" "}
        <Show when={sourceID()} fallback={<span data-slot="mailbox-message-source-text">{label()}</span>}>
          <button data-slot="session-turn-mailbox-link" onClick={() => data.navigateToSession?.(sourceID()!)}>
            {label()}
          </button>
        </Show>
      </span>
    </div>
  )
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    messageID: string
    lastUserMessageID?: string
    stepsExpanded?: boolean
    onStepsExpandedToggle?: () => void
    onUserInteracted?: () => void
    cortexRunning?: number
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()
  const diffComponent = useDiffComponent()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyPermissions: PermissionRequest[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => data.store.message[props.sessionID] ?? emptyMessages)

  const messageIndex = createMemo(() => {
    const messages = allMessages()
    const result = Binary.search(messages, props.messageID, (m) => m.id)
    if (!result.found) return -1

    const msg = messages[result.index]
    if (msg.role !== "user") return -1

    return result.index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const msg = allMessages()[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const specialUserMessageRenderer = createMemo(() => {
    const msg = message()
    if (!msg) return undefined
    return getSpecialUserMessageRenderer(msg)
  })

  const lastUserMessageID = createMemo(() => {
    if (props.lastUserMessageID) return props.lastUserMessageID

    const messages = allMessages()
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === "user") return msg.id
    }
    return undefined
  })

  const isLastUserMessage = createMemo(() => props.messageID === lastUserMessageID())

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return data.store.part[msg.id] ?? emptyParts
  })

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages()
      const index = messageIndex()
      if (index < 0) return emptyAssistant

      const validParentIDs = new Set([msg.id])
      const result: AssistantMessage[] = []
      for (let i = index + 1; i < messages.length; i++) {
        const item = messages[i]
        if (!item) continue
        if (item.role === "user") {
          const user = item as UserMessage
          if (user.metadata?.synthetic) {
            if (hasSpecialUserMessageRenderer(user)) break
            validParentIDs.add(user.id)
            continue
          }
          break
        }
        if (item.role === "assistant" && validParentIDs.has((item as AssistantMessage).parentID))
          result.push(item as AssistantMessage)
      }
      return result
    },
    emptyAssistant,
    { equals: same },
  )

  const lastAssistantMessage = createMemo(() => assistantMessages().at(-1))

  const error = createMemo(() => assistantMessages().find((m) => m.error)?.error)

  const hasSteps = createMemo(() => {
    for (const m of assistantMessages()) {
      const msgParts = data.store.part[m.id]
      if (!msgParts) continue
      for (const p of msgParts) {
        if (p?.type === "tool" && !shouldHideToolPart(p)) return true
      }
    }
    return false
  })

  const stepCount = createMemo(() => {
    let count = 0
    for (const m of assistantMessages()) {
      const msgParts = data.store.part[m.id]
      if (!msgParts) continue
      for (const p of msgParts) {
        if (p?.type === "tool" && !shouldHideToolPart(p)) count++
      }
    }
    return count
  })

  const permissions = createMemo(() => data.store.permission?.[props.sessionID] ?? emptyPermissions)
  const permissionCount = createMemo(() => permissions().length)

  const shellModePart = createMemo(() => {
    const p = parts()
    if (!p.every((part) => part?.type === "text" && part?.synthetic)) return

    const msgs = assistantMessages()
    if (msgs.length !== 1) return

    const msgParts = data.store.part[msgs[0].id] ?? emptyParts
    if (msgParts.length !== 1) return

    const assistantPart = msgParts[0]
    if (assistantPart?.type === "tool" && assistantPart.tool === "bash") return assistantPart
  })

  const isShellMode = createMemo(() => !!shellModePart())

  const rawStatus = createMemo(() => {
    const msgs = assistantMessages()
    let last: PartType | undefined
    let currentTask: ToolPart | undefined

    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = data.store.part[msgs[mi].id] ?? emptyParts
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (!part) continue
        if (!last) last = part

        if (
          part.type === "tool" &&
          part.tool === "task" &&
          part.state &&
          "metadata" in part.state &&
          part.state.metadata?.sessionId &&
          part.state.status === "running"
        ) {
          currentTask = part as ToolPart
          break
        }
      }
      if (currentTask) break
    }

    const taskSessionId = extractRunningTaskSessionID(currentTask)

    if (taskSessionId) {
      const taskMessages = data.store.message[taskSessionId] ?? emptyMessages
      for (let mi = taskMessages.length - 1; mi >= 0; mi--) {
        const msg = taskMessages[mi]
        if (!msg || msg.role !== "assistant") continue

        const msgParts = data.store.part[msg.id] ?? emptyParts
        for (let pi = msgParts.length - 1; pi >= 0; pi--) {
          const part = msgParts[pi]
          if (part) return computeStatusFromPart(part)
        }
      }
    }

    return computeStatusFromPart(last)
  })

  const status = createMemo(() => data.store.session_status[props.sessionID] ?? idle)
  const working = createMemo(() => {
    if (!isLastUserMessage()) return false
    const last = lastAssistantMessage()
    if (last?.time.completed == null) {
      const s = data.store.session_status[props.sessionID]
      if (s && s.type === "idle") return false
      return true
    }
    const s = data.store.session_status[props.sessionID]
    if (s && s.type !== "idle") return true
    return false
  })
  const statusDescription = createMemo(() => {
    const s = status()
    if (s.type === "busy") return s.description
    return undefined
  })

  const retry = createMemo(() => {
    const s = status()
    if (s.type !== "retry") return
    return s
  })

  const hasDiffs = createMemo(() => message()?.summary?.diffs?.length)
  const retryMessage = createMemo(() => retry()?.message ?? "")
  const retryMessageId = createMemo(() => `session-turn-retry-message-${props.messageID}`)
  const retryPreview = createMemo(() => {
    const message = retryMessage()
    if (message.length <= RETRY_PREVIEW_CHAR_LIMIT) return message
    return message.slice(0, RETRY_PREVIEW_CHAR_LIMIT).trimEnd() + "…"
  })
  const retryExpandable = createMemo(() => retryMessage().length > RETRY_PREVIEW_CHAR_LIMIT)

  const chroniclerSessionID = createMemo(() => {
    const msg = lastAssistantMessage()
    if (!msg || !msg.summary) return undefined
    return msg.metadata?.chroniclerSessionID as string | undefined
  })
  const narrativeItems = createMemo(() =>
    collectSessionTurnNarrativeItems(assistantMessages(), data.store.part, working()),
  )
  const hasNarrativeItems = createMemo(() => narrativeItems().length > 0)
  const onlyMediaNarrative = createMemo(() => {
    const items = narrativeItems()
    return items.length > 0 && items.every((item) => item.kind === "media-pending" || item.kind === "media-result")
  })
  const showStepsRow = createMemo(
    () =>
      hasSteps() ||
      chroniclerSessionID() ||
      (working() && !onlyMediaNarrative()) ||
      (!working() && assistantMessages().length > 0 && !onlyMediaNarrative()),
  )

  const injectedContext = createMemo(() => getInjectedContext(message() as UserMessage | undefined))

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
  })

  const agentName = createMemo(() => {
    const msg = lastAssistantMessage()
    return titlecaseStatusLabel(msg?.agent ?? "Synergy")
  })
  const workingPhrase = createMemo(() =>
    computeWorkingPhrase({
      agentName: agentName(),
      cortexRunning: props.cortexRunning ?? 0,
      seed: props.messageID,
    }),
  )

  const diffInit = 20
  const diffBatch = 20

  const [store, setStore] = createStore({
    retrySeconds: 0,
    retryExpanded: false,
    diffsOpen: [] as string[],
    diffLimit: diffInit,
    status: rawStatus(),
    duration: duration(),
  })

  function computeDuration(fromMs: number, toMs?: number): string {
    const from = DateTime.fromMillis(fromMs)
    const to = toMs != null ? DateTime.fromMillis(toMs) : DateTime.now()
    const interval = Interval.fromDateTimes(from, to)
    const unit: DurationUnit[] = interval.length("seconds") > 60 ? ["minutes", "seconds"] : ["seconds"]
    return interval
      .toDuration(unit)
      .normalize()
      .mapUnits((x) => Math.round(x))
      .toHuman({
        notation: "compact",
        unitDisplay: "narrow",
        compactDisplay: "short",
        showZeros: false,
      })
  }

  function duration() {
    const msg = message()
    if (!msg) return ""
    if (working()) {
      return computeDuration(msg.time.created)
    }
    const completed = lastAssistantMessage()?.time.completed
    if (completed != null) {
      return computeDuration(msg.time.created, completed)
    }
    return ""
  }

  createEffect(
    on(
      () => message()?.id,
      () => {
        setStore("diffsOpen", [])
        setStore("diffLimit", diffInit)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const r = retry()
    if (!r) {
      setStore("retrySeconds", 0)
      return
    }
    const updateSeconds = () => {
      const next = r.next
      if (next) setStore("retrySeconds", Math.max(0, Math.round((next - Date.now()) / 1000)))
    }
    updateSeconds()
    const timer = setInterval(updateSeconds, 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(
    on(
      retryMessage,
      () => {
        setStore("retryExpanded", false)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (!working()) return
    const timer = setInterval(() => {
      setStore("duration", duration())
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(
    on(
      () => {
        const completed = lastAssistantMessage()?.time.completed
        return completed != null && !working()
      },
      () => {
        setStore("duration", duration())
      },
      { defer: true },
    ),
  )

  createEffect(
    on(permissionCount, (count, prev) => {
      if (!count) return
      if (prev !== undefined && count <= prev) return
      autoScroll.forceScrollToBottom()
    }),
  )

  let lastStatusChange = Date.now()
  let statusTimeout: number | undefined
  createEffect(() => {
    const newStatus = rawStatus()
    if (newStatus === store.status || !newStatus) return

    const timeSinceLastChange = Date.now() - lastStatusChange
    if (timeSinceLastChange >= 2500) {
      setStore("status", newStatus)
      lastStatusChange = Date.now()
      if (statusTimeout) {
        clearTimeout(statusTimeout)
        statusTimeout = undefined
      }
    } else {
      if (statusTimeout) clearTimeout(statusTimeout)
      statusTimeout = setTimeout(() => {
        setStore("status", rawStatus())
        lastStatusChange = Date.now()
        statusTimeout = undefined
      }, 2500 - timeSinceLastChange) as unknown as number
    }
  })

  return (
    <div data-component="session-turn" class={props.classes?.root}>
      <div
        ref={autoScroll.scrollRef}
        onScroll={autoScroll.handleScroll}
        data-slot="session-turn-content"
        class={props.classes?.content}
      >
        <div onClick={autoScroll.handleInteraction}>
          <Show when={message()}>
            {(msg) => (
              <div
                ref={autoScroll.contentRef}
                data-message={msg().id}
                data-slot="session-turn-message-container"
                class={props.classes?.container}
              >
                <Switch>
                  <Match when={isShellMode()}>
                    <Part part={shellModePart()!} message={msg()} defaultOpen />
                  </Match>
                  <Match when={true}>
                    {/* Title — small label */}
                    <Show when={msg().summary?.title}>
                      <div data-slot="session-turn-title">
                        <Switch>
                          <Match when={working()}>
                            <Typewriter as="h1" text={msg().summary?.title} data-slot="session-turn-typewriter" />
                          </Match>
                          <Match when={true}>
                            <h1>{msg().summary?.title}</h1>
                          </Match>
                        </Switch>
                        <Show when={msg().time?.created}>
                          <span data-slot="session-turn-title-timestamp">{formatTimestamp(msg().time.created)}</span>
                        </Show>
                      </div>
                    </Show>
                    {/* Mailbox source annotation */}
                    <Show when={(msg() as UserMessage).metadata?.mailbox && !specialUserMessageRenderer()}>
                      <MailboxSourceBadge message={msg() as UserMessage} />
                    </Show>
                    {/* User message */}
                    <Show when={specialUserMessageRenderer()} fallback={<Message message={msg()} parts={parts()} />}>
                      {(SpecialUserMessage) => (
                        <Dynamic component={SpecialUserMessage()} message={msg()} parts={parts()} />
                      )}
                    </Show>
                    {/* Steps trigger */}
                    <Show when={showStepsRow()}>
                      <div data-slot="session-turn-steps-row">
                        <div
                          data-slot="session-turn-steps-trigger"
                          data-expandable={!working() && hasSteps() && assistantMessages().length > 0}
                          data-expanded={hasSteps() && props.stepsExpanded}
                          onClick={!working() && hasSteps() ? (props.onStepsExpandedToggle ?? (() => {})) : () => {}}
                        >
                          <Show when={working()}>
                            <Spinner />
                          </Show>
                          <Switch>
                            <Match when={retry()}>
                              <span data-slot="session-turn-retry-group">
                                <span
                                  id={retryMessageId()}
                                  data-slot="session-turn-retry-message"
                                  data-expanded={store.retryExpanded || !retryExpandable()}
                                  title={retryExpandable() && !store.retryExpanded ? retryMessage() : undefined}
                                >
                                  {store.retryExpanded || !retryExpandable() ? retryMessage() : retryPreview()}
                                </span>
                                <Show when={retryExpandable()}>
                                  <button
                                    type="button"
                                    data-slot="session-turn-retry-toggle"
                                    aria-controls={retryMessageId()}
                                    aria-expanded={store.retryExpanded}
                                    aria-label={
                                      store.retryExpanded ? "Hide full retry message" : "Show full retry message"
                                    }
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setStore("retryExpanded", (value) => !value)
                                    }}
                                  >
                                    {store.retryExpanded ? "less" : "more"}
                                  </button>
                                </Show>
                              </span>
                              <span data-slot="session-turn-retry-seconds">
                                · retrying {store.retrySeconds > 0 ? `in ${store.retrySeconds}s ` : ""}
                              </span>
                              <span data-slot="session-turn-retry-attempt">(#{retry()?.attempt})</span>
                            </Match>
                            <Match when={working()}>
                              <span>{store.status ?? statusDescription() ?? workingPhrase()}</span>
                              <Show when={store.duration}>
                                <span data-slot="session-turn-separator">·</span>
                                <span data-slot="session-turn-duration">{store.duration}</span>
                              </Show>
                            </Match>
                            <Match when={true}>
                              <Show when={stepCount() > 0}>
                                <span data-slot="session-turn-step-count">{stepCount()} steps</span>
                                <span data-slot="session-turn-separator">·</span>
                              </Show>
                              <span data-slot="session-turn-duration">{store.duration}</span>
                            </Match>
                          </Switch>
                          <Show when={!working() && hasSteps() && assistantMessages().length > 0}>
                            <svg data-slot="session-turn-expand-icon" viewBox="0 0 16 16" fill="none">
                              <path
                                d="M6 4l4 4-4 4"
                                stroke="currentColor"
                                stroke-width="1.5"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </Show>
                        </div>
                        <Show when={chroniclerSessionID()}>
                          {(sessionID) => (
                            <button
                              data-slot="session-turn-chronicler-button"
                              title="View chronicler session"
                              onClick={(e) => {
                                e.stopPropagation()
                                data.navigateToSession?.(sessionID())
                              }}
                            >
                              <Icon name="pen-line" size="small" />
                            </button>
                          )}
                        </Show>
                        <ResonancePopover context={injectedContext()} />
                      </div>
                    </Show>
                    {/* Steps content (expanded) */}
                    <Show
                      when={
                        ((working() && hasSteps()) || (props.stepsExpanded && hasSteps())) &&
                        assistantMessages().length > 0
                      }
                    >
                      <div data-slot="session-turn-collapsible-content-inner">
                        <For each={assistantMessages()}>
                          {(assistantMessage) => (
                            <AssistantMessageItem message={assistantMessage} working={working()} />
                          )}
                        </For>
                        <Show when={error()}>
                          <ErrorCard error={(error()?.data?.message as string) ?? ""} compact />
                        </Show>
                      </div>
                    </Show>
                    {/* Response — no label, just content */}
                    <Show when={hasNarrativeItems() || (!working() && hasDiffs())}>
                      <div data-slot="session-turn-response-section">
                        <For each={narrativeItems()}>
                          {(item) => <NarrativeItemDisplay item={item} serverUrl={data.serverUrl} />}
                        </For>
                        <Show when={!working() && hasDiffs()}>
                          <Accordion
                            data-slot="session-turn-accordion"
                            multiple
                            value={store.diffsOpen}
                            onChange={(value) => {
                              if (!Array.isArray(value)) return
                              setStore("diffsOpen", value)
                            }}
                          >
                            <For each={(msg().summary?.diffs ?? []).slice(0, store.diffLimit)}>
                              {(diff) => (
                                <Accordion.Item value={diff.file}>
                                  <StickyAccordionHeader>
                                    <Accordion.Trigger>
                                      <div data-slot="session-turn-accordion-trigger-content">
                                        <div data-slot="session-turn-file-info">
                                          <FileIcon
                                            node={{ path: diff.file, type: "file" }}
                                            data-slot="session-turn-file-icon"
                                          />
                                          <div data-slot="session-turn-file-path">
                                            <Show when={diff.file.includes("/")}>
                                              <span data-slot="session-turn-directory">
                                                {getDirectory(diff.file)}&lrm;
                                              </span>
                                            </Show>
                                            <span data-slot="session-turn-filename">{getFilename(diff.file)}</span>
                                          </div>
                                        </div>
                                        <div data-slot="session-turn-accordion-actions">
                                          <DiffChanges changes={diff} />
                                          <Icon name="grip-vertical" size="small" />
                                        </div>
                                      </div>
                                    </Accordion.Trigger>
                                  </StickyAccordionHeader>
                                  <Accordion.Content data-slot="session-turn-accordion-content">
                                    <Show when={store.diffsOpen.includes(diff.file!)}>
                                      <Dynamic
                                        component={diffComponent}
                                        before={{
                                          name: diff.file!,
                                          contents: diff.before!,
                                        }}
                                        after={{
                                          name: diff.file!,
                                          contents: diff.after!,
                                        }}
                                      />
                                    </Show>
                                  </Accordion.Content>
                                </Accordion.Item>
                              )}
                            </For>
                          </Accordion>
                          <Show when={(msg().summary?.diffs?.length ?? 0) > store.diffLimit}>
                            <Button
                              data-slot="session-turn-accordion-more"
                              variant="ghost"
                              size="small"
                              onClick={() => {
                                const total = msg().summary?.diffs?.length ?? 0
                                setStore("diffLimit", (limit) => {
                                  const next = limit + diffBatch
                                  if (next > total) return total
                                  return next
                                })
                              }}
                            >
                              Show more changes ({(msg().summary?.diffs?.length ?? 0) - store.diffLimit})
                            </Button>
                          </Show>
                        </Show>
                      </div>
                    </Show>
                    {/* Error (when expanded steps section is not showing it) */}
                    <Show when={error() && !(working() || (props.stepsExpanded && hasSteps()))}>
                      <ErrorCard error={(error()?.data?.message as string) ?? ""} compact />
                    </Show>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
