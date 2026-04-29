import { For, Show, createMemo, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { Message } from "@ericsanchezok/synergy-sdk"
import type { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ConversationViewport } from "./conversation-viewport"
import {
  type HolosBubbleGroup,
  type HolosSender,
  extractHolosText,
  formatHolosMessageTime,
  holosSenderLabel,
  groupHolosMessages,
  isHolosOutbound,
} from "./holos-chat-shared"

export function HolosGreeting(props: { contactName: string }) {
  return (
    <div
      class="flex flex-col items-center gap-4 text-center mb-8 pointer-events-none"
      style={{ animation: "greetFadeIn 420ms ease-out both" }}
    >
      <div class="size-18 rounded-full bg-surface-brand-base/15 flex items-center justify-center text-24-medium text-text-strong shadow-sm ring-1 ring-border-base/60">
        {props.contactName.charAt(0).toUpperCase()}
      </div>
      <div class="space-y-1.5">
        <div class="inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-3 py-1 text-11-medium text-text-weak uppercase tracking-[0.14em]">
          <Icon name="message-square" size="small" />
          Holos conversation
        </div>
        <h1 class="text-36-medium text-text-strong">{props.contactName}</h1>
        <p class="text-14-regular text-text-weak max-w-md">
          Keep it natural here — jump between direct replies and agent branches without losing the thread.
        </p>
      </div>
    </div>
  )
}

function SenderAvatar(props: { sender: HolosSender; contactName: string; myName: string }) {
  const isAgent = () => props.sender === "my-agent" || props.sender === "peer-agent"
  const isPeer = () => props.sender === "peer" || props.sender === "peer-agent"

  const name = () => (isPeer() ? props.contactName : props.myName)
  const initial = () => name().charAt(0).toUpperCase()

  return (
    <div class="relative shrink-0 self-start pt-1">
      <div
        classList={{
          "size-9 rounded-full flex items-center justify-center text-12-medium text-text-strong shadow-sm ring-1 ring-border-base/60": true,
          "bg-surface-brand-base/15": isPeer(),
          "bg-surface-raised-stronger": !isPeer(),
        }}
      >
        {initial()}
      </div>
      <Show when={isAgent()}>
        <div
          class="absolute -bottom-0.5 -right-0.5 size-4 rounded-full bg-background-base border border-border-base flex items-center justify-center"
          style={{ animation: "badgePopIn 220ms cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
        >
          <Icon name="bot" class="text-text-subtle" style={{ "font-size": "11px" }} />
        </div>
      </Show>
    </div>
  )
}

function HeaderPill(props: { icon: "message-square" | "git-branch" | "sparkles"; label: string }) {
  return (
    <span class="inline-flex items-center gap-1.5 h-7 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-3 text-11-medium text-text-weak whitespace-nowrap">
      <Icon name={props.icon} size="small" />
      {props.label}
    </span>
  )
}

function HolosConversationHeader(props: {
  contactName: string
  contactBio?: string
  messageCount: number
  branchCount: number
}) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div class="flex justify-center">
      <div class="w-full md:max-w-200 flex flex-col items-start gap-2.5">
        <button
          type="button"
          class="inline-flex max-w-full items-center gap-2 rounded-full border border-border-base bg-background-base/86 backdrop-blur-xl px-3.5 py-2 text-left shadow-[0_14px_38px_-30px_color-mix(in_srgb,var(--surface-brand-base)_34%,transparent)] hover:bg-background-base transition-colors"
          onClick={() => setExpanded((value) => !value)}
        >
          <div class="size-8 rounded-xl bg-surface-brand-base/15 flex items-center justify-center text-13-medium text-text-strong shadow-sm ring-1 ring-border-base/60 shrink-0">
            {props.contactName.charAt(0).toUpperCase()}
          </div>
          <span class="text-13-medium text-text-strong truncate max-w-40 md:max-w-none">{props.contactName}</span>
          <HeaderPill icon="message-square" label="Holos conversation" />
          <Show when={props.branchCount > 0}>
            <HeaderPill icon="git-branch" label={`${props.branchCount} branch${props.branchCount === 1 ? "" : "es"}`} />
          </Show>
          <span class="hidden md:inline text-11-medium text-text-subtle">
            {props.messageCount} message{props.messageCount === 1 ? "" : "s"}
          </span>
          <span class="hidden md:inline text-text-subtle">·</span>
          <span class="hidden md:inline-flex items-center gap-1 text-11-medium text-text-weak">
            <Icon name="sparkles" size="small" />
            Live branch links
          </span>
          <span class="inline-flex items-center justify-center size-7 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha shrink-0 ml-auto">
            <Icon name={expanded() ? "chevron-up" : "chevron-down"} size="small" />
          </span>
        </button>
        <Show when={expanded()}>
          <div class="w-full rounded-[24px] border border-border-base bg-background-base/88 backdrop-blur-xl px-4 py-3 shadow-[0_20px_50px_-36px_color-mix(in_srgb,var(--surface-brand-base)_42%,transparent)]">
            <p class="text-13-regular text-text-weak leading-6 max-w-2xl">
              {props.contactBio?.trim() || "Direct Holos conversation with branch-aware replies and session handoffs."}
            </p>
          </div>
        </Show>
      </div>
    </div>
  )
}

function HolosContextButton(props: { icon: "git-branch" | "message-square"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="inline-flex items-center gap-1.5 h-7 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-3 text-11-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover active:scale-95 transition-all shadow-xs max-w-full"
      onClick={props.onClick}
      style={{ animation: "cardPopIn 260ms ease-out both" }}
    >
      <Icon name={props.icon} size="small" />
      {props.label}
    </button>
  )
}

function HolosMessageMeta(props: {
  message: Message
  sender: HolosSender
  contactName: string
  myName: string
  branchSessionId?: string
  sourceSessionID?: string
  sourceLabel: string
  onOpenBranch?: (subSessionId: string, triggerMessageId: string) => void
  onReplyToMessage?: (messageId: string) => void
}) {
  const data = useData()
  const out = () => isHolosOutbound(props.sender)
  const isAgent = () => props.sender === "my-agent" || props.sender === "peer-agent"
  const timestamp = createMemo(() => formatHolosMessageTime(props.message.time.created))

  return (
    <div
      classList={{
        "flex flex-col gap-1 px-1 text-[11px] text-text-subtle transition-opacity": true,
        "items-start": !out(),
        "items-end": out(),
        "opacity-100 md:opacity-0 md:group-hover:opacity-100": true,
      }}
    >
      <div class="flex items-center gap-1.5 leading-none flex-wrap">
        <Show when={isAgent()}>
          <span class="inline-flex items-center gap-1">
            <Icon name="bot" size="small" />
            <span>{holosSenderLabel(props.sender, props.contactName, props.myName)}</span>
          </span>
        </Show>
        <Show when={!isAgent()}>
          <span>{holosSenderLabel(props.sender, props.contactName, props.myName)}</span>
        </Show>
        <span>·</span>
        <span>{timestamp()}</span>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap">
        <Show when={props.branchSessionId}>
          {(branchSessionId) => (
            <HolosContextButton
              icon="git-branch"
              label="Open branch"
              onClick={() => props.onOpenBranch?.(branchSessionId(), props.message.id)}
            />
          )}
        </Show>
        <Show when={props.sourceSessionID}>
          {(sessionID) => (
            <HolosContextButton
              icon="message-square"
              label={`From ${props.sourceLabel}`}
              onClick={() => data.navigateToSession?.(sessionID())}
            />
          )}
        </Show>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha px-2 py-1 text-[11px] font-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover active:scale-95 transition-all"
          onClick={() => props.onReplyToMessage?.(props.message.id)}
        >
          <Icon name="message-square" size="small" />
          Reply
        </button>
      </div>
    </div>
  )
}

function HolosMessageCard(props: {
  message: Message
  sender: HolosSender
  parts: Array<{ type: string; [key: string]: unknown }>
  contactName: string
  myName: string
  branchSessionId?: string
  onOpenBranch?: (subSessionId: string, triggerMessageId: string) => void
  onReplyToMessage?: (messageId: string) => void
}) {
  const textContent = createMemo(() => extractHolosText(props.parts))
  const out = () => isHolosOutbound(props.sender)
  const isAgent = () => props.sender === "my-agent" || props.sender === "peer-agent"
  const metadata = createMemo(() => (props.message.metadata as Record<string, unknown> | undefined) ?? {})
  const sourceSessionID = createMemo(() => metadata().sourceSessionID as string | undefined)
  const sourceName = createMemo(() => metadata().sourceName as string | undefined)
  const sourceLabel = createMemo(() => sourceName() ?? "Agent branch")
  const quote = createMemo(
    () => (metadata().quote as { messageId?: string; text?: string; senderName?: string } | undefined) ?? undefined,
  )
  const replyToMessageId = createMemo(() => quote()?.messageId)
  const quotedText = createMemo(() => quote()?.text)
  const quotedSenderName = createMemo(() => quote()?.senderName)

  return (
    <div
      id={`message-${props.message.id}`}
      data-message-id={props.message.id}
      class="group flex flex-col gap-2 min-w-0"
    >
      <div
        classList={{
          "relative rounded-[24px] px-4 py-4 min-w-0 break-words shadow-[0_18px_50px_-38px_rgba(0,0,0,0.65)] ring-1 ring-inset": true,
          "bg-surface-raised-base ring-border-base/70": !out() && !isAgent(),
          "bg-surface-raised-stronger ring-border-base/70": !out() && isAgent(),
          "bg-surface-brand-base/18 ring-border-base/55": out() && !isAgent(),
          "bg-surface-brand-base/10 ring-border-base/65": out() && isAgent(),
        }}
        style={{ animation: "cardPopIn 260ms ease-out both" }}
      >
        <Show when={replyToMessageId() && quotedText()}>
          <button
            type="button"
            class="mb-3 w-full rounded-[18px] border border-border-base/70 bg-background-base/55 px-3 py-2 text-left transition-colors hover:bg-background-base/72"
            onClick={() => {
              const messageId = replyToMessageId()
              if (!messageId) return
              const target = document.getElementById(`message-${messageId}`)
              target?.scrollIntoView({ behavior: "smooth", block: "center" })
            }}
          >
            <div class="flex items-center gap-1.5 text-[11px] font-medium text-text-subtle pb-1.5">
              <Icon name="message-square" size="small" />
              <span>{quotedSenderName() ?? "Quoted message"}</span>
            </div>
            <div class="text-12-regular text-text-weak line-clamp-2 whitespace-pre-wrap">{quotedText()}</div>
          </button>
        </Show>
        <Show when={textContent()}>
          <Markdown text={textContent()} class="text-14-regular leading-6 text-text-strong [&_p]:my-0 [&_p+p]:mt-2" />
        </Show>
      </div>
      <HolosMessageMeta
        message={props.message}
        sender={props.sender}
        contactName={props.contactName}
        myName={props.myName}
        branchSessionId={props.branchSessionId}
        sourceSessionID={sourceSessionID()}
        sourceLabel={sourceLabel()}
        onOpenBranch={props.onOpenBranch}
        onReplyToMessage={props.onReplyToMessage}
      />
    </div>
  )
}

function HolosMessageGroup(props: {
  group: HolosBubbleGroup
  contactName: string
  myName: string
  branchMap: Record<string, string>
  onOpenBranch?: (subSessionId: string, triggerMessageId: string) => void
  onReplyToMessage?: (messageId: string) => void
}) {
  const data = useData()
  const out = () => isHolosOutbound(props.group.sender)

  return (
    <div
      classList={{
        "grid min-w-0 items-start gap-x-2.5 gap-y-1": true,
        "self-start": !out(),
        "self-end": out(),
        "max-w-[88%] md:max-w-[76%]": true,
      }}
      style={{
        "grid-template-columns": out() ? "minmax(0,1fr) auto" : "auto minmax(0,1fr)",
      }}
    >
      <div class="self-start" style={{ "grid-column": out() ? "2" : "1", "grid-row": "1" }}>
        <SenderAvatar sender={props.group.sender} contactName={props.contactName} myName={props.myName} />
      </div>
      <div class="min-w-0 flex flex-col gap-2 self-start" style={{ "grid-column": out() ? "1" : "2" }}>
        <div class="flex flex-col gap-2 min-w-0">
          <For each={props.group.messages}>
            {(msg) => (
              <HolosMessageCard
                message={msg}
                sender={props.group.sender}
                parts={data.store.part[msg.id] ?? []}
                contactName={props.contactName}
                myName={props.myName}
                branchSessionId={props.branchMap[msg.id]}
                onOpenBranch={props.onOpenBranch}
                onReplyToMessage={props.onReplyToMessage}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

export function HolosConversation(props: {
  sessionID: string
  contactName: string
  contactBio?: string
  myName: string
  messages: Accessor<Message[]>
  branchMap: Accessor<Record<string, string>>
  onOpenBranch?: (subSessionId: string, triggerMessageId: string) => void
  onReplyToMessage?: (messageId: string) => void
  autoScroll: ReturnType<typeof createAutoScroll>
  setScrollRef: (el: HTMLDivElement | undefined) => void
}) {
  const [scrolledUp, setScrolledUp] = createSignal(false)
  const branchCount = createMemo(() => Object.keys(props.branchMap()).length)

  let prevGroups: HolosBubbleGroup[] = []
  const groups = createMemo(() => {
    const next = groupHolosMessages(props.messages())
    const prevByKey = new Map(prevGroups.map((g) => [g.key, g]))
    const stable = next.map((g) => {
      const existing = prevByKey.get(g.key)
      if (existing && existing.sender === g.sender) {
        existing.messages = g.messages
        return existing
      }
      return g
    })
    prevGroups = stable
    return stable
  })

  return (
    <ConversationViewport
      scrolledUp={scrolledUp()}
      onScrolledUpChange={setScrolledUp}
      autoScroll={props.autoScroll}
      setScrollRef={props.setScrollRef}
      scrollButtonOffsetClass="bottom-[calc(var(--prompt-height,8rem)+20px)]"
      stickyHeader={
        <div class="sticky top-0 z-10 px-4 md:px-6 pt-3 pb-2 bg-gradient-to-b from-background-stronger via-background-stronger/96 to-transparent backdrop-blur-[2px]">
          <div class="mx-auto w-full md:max-w-200">
            <HolosConversationHeader
              contactName={props.contactName}
              contactBio={props.contactBio}
              messageCount={props.messages()?.length ?? 0}
              branchCount={branchCount()}
            />
          </div>
        </div>
      }
      contentClass="flex flex-col gap-5 px-4 md:px-6 pb-[calc(var(--prompt-height,8rem)+72px)] pt-1"
    >
      <div class="mx-auto w-full md:max-w-200 flex flex-col gap-5">
        <For each={groups()}>
          {(group) => (
            <HolosMessageGroup
              group={group}
              contactName={props.contactName}
              myName={props.myName}
              branchMap={props.branchMap()}
              onOpenBranch={props.onOpenBranch}
              onReplyToMessage={props.onReplyToMessage}
            />
          )}
        </For>
      </div>
    </ConversationViewport>
  )
}
