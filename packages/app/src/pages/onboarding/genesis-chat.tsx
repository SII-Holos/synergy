import { createSignal, createEffect, createMemo, onCleanup, For, Show, batch, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import { Mark } from "@ericsanchezok/synergy-ui/logo"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput } from "@/context/input"
import { usePlatform } from "@/context/platform"
import { Identifier } from "@/utils/id"
import type { Message, Part, TextPart, ToolPart, Event } from "@ericsanchezok/synergy-sdk/client"

const COMPLETION_MARKER = "<!-- genesis:complete -->"
const TRIGGER_TEXT = "[genesis:init]"
const GENESIS_MAX_ROUNDS = 5
const SAVE_TRIGGER = "[genesis:save]"
const GENESIS_PHASE_LABELS = [
  "Getting your context",
  "Understanding your goals",
  "Learning your workflow",
  "Shaping your defaults",
  "Wrapping up your setup",
]
const GENESIS_PHASE_SUGGESTIONS = [
  [
    "I'm Alex — you can call me Nova — I prefer English.",
    "I'm Sam. I'd like to call you Atlas. English works best for me.",
    "我叫小林，我想叫你星流，我更习惯中文。",
    "I'm Maya — call you Echo — I'm comfortable with both English and 中文.",
  ],
  [
    "I'm more act-first than plan-first.",
    "I'm pretty deliberate — I like thinking things through before moving.",
    "I'm calm, curious, and usually pretty independent.",
    "I move fast, but I still like some structure around the work.",
  ],
  [
    "Be concise and direct with me.",
    "A warm but straightforward tone works best for me.",
    "I like collaborative back-and-forth, but not too much fluff.",
    "Default to practical suggestions and clear tradeoffs.",
  ],
  [
    "I'm mostly interested in building software and learning better workflows.",
    "I care a lot about tools, systems, and how people actually work.",
    "Outside work, I like reading, design, and exploring new ideas.",
    "I'm into engineering, product thinking, and making things feel polished.",
  ],
  [
    "A great outcome is having a teammate that understands how I think.",
    "I want Synergy to feel more personalized over time.",
    "I'd love faster planning, clearer communication, and less friction.",
    "The ideal setup is proactive help without too much hand-holding.",
  ],
] as const
const GENESIS_SUGGESTION_RULES = [
  {
    keywords: ["what's yours", "what is yours", "call me", "language", "prefer", "名字", "怎么称呼", "叫你", "语言"],
    suggestions: GENESIS_PHASE_SUGGESTIONS[0],
  },
  {
    keywords: [
      "act-first",
      "think things through",
      "kind of person",
      "your energy",
      "personality",
      "性格",
      "什么样的人",
      "风格偏",
      "做事",
    ],
    suggestions: GENESIS_PHASE_SUGGESTIONS[1],
  },
  {
    keywords: ["casual", "formal", "prefer me", "behave", "concise", "detailed", "style", "语气", "正式", "简洁"],
    suggestions: GENESIS_PHASE_SUGGESTIONS[2],
  },
  {
    keywords: ["interests", "hobbies", "care about", "life", "outside work", "爱好", "感兴趣", "在意", "生活里"],
    suggestions: GENESIS_PHASE_SUGGESTIONS[3],
  },
  {
    keywords: ["ideal", "outcome", "help with", "want from", "best way", "setup", "希望", "想要", "结果", "帮助你"],
    suggestions: GENESIS_PHASE_SUGGESTIONS[4],
  },
] as const

function stripMarkers(text: string): string {
  return text.replace(COMPLETION_MARKER, "").replace(SAVE_TRIGGER, "").trim()
}

interface GenesisChatProps {
  heroReady?: boolean
  onSkip?: () => void
  onProfileUpdate: (profile: { name: string; bio: string }) => void
  onComplete: () => void
}

interface SyncState {
  messages: Message[]
  parts: { [messageID: string]: Part[] }
}

export function GenesisChat(props: GenesisChatProps) {
  const globalSDK = useGlobalSDK()
  const input = useInput()
  const platform = usePlatform()

  const client = createSynergyClient({
    baseUrl: globalSDK.url,
    fetch: platform.fetch,
    directory: "global",
    throwOnError: true,
  })

  const [sessionID, setSessionID] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<"idle" | "busy">("idle")
  const [inputText, setInputText] = createSignal("")
  const [initialized, setInitialized] = createSignal(false)
  const [triggerMessageID, setTriggerMessageID] = createSignal<string | null>(null)
  const [heroAnimated, setHeroAnimated] = createSignal(false)
  const [userRounds, setUserRounds] = createSignal(0)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [completed, setCompleted] = createSignal(false)

  createEffect(() => {
    if (props.heroReady !== false) {
      setHeroAnimated(true)
    }
  })

  const [store, setStore] = createStore<SyncState>({
    messages: [],
    parts: {},
  })

  let scrollRef: HTMLDivElement | undefined
  let textareaRef: HTMLTextAreaElement | undefined

  const scrollToBottom = () => {
    if (scrollRef) {
      requestAnimationFrame(() => {
        scrollRef!.scrollTop = scrollRef!.scrollHeight
      })
    }
  }

  const syncMessages = async () => {
    const sid = sessionID()
    if (!sid) return
    try {
      const res = await client.session.messages({ sessionID: sid })
      const data = res.data
      if (!data) return
      const messages = data.map((item) => item.info).sort((a, b) => a.id.localeCompare(b.id))
      batch(() => {
        setStore("messages", reconcile(messages))
        for (const item of data) {
          setStore("parts", item.info.id, reconcile(item.parts))
        }
      })
      scrollToBottom()
    } catch {}
  }

  const handleEvent = (event: Event) => {
    const sid = sessionID()
    if (!sid) return

    switch (event.type) {
      case "message.updated": {
        const msg = event.properties.info
        if (msg.sessionID !== sid) break
        const result = Binary.search(store.messages, msg.id, (m) => m.id)
        if (result.found) {
          setStore("messages", result.index, reconcile(msg))
        } else {
          setStore(
            "messages",
            produce((draft) => {
              draft.splice(result.index, 0, msg)
            }),
          )
        }
        scrollToBottom()
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        if (part.sessionID !== sid) break
        const existing = store.parts[part.messageID]
        if (!existing) {
          setStore("parts", part.messageID, [part])
        } else {
          const result = Binary.search(existing, part.id, (p) => p.id)
          if (result.found) {
            setStore("parts", part.messageID, result.index, part)
          } else {
            setStore(
              "parts",
              part.messageID,
              produce((draft) => {
                draft.splice(result.index, 0, part)
              }),
            )
          }
        }

        if (part.type === "tool" && part.tool === "profile_update") {
          const toolPart = part as ToolPart
          if (toolPart.state.status === "completed") {
            const input = toolPart.state.input as { name?: string; bio?: string }
            if (input.name && input.bio) {
              props.onProfileUpdate({ name: input.name, bio: input.bio })
            }
          }
        }

        if (part.type === "text") {
          const textPart = part as TextPart
          if (textPart.text.includes(COMPLETION_MARKER)) {
            setCompleted(true)
            props.onComplete()
          }
        }

        scrollToBottom()
        break
      }
      case "session.status": {
        if (event.properties.sessionID !== sid) break
        const s = event.properties.status
        const next = s.type === "busy" ? "busy" : "idle"
        const prev = status()
        setStatus(next as "idle" | "busy")
        if (prev === "busy" && next === "idle") {
          syncMessages()
        }
        break
      }
      case "session.error": {
        if (event.properties.sessionID !== sid) break
        const err = event.properties.error as Record<string, unknown> | undefined
        let msg = "An unexpected error occurred"
        if (err) {
          if ("data" in err && err.data && typeof err.data === "object" && "message" in (err.data as object)) {
            msg = String((err.data as Record<string, unknown>).message)
          } else if (err.name) {
            msg = String(err.name)
          }
        }
        setErrorMessage(msg)
        break
      }
    }
  }

  const unsub = globalSDK.event.on("global", handleEvent)
  onCleanup(unsub)

  let initializing = false
  const initSession = async () => {
    if (initializing) return
    initializing = true
    setErrorMessage(null)
    try {
      await client.channel.genesis.reset().catch(() => {})
      const res = await client.channel.genesis.session()
      const session = res.data
      if (!session) {
        setErrorMessage("Failed to create the onboarding session.")
        return
      }
      setSessionID(session.id)

      const messageID = Identifier.ascending("message")
      setTriggerMessageID(messageID)

      await client.session.promptAsync({
        sessionID: session.id,
        agent: "genesis",
        messageID,
        parts: [{ type: "text", text: TRIGGER_TEXT }],
      })

      setInitialized(true)
      setStatus("busy")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown onboarding error."
      setErrorMessage(message)
      setInitialized(true)
      setStatus("idle")
    } finally {
      initializing = false
    }
  }

  createEffect(() => {
    if (!initialized()) {
      initSession()
    }
  })

  const retryInit = () => {
    setErrorMessage(null)
    setInitialized(false)
    initializing = false
  }

  const visibleMessages = createMemo(() => {
    const trigger = triggerMessageID()
    return store.messages.filter((m) => {
      if (m.role === "user" && m.id === trigger) return false
      if (m.role === "assistant") {
        const parts = store.parts[m.id]
        if (!parts) return false
        const hasText = parts.some((p) => p.type === "text" && stripMarkers((p as TextPart).text))
        if (!hasText) return false
      }
      return true
    })
  })

  const hasVisibleMessages = createMemo(() => visibleMessages().length > 0)

  const completedRounds = createMemo(() => {
    return visibleMessages().filter((m) => m.role === "user").length
  })

  const sendShortcut = createMemo(() => input.sendShortcut())
  const shortcutHint = createMemo(() =>
    sendShortcut() === "enter" ? "Enter to send · Shift+Enter newline" : "⌘/Ctrl+Enter to send · Enter newline",
  )
  const currentPhaseIndex = createMemo(() => Math.min(completedRounds(), GENESIS_PHASE_LABELS.length - 1))
  const currentPhaseLabel = createMemo(() => GENESIS_PHASE_LABELS[currentPhaseIndex()])
  const latestAssistantPrompt = createMemo(() => {
    const messages = visibleMessages()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.role !== "assistant") continue
      const text = getTextForMessage(message.id)()
      if (text) return text.toLowerCase()
    }
    return ""
  })
  const currentSuggestions = createMemo(() => {
    const latest = latestAssistantPrompt()
    if (latest) {
      for (const rule of GENESIS_SUGGESTION_RULES) {
        if (rule.keywords.some((keyword) => latest.includes(keyword))) {
          return rule.suggestions
        }
      }
    }
    return GENESIS_PHASE_SUGGESTIONS[currentPhaseIndex()]
  })

  const activeToolName = createMemo(() => {
    const messages = store.messages
    if (messages.length === 0) return null
    const last = messages[messages.length - 1]
    if (last.role !== "assistant") return null
    const parts = store.parts[last.id]
    if (!parts) return null
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p.type === "tool") {
        const tp = p as ToolPart
        if (tp.state.status === "running" || tp.state.status === "pending") {
          return tp.tool
        }
      }
    }
    return null
  })

  const rawBusyLabel = createMemo(() => {
    const tool = activeToolName()
    if (tool === "profile_update" || tool === "memory_write" || tool === "memory_edit") return "Updating profile..."
    return "Getting to know each other..."
  })

  const LABEL_MIN_HOLD = 1500
  const [busyLabel, setBusyLabel] = createSignal(rawBusyLabel())
  let labelSetAt = Date.now()
  let labelTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    const next = rawBusyLabel()
    const elapsed = Date.now() - labelSetAt
    if (labelTimer) clearTimeout(labelTimer)
    if (elapsed >= LABEL_MIN_HOLD) {
      setBusyLabel(next)
      labelSetAt = Date.now()
    } else {
      labelTimer = setTimeout(() => {
        setBusyLabel(next)
        labelSetAt = Date.now()
      }, LABEL_MIN_HOLD - elapsed)
    }
  })

  onCleanup(() => {
    if (labelTimer) clearTimeout(labelTimer)
  })

  const getTextForMessage = (messageID: string): Accessor<string> => {
    return createMemo(() => {
      const parts = store.parts[messageID]
      if (!parts) return ""
      const result = parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => stripMarkers(p.text))
        .filter(Boolean)
        .join("\n\n")
      return result
    })
  }

  const handleSend = async () => {
    const text = inputText().trim()
    const sid = sessionID()
    if (!text || !sid || status() === "busy") return

    const nextRound = userRounds() + 1
    const shouldTriggerSave = !completed() && nextRound >= 5 && (nextRound - 5) % 2 === 0
    const payloadText = shouldTriggerSave ? `${text}\n\n${SAVE_TRIGGER}` : text

    setUserRounds(nextRound)

    setInputText("")
    if (textareaRef) textareaRef.style.height = "auto"

    const messageID = Identifier.ascending("message")
    const partID = Identifier.ascending("part")

    setStore(
      "messages",
      produce((draft) => {
        draft.push({
          id: messageID,
          sessionID: sid,
          role: "user",
          time: { created: Date.now() },
          agent: "genesis",
          model: { providerID: "", modelID: "" },
        } as Message)
      }),
    )
    setStore("parts", messageID, [
      {
        id: partID,
        sessionID: sid,
        messageID,
        type: "text",
        text,
      } as TextPart,
    ])

    scrollToBottom()

    try {
      setErrorMessage(null)
      await client.session.promptAsync({
        sessionID: sid,
        agent: "genesis",
        messageID,
        parts: [{ id: partID, type: "text", text: payloadText }],
      })
      setStatus("busy")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send onboarding reply."
      setErrorMessage(message)
      setStatus("idle")
      setStore(
        "messages",
        produce((draft) => {
          const idx = draft.findIndex((m) => m.id === messageID)
          if (idx >= 0) draft.splice(idx, 1)
        }),
      )
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return

    const modEnter = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
    const plainEnter = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey

    if (sendShortcut() === "enter") {
      if (plainEnter) {
        e.preventDefault()
        handleSend()
      }
      return
    }

    if (modEnter) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div class="flex flex-col h-full relative">
      <style>{`
        @keyframes genesis-text-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div
        class="fixed inset-0 z-10 flex flex-col items-center justify-center bg-background-base transition-opacity duration-[2000ms] ease-out"
        classList={{
          "opacity-100": !hasVisibleMessages(),
          "opacity-0 pointer-events-none": hasVisibleMessages(),
        }}
      >
        <div class="flex flex-col items-center gap-5">
          <Show
            when={!errorMessage()}
            fallback={
              <>
                <h1
                  class="text-center text-text-strong font-light tracking-tight leading-none whitespace-nowrap"
                  style={{
                    "font-size": "clamp(36px, 5vw, 56px)",
                    opacity: heroAnimated() ? undefined : 0,
                    animation: heroAnimated() ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards" : "none",
                  }}
                >
                  Almost there
                </h1>
                <p
                  class="text-text-weak text-sm text-center max-w-md"
                  style={{
                    opacity: heroAnimated() ? undefined : 0,
                    animation: heroAnimated()
                      ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.4s both"
                      : "none",
                  }}
                >
                  Synergy needs an AI provider to get started.
                </p>
                <Show when={errorMessage()}>
                  {(message) => (
                    <p
                      class="text-text-weaker text-sm text-center max-w-md"
                      style={{
                        opacity: heroAnimated() ? undefined : 0,
                        animation: heroAnimated()
                          ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.6s both"
                          : "none",
                      }}
                    >
                      {message()}
                    </p>
                  )}
                </Show>
                <p
                  class="text-text-weak text-sm text-center max-w-md"
                  style={{
                    opacity: heroAnimated() ? undefined : 0,
                    animation: heroAnimated()
                      ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.8s both"
                      : "none",
                  }}
                >
                  Run{" "}
                  <code class="font-mono bg-surface-raised-stronger-non-alpha px-1.5 py-0.5 rounded text-text-base">
                    synergy config ui
                  </code>{" "}
                  in your terminal to configure a model, then come back here.
                </p>
                <button
                  type="button"
                  class="px-6 py-2.5 rounded-xl bg-surface-interactive-base/10 text-text-base text-14-medium hover:bg-surface-interactive-base/15 transition-colors"
                  style={{
                    opacity: heroAnimated() ? undefined : 0,
                    animation: heroAnimated()
                      ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 1.2s both"
                      : "none",
                  }}
                  onClick={retryInit}
                >
                  Retry
                </button>
              </>
            }
          >
            <h1
              class="text-center text-text-strong font-light tracking-tight leading-none whitespace-nowrap"
              style={{
                "font-size": "clamp(36px, 5vw, 56px)",
                opacity: heroAnimated() ? undefined : 0,
                animation: heroAnimated() ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards" : "none",
              }}
            >
              Let's get to know each other
            </h1>
            <p
              class="text-text-weak text-sm text-center max-w-xl leading-relaxed"
              style={{
                opacity: heroAnimated() ? undefined : 0,
                animation: heroAnimated() ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.45s both" : "none",
              }}
            >
              This is your Genesis session. Synergy is learning about your goals, workflow, and preferences so it can
              personalize how it helps you from here on.
            </p>
            <p
              class="text-text-weaker text-sm text-center max-w-lg leading-relaxed"
              style={{
                opacity: heroAnimated() ? undefined : 0,
                animation: heroAnimated() ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.8s both" : "none",
              }}
            >
              Talk naturally — share what you work on, what you want help with, or how you like to collaborate.
            </p>
            <div
              class="flex items-center gap-1.5"
              style={{
                opacity: heroAnimated() ? undefined : 0,
                animation: heroAnimated() ? "genesis-text-in 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) 1.2s both" : "none",
              }}
            >
              <span class="size-1 rounded-full bg-text-weaker/60 animate-pulse" />
              <span class="size-1 rounded-full bg-text-weaker/60 animate-pulse [animation-delay:200ms]" />
              <span class="size-1 rounded-full bg-text-weaker/60 animate-pulse [animation-delay:400ms]" />
            </div>
            <Show when={props.onSkip}>
              <button
                type="button"
                class="text-text-weaker/50 text-[13px] hover:text-text-weak transition-colors"
                style={{
                  opacity: heroAnimated() ? undefined : 0,
                  animation: heroAnimated() ? "genesis-text-in 1s cubic-bezier(0.2, 0.8, 0.2, 1) 2s both" : "none",
                }}
                onClick={() => props.onSkip?.()}
              >
                Skip
              </button>
            </Show>
          </Show>
        </div>
      </div>

      <div class="flex flex-col items-center w-full" style={{ height: "78vh", "margin-top": "8vh" }}>
        <Show when={hasVisibleMessages()}>
          <div
            class="shrink-0 flex items-center justify-center gap-2 py-4 transition-opacity duration-1000"
            classList={{
              "opacity-0": !hasVisibleMessages(),
              "opacity-100": hasVisibleMessages(),
            }}
          >
            {Array.from({ length: GENESIS_MAX_ROUNDS }).map((_, i) => {
              const capped = Math.min(completedRounds(), GENESIS_MAX_ROUNDS)
              return (
                <span
                  class="rounded-full transition-all duration-150 ease"
                  classList={{
                    "bg-text-weaker/40": i > capped,
                    "bg-text-base": i < capped,
                    "bg-text-strong": i === capped && capped < GENESIS_MAX_ROUNDS,
                  }}
                  style={{
                    width: i === capped && capped < GENESIS_MAX_ROUNDS ? "8px" : "5px",
                    height: i === capped && capped < GENESIS_MAX_ROUNDS ? "8px" : "5px",
                    "box-shadow":
                      i === capped && capped < GENESIS_MAX_ROUNDS
                        ? "0 0 0 3px color-mix(in srgb, var(--text-strong) 12%, transparent)"
                        : "none",
                  }}
                />
              )
            })}
          </div>
        </Show>
        <div class="relative flex-1 w-full max-w-2xl min-h-0">
          <div
            class="absolute inset-x-0 top-0 h-20 z-10 pointer-events-none"
            style={{ background: "linear-gradient(to bottom, var(--color-background-base), transparent)" }}
          />
          <div ref={scrollRef} class="h-full overflow-y-auto no-scrollbar flex flex-col">
            <div
              class="flex-1 flex flex-col justify-end transition-opacity duration-[2000ms] delay-500"
              classList={{
                "opacity-0": !hasVisibleMessages(),
                "opacity-100": hasVisibleMessages(),
              }}
            >
              <div class="px-6 py-8">
                <div class="space-y-6">
                  <div class="rounded-2xl border border-border-weak-base/60 bg-surface-raised-stronger-non-alpha px-4 py-3.5 shadow-sm">
                    <div class="flex items-center justify-between gap-3 pb-1.5">
                      <div class="text-11-medium uppercase tracking-[0.18em] text-text-weaker">Genesis</div>
                      <div class="text-11-medium text-text-weaker">{currentPhaseLabel()}</div>
                    </div>
                    <p class="text-13-regular text-text-weak leading-relaxed">
                      This first session helps Synergy understand your goals, workflow, and preferences so future help
                      can feel more relevant and proactive.
                    </p>
                  </div>
                  <For each={visibleMessages()}>
                    {(message) => {
                      const text = getTextForMessage(message.id)
                      return (
                        <div
                          class="group flex gap-3"
                          classList={{
                            "flex-row-reverse": message.role === "user",
                          }}
                        >
                          <Show when={message.role === "assistant"}>
                            <div class="shrink-0 size-7 rounded-lg bg-surface-interactive-base/10 flex items-center justify-center mt-1">
                              <Mark class="size-4" />
                            </div>
                          </Show>

                          <div
                            classList={{
                              "max-w-[85%]": true,
                              "rounded-2xl rounded-tr-sm px-4 py-3 bg-surface-raised-stronger-non-alpha text-text-base border border-border-weak-base/40":
                                message.role === "user",
                              "text-text-base pt-0.5": message.role === "assistant",
                            }}
                          >
                            <Show
                              when={message.role === "assistant"}
                              fallback={<p class="text-14-regular whitespace-pre-wrap break-words">{text()}</p>}
                            >
                              <Markdown text={text()} cacheKey={message.id} class="text-14-regular" />
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>

                  <Show when={status() === "busy" && visibleMessages().at(-1)?.role !== "assistant"}>
                    <div class="flex gap-3">
                      <div class="shrink-0 size-7 rounded-lg bg-surface-interactive-base/10 flex items-center justify-center mt-1">
                        <Mark class="size-4" />
                      </div>
                      <div class="flex items-center py-3">
                        <span class="text-13-regular text-text-weak animate-pulse">{busyLabel()}</span>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          class="shrink-0 w-full max-w-2xl px-6 pt-4 pb-6 transition-opacity duration-[2000ms] delay-500"
          classList={{
            "opacity-0 pointer-events-none": !hasVisibleMessages(),
            "opacity-100": hasVisibleMessages(),
          }}
        >
          <div class="space-y-3">
            <div class="flex flex-wrap gap-2">
              <For each={currentSuggestions()}>
                {(suggestion) => (
                  <button
                    type="button"
                    class="rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha px-3 py-1.5 text-12-regular text-text-weak transition-colors hover:border-border-base hover:text-text-base"
                    onClick={() => {
                      if (status() === "busy") return
                      setInputText(suggestion)
                      requestAnimationFrame(() => {
                        if (!textareaRef) return
                        textareaRef.focus()
                        textareaRef.style.height = "auto"
                        textareaRef.style.height = textareaRef.scrollHeight + "px"
                      })
                    }}
                  >
                    {suggestion}
                  </button>
                )}
              </For>
            </div>
            <div
              class="relative flex items-end gap-2 bg-surface-raised-stronger-non-alpha border border-border-base transition-shadow focus-within:shadow-xs-border px-5 py-3"
              style={{ "border-radius": "24px" }}
            >
              <textarea
                ref={textareaRef}
                value={inputText()}
                onInput={(e) => {
                  setInputText(e.currentTarget.value)
                  e.currentTarget.style.height = "auto"
                  e.currentTarget.style.height = e.currentTarget.scrollHeight + "px"
                }}
                onKeyDown={handleKeyDown}
                placeholder="Share your background, goals, or how you want Synergy to help"
                rows={1}
                class="flex-1 resize-none bg-transparent text-14-regular text-text-strong placeholder:text-text-weaker outline-none max-h-32 min-h-[24px] py-0.5"
                disabled={status() === "busy"}
              />
              <button
                type="button"
                class="shrink-0 size-8 rounded-full flex items-center justify-center transition-all duration-150"
                classList={{
                  "text-text-weaker cursor-not-allowed": !inputText().trim() || status() === "busy",
                  "text-text-base bg-white/10 hover:bg-white/15 active:scale-95":
                    !!inputText().trim() && status() !== "busy",
                }}
                disabled={!inputText().trim() || status() === "busy"}
                onClick={handleSend}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3.5 8L12.5 8M8 3.5L12.5 8L8 12.5"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
            <div class="px-1 text-11-medium text-text-weaker flex items-center justify-between gap-3">
              <span>{shortcutHint()}</span>
              <span>Talk naturally — this session shapes your setup.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export async function cleanupGenesisSession(baseUrl: string, fetchFn?: typeof fetch) {
  const client = createSynergyClient({
    baseUrl,
    fetch: fetchFn,
    directory: "global",
    throwOnError: false,
  })
  await client.channel.genesis.reset().catch(() => {})
}
