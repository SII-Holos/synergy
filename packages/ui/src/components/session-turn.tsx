import type {
  AssistantMessage,
  AttachmentPart,
  Message as MessageType,
  Part as PartType,
  PermissionRequest,
  ReasoningPart,
  SessionStatus,
  TextPart,
  ToolPart,
  UserMessage,
} from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"

import { Binary } from "@ericsanchezok/synergy-util/binary"
import { createEffect, createMemo, For, Match, on, ParentProps, Show, Switch } from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Message, Part } from "./message-part"
import { MessageSlotOutlet, type MessageSlotName } from "./message-slots"
import { AttachmentGallery } from "./attachment-card"
import { resolveAttachmentPresentation } from "./attachment-card-utils"
import { MediaGenerationCard } from "./media-generation-card"
import { isActiveMediaGenerationToolPart, isToolCardHidden } from "./tool-result-presentation"
import "./session-turn.css"
import "./tool-renders"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ErrorCard } from "./error-card"
import { Dynamic } from "solid-js/web"
import { Button } from "./button"
import { createStore } from "solid-js/store"
import { createAutoScroll } from "../hooks"
import { getSpecialUserMessageRenderer, hasSpecialUserMessageRenderer } from "./special-user-message"

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export type SessionTurnTimelineItem =
  | {
      kind: "part"
      message: AssistantMessage
      part: TextPart | ToolPart | AttachmentPart
    }
  | {
      kind: "reasoning"
      message: AssistantMessage
      part: ReasoningPart
    }
  | {
      kind: "media-pending"
      message: AssistantMessage
      part: ToolPart
    }
  | {
      kind: "tool-attachments"
      message: AssistantMessage
      part: ToolPart
      files: AttachmentPart[]
    }

export type SessionTurnTimelineVisualKind =
  | "text"
  | "reasoning"
  | "tool"
  | "attachment"
  | "media-pending"
  | "tool-attachments"

const DEFAULT_PROVIDER_PRELUDE_TEXT = "Awaiting response..."

function visibleAttachmentParts(files: AttachmentPart[] | undefined): AttachmentPart[] {
  return (files ?? []).filter((file) => !resolveAttachmentPresentation(file).hidden)
}

export function timelineKindForPart(part: PartType, working: boolean): SessionTurnTimelineItem["kind"] | undefined {
  if (part.type === "text") return part.text.trim() ? "part" : undefined
  if (part.type === "attachment") return resolveAttachmentPresentation(part).hidden ? undefined : "part"
  if (part.type === "reasoning") return working && part.text.trim() ? "reasoning" : undefined
  if (part.type !== "tool") return undefined
  if (isActiveMediaGenerationToolPart(part)) return "media-pending"
  if (isToolCardHidden(part)) {
    if (part.state.status !== "completed") return undefined
    return visibleAttachmentParts(part.state.attachments).length > 0 ? "tool-attachments" : undefined
  }
  return "part"
}

export function timelineVisualKind(item: SessionTurnTimelineItem): SessionTurnTimelineVisualKind {
  if (item.kind !== "part") return item.kind
  if (item.part.type === "tool") return "tool"
  if (item.part.type === "attachment") return "attachment"
  return "text"
}

export function timelineItemStableKey(item: SessionTurnTimelineItem): string {
  return `${timelineVisualKind(item)}:${item.message.id}:${item.part.id}`
}

export function collectSessionTurnTimelineItems(
  messages: AssistantMessage[],
  partsByMessage: Record<string, PartType[] | undefined>,
  working: boolean,
): SessionTurnTimelineItem[] {
  const items: SessionTurnTimelineItem[] = []

  for (const message of messages) {
    const parts = partsByMessage[message.id] ?? []
    for (const part of parts) {
      const kind = timelineKindForPart(part, working)
      if (!kind) continue

      if (kind === "media-pending") {
        items.push({ kind, message, part: part as ToolPart })
        continue
      }

      if (kind === "tool-attachments") {
        const toolPart = part as ToolPart
        const files = toolPart.state.status === "completed" ? visibleAttachmentParts(toolPart.state.attachments) : []
        if (files.length === 0) continue
        items.push({ kind, message, part: toolPart, files })
        continue
      }

      if (kind === "reasoning") {
        items.push({ kind, message, part: part as ReasoningPart })
        continue
      }

      items.push({ kind, message, part: part as TextPart | ToolPart | AttachmentPart })
    }
  }

  return items
}

export function providerPreludeText(status: SessionStatus | undefined): string {
  if (status?.type === "busy") {
    const description = status.description?.trim()
    if (description) return description
  }
  return DEFAULT_PROVIDER_PRELUDE_TEXT
}

export function shouldShowProviderPrelude(input: {
  working: boolean
  hasError: boolean
  latestAssistant?: AssistantMessage
  latestAssistantTimelineItems: readonly SessionTurnTimelineItem[]
}): boolean {
  if (!input.working || input.hasError) return false
  if (!input.latestAssistant) return true
  if (input.latestAssistant.time.completed != null) return false
  return input.latestAssistantTimelineItems.length === 0
}

function TimelineItemDisplay(props: { item: SessionTurnTimelineItem; serverUrl: string }) {
  if (props.item.kind === "part" || props.item.kind === "reasoning") {
    return <Part part={props.item.part} message={props.item.message} />
  }
  if (props.item.kind === "media-pending") return <MediaGenerationCard part={props.item.part} />
  return <AttachmentGallery files={props.item.files} serverUrl={props.serverUrl} />
}

function isToolTimelineItem(item: SessionTurnTimelineItem): boolean {
  const kind = timelineVisualKind(item)
  return kind === "tool" || kind === "media-pending" || kind === "tool-attachments"
}

function ProviderPrelude(props: { text: string }) {
  return (
    <div data-component="provider-prelude" role="status" aria-live="polite">
      {props.text}
    </div>
  )
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
    onUserInteracted?: () => void
    classes?: {
      root?: string
      content?: string
      container?: string
    }
  }>,
) {
  const data = useData()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyPermissions: PermissionRequest[] = []

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

  const hasDiffs = createMemo(() => message()?.summary?.diffs?.length)
  const timelineItems = createMemo(() =>
    collectSessionTurnTimelineItems(assistantMessages(), data.store.part, working()),
  )
  const latestAssistantTimelineItems = createMemo(() => {
    const latest = lastAssistantMessage()
    if (!latest) return []
    return collectSessionTurnTimelineItems([latest], data.store.part, working())
  })
  const timelineItemMap = createMemo(() => {
    const result = new Map<string, SessionTurnTimelineItem>()
    for (const item of timelineItems()) result.set(timelineItemStableKey(item), item)
    return result
  })
  const timelineItemKeys = createMemo(() => timelineItems().map(timelineItemStableKey))
  const timelineSlotIndexes = createMemo(() => {
    const items = timelineItems()
    const firstReasoning = items.findIndex((item) => timelineVisualKind(item) === "reasoning")
    const lastReasoning = items.findLastIndex((item) => timelineVisualKind(item) === "reasoning")
    const firstTool = items.findIndex(isToolTimelineItem)
    const lastTool = items.findLastIndex(isToolTimelineItem)
    return { firstReasoning, lastReasoning, firstTool, lastTool }
  })
  const renderMessageSlot = (slot: MessageSlotName) => (
    <MessageSlotOutlet slot={slot} sessionId={props.sessionID} messageId={props.messageID} />
  )
  const hasTimelineItems = createMemo(() => timelineItems().length > 0)
  const sessionStatus = createMemo(() => data.store.session_status[props.sessionID])
  const showProviderPrelude = createMemo(() =>
    shouldShowProviderPrelude({
      working: working(),
      hasError: !!error(),
      latestAssistant: lastAssistantMessage(),
      latestAssistantTimelineItems: latestAssistantTimelineItems(),
    }),
  )

  const autoScroll = createAutoScroll({
    working,
    onUserInteracted: props.onUserInteracted,
  })

  const diffInit = 20
  const diffBatch = 20

  const [store, setStore] = createStore({
    diffsOpen: [] as string[],
    diffLimit: diffInit,
  })

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

  createEffect(
    on(permissionCount, (count, prev) => {
      if (!count) return
      if (prev !== undefined && count <= prev) return
      autoScroll.forceScrollToBottom()
    }),
  )

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
                    {/* Mailbox source annotation */}
                    <Show when={(msg() as UserMessage).metadata?.mailbox && !specialUserMessageRenderer()}>
                      <MailboxSourceBadge message={msg() as UserMessage} />
                    </Show>
                    {/* User message */}
                    <Show
                      when={specialUserMessageRenderer()}
                      fallback={<Message message={msg()} parts={parts()} userVariant="turn-bubble" />}
                    >
                      {(SpecialUserMessage) => (
                        <Dynamic component={SpecialUserMessage()} message={msg()} parts={parts()} />
                      )}
                    </Show>
                    <Show when={hasTimelineItems() || showProviderPrelude() || (!working() && hasDiffs())}>
                      <div data-slot="session-turn-timeline">
                        <For each={timelineItemKeys()}>
                          {(key, index) => {
                            const item = () => timelineItemMap().get(key)
                            return (
                              <Show when={item()}>
                                {(current) => (
                                  <>
                                    <Show when={index() === timelineSlotIndexes().firstReasoning}>
                                      {renderMessageSlot("before-reasoning")}
                                    </Show>
                                    <Show when={index() === timelineSlotIndexes().firstTool}>
                                      {renderMessageSlot("before-tools")}
                                    </Show>
                                    <div
                                      data-slot="session-turn-timeline-item"
                                      data-kind={timelineVisualKind(current())}
                                    >
                                      <TimelineItemDisplay item={current()} serverUrl={data.serverUrl} />
                                    </div>
                                    <Show when={index() === timelineSlotIndexes().lastReasoning}>
                                      {renderMessageSlot("after-reasoning")}
                                    </Show>
                                    <Show when={index() === timelineSlotIndexes().lastTool}>
                                      {renderMessageSlot("after-tools")}
                                    </Show>
                                  </>
                                )}
                              </Show>
                            )
                          }}
                        </For>
                        <Show when={showProviderPrelude()}>
                          <div data-slot="session-turn-timeline-item" data-kind="provider-prelude">
                            <ProviderPrelude text={providerPreludeText(sessionStatus())} />
                          </div>
                        </Show>
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
                                      <div data-component="session-turn-diff-preview">
                                        <div class="text-12-regular text-text-weak">
                                          {diff.beforeBytes ?? 0} bytes to {diff.afterBytes ?? 0} bytes
                                          <Show when={diff.truncated}> - preview truncated</Show>
                                        </div>
                                        <Show
                                          when={diff.preview}
                                          fallback={
                                            <div class="text-12-regular text-text-weaker">
                                              No text preview available.
                                            </div>
                                          }
                                        >
                                          {(preview) => (
                                            <pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-subtle p-3 text-12-regular text-text-base">
                                              {preview()}
                                            </pre>
                                          )}
                                        </Show>
                                      </div>
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
                    <Show when={error()}>
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
