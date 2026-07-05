import { Show, Match, Switch, createMemo, createEffect, createSignal, on, onCleanup } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { useFile, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { hasSpecialUserMessageRenderer } from "@ericsanchezok/synergy-ui/special-user-message"

import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { WORKSPACE_SESSION_MIN_WIDTH } from "@/context/workspace-layout"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"

import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
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
import { SessionReviewTab } from "@/components/session"

import { navMark, navParams } from "@/utils/perf"
import { same } from "@/utils/same"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"

import { useSessionCommands } from "@/components/session/commands"
import { useSessionMeta } from "@/composables/use-session-meta"
import { SessionConversation } from "@/components/session/conversation"
import { PromptDock } from "@/components/session/prompt-dock"
import { TabsPanel } from "@/components/session/tabs-panel"
import { WorkbenchPanelsProvider, useWorkbenchPanels } from "@/context/workbench-panels"
import { WorkspaceNotesTool } from "@/components/workspace/tool-notes"
import { WorkspaceBrowserTool } from "@/components/workspace/tool-browser"
import { WorkspaceTerminalTool } from "@/components/workspace/tool-terminal"
import { WorkbenchSurface } from "@/components/session/workbench-surface"
import { SessionTopBar } from "@/components/top-bar/session-top-bar"
import { blueprintNoteCreateFocusRequest } from "@/components/note/blueprint-note-focus"
import {
  defaultNewSessionWorkspaceSelection,
  normalizePathForCompare,
  type NewSessionWorkspaceSelection,
} from "@/components/session/worktree-session"
import { WorktreeTransitionContent } from "@/components/session/worktree-transition-dialog"
import { worktreeTransition, clearWorktreeTransition } from "@/components/session/worktree-progress-signals"
import { RollbackBanner } from "@/components/session/rollback-banner"
import { DialogRewindConfirm } from "@/components/session/dialog-rewind-confirm"

const handoff = {
  prompt: "",
  terminals: [] as string[],
  files: {} as Record<string, SelectedLineRange | null>,
}

export default function Page() {
  return (
    <WorkbenchPanelsProvider>
      <SessionPageContent />
    </WorkbenchPanelsProvider>
  )
}

function SessionPageContent() {
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
  const workbench = useWorkbenchPanels()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey()))
  const sideSurface = createMemo(() => layout.surface(sessionKey(), "side"))
  const bottomSurface = createMemo(() => layout.surface(sessionKey(), "bottom"))
  const sideOpen = createMemo(() => sideSurface().opened())
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
    messageId: undefined as string | undefined,
    turnStart: 0,
    mobileTab: "session" as "session" | "review",
    newSessionWorkspaceSelection: undefined as NewSessionWorkspaceSelection | undefined,
    promptHeight: 0,
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const reviewCount = createMemo(() => info()?.summary?.files ?? 0)
  const hasReview = createMemo(() => reviewCount() > 0)
  const rollback = createMemo(() => info()?.history?.rollback)
  const rollbackActive = createMemo(() => rollback() !== undefined)
  const [rollbackDismissed, setRollbackDismissed] = createSignal(false)
  const showRollbackBanner = createMemo(() => rollback() !== undefined && !rollbackDismissed())
  const hiddenMessageIDs = createMemo(() => {
    const rb = rollback()
    if (!rb) return new Set<string>()
    // Use cutMessageID when available, fallback to droppedMessageIDs
    if (rb.cutMessageID) return new Set([rb.cutMessageID])
    return new Set(rb.droppedMessageIDs ?? [])
  })
  const messages = createMemo(() => {
    const raw = (params.id ? (sync.data.message[params.id] ?? []) : []) ?? []
    const hidden = hiddenMessageIDs()
    if (hidden.size === 0) return raw
    return raw.filter((message) => !hidden.has(message.id))
  })
  const isNewSession = createMemo(() => {
    if (!params.id) return true
    if (isHomeScope(sdk.scopeKey) && (messages()?.length ?? 0) === 0) return true
    return false
  })
  const openRewindConfirm = (message: UserMessage) => {
    const targetMsg = message
    const sessionID = params.id
    dialog.push(() => (
      <DialogRewindConfirm
        cutMessage={targetMsg}
        allMessages={messages().filter((m) => m.role === "user" || m.role === "assistant")}
        partsByMessage={sync.data.part}
        filesByMessage={{}}
        onRewind={async (cutMessageID, restoreFiles) => {
          if (!sessionID) return
          if (status().type !== "idle") {
            await sdk.client.session.abort({ sessionID }).catch(() => {})
          }
          await sdk.client.session.rollback({ sessionID, cutMessageID })
          if (restoreFiles) {
            const rb = rollback()
            if (rb) {
              await sdk.client.session.files.restore({ sessionID, rollbackID: rb.id }).catch(() => {})
            }
          }
          setActiveMessage(userMessages().findLast((x) => x.id < cutMessageID))
        }}
      />
    ))
  }
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
  // ── Root message derivation layer ───────────────────────────────────
  // Replaces old isSessionIdentityAnchor / isGuidedContextUserMessage / synthetic metadata
  // heuristics with orthogonal isRoot/visible/rootID/origin fields.
  /** @deprecated Use inline empty arrays or nullish coalescing. */
  const emptyUserMessages: UserMessage[] = []
  const rootMessages = createMemo(
    () =>
      messages().filter((m) => {
        if (m.role !== "user") return false
        const user = m as UserMessage
        // Use new isRoot field when available; fall back to old metadata heuristics
        if (user.isRoot !== undefined) return user.isRoot === true
        return user.metadata?.noReply !== true && !user.metadata?.guided && !user.metadata?.synthetic
      }) as UserMessage[],
    emptyUserMessages,
  )
  const visibleRoots = createMemo(() => rootMessages().filter((m) => m.visible !== false), emptyUserMessages)
  const lastRoot = createMemo(() => rootMessages().at(-1))
  // visibleRoots for navigation/timeline (deprecated old names kept for compatibility)
  const visibleUserMessages = visibleRoots
  // userMessages — kept for commands hook compatibility
  const userMessages = visibleRoots
  // renderableUserMessages — kept for compatibility, mirror visibleRoots
  const renderableUserMessages = createMemo(
    () =>
      messages().filter((m) => {
        if (m.role !== "user") return false
        const user = m as UserMessage
        if (user.isRoot !== undefined) return user.isRoot === true && user.visible !== false
        return !user.metadata?.synthetic || hasSpecialUserMessageRenderer(user)
      }) as UserMessage[],
    emptyUserMessages,
  )
  const lastUserMessage = lastRoot
  const lastRenderableUserMessage = createMemo(() => renderableUserMessages().at(-1))
  const selectableAgentNames = createMemo(() => new Set(local.agent.list().map((agent) => agent.name)))
  // Composer agent/model inheritance: use lastRoot instead of lastUserMessage
  createEffect(
    on(
      () => [lastRoot()?.id, lastRoot()?.agent, lastRoot()?.model, selectableAgentNames()] as const,
      () => {
        const msg = lastRoot()
        if (!msg) return
        if (msg.agent && selectableAgentNames().has(msg.agent)) local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model)
      },
    ),
  )

  const renderedUserMessages = createMemo(() => {
    const msgs = visibleRoots()
    if (!msgs) return emptyUserMessages
    const start = store.turnStart
    if (start <= 0) return msgs
    if (start >= msgs.length) return emptyUserMessages
    return msgs.slice(start) as UserMessage[]
  }, emptyUserMessages)

  const renderedConversationUserMessages = createMemo(() => {
    const firstID = renderedUserMessages()[0]?.id
    const msgs = renderableUserMessages()
    if (!firstID) return msgs
    return msgs.filter((message) => message.id >= firstID)
  }, emptyUserMessages)

  /** @deprecated Use inline empty arrays or nullish coalescing. */
  const emptyTimeline: Message[] = []
  const isActionCommandMessage = (message: Message) => {
    const metadata = message.metadata as
      | { command?: { kind?: string; promptVisible?: boolean }; promptVisible?: boolean }
      | undefined
    return metadata?.command?.kind === "action" && metadata.promptVisible === false
  }

  const mergeTimelineMessages = (items: Message[]) => {
    const seen = new Set<string>()
    const result: Message[] = []
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      result.push(item)
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  }

  const pendingTimeline = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return [] as import("@ericsanchezok/synergy-sdk/client").SessionInboxItem[]
    const inbox = sync.data.inbox[sessionID]
    if (!inbox || inbox.length === 0) return []
    return inbox
      .filter((item) => item.mode === "task" || item.mode === "steer")
      .filter((item) => item.message?.origin?.type === "user")
  })

  const timeline = createMemo(() => {
    const turns = renderedConversationUserMessages() as Message[]
    const firstID = renderedUserMessages()[0]?.id ?? turns[0]?.id
    const mailbox: Message[] = []
    const actionCommands: Message[] = []
    for (const msg of messages()) {
      if (isActionCommandMessage(msg)) {
        if (!firstID || msg.id >= firstID) actionCommands.push(msg)
        continue
      }
      if (msg.role !== "assistant") continue
      if (!(msg as AssistantMessage).metadata?.mailbox) continue
      if (firstID && msg.id < firstID) continue
      mailbox.push(msg)
    }
    if ((!turns || turns.length === 0) && actionCommands.length === 0) return emptyTimeline
    if (mailbox.length === 0 && actionCommands.length === 0) return turns
    return mergeTimelineMessages([...turns, ...mailbox, ...actionCommands])
  }, emptyTimeline)

  const scopeRoot = createMemo(() => sync.scope?.worktree ?? sync.data.path.directory)
  const newSessionWorkspaceSelection = createMemo(() =>
    defaultNewSessionWorkspaceSelection({
      selected: store.newSessionWorkspaceSelection,
      currentDirectory: sync.data.path.directory,
      canonicalDirectory: scopeRoot(),
    }),
  )
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
    if (!msgs || msgs.length === 0) return

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
          hydratedSessions.delete(prevId)
          initializedSessions.delete(prevId)
        }
        if (id) sync.session.sync(id, { refreshVolatile: true })
      },
    ),
  )

  createEffect(() => {
    if (!sdk.connected()) return
    const id = params.id
    if (id) sync.session.sync(id, { refreshVolatile: true })
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

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })

  const currentSession = createMemo(() => sync.data.session.find((s) => s.id === params.id))
  const sessionMeta = useSessionMeta(currentSession, sessionHasMessages)
  const focusedBlueprintWriteParts = new Set<string>()
  const unsubBlueprintNoteWrite = sdk.event.on("message.part.updated", (event) => {
    const sessionID = params.id
    if (!sessionID) return

    const request = blueprintNoteCreateFocusRequest(event.properties.part, sessionID)
    if (!request) return

    const key = `${event.properties.part.sessionID}:${event.properties.part.id}:${request.noteID}`
    if (focusedBlueprintWriteParts.has(key)) return
    focusedBlueprintWriteParts.add(key)

    void workbench.openPanel("notes", {
      reuseExisting: true,
      init: {
        resourceId: request.noteID,
        source:
          request.scopeID === "home" ? HOME_SCOPE_KEY : request.scopeID || (sdk.isHome ? HOME_SCOPE_KEY : sdk.scopeKey),
      },
    })
  })
  onCleanup(unsubBlueprintNoteWrite)

  createEffect(() => {
    const session = currentSession()
    const id = params.id
    if (!session || !id) return
    const routeScope = sdk.scopeKey
    const sessionScope = session.scope.type === "home" ? HOME_SCOPE_KEY : session.scope.directory
    if (!sessionScope) return
    if (normalizePathForCompare(routeScope) === normalizePathForCompare(sessionScope)) return
    navigate(`/${base64Encode(sessionScope)}/session/${id}`, { replace: true })
  })
  const parentSession = createMemo(() => {
    const current = currentSession()
    if (!current?.parentID) return undefined
    return sync.data.session.find((s) => s.id === current.parentID)
  })
  const forkedFromSession = createMemo(() => {
    const source = currentSession()?.forkedFrom
    if (!source) return undefined
    return sync.data.session.find((s) => s.id === source.sessionID)
  })
  const backPath = createMemo(() => {
    if (parentSession()) return undefined
    const from = (location.state as { from?: string } | undefined)?.from
    return from ?? undefined
  })

  createEffect(() => {
    const session = currentSession()
    let title: string
    if (isHomeScope(sdk.scopeKey)) {
      title = "Home"
    } else {
      title = session?.title || "New session"
    }
    document.title = `${title} — Synergy`
  })

  onCleanup(() => {
    document.title = "Synergy"
  })

  createEffect(
    on(
      () => params.id,
      () => {
        setStore("messageId", undefined)
      },
      { defer: true },
    ),
  )

  useSessionCommands({
    command,
    sdk,
    sync,
    local,
    dialog,
    terminal,
    layout,
    prompt,
    navigate,
    routeParams: params as unknown as { dir: string; id?: string },
    info,
    status,
    activeMessage,
    visibleUserMessages,
    userMessages,
    setActiveMessage,
    navigateMessageByOffset,
    isWorking: () => status().type !== "idle",
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
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

  const contextOpen = createMemo(() => tabs().active() === "context" || tabs().all().includes("context"))
  const openedTabs = createMemo(() =>
    tabs()
      .all()
      .filter((tab) => tab !== "context"),
  )

  const reviewTab = createMemo(() => hasReview() || tabs().active() === "review")
  const mobileReview = createMemo(() => !isDesktop() && hasReview() && store.mobileTab === "review")

  const showTabs = createMemo(
    () => layout.review.opened() && (hasReview() || (tabs().all()?.length ?? 0) > 0 || contextOpen()),
  )

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

        const len = visibleUserMessages()?.length ?? 0
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

        const afterLayoutSettles = (fn: () => void) => {
          requestAnimationFrame(() => requestAnimationFrame(fn))
        }
        initScrollFrame = requestAnimationFrame(() => {
          initScrollFrame = undefined

          const hash = window.location.hash.slice(1)
          if (!hash) {
            afterLayoutSettles(() => autoScroll.forceScrollToBottom())
            return
          }

          afterLayoutSettles(() => {
            const hashTarget = document.getElementById(hash)
            if (hashTarget) {
              hashTarget.scrollIntoView({ behavior: "auto", block: "start" })
              return
            }

            const match = hash.match(/^message-(.+)$/)
            if (match) {
              const anyMessage = messages().find((message) => message.id === match[1])
              if (anyMessage) {
                const el = document.getElementById(hash)
                if (el) el.scrollIntoView({ behavior: "auto", block: "center" })
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
        })
      },
    ),
  )

  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
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
    <>
      <Show when={!!params.id}>
        <WorkspaceBrowserTool />
      </Show>
      <WorkspaceNotesTool />
      <WorkspaceTerminalTool />
      <div class="synergy-workbench-canvas relative bg-background-stronger size-full overflow-hidden flex flex-col">
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

          <div
            class="session-workbench-pane synergy-workbench-canvas @container relative min-w-0 flex flex-col min-h-0 h-full bg-background-stronger pt-3 pb-0 md:py-3"
            classList={{
              "flex-1": !(isDesktop() && showTabs()),
            }}
            style={{
              width: isDesktop() && showTabs() ? `${layout.session.width()}px` : undefined,
              "min-width": isDesktop() && sideOpen() ? `${WORKSPACE_SESSION_MIN_WIDTH}px` : undefined,
              "--prompt-height": store.promptHeight ? `${store.promptHeight}px` : undefined,
            }}
          >
            <div class="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
              <Show when={worktreeTransition()}>
                {(transition) => (
                  <Show when={transition().sessionID === params.id}>
                    <div class="absolute inset-0 z-40 flex flex-col bg-background-base">
                      <WorktreeTransitionContent
                        mode={transition().mode}
                        sessionID={transition().sessionID}
                        directory={transition().directory}
                        onClose={clearWorktreeTransition}
                      />
                    </div>
                  </Show>
                )}
              </Show>
              <SessionTopBar />
              <Show when={showRollbackBanner()}>
                <RollbackBanner
                  sessionID={params.id!}
                  rollback={rollback()!}
                  sdk={sdk}
                  onDismiss={() => setRollbackDismissed(true)}
                />
              </Show>
              <div class="flex-1 min-h-0 min-w-0 overflow-hidden">
                <Switch>
                  <Match when={!isNewSession()}>
                    <Show
                      when={activeMessage() || (timeline()?.length ?? 0) > 0}
                      fallback={
                        <Show
                          when={messagesReady()}
                          fallback={
                            <div class="synergy-workbench-canvas flex h-full flex-col items-center justify-center gap-3 bg-background-stronger">
                              <Spinner class="size-10 text-text-weak" />
                              <span class="text-sm text-text-weak">Loading conversation…</span>
                            </div>
                          }
                        >
                          <div class="synergy-workbench-canvas flex h-full items-center justify-center bg-background-stronger">
                            <span class="text-sm text-text-weak">No messages yet</span>
                          </div>
                        </Show>
                      }
                    >
                      <Show
                        when={!mobileReview()}
                        fallback={
                          <div class="synergy-workbench-canvas relative h-full overflow-hidden bg-background-stronger">
                            <Show
                              when={diffsReady()}
                              fallback={<div class="px-4 py-4 text-text-weak">Loading changes…</div>}
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
                          pendingTimeline={pendingTimeline}
                          visibleUserMessages={visibleUserMessages}
                          lastUserMessage={lastRenderableUserMessage}
                          activeMessage={activeMessage}
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
                          terminalHeight={bottomSurface().opened() ? bottomSurface().size : () => 0}
                          workspaceOpen={sideOpen}
                          onRewind={openRewindConfirm}
                          rollbackActive={rollbackActive()}
                        />
                      </Show>
                    </Show>
                  </Match>
                  <Match when={true}>{null}</Match>
                </Switch>
              </div>
            </div>
            <PromptDock
              ref={(el) => (promptDock = el)}
              inputRef={(el) => {
                inputRef = el
              }}
              isNewSession={isNewSession}
              showTabs={showTabs}
              isGlobal={isHomeScope(sdk.scopeKey)}
              sessionID={params.id}
              prompt={prompt}
              sync={sync}
              sdk={sdk}
              navigate={(id) => navigate(`/${params.dir}/session/${id}`)}
              handoffPrompt={handoff.prompt}
              meta={sessionMeta}
              parentTitle={parentSession()?.title}
              forkedFromID={currentSession()?.forkedFrom?.sessionID}
              forkedFromTitle={forkedFromSession()?.title ?? currentSession()?.forkedFrom?.title}
              backPath={backPath}
              newSessionWorkspaceSelection={newSessionWorkspaceSelection}
              newSessionCanonicalDirectory={scopeRoot}
              newSessionCurrentDirectory={() => sync.data.path.directory}
              onNewSessionWorkspaceSelectionChange={(selection) => setStore("newSessionWorkspaceSelection", selection)}
              onNewSessionWorkspaceSelectionReset={() => setStore("newSessionWorkspaceSelection", undefined)}
              scopeName={scopeName}
              branch={branch}
              lastModified={lastModified}
              workspaceOpen={sideOpen}
              rollbackActive={rollbackActive()}
            />
            <Show when={isDesktop() && showTabs() && !sideOpen()}>
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
          <Show when={isDesktop()}>
            <WorkbenchSurface surface="side" />
          </Show>
        </div>

        <Show when={isDesktop()}>
          <WorkbenchSurface surface="bottom" />
        </Show>
      </div>
    </>
  )
}
