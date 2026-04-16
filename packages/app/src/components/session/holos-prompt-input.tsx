import { createMemo, createSignal, Show } from "solid-js"
import type { Message } from "@ericsanchezok/synergy-sdk"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { useSDK } from "@/context/sdk"
import { useInput } from "@/context/input"
import { extractHolosText, formatHolosMessageTime } from "./holos-chat-shared"

export function HolosPromptInput(props: {
  contactId: string
  contactName: string
  sessionId: string
  replyToMessage?: Message
  replyToParts?: Array<{ type: string; [key: string]: unknown }>
  onCancelReply?: () => void
}) {
  const sdk = useSDK()
  const input = useInput()
  const [text, setText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  let textareaRef!: HTMLTextAreaElement

  const replyPreview = createMemo(() => {
    const message = props.replyToMessage
    if (!message) return undefined
    const messageParts = props.replyToParts ?? []
    const body = extractHolosText(messageParts).trim()
    const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
    const holos = metadata.holos as { inbound?: boolean } | undefined
    const isInbound = message.role === "user" && holos?.inbound === true
    const source = metadata.source as string | undefined
    const sender = isInbound
      ? source === "agent"
        ? `${props.contactName}'s Agent`
        : props.contactName
      : source === "agent"
        ? "Your Agent"
        : "You"
    return {
      sender,
      text: body,
      time: formatHolosMessageTime(message.time.created),
    }
  })

  const resizeTextarea = () => {
    textareaRef.style.height = "auto"
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 240) + "px"
  }

  const handleInput = (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    setText(e.currentTarget.value)
    resizeTextarea()
  }

  const send = async () => {
    const trimmed = text().trim()
    if (!trimmed || sending()) return

    setSending(true)
    try {
      await sdk.client.holos.contact.sendMessage({
        id: props.contactId,
        text: trimmed,
        replyToMessageId: props.replyToMessage?.id,
      })
      setText("")
      textareaRef.value = ""
      resizeTextarea()
      props.onCancelReply?.()
    } finally {
      setSending(false)
      textareaRef.focus()
    }
  }

  const sendShortcut = createMemo(() => input.sendShortcut())
  const shortcutHint = createMemo(() =>
    sendShortcut() === "enter" ? "Enter to send · Shift+Enter newline" : "⌘/Ctrl+Enter to send · Enter newline",
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.replyToMessage) {
      e.preventDefault()
      props.onCancelReply?.()
      return
    }

    if (e.key !== "Enter" || e.isComposing) return

    const modEnter = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    const plainEnter = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey

    if (sendShortcut() === "enter") {
      if (plainEnter) {
        e.preventDefault()
        send()
      }
      return
    }

    if (modEnter) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div class="space-y-2.5" style={{ animation: "cardPopIn 320ms ease-out both" }}>
      <div class="flex flex-wrap items-center gap-1.5 px-1">
        <div class="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-surface-base border border-border-weak-base text-12-medium text-text-base">
          <Icon name="message-square" size="small" class="text-icon-base" />
          Direct reply
        </div>
        <div class="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-surface-base border border-border-weak-base text-12-medium text-text-weak">
          <Icon name="git-branch" size="small" class="text-icon-weaker" />
          Branch links appear on triggered messages
        </div>
      </div>
      <div
        classList={{
          "group/prompt-input relative overflow-hidden rounded-[24px] border border-border-base bg-surface-raised-stronger-non-alpha shadow-[0_20px_54px_-38px_rgba(0,0,0,0.72)] transition-all duration-200": true,
          "opacity-70 pointer-events-none": sending(),
          "focus-within:border-border-strong focus-within:shadow-[0_24px_60px_-34px_color-mix(in_srgb,var(--surface-brand-base)_28%,transparent)]": true,
        }}
      >
        <div
          class="pointer-events-none absolute inset-x-4 top-0 h-px opacity-70"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--surface-brand-base) 28%, transparent) 22%, color-mix(in srgb, var(--surface-brand-base) 14%, transparent) 78%, transparent 100%)",
          }}
        />
        <div class="relative flex flex-col gap-3 p-3">
          <Show when={replyPreview()}>
            {(reply) => (
              <div class="rounded-[18px] border border-border-base bg-background-base/76 px-3.5 py-3 shadow-inner">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 text-11-medium text-text-subtle pb-1.5">
                      <Icon name="message-square" size="small" />
                      <span>Replying to {reply().sender}</span>
                      <span>·</span>
                      <span>{reply().time}</span>
                    </div>
                    <div class="text-12-regular text-text-weak line-clamp-3 whitespace-pre-wrap">
                      {reply().text || "(No text content)"}
                    </div>
                  </div>
                  <IconButton icon="x" variant="ghost" onClick={() => props.onCancelReply?.()} />
                </div>
              </div>
            )}
          </Show>
          <div class="rounded-[18px] border border-border-weak-base bg-background-base/72 px-4 py-3 shadow-inner">
            <div class="flex items-center justify-between gap-3 pb-2 text-11-medium text-text-subtle">
              <span>Message {props.contactName}</span>
              <span>
                {sending() ? "Sending…" : props.replyToMessage ? `${shortcutHint()} · Esc to cancel` : shortcutHint()}
              </span>
            </div>
            <div class="flex items-end gap-3">
              <div class="relative min-w-0 flex-1 max-h-[240px] overflow-y-auto">
                <textarea
                  data-holos-input="true"
                  ref={(el) => (textareaRef = el)}
                  rows={1}
                  placeholder={`Send a message to ${props.contactName}...`}
                  disabled={sending()}
                  value={text()}
                  onInput={handleInput}
                  onKeyDown={handleKeyDown}
                  class="w-full resize-none bg-transparent text-14-regular leading-6 text-text-strong placeholder:text-text-weak focus:outline-none"
                  style={{ "max-height": "240px" }}
                />
              </div>
              <IconButton
                type="button"
                icon="arrow-up"
                variant="primary"
                class="size-10 rounded-full! shrink-0 shadow-md hover:scale-105 active:scale-95 transition-transform"
                disabled={!text().trim() || sending()}
                onClick={send}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
