import { Show, Match, Switch, createMemo, createEffect, createSignal, on, onCleanup } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { useFile, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { hasSpecialUserMessageRenderer } from "@ericsanchezok/synergy-ui/special-user-message"

import { WORKSPACE_SESSION_MIN_WIDTH } from "@/context/layout/workspace"
import { createAutoScroll } from "@ericsanchezok/synergy-ui/hooks"

import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { useLayout } from "@/context/layout"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useCommand } from "@/context/command"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { UserMessage, AssistantMessage, Message } from "@ericsanchezok/synergy-sdk"
import type { FileDiff, Session, SessionInboxItem, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { useSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { extractPromptDraft } from "@/utils/prompt"
import { inlineLength } from "@/components/prompt-input/content"

import { SessionReviewTab } from "@/components/session"
import { navMark, navParams } from "@/utils/perf"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"

import { requestErrorMessage } from "@/utils/error"
import { useSessionCommands } from "@/components/session/commands"
import { useSessionMeta } from "@/composables/use-session-meta"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { replaceSessionHistoryUrl, sessionRouteReplaceOptions } from "@/composables/use-navigate-to-session-model"
import { SessionConversation } from "@/components/session/conversation"
import { PromptDock } from "@/components/session/prompt-dock"
import { useWorkbenchPanels } from "@/context/workbench"
import { useLocale } from "@/context/locale"
import { AP } from "@/app-i18n"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { WorkbenchSurface } from "@/components/workspace/workbench-surface"
import { SessionTopBar } from "@/components/top-bar/session-top-bar"
import { blueprintNoteCreateFocusRequest } from "@/context/plan-blueprint-offer"
import {
  createWorkspaceTransitionErrorProgress,
  createWorkspaceTransitionLoadingProgress,
  createWorkspaceTransitionRefreshErrorProgress,
  createWorkspaceTransitionRefreshProgress,
  createWorkspaceTransitionSuccessProgress,
  defaultNewSessionWorkspaceSelection,
  normalizePathForCompare,
  worktreeSetupFailureMessage,
  type NewSessionWorkspaceSelection,
  type SessionWorkspaceTransitionRequest,
} from "@/components/session/worktree-session"
import {
  isSessionTransitionBlocking,
  type SessionTransitionActions,
  type SessionTransitionProgress,
} from "@/components/session/session-transition-progress"
import { RollbackBanner } from "@/components/session/rollback-banner"
import { DialogRewindConfirm } from "@/components/session/dialog-rewind-confirm"
import { hasSessionRenderableContent, sessionLoadView } from "@/components/session/session-load-state"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { ResourceOpenProvider } from "@/context/resource-open"
import { BuiltinWorkbenchPanelsProvider } from "@/components/workspace/builtin-workbench-panels"
import { useSessionTransition } from "@/context/session-transition"
import {
  messagesBefore,
  messagesFrom,
  previousMessage,
  selectMessagesInCanonicalOrder,
} from "@/components/session/session-message-order"
import {
  adjustedScrollTop,
  selectPrependAnchor,
  type PrependScrollAnchor,
} from "@/components/session/session-history-scroll"

const handoff = {
  prompt: "",
  terminals: [] as string[],
  files: {} as Record<string, SelectedLineRange | null>,
}

export default function Page() {
  return (
    <TerminalProvider>
      <ResourceOpenProvider>
        <PromptProvider>
          <BuiltinWorkbenchPanelsProvider>
            <SessionPageContent />
          </BuiltinWorkbenchPanelsProvider>
        </PromptProvider>
      </ResourceOpenProvider>
    </TerminalProvider>
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
  const navigateToSession = useNavigateToSession()
  const prompt = usePrompt()
  const { fmt, i18n } = useLocale()
  const workbench = useWorkbenchPanels()
  const sessionTransition = useSessionTransition()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const sideSurface = createMemo(() => layout.surface(sessionKey(), "side"))
  const bottomSurface = createMemo(() => layout.surface(sessionKey(), "bottom"))
  const sideOpen = createMemo(() => sideSurface().opened())
  const view = createMemo(() => layout.view(sessionKey()))

  createEffect(() => {
    layout.tryRevealInitialSideWorkspace(sessionKey())
  })

  createEffect(
    on(
      () => [params.dir, params.id, sync.data.scopeID] as const,
      ([dir, id, scopeID], prev) => {
        if (!id) return
        navParams({ dir, from: prev?.[1], to: id, scopeID })
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

  const isDesktop = () => layout.isDesktop()

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    turnStart: 0,
    newSessionWorkspaceSelection: undefined as NewSessionWorkspaceSelection | undefined,
    promptHeight: 0,
    mobileReviewOpen: false,
    mobileReviewSelectedFile: undefined as string | undefined,
    delayedMessageLoad: undefined as { sessionID: string; generation: number } | undefined,
  })

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const reviewCount = createMemo(() => info()?.summary?.files ?? 0)
  const rollback = createMemo(() => info()?.history?.rollback)
  const rollbackActive = createMemo(() => rollback()?.canUnrollback === true)
  const [rollbackDismissed, setRollbackDismissed] = createSignal(false)
  const visibleSessionTransitionEntry = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return undefined
    return sessionTransition.get(sessionID)
  })
  const visibleSessionTransition = createMemo(() => visibleSessionTransitionEntry()?.progress ?? null)
  const visibleSessionTransitionActions = createMemo(() => visibleSessionTransitionEntry()?.actions)
  const sessionTransitionPending = createMemo(() => isSessionTransitionBlocking(visibleSessionTransition()))
  const clearSessionTransition = sessionTransition.clear
  const setSessionTransition = sessionTransition.set
  const refreshWorkspaceTransition = (input: {
    request: SessionWorkspaceTransitionRequest
    success: SessionTransitionProgress
    toast: { title: string; description: string }
  }) => {
    const { request } = input
    setSessionTransition(request.sessionID, createWorkspaceTransitionRefreshProgress(request))
    const retry = () => refreshWorkspaceTransition(input)
    const run = async () => {
      try {
        await sync.session.sync(request.sessionID, { trigger: { type: "workspace-transition" } })
        setSessionTransition(request.sessionID, input.success, {
          dismiss: () => clearSessionTransition(request.sessionID),
        })
        showToast({ type: "info", ...input.toast })
      } catch (error) {
        const message = requestErrorMessage(error)
        setSessionTransition(
          request.sessionID,
          createWorkspaceTransitionRefreshErrorProgress({ operation: request.operation, message }),
          {
            retry,
            dismiss: () => clearSessionTransition(request.sessionID),
          },
        )
        showToast({
          type: "error",
          title: i18n._(AP.layoutWorktreeRefreshFailed.id),
          description: message,
        })
      }
    }
    void run()
  }
  const startWorkspaceTransition = (request: SessionWorkspaceTransitionRequest) => {
    if (sessionTransition.get(request.sessionID)?.progress.phase === "loading") return
    const retry = () => startWorkspaceTransition(request)
    setSessionTransition(request.sessionID, createWorkspaceTransitionLoadingProgress(request))
    const run = async () => {
      try {
        if (request.operation === "leave") {
          await sdk.client.worktree.leave({ directory: request.directory, sessionID: request.sessionID })
          refreshWorkspaceTransition({
            request,
            success: createWorkspaceTransitionSuccessProgress({ operation: "leave" }),
            toast: {
              title: i18n._(AP.layoutLeftWorktree.id),
              description: i18n._(AP.layoutWorktreeLeftToast.id),
            },
          })
          return
        }

        const result = await sdk.client.worktree.create({
          directory: request.directory,
          worktreeCreateInput: {
            sessionID: request.sessionID,
            bind: true,
            name: request.name,
          },
        })
        const setupFailure = worktreeSetupFailureMessage(result.data)
        if (setupFailure) {
          await sdk.client.worktree
            .leave({ directory: request.directory, sessionID: request.sessionID })
            .catch(() => undefined)
          await sync.session
            .sync(request.sessionID, { trigger: { type: "workspace-transition" } })
            .catch(() => undefined)
          throw new Error(setupFailure)
        }
        const description = result.data?.name
          ? i18n._(AP.layoutWorktreeDesc.id, { name: result.data.name })
          : i18n._(AP.layoutWorktreeDescDefault.id)
        refreshWorkspaceTransition({
          request,
          success: createWorkspaceTransitionSuccessProgress({ operation: "enter", description }),
          toast: { title: i18n._(AP.layoutMovedToWorktree.id), description },
        })
      } catch (error) {
        const message = requestErrorMessage(error)
        setSessionTransition(
          request.sessionID,
          createWorkspaceTransitionErrorProgress({
            operation: request.operation,
            message,
          }),
          {
            retry,
            dismiss: () => clearSessionTransition(request.sessionID),
          },
        )
        showToast({
          type: "error",
          title:
            request.operation === "leave"
              ? i18n._(AP.layoutLeaveWorktreeFailed.id)
              : i18n._(AP.layoutMoveWorktreeFailed.id),
          description: message,
        })
      }
    }
    void run()
  }
  const setNewSessionTransition = (input: {
    sessionID: string
    progress: SessionTransitionProgress | null
    actions?: SessionTransitionActions
  }) => {
    if (!input.progress) {
      clearSessionTransition(input.sessionID)
      return
    }
    setSessionTransition(input.sessionID, input.progress, input.actions)
  }
  // A fresh rewind (new rollback event id) always shows its banner, even if a
  // previous banner was dismissed.
  createEffect(
    on(
      () => rollback()?.id,
      () => setRollbackDismissed(false),
      { defer: true },
    ),
  )
  const showRollbackBanner = createMemo(() => rollback() !== undefined && !rollbackDismissed())
  const hiddenMessageIDs = createMemo(() => {
    const rb = rollback()
    if (!rb) return null as { cutMessageID: string } | null | Set<string>
    // While redo is still possible, use prefix-cut: hide the cut message and
    // everything after it. Once a new root invalidates redo, only the original
    // dropped set remains hidden so the new branch is visible.
    if (rb.cutMessageID && rb.canUnrollback) return { cutMessageID: rb.cutMessageID }
    return new Set(rb.droppedMessageIDs ?? [])
  })
  const messages = createMemo(() => {
    const raw = (params.id ? (sync.data.message[params.id] ?? []) : []) ?? []
    // Rollback filtering is gated by hiddenMessageIDs: the prefix-cut only
    // applies while redo is possible (canUnrollback). Once a new root has been
    // started the cut is superseded by the dropped-id set so the new branch —
    // including messages sent after undoing the first message — stays visible.
    const hidden = hiddenMessageIDs()
    if (!hidden) return raw
    if ("cutMessageID" in hidden) return messagesBefore(raw, hidden.cutMessageID)
    if (hidden.size === 0) return raw
    return raw.filter((message) => !hidden.has(message.id))
  })
  const openRewindConfirm = (message: UserMessage | undefined) => {
    if (!message?.id) return
    const targetMsg = message
    const targetID = targetMsg.id
    const sessionID = params.id
    if (!sessionID) return
    dialog.push(() => (
      <DialogRewindConfirm
        cutMessage={targetMsg}
        allMessages={messages().filter((m) => m.role === "user" || m.role === "assistant")}
        partsByMessage={sync.data.part}
        onRewind={async (cutMessageID, restoreFiles) => {
          if (!sessionID || !cutMessageID) return
          const previousActiveMessage = previousMessage(userMessages(), cutMessageID)
          // Abort if running. After abort, give the runtime a moment to settle
          // so assertIdle in rollback doesn't reject with BusyError.
          if (status().type !== "idle") {
            await sdk.client.session.abort({ sessionID }).catch(() => {})
            await new Promise((r) => setTimeout(r, 500))
          }
          const result = await sdk.client.session.rollback({ sessionID, cutMessageID })
          if (restoreFiles && result.data?.id) {
            await sdk.client.session.files.restore({ sessionID, rollbackID: result.data.id }).catch(() => {})
          }
          // Backfill prompt from the cut message per spec §3.5
          const cutParts = sync.data.part[targetID]
          if (cutParts) {
            const restored = extractPromptDraft({ message: targetMsg, parts: cutParts, directory: sdk.directory })
            prompt.set(restored.prompt, inlineLength(restored.prompt))
            prompt.context.set(restored.context)
          }
          setActiveMessage(previousActiveMessage)
        }}
      />
    ))
  }
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const messageLoad = createMemo(() => {
    const id = params.id
    if (!id) return { phase: "idle" as const, generation: 0, hasSnapshot: false }
    return sync.session.loadState(id)
  })
  let loadingRecoveryTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [params.id, messageLoad().phase, messageLoad().generation, messageLoad().hasSnapshot] as const,
      ([sessionID, phase, generation, hasSnapshot]) => {
        clearTimeout(loadingRecoveryTimer)
        setStore("delayedMessageLoad", undefined)
        if (!sessionID || phase !== "loading" || hasSnapshot) return
        loadingRecoveryTimer = setTimeout(() => {
          setStore("delayedMessageLoad", { sessionID, generation })
        }, 10_000)
      },
    ),
  )
  const messageLoadDelayed = createMemo(() => {
    const delayed = store.delayedMessageLoad
    if (!delayed) return false
    const load = messageLoad()
    return delayed.sessionID === params.id && delayed.generation === load.generation
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
  const historyMode = createMemo(() => {
    const id = params.id
    if (!id) return "latest" as const
    return sync.session.history.mode(id)
  })
  const historyPendingLatest = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.pendingLatest(id)
  })
  // ── Root message derivation layer ───────────────────────────────────
  // Replaces old isSessionIdentityAnchor / isGuidedContextUserMessage / synthetic metadata
  // heuristics with orthogonal isRoot/visible/rootID/origin fields.
  /** @deprecated Use inline empty arrays or nullish coalescing. */
  const emptyUserMessages: UserMessage[] = []
  const rootMessages = createMemo(
    () => messages().filter((m) => m.role === "user" && (m as UserMessage).isRoot === true) as UserMessage[],
    emptyUserMessages,
  )
  const visibleRoots = createMemo(() => rootMessages().filter((m) => m.visible !== false), emptyUserMessages)
  const lastRoot = createMemo(() => rootMessages().at(-1))
  // visibleRoots for navigation/timeline (deprecated old names kept for compatibility)
  const visibleUserMessages = visibleRoots
  // userMessages — kept for commands hook compatibility
  const userMessages = visibleRoots
  // renderableUserMessages — deprecated alias, use visibleRoots
  const renderableUserMessages = visibleRoots
  const lastUserMessage = lastRoot
  const lastRenderableUserMessage = lastRoot
  // Composer agent/model inheritance is handled inside local.model/local.agent as
  // a read-only "sessionDefault" derivation (server modelOverride, else the last
  // root message). The old effect that wrote lastRoot's agent/model back into the
  // local selector store was removed: it let a late message load silently
  // overwrite the user's explicit in-composer choice (issue #318).

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
    const msgs = visibleRoots()
    if (!firstID) return msgs
    return messagesFrom(msgs, firstID)
  }, emptyUserMessages)

  /** @deprecated Use inline empty arrays or nullish coalescing. */
  const emptyTimeline: Message[] = []
  const isActionCommandMessage = (message: Message) => {
    const metadata = message.metadata as
      | { command?: { kind?: string; promptVisible?: boolean }; promptVisible?: boolean }
      | undefined
    if (metadata?.command?.kind !== "action") return false
    // Prefer the canonical includeInContext; fall back to command.promptVisible
    // for messages written before it was set.
    if (message.includeInContext !== undefined) return message.includeInContext === false
    return metadata.promptVisible === false
  }

  const mergeTimelineMessages = (items: Message[]) => selectMessagesInCanonicalOrder(messages(), items)

  const pendingTimeline = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return [] as SessionInboxItem[]
    const inbox = sync.data.inbox[sessionID]
    if (!inbox || inbox.length === 0) return []
    return inbox
      .filter((item) => item.mode === "task" || item.mode === "steer")
      .filter((item) => item.message?.visible !== false)
      .filter((item) => (item.message?.origin?.type ?? item.source?.type) === "user")
  })
  const isNewSession = createMemo(() => {
    if (!params.id) return true
    if (!isHomeScope(sdk.scopeKey)) return false
    return (messages()?.length ?? 0) === 0 && pendingTimeline().length === 0 && visibleSessionTransition() === null
  })
  const guidePending = async (item: SessionInboxItem) => {
    const sessionID = params.id
    if (!sessionID) return
    await sdk.client.session.inboxGuide({ sessionID, itemID: item.id })
  }
  const removePending = async (item: SessionInboxItem) => {
    const sessionID = params.id
    if (!sessionID) return
    await sdk.client.session.inboxRemove({ sessionID, itemID: item.id })
  }

  const timeline = createMemo(() => {
    const turns = renderedConversationUserMessages() as Message[]
    const firstID = renderedUserMessages()[0]?.id ?? turns[0]?.id
    const canonical = firstID ? messagesFrom(messages(), firstID) : messages()
    const mailbox: Message[] = []
    const actionCommands: Message[] = []
    for (const msg of canonical) {
      if (isActionCommandMessage(msg)) {
        actionCommands.push(msg)
        continue
      }
      if (msg.role !== "assistant") continue
      if (!(msg as AssistantMessage).metadata?.mailbox) continue
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
    return fmt.relative(scope.time.updated ?? scope.time.created)
  })

  const activeMessage = createMemo(() => {
    if (!store.messageId) return lastUserMessage()
    const found = visibleUserMessages()?.find((m) => m.id === store.messageId)
    return found ?? lastUserMessage()
  })
  const conversationLoadView = createMemo(() =>
    sessionLoadView({
      hasRenderableContent: hasSessionRenderableContent({
        hasActiveMessage: !!activeMessage(),
        timelineCount: timeline()?.length ?? 0,
        pendingTimelineCount: pendingTimeline().length,
        hasTransition: visibleSessionTransition() !== null,
      }),
      messages: params.id ? sync.data.message[params.id] : [],
      load: messageLoad(),
      delayed: messageLoadDelayed(),
    }),
  )
  const conversationLoadError = createMemo(() => {
    const view = conversationLoadView()
    if (view.type === "initial-error" || view.type === "empty-error") return view.error
    return ""
  })
  const refreshConversation = async () => {
    const id = params.id
    if (!id) return
    await sync.session.refresh(id).catch(() => undefined)
  }
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

  const idle = { type: "idle" as const }
  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let scroller: HTMLDivElement | undefined

  const hydratedSessions = new Set<string>()
  const initializedSessions = new Set<string>()

  // Single idempotent entry point for loading a session's data. Runs on session
  // switch and on (re)connect; sync.session.sync dedups concurrent/ready loads
  // internally. Replaces two separate effects that both called sync (one on
  // params.id, one on sdk.connected) and double-fetched on mount.
  createEffect(
    on(
      () => [params.id, sdk.connected()] as const,
      ([id, connected], prev) => {
        const prevId = prev?.[0]
        if (prevId && prevId !== id) {
          hydratedSessions.delete(prevId)
          initializedSessions.delete(prevId)
        }
        // Protect the viewed session's buckets from LRU eviction.
        sync.markActiveSession(id)
        if (connected && id) void sync.session.sync(id, { refreshVolatile: true }).catch(() => undefined)
      },
    ),
  )

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

  const currentSession = createMemo(() => sync.data.session.find((s) => s.id === params.id))
  const status = createMemo<SessionStatus>(() => {
    const runtimeStatus = sync.data.session_status[params.id ?? ""]
    if (runtimeStatus && runtimeStatus.type !== "idle") return runtimeStatus
    const working = currentSession()?.working
    if (working?.status === "busy") return { type: "busy", description: working.description }
    if (working?.status === "retry") {
      return {
        type: "retry",
        attempt: working.attempt,
        message: working.message,
        next: working.next,
      }
    }
    if (working?.status === "recovering") return { type: "recovering" }
    return runtimeStatus ?? idle
  })

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })

  const sessionMeta = useSessionMeta(currentSession, sessionHasMessages)
  const focusedBlueprintCreateParts = new Set<string>()
  const unsubBlueprintNoteCreate = sdk.event.on("message.part.updated", (event) => {
    const sessionID = params.id
    if (!sessionID) return

    const request = blueprintNoteCreateFocusRequest(event.properties.part, sessionID)
    if (!request) return

    const key = `${event.properties.part.sessionID}:${event.properties.part.id}:${request.noteID}`
    if (focusedBlueprintCreateParts.has(key)) return
    focusedBlueprintCreateParts.add(key)

    void workbench.openPanel("notes", {
      reuseExisting: true,
      init: {
        resourceId: request.noteID,
        source:
          request.scopeID === "home" ? HOME_SCOPE_KEY : request.scopeID || (sdk.isHome ? HOME_SCOPE_KEY : sdk.scopeKey),
      },
    })
  })
  onCleanup(unsubBlueprintNoteCreate)

  createEffect(() => {
    const session = currentSession()
    const id = params.id
    if (!session || !id) return
    const routeScope = sdk.scopeKey
    const sessionScope = session.scope.type === "home" ? HOME_SCOPE_KEY : session.scope.directory
    if (!sessionScope) return
    if (normalizePathForCompare(routeScope) === normalizePathForCompare(sessionScope)) return
    navigate(`/${base64Encode(sessionScope)}/session/${id}`, sessionRouteReplaceOptions(location.state))
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
      title = i18n._(AP.sessionTitleHome.id)
    } else {
      title = session?.title || i18n._(AP.sessionTitleNew.id)
    }
    document.title = i18n._(AP.sessionTitleTemplate.id, { title })
  })

  onCleanup(() => {
    document.title = i18n._(AP.sessionTitleApp.id)
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
    onRewind: openRewindConfirm,
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

  const isWorking = createMemo(() => status().type !== "idle")
  const autoScroll = createAutoScroll({
    working: isWorking,
  })

  const [scrolledUp, setScrolledUp] = createSignal(false)

  let scrollSpyFrame: number | undefined
  let scrollSpyTarget: HTMLDivElement | undefined
  let initScrollFrame: number | undefined
  let historyScrollFrame: number | undefined

  const anchor = (id: string) => `message-${id}`

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
  }

  const afterHistoryLayoutSettles = (fn: () => void) => {
    if (historyScrollFrame !== undefined) cancelAnimationFrame(historyScrollFrame)
    historyScrollFrame = requestAnimationFrame(() => {
      historyScrollFrame = requestAnimationFrame(() => {
        historyScrollFrame = undefined
        fn()
      })
    })
  }

  const capturePrependScrollAnchor = (): PrependScrollAnchor | undefined => {
    const container = scroller
    if (!container) return
    const viewportTop = container.getBoundingClientRect().top
    const candidates = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        messageID: node.dataset.messageId ?? "",
        top: rect.top,
        bottom: rect.bottom,
      }
    })
    return selectPrependAnchor(
      candidates.filter((candidate) => candidate.messageID),
      viewportTop,
    )
  }

  const restorePrependScrollAnchor = (anchor: PrependScrollAnchor | undefined) => {
    const container = scroller
    if (!container || !anchor) return
    const node = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (candidate) => candidate.dataset.messageId === anchor.messageID,
    )
    if (!node) return
    const afterOffsetTop = node.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTop = adjustedScrollTop({
      scrollTop: container.scrollTop,
      beforeOffsetTop: anchor.offsetTop,
      afterOffsetTop,
    })
  }

  const loadEarlierMessages = async () => {
    const id = params.id
    if (!id) return
    const scrollAnchor = capturePrependScrollAnchor()
    try {
      const result = await sync.session.history.loadMore(id)
      if (!result) return
      setStore("turnStart", 0)
      afterHistoryLayoutSettles(() => {
        if (result === "latest") {
          autoScroll.forceScrollToBottom()
          return
        }
        restorePrependScrollAnchor(scrollAnchor)
      })
    } catch (error) {
      showToast({
        type: "error",
        title: i18n._(AP.sessionLoadEarlierFailed.id),
        description: requestErrorMessage(error),
      })
    }
  }

  const returnToLatestMessages = async () => {
    const id = params.id
    if (!id) return
    try {
      await sync.session.history.returnLatest(id)
      setStore("turnStart", 0)
      afterHistoryLayoutSettles(() => autoScroll.forceScrollToBottom())
    } catch (error) {
      showToast({
        type: "error",
        title: i18n._(AP.sessionReturnLatestFailed.id),
        description: requestErrorMessage(error),
      })
    }
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
    replaceSessionHistoryUrl(window.history, `#${anchor(id)}`)
  }

  const clearHash = () => {
    if (!window.location.hash) return
    replaceSessionHistoryUrl(window.history, window.location.pathname + window.location.search)
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
      Array.from(file.openPaths()).map((path) => [path, file.view.selectedLines(path) ?? null] as const),
    )
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    if (scrollSpyFrame !== undefined) cancelAnimationFrame(scrollSpyFrame)
    if (initScrollFrame !== undefined) cancelAnimationFrame(initScrollFrame)
    if (historyScrollFrame !== undefined) cancelAnimationFrame(historyScrollFrame)
    hydratedSessions.clear()
    initializedSessions.clear()
    clearTimeout(loadingRecoveryTimer)
  })

  return (
    <>
      <div class="synergy-workbench-canvas relative bg-background-stronger size-full overflow-hidden flex flex-col">
        <div class="flex-1 min-h-0 flex flex-col md:flex-row relative">
          <div
            class="session-workbench-pane synergy-workbench-canvas @container relative min-w-0 flex flex-1 flex-col bg-background-stronger pt-3 pb-0 md:py-3"
            style={{
              "min-width": isDesktop() && sideOpen() ? `${WORKSPACE_SESSION_MIN_WIDTH}px` : undefined,
              "--prompt-height": store.promptHeight ? `${store.promptHeight}px` : undefined,
            }}
          >
            <div class="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
              <SessionTopBar
                onWorkspaceTransition={startWorkspaceTransition}
                sessionTransitionPending={sessionTransitionPending}
              />
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
                    <Switch>
                      <Match when={conversationLoadView().type === "conversation"}>
                        <SessionConversation
                          sessionID={params.id!}
                          paramsDir={params.dir!}
                          timeline={timeline}
                          pendingTimeline={pendingTimeline}
                          sessionTransition={visibleSessionTransition}
                          sessionTransitionActions={visibleSessionTransitionActions}
                          visibleUserMessages={visibleUserMessages}
                          lastUserMessage={lastRenderableUserMessage}
                          activeMessage={activeMessage}
                          isWorking={isWorking}
                          turnStart={store.turnStart}
                          turnBatch={turnBatch}
                          onSetTurnStart={(start) => setStore("turnStart", start)}
                          historyMore={historyMore}
                          historyLoading={historyLoading}
                          historyMode={historyMode}
                          historyPendingLatest={historyPendingLatest}
                          onLoadMore={() => void loadEarlierMessages()}
                          onReturnLatest={() => void returnToLatestMessages()}
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
                          onReviewChanges={(input) => {
                            if (isDesktop()) {
                              void workbench.openPanel("session-review", {
                                reuseExisting: true,
                                init: {
                                  ...(input.file ? { resourceId: input.file } : {}),
                                  source: input.messageID,
                                },
                              })
                            } else {
                              setStore({
                                mobileReviewOpen: true,
                                mobileReviewSelectedFile: input.file,
                              })
                            }
                          }}
                          onPendingGuide={(item) => void guidePending(item)}
                          onPendingRemove={(item) => void removePending(item)}
                          rollbackActive={rollbackActive()}
                        />
                      </Match>
                      <Match
                        when={
                          conversationLoadView().type === "loading" || conversationLoadView().type === "delayed-loading"
                        }
                      >
                        <div class="synergy-workbench-canvas flex h-full flex-col items-center justify-center gap-3 bg-background-stronger">
                          <Spinner class="size-10 text-text-weak" />
                          <span class="text-sm text-text-weak">{i18n._(AP.sessionLoading.id)}</span>
                          <Show when={conversationLoadView().type === "delayed-loading"}>
                            <button
                              type="button"
                              class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-text-weak transition-colors hover:bg-background-base hover:text-text-base"
                              onClick={() => void refreshConversation()}
                            >
                              <Icon name={getSemanticIcon("action.refresh")} size="small" />
                              <span>{i18n._(AP.sessionRetry.id)}</span>
                            </button>
                          </Show>
                        </div>
                      </Match>
                      <Match when={conversationLoadView().type === "initial-error"}>
                        <div class="synergy-workbench-canvas flex h-full flex-col items-center justify-center gap-3 bg-background-stronger text-center">
                          <span class="text-sm text-text-strong">{i18n._(AP.sessionErrorTitle.id)}</span>
                          <span class="max-w-md text-sm text-text-weak">{conversationLoadError()}</span>
                          <button
                            type="button"
                            class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-text-weak transition-colors hover:bg-background-base hover:text-text-base"
                            onClick={() => void refreshConversation()}
                          >
                            <Icon name={getSemanticIcon("action.refresh")} size="small" />
                            <span>{i18n._(AP.sessionRetry.id)}</span>
                          </button>
                        </div>
                      </Match>
                      <Match when={true}>
                        <div class="synergy-workbench-canvas flex h-full flex-col items-center justify-center gap-3 bg-background-stronger text-center">
                          <span class="text-sm text-text-weak">{i18n._(AP.sessionNoMessages.id)}</span>
                          <Show when={conversationLoadView().type === "empty-error"}>
                            <span class="max-w-md text-sm text-text-error">{conversationLoadError()}</span>
                          </Show>
                          <button
                            type="button"
                            class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-text-weak transition-colors hover:bg-background-base hover:text-text-base disabled:opacity-50"
                            disabled={conversationLoadView().type === "refreshing-empty"}
                            onClick={() => void refreshConversation()}
                          >
                            <Icon
                              name={getSemanticIcon("action.refresh")}
                              size="small"
                              class={conversationLoadView().type === "refreshing-empty" ? "animate-spin" : undefined}
                            />
                            <span>
                              {conversationLoadView().type === "refreshing-empty"
                                ? i18n._(AP.sessionRefreshing.id)
                                : i18n._(AP.sessionRefresh.id)}
                            </span>
                          </button>
                        </div>
                      </Match>
                    </Switch>
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
              isGlobal={isHomeScope(sdk.scopeKey)}
              sessionID={params.id}
              prompt={prompt}
              sync={sync}
              sdk={sdk}
              navigate={navigateToSession}
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
              onNewSessionTransitionChange={setNewSessionTransition}
              sessionTransitionPending={sessionTransitionPending}
              scopeName={scopeName}
              branch={branch}
              lastModified={lastModified}
              workspaceOpen={sideOpen}
              rollbackActive={rollbackActive()}
            />
          </div>
          {/* Desktop side workspace */}
          <div class="hidden md:block">
            <WorkbenchSurface surface="side" />
          </div>

          {/* Mobile side workspace overlay */}
          <Show when={!isDesktop() && sideOpen()}>
            <div class="absolute inset-0 z-50 flex flex-col bg-background-stronger">
              <WorkspaceMobileHeader onClose={() => sideSurface().close()} />
              <div class="mobile-workbench-overlay relative flex-1 min-h-0">
                <WorkbenchSurface surface="side" />
              </div>
            </div>
          </Show>
        </div>

        <Show when={isDesktop()}>
          <WorkbenchSurface surface="bottom" />
        </Show>
        <Show when={!isDesktop() && store.mobileReviewOpen}>
          <div
            class="md:hidden absolute inset-x-0 bottom-0 z-40 flex flex-col bg-background-stronger border-t border-border-weak-base rounded-t-xl shadow-lg"
            style={{ height: "50vh" }}
          >
            <div class="flex items-center justify-between px-4 h-11 shrink-0">
              <span class="text-13-medium text-text-strong">
                {i18n._(AP.sessionFilesChanged.id, { count: reviewCount() })}
              </span>
              <button
                type="button"
                class="flex items-center justify-center size-7 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                aria-label={i18n._(AP.sessionCloseReview.id)}
                onClick={() => setStore("mobileReviewOpen", false)}
              >
                <Icon name={getSemanticIcon("action.close")} size="small" />
              </button>
            </div>
            <div class="flex-1 min-h-0 overflow-auto">
              <Show
                when={params.id && sync.data.session_diff[params.id]}
                fallback={
                  <div class="px-4 py-4 text-13-regular text-text-weak">{i18n._(AP.sessionLoadingChanges.id)}</div>
                }
              >
                {(rawDiffs) => {
                  const diffsArr = Array.isArray(rawDiffs()) ? (rawDiffs() as FileDiff[]) : ([] as FileDiff[])
                  return (
                    <SessionReviewTab
                      diffs={() => diffsArr}
                      view={view}
                      diffStyle="unified"
                      selectedFile={() => store.mobileReviewSelectedFile}
                      onViewFile={(path) => void file.openWorkspaceFile(path)}
                    />
                  )
                }}
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
