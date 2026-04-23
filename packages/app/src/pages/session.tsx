import { Show, Match, Switch, createMemo, createEffect, createSignal, createResource, on, onCleanup } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { useFile, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"

import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"

import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { DateTime } from "luxon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useCommand } from "@/context/command"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { UserMessage, AssistantMessage, Message } from "@ericsanchezok/synergy-sdk"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { getDraggableId } from "@/utils/solid-dnd"
import { usePermission } from "@/context/permission"
import { SessionReviewTab } from "@/components/session"

import { navMark, navParams } from "@/utils/perf"
import { same } from "@/utils/same"
import { isGlobalScope } from "@/utils/scope"
import { isHolosSession } from "@/utils/session"

import { useSessionCommands } from "@/components/session/commands"
import { SessionConversation } from "@/components/session/conversation"
import { HolosConversation, HolosGreeting } from "@/components/session/holos-conversation"
import { HolosPromptInput } from "@/components/session/holos-prompt-input"
import { PromptDock } from "@/components/session/prompt-dock"
import { TabsPanel } from "@/components/session/tabs-panel"
import { TerminalPanel } from "@/components/session/terminal-panel"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

const handoff = {
  prompt: "",
  terminals: [] as string[],
  files: {} as Record<string, SelectedLineRange | null>,
}

export default function Page() {
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const terminal = useTerminal()
  const dialog = useDialog()
  const command = useCommand()
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const sdk = useSDK()
  const prompt = usePrompt()
  const permission = usePermission()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey()))
  const view = createMemo(() => layout.view(sessionKey()))

  if (import.meta.env.DEV) {
    createEffect(
      on(
        () => [params.dir, params.id] as const,
        ([dir, id], prev) => {
          if (!id) return
          navParams({ dir, from: prev?.[1], to: id })
        },
      ),
    )

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!prompt.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:prompt-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!terminal.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:terminal-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (!file.ready()) return
      navMark({ dir: params.dir, to: id, name: "storage:file-view-ready" })
    })

    createEffect(() => {
      const id = params.id
      if (!id) return
      if (sync.data.message[id] === undefined) return
      navMark({ dir: params.dir, to: id, name: "session:data-ready" })
    })
  }

  const isDesktop = () => layout.isDesktop()

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().open(next)

    const path = file.pathFromTab(next)
    if (path) file.load(path)
  }

  createEffect(() => {
    const active = tabs().active()
    if (!active) return

    const path = file.pathFromTab(active)
    if (path) file.load(path)
  })

  createEffect(() => {
    const current = tabs().all()
    if (current.length === 0) return

    const next = normalizeTabs(current)
    if (same(current, next)) return

    tabs().setAll(next)

    const active = tabs().active()
    if (!active) return
    if (!active.startsWith("file://")) return

    const normalized = normalizeTab(active)
    if (active === normalized) return
    tabs().setActive(normalized)
  })

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
    activeTerminalDraggable: undefined as string | undefined,
    expanded: {} as Record<string, boolean>,
    messageId: undefined as string | undefined,
    turnStart: 0,
    mobileTab: "session" as "session" | "review",
    newSessionWorktree: "main",
    promptHeight: 0,
    holosReplyToMessageId: undefined as string | undefined,
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const reviewCount = createMemo(() => info()?.summary?.files ?? 0)
  const hasReview = createMemo(() => reviewCount() > 0)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const holosReplyToMessage = createMemo(() => {
    const replyToMessageId = store.holosReplyToMessageId
    if (!replyToMessageId) return undefined
    return messages().find((message) => message.id === replyToMessageId)
  })
  const [resolvingHome, setResolvingHome] = createSignal(false)
  const isNewSession = createMemo(() => {
    if (resolvingHome()) return false
    if (!params.id) return true
    if (isGlobalScope(sdk.directory) && messages().length === 0) return true
    return false
  })
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const emptyUserMessages: UserMessage[] = []
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user" && !(m as UserMessage).metadata?.synthetic) as UserMessage[],
    emptyUserMessages,
  )
  const visibleUserMessages = createMemo(() => {
    const revert = revertMessageID()
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  }, emptyUserMessages)
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))
  const cortexRunning = createMemo(() => {
    const id = params.id
    if (!id) return 0
    return sync.data.cortex.filter((t) => t.parentSessionID === id && t.status === "running").length
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        if (msg.agent) local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
      },
    ),
  )

  const renderedUserMessages = createMemo(() => {
    const msgs = visibleUserMessages()
    const start = store.turnStart
    if (start <= 0) return msgs
    if (start >= msgs.length) return emptyUserMessages
    return msgs.slice(start)
  }, emptyUserMessages)

  const emptyTimeline: Message[] = []

  const timeline = createMemo(() => {
    const turns = renderedUserMessages() as Message[]
    const firstID = turns[0]?.id
    const mailbox: Message[] = []
    for (const msg of messages()) {
      if (msg.role !== "assistant") continue
      if (!(msg as AssistantMessage).metadata?.mailbox) continue
      if (firstID && msg.id < firstID) continue
      mailbox.push(msg)
    }
    if (mailbox.length === 0) return turns.length > 0 ? turns : emptyTimeline
    const result = [...turns, ...mailbox]
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  }, emptyTimeline)

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const scope = sync.scope
    if (scope && sync.data.path.directory !== scope.worktree) return sync.data.path.directory
    return "main"
  })

  const scopeRoot = createMemo(() => sync.scope?.worktree ?? sync.data.path.directory)
  const scopeName = createMemo(() => getFilename(scopeRoot()))
  const branch = createMemo(() => sync.data.vcs?.branch)
  const lastModified = createMemo(() => {
    const scope = sync.scope
    if (!scope) return undefined
    return DateTime.fromMillis(scope.time.updated ?? scope.time.created).toRelative()
  })

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })
  const setActiveMessage = (message: UserMessage | undefined) => {
    setStore("messageId", message?.id)
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = activeMessage()
    const currentIndex = current ? msgs.findIndex((m) => m.id === current.id) : -1

    let targetIndex: number
    if (currentIndex === -1) {
      targetIndex = offset > 0 ? 0 : msgs.length - 1
    } else {
      targetIndex = currentIndex + offset
    }

    if (targetIndex < 0 || targetIndex >= msgs.length) return

    scrollToMessage(msgs[targetIndex], "auto")
  }

  const diffs = createMemo(() => (params.id ? (sync.data.session_diff[params.id] ?? []) : []))
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasReview()) return true
    return sync.data.session_diff[id] !== undefined
  })

  const idle = { type: "idle" as const }
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined

  const hydratedSessions = new Set<string>()
  const initializedSessions = new Set<string>()

  createEffect(
    on(
      () => params.id,
      (id, prevId) => {
        if (prevId && prevId !== id) {
          sync.evictSession(prevId)
          hydratedSessions.delete(prevId)
          initializedSessions.delete(prevId)
        }
        if (id) sync.session.sync(id)
      },
    ),
  )

  createEffect(() => {
    if (!sdk.connected()) return
    const id = params.id
    if (id) sync.session.sync(id)
  })

  createEffect(() => {
    if (params.id) return
    if (!isGlobalScope(sdk.directory)) return
    setResolvingHome(true)
    sdk.client.channel.app.session().then((res) => {
      const session = res.data
      if (session) {
        navigate(`/${params.dir}/session/${session.id}`, { replace: true })
      }
      setResolvingHome(false)
    })
  })

  createEffect(() => {
    if (!layout.terminal.opened()) return
    if (!terminal.ready()) return
    if (terminal.all().length !== 0) return
    terminal.new()
  })

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
          clearHash()
        }
      },
      { defer: true },
    ),
  )

  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? idle)

  const currentSession = createMemo(() => sync.data.session.find((s) => s.id === params.id))
  const parentSession = createMemo(() => {
    const current = currentSession()
    if (!current?.parentID) return undefined
    return sync.data.session.find((s) => s.id === current.parentID)
  })
  const parentHolosContactId = createMemo(() => {
    const session = parentSession()
    return isHolosSession(session) ? session.endpoint.agentId : undefined
  })
  const [parentHolosContact] = createResource(parentHolosContactId, async (contactId) => {
    const res = await sdk.client.holos.contact.get({ id: contactId })
    return res.data
  })
  const backPath = createMemo(() => {
    if (parentSession()) return undefined
    const from = (location.state as { from?: string } | undefined)?.from
    return from ?? undefined
  })

  const isHolosConversation = createMemo(() => isHolosSession(currentSession()))
  const holosContactId = createMemo(() => {
    const session = currentSession()
    return isHolosSession(session) ? session.endpoint.agentId : undefined
  })
  const [holosContact] = createResource(holosContactId, async (contactId) => {
    const res = await sdk.client.holos.contact.get({ id: contactId })
    return res.data
  })
  const [myProfile] = createResource(isHolosConversation, async (isHolos) => {
    if (!isHolos) return undefined
    const res = await sdk.client.holos.profile.get()
    return res.data
  })
  const holosReplyMappingKey = createMemo(() => {
    if (!isHolosConversation() || !params.id) return undefined
    const msgCount = messages().length
    return { sessionId: params.id, msgCount }
  })
  const [holosReplyMappings] = createResource(holosReplyMappingKey, async (key) => {
    const res = await sdk.client.holos.friendReply.list({ sessionId: key.sessionId })
    return res.data ?? []
  })
  const holosBranchMap = createMemo(() => {
    const result: Record<string, string> = {}
    for (const mapping of holosReplyMappings() ?? []) {
      result[mapping.triggerMessageId] = mapping.subSessionId
    }
    return result
  })

  createEffect(
    on(
      () => params.id,
      () => {
        setStore("messageId", undefined)
        setStore("expanded", {})
        setStore("holosReplyToMessageId", undefined)
      },
      { defer: true },
    ),
  )

  const isStepsExpanded = (id: string) => store.expanded[id] ?? true

  const toggleStepsExpanded = (id: string) => {
    setStore("expanded", id, !isStepsExpanded(id))
  }

  useSessionCommands({
    command,
    sdk,
    sync,
    local,
    dialog,
    terminal,
    layout,
    prompt,
    permission,
    navigate,
    routeParams: params as unknown as { dir: string; id?: string },
    info,
    status,
    activeMessage,
    visibleUserMessages,
    userMessages,
    setActiveMessage,
    isExpanded: isStepsExpanded,
    setExpanded: (id, open) => setStore("expanded", id, open),
    navigateMessageByOffset,
    isWorking: () => status().type !== "idle",
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    const activeElement = document.activeElement as HTMLElement | undefined
    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement.tagName) || activeElement.isContentEditable
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      inputRef?.focus()
    }
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const currentTabs = tabs().all()
      const fromIndex = currentTabs?.indexOf(draggable.id.toString())
      const toIndex = currentTabs?.indexOf(droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== undefined) {
        tabs().move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const handleTerminalDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeTerminalDraggable", id)
  }

  const handleTerminalDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const terminals = terminal.all()
      const fromIndex = terminals.findIndex((t: LocalPTY) => t.id === draggable.id.toString())
      const toIndex = terminals.findIndex((t: LocalPTY) => t.id === droppable.id.toString())
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        terminal.move(draggable.id.toString(), toIndex)
      }
    }
  }

  const handleTerminalDragEnd = () => {
    setStore("activeTerminalDraggable", undefined)
  }

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context"),
  )

  const reviewTab = createMemo(() => hasReview() || tabs().active() === "review")
  const mobileReview = createMemo(() => !isDesktop() && hasReview() && store.mobileTab === "review")

  const showTabs = createMemo(() => layout.review.opened() && (hasReview() || tabs().all().length > 0 || contextOpen()))

  const activeTab = createMemo(() => {
    const active = tabs().active()
    if (active) return active
    if (reviewTab()) return "review"

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    return "review"
  })

  createEffect(() => {
    if (!layout.ready()) return
    if (tabs().active()) return
    if (!hasReview() && openedTabs().length === 0 && !contextOpen()) return
    tabs().setActive(activeTab())
  })

  createEffect(() => {
    const id = params.id
    if (!id) return
    if (!hasReview()) return

    const wants = isDesktop() ? layout.review.opened() && activeTab() === "review" : store.mobileTab === "review"
    if (!wants) return
    if (diffsReady()) return

    sync.session.diff(id)
  })

  const isWorking = createMemo(() => status().type !== "idle")
  const autoScroll = createAutoScroll({
    working: isWorking,
  })

  const [scrolledUp, setScrolledUp] = createSignal(false)

  let scrollSpyFrame: number | undefined
  let scrollSpyTarget: HTMLDivElement | undefined
  let initScrollFrame: number | undefined

  const anchor = (id: string) => `message-${id}`

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
  }

  const turnInit = 20
  const turnBatch = 20

  createEffect(
    on(
      () => [params.id, messagesReady()] as const,
      ([id, ready]) => {
        setStore("turnStart", 0)
        if (!id || !ready) return

        if (hydratedSessions.has(id)) return
        hydratedSessions.add(id)

        const len = visibleUserMessages().length
        const start = len > turnInit ? len - turnInit : 0
        setStore("turnStart", start)
      },
      { defer: true },
    ),
  )

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === store.promptHeight) return

      const el = scroller
      const stick = el ? el.scrollHeight - el.clientHeight - el.scrollTop < 10 : false

      setStore("promptHeight", next)

      if (stick && el) {
        requestAnimationFrame(() => {
          el.scrollTo({ top: el.scrollHeight, behavior: "auto" })
        })
      }
    },
  )

  const updateHash = (id: string) => {
    window.history.replaceState(null, "", `#${anchor(id)}`)
  }

  const clearHash = () => {
    if (!window.location.hash) return
    window.history.replaceState(null, "", window.location.pathname + window.location.search)
  }

  const scrollToMessage = (message: UserMessage, behavior: ScrollBehavior = "smooth") => {
    setActiveMessage(message)

    const msgs = visibleUserMessages()
    const index = msgs.findIndex((m) => m.id === message.id)
    if (index !== -1 && index < store.turnStart) {
      setStore("turnStart", index)

      requestAnimationFrame(() => {
        const el = document.getElementById(anchor(message.id))
        if (el) el.scrollIntoView({ behavior, block: "start" })
      })

      updateHash(message.id)
      return
    }

    const el = document.getElementById(anchor(message.id))
    if (el) el.scrollIntoView({ behavior, block: "start" })
    updateHash(message.id)
  }

  const scheduleScrollSpy = (container: HTMLDivElement) => {
    scrollSpyTarget = container
    if (scrollSpyFrame !== undefined) return

    scrollSpyFrame = requestAnimationFrame(() => {
      scrollSpyFrame = undefined

      const target = scrollSpyTarget
      scrollSpyTarget = undefined
      if (!target) return

      const nodes = target.querySelectorAll<HTMLElement>("[data-message-id]")
      const cutoff = target.scrollTop + 100
      let id: string | undefined

      for (const node of nodes) {
        const next = node.dataset.messageId
        if (!next) continue
        if (node.offsetTop > cutoff) break
        id = next
      }

      if (!id) return
      if (id === store.messageId) return

      setStore("messageId", id)
    })
  }

  createEffect(
    on(
      () => [params.id, messagesReady()] as const,
      ([sessionID, ready]) => {
        if (initScrollFrame !== undefined) {
          cancelAnimationFrame(initScrollFrame)
          initScrollFrame = undefined
        }

        if (!sessionID || !ready) return

        if (initializedSessions.has(sessionID)) return
        initializedSessions.add(sessionID)

        initScrollFrame = requestAnimationFrame(() => {
          initScrollFrame = undefined

          const hash = window.location.hash.slice(1)
          if (!hash) {
            autoScroll.forceScrollToBottom()
            return
          }

          const hashTarget = document.getElementById(hash)
          if (hashTarget) {
            hashTarget.scrollIntoView({ behavior: "auto", block: "start" })
            return
          }

          const match = hash.match(/^message-(.+)$/)
          if (match) {
            const anyMessage = messages().find((message) => message.id === match[1])
            if (anyMessage) {
              requestAnimationFrame(() => {
                const el = document.getElementById(hash)
                if (el) el.scrollIntoView({ behavior: "auto", block: "center" })
              })
              return
            }

            const msg = visibleUserMessages().find((m) => m.id === match[1])
            if (msg) {
              scrollToMessage(msg, "auto")
              return
            }
          }

          autoScroll.forceScrollToBottom()
        })
      },
    ),
  )

  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "attachment") return `[file:${part.filename}]`
        if (part.type === "note") return `[note:${part.title || "Untitled"}]`
        if (part.type === "session") return `[session:${part.title || "Untitled"}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    handoff.prompt = previewPrompt()
  })

  createEffect(() => {
    if (!terminal.ready()) return
    handoff.terminals = terminal.all().map((t) => t.title)
  })

  createEffect(() => {
    if (!file.ready()) return
    handoff.files = Object.fromEntries(
      tabs()
        .all()
        .flatMap((tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return []
          return [[path, file.selectedLines(path) ?? null] as const]
        }),
    )
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    if (scrollSpyFrame !== undefined) cancelAnimationFrame(scrollSpyFrame)
    if (initScrollFrame !== undefined) cancelAnimationFrame(initScrollFrame)
    hydratedSessions.clear()
    initializedSessions.clear()
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Mobile tab bar */}
        <Show when={!isDesktop() && hasReview()}>
          <Tabs class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="w-1/2"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                Session
              </Tabs.Trigger>
              <Tabs.Trigger
                value="review"
                class="w-1/2 !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "review")}
              >
                {reviewCount()} Files Changed
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        {/* Session panel */}
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger": true,
            "flex-1 md:flex-none py-6 md:py-3": true,
          }}
          style={{
            width: isDesktop() && showTabs() ? `${layout.session.width()}px` : "100%",
            "--prompt-height": store.promptHeight ? `${store.promptHeight}px` : undefined,
          }}
        >
          <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
            <Show when={isHolosSession(parentSession())}>
              <div class="shrink-0 px-4 md:px-6 pb-2">
                <button
                  type="button"
                  class="w-full md:max-w-200 md:mx-auto flex items-center justify-between gap-3 rounded-[22px] border border-border-base bg-surface-raised-stronger-non-alpha px-4 py-3 text-left shadow-sm hover:bg-surface-raised-base-hover active:scale-[0.995] transition-all duration-150"
                  onClick={() => navigate(`/${params.dir}/session/${parentSession()!.id}`)}
                >
                  <div class="min-w-0 flex items-center gap-3">
                    <div class="size-9 rounded-full bg-surface-brand-base/12 border border-border-base flex items-center justify-center shrink-0">
                      <Icon name="arrow-left" size="small" />
                    </div>
                    <div class="min-w-0">
                      <div class="text-12-medium text-text-weak">Back to Holos conversation</div>
                      <div class="text-14-medium text-text-strong truncate">
                        {parentHolosContact()?.name ?? parentSession()?.title ?? "Return to Holos conversation"}
                      </div>
                    </div>
                  </div>
                  <div class="hidden md:flex items-center gap-1.5 text-11-medium text-text-subtle shrink-0">
                    <Icon name="git-branch" size="small" />
                    <span>Holos branch</span>
                  </div>
                </button>
              </div>
            </Show>
            <div class="flex-1 min-h-0 overflow-hidden">
              <Switch>
                <Match when={isHolosConversation() && holosContact()}>
                  <HolosConversation
                    sessionID={params.id!}
                    contactName={holosContact()!.name}
                    contactBio={holosContact()!.bio}
                    myName={myProfile()?.profile?.name ?? "Me"}
                    messages={messages}
                    branchMap={holosBranchMap}
                    onOpenBranch={(subSessionId, triggerMessageId) =>
                      navigate(`/${params.dir}/session/${subSessionId}#message-${triggerMessageId}`, {
                        state: { from: window.location.pathname + window.location.search + window.location.hash },
                      })
                    }
                    onReplyToMessage={(messageId: string) => {
                      setStore("holosReplyToMessageId", messageId)
                      requestAnimationFrame(() => {
                        const textarea = document.querySelector<HTMLTextAreaElement>("[data-holos-input='true']")
                        textarea?.focus()
                      })
                    }}
                    autoScroll={autoScroll}
                    setScrollRef={setScrollRef}
                  />
                </Match>
                <Match when={!isNewSession()}>
                  <Show when={activeMessage() || timeline().length > 0}>
                    <Show
                      when={!mobileReview()}
                      fallback={
                        <div class="relative h-full overflow-hidden">
                          <Show
                            when={diffsReady()}
                            fallback={<div class="px-4 py-4 text-text-weak">Loading changes...</div>}
                          >
                            <SessionReviewTab
                              diffs={diffs}
                              view={view}
                              diffStyle="unified"
                              onViewFile={(path) => {
                                const value = file.tab(path)
                                tabs().open(value)
                                file.load(path)
                              }}
                              classes={{
                                root: "pb-[calc(var(--prompt-height,8rem)+32px)]",
                                header: "px-4",
                                container: "px-4",
                              }}
                            />
                          </Show>
                        </div>
                      }
                    >
                      <SessionConversation
                        sessionID={params.id!}
                        paramsDir={params.dir!}
                        timeline={timeline}
                        visibleUserMessages={visibleUserMessages}
                        lastUserMessage={lastUserMessage}
                        activeMessage={activeMessage}
                        cortexRunning={cortexRunning}
                        expanded={store.expanded}
                        onToggleExpanded={toggleStepsExpanded}
                        showTabs={showTabs}
                        isWorking={isWorking}
                        turnStart={store.turnStart}
                        turnBatch={turnBatch}
                        onSetTurnStart={(start) => setStore("turnStart", start)}
                        historyMore={historyMore}
                        historyLoading={historyLoading}
                        onLoadMore={() => {
                          const id = params.id
                          if (!id) return
                          setStore("turnStart", 0)
                          sync.session.history.loadMore(id)
                        }}
                        scrolledUp={scrolledUp}
                        onScrolledUpChange={setScrolledUp}
                        autoScroll={autoScroll}
                        onClearHash={clearHash}
                        onScheduleScrollSpy={scheduleScrollSpy}
                        setScrollRef={setScrollRef}
                        isDesktop={isDesktop}
                        scrollToMessage={scrollToMessage}
                        anchor={anchor}
                      />
                    </Show>
                  </Show>
                </Match>
                <Match when={true}>{null}</Match>
              </Switch>
            </div>
          </div>

          <Show
            when={isHolosConversation() && holosContact()}
            fallback={
              <PromptDock
                ref={(el) => (promptDock = el)}
                inputRef={(el) => {
                  inputRef = el
                }}
                isNewSession={isNewSession}
                showTabs={showTabs}
                isGlobal={isGlobalScope(sdk.directory)}
                sessionID={params.id}
                prompt={prompt}
                sync={sync}
                sdk={sdk}
                navigate={(id) => navigate(`/${params.dir}/session/${id}`)}
                handoffPrompt={handoff.prompt}
                parentSession={parentSession}
                backPath={backPath}
                newSessionWorktree={newSessionWorktree}
                onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                scopeName={scopeName}
                branch={branch}
                lastModified={lastModified}
              />
            }
          >
            <div
              ref={(el) => (promptDock = el)}
              classList={{
                "absolute inset-x-0 bottom-0 flex flex-col justify-center items-center z-50 px-4 md:px-0 pointer-events-none": true,
                "pt-12 pb-4 bg-gradient-to-t from-background-stronger via-background-stronger to-transparent":
                  messages().length > 0,
                "pb-4": messages().length === 0,
              }}
              style={{
                transform: messages().length === 0 ? "translateY(-35vh)" : "translateY(0)",
                transition: "transform 400ms ease-out",
              }}
            >
              <div class="w-full md:px-6 md:max-w-200 pointer-events-auto">
                <Show when={messages().length === 0}>
                  <HolosGreeting contactName={holosContact()!.name} />
                </Show>
                <HolosPromptInput
                  contactId={holosContact()!.id}
                  contactName={holosContact()!.name}
                  sessionId={params.id!}
                  replyToMessage={holosReplyToMessage()}
                  replyToParts={holosReplyToMessage() ? (sync.data.part[holosReplyToMessage()!.id] ?? []) : undefined}
                  onCancelReply={() => setStore("holosReplyToMessageId", undefined)}
                />
              </div>
            </div>
          </Show>

          <Show when={isDesktop() && showTabs()}>
            <ResizeHandle
              direction="horizontal"
              size={layout.session.width()}
              min={450}
              max={window.innerWidth * 0.45}
              onResize={layout.session.resize}
            />
          </Show>
        </div>

        {/* Desktop tabs panel */}
        <Show when={isDesktop() && showTabs()}>
          <TabsPanel
            activeTab={activeTab}
            openTab={openTab}
            tabs={tabs}
            view={view}
            layout={layout}
            file={file}
            prompt={prompt}
            command={command}
            dialog={dialog}
            reviewTab={reviewTab}
            contextOpen={contextOpen}
            openedTabs={openedTabs}
            info={info}
            diffs={diffs}
            diffsReady={diffsReady}
            messages={messages}
            visibleUserMessages={visibleUserMessages}
            handleDragStart={handleDragStart}
            handleDragOver={handleDragOver}
            handleDragEnd={handleDragEnd}
            activeDraggable={store.activeDraggable}
            handoffFiles={handoff.files}
          />
        </Show>
      </div>

      <Show when={isDesktop() && layout.terminal.opened()}>
        <TerminalPanel
          layout={layout}
          terminal={terminal}
          command={command}
          handoffTerminals={handoff.terminals}
          handleTerminalDragStart={handleTerminalDragStart}
          handleTerminalDragOver={handleTerminalDragOver}
          handleTerminalDragEnd={handleTerminalDragEnd}
          activeTerminalDraggable={store.activeTerminalDraggable}
        />
      </Show>
    </div>
  )
}
