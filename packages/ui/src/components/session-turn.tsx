import type {
  AssistantMessage,
  AttachmentPart,
  Message as MessageType,
  Part as PartType,
  PermissionRequest,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
} from "@ericsanchezok/synergy-sdk/client"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"

import { Binary } from "@ericsanchezok/synergy-util/binary"
import { createEffect, createMemo, For, Match, on, ParentProps, Show, Switch } from "solid-js"
import { DiffChanges } from "./diff-changes"
import { Typewriter } from "./typewriter"
import { Message, Part } from "./message-part"
import { AttachmentGallery } from "./attachment-card"
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

export function timelineKindForPart(part: PartType, working: boolean): SessionTurnTimelineItem["kind"] | undefined {
  if (part.type === "text") return "part"
  if (part.type === "attachment") return "part"
  if (part.type === "reasoning") return working ? "reasoning" : undefined
  if (part.type !== "tool") return undefined
  if (isActiveMediaGenerationToolPart(part)) return "media-pending"
  if (isToolCardHidden(part)) {
    return part.state.status === "completed" && (part.state.attachments?.length ?? 0) > 0
      ? "tool-attachments"
      : undefined
  }
  return "part"
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
        const files = toolPart.state.status === "completed" ? (toolPart.state.attachments ?? []) : []
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

function TimelineItemDisplay(props: { item: SessionTurnTimelineItem; serverUrl: string }) {
  if (props.item.kind === "part" || props.item.kind === "reasoning") {
    return <Part part={props.item.part} message={props.item.message} />
  }
  if (props.item.kind === "media-pending") return <MediaGenerationCard part={props.item.part} />
  return <AttachmentGallery files={props.item.files} serverUrl={props.serverUrl} />
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
  const diffComponent = useDiffComponent()

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
  const hasTimelineItems = createMemo(() => timelineItems().length > 0)

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
                    <Show
                      when={specialUserMessageRenderer()}
                      fallback={<Message message={msg()} parts={parts()} userVariant="turn-bubble" />}
                    >
                      {(SpecialUserMessage) => (
                        <Dynamic component={SpecialUserMessage()} message={msg()} parts={parts()} />
                      )}
                    </Show>
                    <Show when={hasTimelineItems() || (!working() && hasDiffs())}>
                      <div data-slot="session-turn-timeline">
                        <For each={timelineItems()}>
                          {(item) => <TimelineItemDisplay item={item} serverUrl={data.serverUrl} />}
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
