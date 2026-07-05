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
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, ParentProps, Show, Switch } from "solid-js"
import { DiffChanges } from "./diff-changes"
import { DiffPreview } from "./tool/diff-preview"
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
import { CompactionCard } from "./compaction-card"
import { hasVisibleUserMessageContent } from "./user-message-utils"

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
      part: TextPart | ToolPart | AttachmentPart | PartType
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
  | {
      kind: "compaction"
      message: MessageType
      part?: PartType
    }

export type SessionTurnTimelineVisualKind =
  | "text"
  | "reasoning"
  | "tool"
  | "attachment"
  | "media-pending"
  | "tool-attachments"
  | "compaction"

const DEFAULT_PROVIDER_PRELUDE_TEXT = "Awaiting response…"

export function providerPreludeElapsedLabel(started: number | undefined, now: number): string | undefined {
  if (started == null) return undefined

  const totalSeconds = Math.max(0, Math.floor((now - started) / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const mm = minutes.toString().padStart(2, "0")
  const ss = seconds.toString().padStart(2, "0")

  if (hours > 0) return `${hours}:${mm}:${ss}`
  return `${mm}:${ss}`
}

function visibleAttachmentParts(files: AttachmentPart[] | undefined): AttachmentPart[] {
  return (files ?? []).filter((file) => !resolveAttachmentPresentation(file).hidden)
}

function isCompactionAssistant(message: AssistantMessage): boolean {
  return message.mode === "compaction" || message.agent === "compaction"
}

export function isCompactionBoundaryUser(message: Pick<UserMessage, "metadata">): boolean {
  return message.metadata?.compactionBoundary === true
}

export function collectCompactionParentIDs(messages: readonly MessageType[]): Set<string> {
  const result = new Set<string>()
  for (const message of messages) {
    if (message.role !== "user") continue
    const metadata = (message as UserMessage).metadata
    const parentID = metadata?.compactionParentID
    if (metadata?.compactionBoundary === true && typeof parentID === "string" && parentID) result.add(parentID)
  }
  return result
}

export function collectUserCompactionTimelineItems(
  message: UserMessage,
  parts: readonly PartType[],
): SessionTurnTimelineItem[] {
  const compactionRecovery = parts.find((part) => part.type === "compaction_recovery")
  if (!compactionRecovery) return []
  return [{ kind: "compaction", message, part: compactionRecovery }]
}

export function shouldShowTurnDiffs(
  message: Pick<UserMessage, "metadata" | "summary"> | undefined,
  options: { hasCompactionEvent?: boolean; isCompactedParent?: boolean } = {},
): boolean {
  if (!message) return false
  if (options.isCompactedParent) return false
  if (isCompactionBoundaryUser(message) || options.hasCompactionEvent) return false
  return (message.summary?.diffs?.length ?? 0) > 0
}

export function shouldShowTurnUserChrome(
  message: Pick<UserMessage, "metadata"> | undefined,
  parts: readonly PartType[] | undefined,
  hasCompactionEvent: boolean,
): boolean {
  if (!message) return false
  if (isCompactionBoundaryUser(message)) return false
  if (!hasCompactionEvent) return true
  if (message.metadata?.synthetic === true) return false

  return hasVisibleUserMessageContent(parts)
}

export function timelineKindForPart(part: PartType, working: boolean): SessionTurnTimelineItem["kind"] | undefined {
  if (part.type === "text") return part.text.trim() ? "part" : undefined
  if (part.type === "attachment") return resolveAttachmentPresentation(part).hidden ? undefined : "part"
  if (part.type === "reasoning") return working && part.text.trim() ? "reasoning" : undefined
  if (part.type === "compaction_recovery") return "part"
  if (part.type !== "tool") return undefined
  if (isActiveMediaGenerationToolPart(part)) return "media-pending"
  if (isToolCardHidden(part)) {
    if (part.state.status !== "completed") return undefined
    return visibleAttachmentParts(part.state.attachments).length > 0 ? "tool-attachments" : undefined
  }
  return "part"
}

export function timelineVisualKind(item: SessionTurnTimelineItem): SessionTurnTimelineVisualKind {
  if (item.kind === "compaction") return "compaction"
  if (item.kind !== "part") return item.kind
  if (item.part.type === "tool") return "tool"
  if (item.part.type === "attachment") return "attachment"
  if (item.part.type === "compaction_recovery") return "compaction"
  return "text"
}

export function timelineItemStableKey(item: SessionTurnTimelineItem): string {
  if (item.kind === "compaction") return `compaction:${item.message.id}`
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
    const compactionRecovery = parts.find((part) => part.type === "compaction_recovery")
    if (isCompactionAssistant(message)) {
      items.push({ kind: "compaction", message, part: compactionRecovery })
      continue
    }

    const hasCompactionRecovery = !!compactionRecovery
    for (const part of parts) {
      const kind = timelineKindForPart(part, working)
      if (!kind) continue

      // When a compaction recovery card is present, suppress raw text parts
      // so only the structured card renders — no duplicate markdown output.
      if (hasCompactionRecovery && part.type === "text") continue

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

/**
 * @deprecated Use isRoot/rootID/visible fields instead.
 * Kept for backward compat with old sessions that lack rootID.
 */
export function isGuidedContextUserMessage(message: Pick<UserMessage, "metadata">): boolean {
  const msg = message as UserMessage
  if (msg.isRoot !== undefined) return msg.isRoot === false && msg.visible !== false
  const metadata = message.metadata
  return metadata?.guided === true && metadata?.noReply === true
}

export type SessionTurnDisplayMessage = AssistantMessage | UserMessage

function chipLabelFromOrigin(origin: { type: string; label?: string; detail?: string } | undefined): string {
  if (!origin || !origin.type) return "Guided"
  if (origin.label) return origin.label
  switch (origin.type) {
    case "cortex":
      return "Agent"
    case "agenda":
      return "Agenda"
    case "blueprint":
      return "Blueprint"
    case "channel":
      return "Channel"
    case "agent":
      return "Forwarded"
    case "compaction":
      return "Compaction"
    case "plugin":
      return "Plugin"
    case "system":
      return "System"
    default:
      return "Guided"
  }
}

export function collectMessagesForTurnDisplay(
  messages: MessageType[],
  userMessageID: string,
): SessionTurnDisplayMessage[] {
  const search = Binary.search(messages, userMessageID, (m) => m.id)
  if (!search.found) return []

  const userMessage = messages[search.index]
  if (!userMessage || userMessage.role !== "user") return []

  const user = userMessage as UserMessage
  const rootID = user.rootID

  // If this message has no rootID field, fall back to old parentID-based logic
  if (rootID === undefined) {
    return collectMessagesForTurnDisplayLegacy(messages, userMessageID)
  }

  const result: SessionTurnDisplayMessage[] = []

  // Walk forward collecting messages with matching rootID
  for (let i = search.index + 1; i < messages.length; i++) {
    const item = messages[i]
    if (!item) break

    const itemRootID = item.rootID
    if (itemRootID === undefined || itemRootID !== rootID) break

    if (item.role === "user") {
      // Non-root user messages become chips; skip root user messages
      if (!(item as UserMessage).isRoot) {
        result.push(item as UserMessage)
      }
      continue
    }

    // Assistant message
    result.push(item as AssistantMessage)
  }

  return result
}

/** Legacy parentID-based fallback when rootID fields are absent */
function collectMessagesForTurnDisplayLegacy(
  messages: MessageType[],
  userMessageID: string,
): SessionTurnDisplayMessage[] {
  const search = Binary.search(messages, userMessageID, (m) => m.id)
  if (!search.found) return []

  const userMessage = messages[search.index]
  if (!userMessage || userMessage.role !== "user") return []

  const validParentIDs = new Set([userMessage.id])
  const result: SessionTurnDisplayMessage[] = []
  for (let i = search.index + 1; i < messages.length; i++) {
    const item = messages[i]
    if (!item) continue
    if (item.role === "user") {
      const user = item as UserMessage
      if (isInlineContextUserMessageLegacy(user)) {
        if (user.metadata?.synthetic && hasSpecialUserMessageRenderer(user)) break
        validParentIDs.add(user.id)
        if (isGuidedContextUserMessageLegacy(user)) result.push(user)
        continue
      }
      break
    }
    if (item.role === "assistant" && validParentIDs.has((item as AssistantMessage).parentID))
      result.push(item as AssistantMessage)
  }
  return result
}

function isInlineContextUserMessageLegacy(message: UserMessage): boolean {
  return message.metadata?.synthetic === true || isGuidedContextUserMessageLegacy(message)
}

function isGuidedContextUserMessageLegacy(message: Pick<UserMessage, "metadata">): boolean {
  const metadata = message.metadata
  return metadata?.guided === true && metadata?.noReply === true
}

export function collectAssistantMessagesForTurn(messages: MessageType[], userMessageID: string): AssistantMessage[] {
  return collectMessagesForTurnDisplay(messages, userMessageID).filter(
    (message): message is AssistantMessage => message.role === "assistant",
  )
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
  if (props.item.kind === "compaction") {
    return <CompactionCard part={props.item.part} message={props.item.message} />
  }
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

type SessionTurnDisplayItem =
  | SessionTurnTimelineItem
  | {
      kind: "guided-user"
      message: UserMessage
      parts: PartType[]
    }
  | {
      kind: "non-root-user"
      message: UserMessage
      parts: PartType[]
      originLabel: string
    }

function isAssistantTimelineDisplayItem(item: SessionTurnDisplayItem): item is SessionTurnTimelineItem {
  return item.kind !== "guided-user" && item.kind !== "non-root-user"
}

function displayItemStableKey(item: SessionTurnDisplayItem): string {
  if (item.kind === "guided-user") return `guided-user:${item.message.id}`
  if (item.kind === "non-root-user") return `non-root-user:${item.message.id}`
  return timelineItemStableKey(item)
}

function displayItemVisualKind(
  item: SessionTurnDisplayItem,
): SessionTurnTimelineVisualKind | "guided-user" | "non-root-user" {
  if (item.kind === "guided-user") return "guided-user"
  if (item.kind === "non-root-user") return "non-root-user"
  return timelineVisualKind(item)
}

function originIconName(origin: { type: string; label?: string; detail?: string } | undefined): string {
  if (!origin || !origin.type) return "message-square"
  switch (origin.type) {
    case "cortex":
      return "bot"
    case "agenda":
      return "calendar-days"
    case "blueprint":
      return "clipboard-list"
    case "channel":
      return "message-circle"
    case "agent":
      return "corner-down-left"
    case "compaction":
      return "archive"
    case "plugin":
      return "puzzle"
    case "system":
      return "cpu"
    default:
      return "bot"
  }
}

function TimelineDisplay(props: {
  item: SessionTurnDisplayItem
  serverUrl: string
  rollbackActive: boolean
  onRewind?: () => void
}) {
  if (props.item.kind === "guided-user") {
    return <Message message={props.item.message} parts={props.item.parts} userVariant="turn-bubble" />
  }
  if (props.item.kind === "non-root-user") {
    return (
      <div data-slot="session-turn-rewind-wrapper">
        <div data-slot="session-turn-chip" data-origin={props.item.message.origin?.type ?? "guided"}>
          <Icon name={originIconName(props.item.message.origin)} size="small" />
          <span data-slot="session-turn-chip-label">{props.item.originLabel}</span>
        </div>
        <button
          type="button"
          data-slot="session-turn-rewind-button"
          data-rollback-active={props.rollbackActive}
          onClick={(e) => {
            e.stopPropagation()
            props.onRewind?.()
          }}
          title="Rewind to before this message"
        >
          <Icon name="undo-2" size="small" />
          <span>Rewind</span>
        </button>
      </div>
    )
  }
  return <TimelineItemDisplay item={props.item} serverUrl={props.serverUrl} />
}

function ProviderPrelude(props: { text: string; elapsed?: string }) {
  return (
    <div data-component="provider-prelude" role="status" aria-live="polite" aria-label={props.text}>
      <span data-slot="provider-prelude-text">{props.text}</span>
      <Show when={props.elapsed}>
        {(elapsed) => (
          <>
            <span data-slot="provider-prelude-separator" aria-hidden="true">
              ·
            </span>
            <span data-slot="provider-prelude-time" aria-hidden="true">
              {elapsed()}
            </span>
          </>
        )}
      </Show>
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
    onRewind?: () => void
    rollbackActive?: boolean
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
  const emptyDisplayMessages: SessionTurnDisplayMessage[] = []
  const emptyDisplayItems: SessionTurnDisplayItem[] = []
  const emptyPermissions: PermissionRequest[] = []

  const allMessages = createMemo(() => data.store.message[props.sessionID] ?? emptyMessages)
  const compactionParentIDs = createMemo(() => collectCompactionParentIDs(allMessages()))

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

  const displayMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyDisplayMessages
      return collectMessagesForTurnDisplay(allMessages(), msg.id)
    },
    emptyDisplayMessages,
    { equals: same },
  )

  const assistantMessages = createMemo(
    () => {
      return displayMessages().filter((message): message is AssistantMessage => message.role === "assistant")
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

  const timelineItems = createMemo(
    () => {
      const result: SessionTurnDisplayItem[] = []
      const msg = message()
      if (msg) result.push(...collectUserCompactionTimelineItems(msg, parts()))
      for (const item of displayMessages()) {
        if (item.role === "user") {
          const userMsg = item as UserMessage
          // Use old metadata-based guided detection as fallback when isRoot/rootID absent
          const isNonRoot = userMsg.isRoot !== undefined ? !userMsg.isRoot : isGuidedContextUserMessage(userMsg)
          if (isNonRoot) {
            result.push({
              kind: "non-root-user",
              message: userMsg,
              parts: data.store.part[item.id] ?? emptyParts,
              originLabel: chipLabelFromOrigin(userMsg.origin),
            })
          }
          continue
        }
        result.push(...collectSessionTurnTimelineItems([item], data.store.part, working()))
      }
      return result
    },
    emptyDisplayItems,
    { equals: same },
  )
  const hasCompactionEvent = createMemo(() =>
    timelineItems().some((item) => isAssistantTimelineDisplayItem(item) && timelineVisualKind(item) === "compaction"),
  )
  const showUserChrome = createMemo(() => shouldShowTurnUserChrome(message(), parts(), hasCompactionEvent()))
  const hasDiffs = createMemo(() => {
    const msg = message()
    return shouldShowTurnDiffs(msg, {
      hasCompactionEvent: hasCompactionEvent(),
      isCompactedParent: !!msg && compactionParentIDs().has(msg.id),
    })
  })
  const latestAssistantTimelineItems = createMemo(() => {
    const latest = lastAssistantMessage()
    if (!latest) return []
    return collectSessionTurnTimelineItems([latest], data.store.part, working())
  })
  const timelineItemMap = createMemo(() => {
    const result = new Map<string, SessionTurnDisplayItem>()
    for (const item of timelineItems()) result.set(displayItemStableKey(item), item)
    return result
  })
  const timelineItemKeys = createMemo(() => timelineItems().map(displayItemStableKey))
  const timelineSlotIndexes = createMemo(() => {
    const items = timelineItems()
    const firstReasoning = items.findIndex(
      (item) => isAssistantTimelineDisplayItem(item) && timelineVisualKind(item) === "reasoning",
    )
    const lastReasoning = items.findLastIndex(
      (item) => isAssistantTimelineDisplayItem(item) && timelineVisualKind(item) === "reasoning",
    )
    const firstTool = items.findIndex((item) => isAssistantTimelineDisplayItem(item) && isToolTimelineItem(item))
    const lastTool = items.findLastIndex((item) => isAssistantTimelineDisplayItem(item) && isToolTimelineItem(item))
    return { firstReasoning, lastReasoning, firstTool, lastTool }
  })
  const renderMessageSlot = (slot: MessageSlotName) => (
    <MessageSlotOutlet slot={slot} sessionId={props.sessionID} messageId={props.messageID} />
  )
  const hasTimelineItems = createMemo(() => timelineItems().length > 0)
  const sessionStatus = createMemo(() => data.store.session_status[props.sessionID])
  const [providerPreludeNow, setProviderPreludeNow] = createSignal(Date.now())
  const providerPreludeStarted = createMemo(() => message()?.time.created)
  const providerPreludeElapsed = createMemo(() =>
    providerPreludeElapsedLabel(providerPreludeStarted(), providerPreludeNow()),
  )
  const showProviderPrelude = createMemo(() =>
    shouldShowProviderPrelude({
      working: working(),
      hasError: !!error(),
      latestAssistant: lastAssistantMessage(),
      latestAssistantTimelineItems: latestAssistantTimelineItems(),
    }),
  )

  createEffect(() => {
    if (!showProviderPrelude()) {
      setProviderPreludeNow(Date.now())
      return
    }

    setProviderPreludeNow(Date.now())
    const timer = setInterval(() => setProviderPreludeNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

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
                    <Show when={showUserChrome()}>
                      {/* Mailbox source annotation */}
                      <Show when={(msg() as UserMessage).metadata?.mailbox && !specialUserMessageRenderer()}>
                        <MailboxSourceBadge message={msg() as UserMessage} />
                      </Show>
                      {/* User message */}
                      <div data-slot="session-turn-rewind-wrapper">
                        <Show
                          when={specialUserMessageRenderer()}
                          fallback={<Message message={msg()} parts={parts()} userVariant="turn-bubble" />}
                        >
                          {(SpecialUserMessage) => (
                            <Dynamic component={SpecialUserMessage()} message={msg()} parts={parts()} />
                          )}
                        </Show>
                        <Show when={props.onRewind && !specialUserMessageRenderer()}>
                          <button
                            type="button"
                            data-slot="session-turn-rewind-button"
                            data-rollback-active={props.rollbackActive === true}
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onRewind?.()
                            }}
                            title="Rewind to before this message"
                          >
                            <Icon name="undo-2" size="small" />
                            <span>Rewind</span>
                          </button>
                        </Show>
                      </div>
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
                                      data-kind={displayItemVisualKind(current())}
                                    >
                                      <TimelineDisplay
                                        item={current()}
                                        serverUrl={data.serverUrl}
                                        rollbackActive={props.rollbackActive === true}
                                        onRewind={props.onRewind}
                                      />
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
                            <ProviderPrelude
                              text={providerPreludeText(sessionStatus())}
                              elapsed={providerPreludeElapsed()}
                            />
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
                              {(diff, index) => {
                                const diffKey = () => diff.file || `diff-${index()}`

                                return (
                                  <Accordion.Item value={diffKey()}>
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
                                      <Show when={store.diffsOpen.includes(diffKey())}>
                                        <DiffPreview diff={diff} variant="session" />
                                      </Show>
                                    </Accordion.Content>
                                  </Accordion.Item>
                                )
                              }}
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
