import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePanel } from "@/context/panel"
import { useNotification } from "@/context/notification"
import { Panel } from "@/components/panel"
import { getScopeLabel } from "@/utils/scope"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

function setSessionDragData(event: DragEvent, session: Session) {
  if (!event.dataTransfer) return
  const title = session.title || "New session"
  const payload = JSON.stringify({
    id: session.id,
    directory: session.scope.directory,
    title,
    updatedAt: session.time.updated ?? session.time.created,
  })

  event.dataTransfer.effectAllowed = "copy"
  event.dataTransfer.setData("application/x-synergy-session", payload)
  event.dataTransfer.setData("text/plain", title)

  const dragImage = document.createElement("div")
  dragImage.className =
    "flex items-center gap-2 px-2.5 py-1.5 bg-surface-raised-base rounded-lg border border-border-base text-12-medium text-text-base"
  dragImage.style.position = "absolute"
  dragImage.style.top = "-1000px"
  dragImage.textContent = title
  document.body.appendChild(dragImage)
  event.dataTransfer.setDragImage(dragImage, 0, 16)
  setTimeout(() => document.body.removeChild(dragImage), 0)
}

export function SessionListView(props: { worktree: string }) {
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const params = useParams()
  const panel = usePanel()

  const PAGE_SIZE = 20
  const [search, setSearch] = createSignal("")
  const [currentPage, setCurrentPage] = createSignal(1)
  const [loading, setLoading] = createSignal(false)
  const [expandedCard, setExpandedCard] = createSignal<string | null>(null)

  let searchTimer: ReturnType<typeof setTimeout> | undefined

  function fetchSessions(page: number, searchQuery?: string) {
    const scope_ = scope()
    if (!scope_) return
    setLoading(true)
    const offset = (page - 1) * PAGE_SIZE
    layout.nav
      .loadSessions(scope_, { offset, limit: PAGE_SIZE, search: searchQuery || undefined })
      .finally(() => setLoading(false))
  }

  function handleSearch(value: string) {
    setSearch(value)
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      setCurrentPage(1)
      fetchSessions(1, value)
    }, 300)
  }

  onMount(() => {
    layout.scopes.open(props.worktree)
  })

  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer)
  })

  const scope = createMemo(() =>
    layout.scopes.list().find((p) => p.worktree === props.worktree || p.sandboxes?.includes(props.worktree)),
  )

  const scopeName = createMemo(() => getScopeLabel(scope(), props.worktree))

  const sessions = createMemo(() => layout.nav.projectSessions(scope()))
  const sessionTotal = createMemo(() => layout.nav.projectSessionTotal(scope()))
  const totalPages = createMemo(() => Math.max(1, Math.ceil(sessionTotal() / PAGE_SIZE)))

  const pinnedSessions = createMemo(() => sessions().filter((s) => s.pinned && s.pinned > 0))
  const unpinnedSessions = createMemo(() => sessions().filter((s) => !s.pinned || s.pinned <= 0))

  function navigateToSession(session: Session) {
    navigate(`/${base64Encode(session.scope.directory!)}/session/${session.id}`)
    panel.close()
  }

  async function archiveSession(session: Session) {
    const nextSession = await layout.nav.archiveSession(session)
    if (session.id === params.id) {
      const dir = base64Encode(session.scope.directory!)
      navigate(nextSession ? `/${dir}/session/${nextSession.id}` : `/${dir}/session`)
    }
  }

  async function togglePin(session: Session) {
    const isPinned = session.pinned && session.pinned > 0
    await layout.nav.pinSession(session, !isPinned)
  }

  function toggleExpand(sessionID: string) {
    setExpandedCard((prev) => (prev === sessionID ? null : sessionID))
  }

  async function renameSession(session: Session, title: string) {
    await globalSDK.client.session.update({
      directory: session.scope.directory,
      sessionID: session.id,
      title,
    })
  }

  function newSession() {
    navigate(`/${base64Encode(props.worktree)}/session`)
    panel.close()
  }

  function goToPage(page: number) {
    if (page < 1 || page > totalPages()) return
    setCurrentPage(page)
    fetchSessions(page, search())
  }

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.HeaderRow>
          <button
            type="button"
            class="flex items-center gap-1.5 -ml-1 px-1.5 py-0.5 rounded-lg text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={() => panel.scopes.back()}
          >
            <Icon name="arrow-left" size="small" />
            <span class="text-12-medium">Projects</span>
          </button>
          <span class="flex-1" />
          <span class="text-14-medium text-text-strong truncate">{scopeName()}</span>
        </Panel.HeaderRow>
        <Panel.Search value={search()} onInput={handleSearch} placeholder="Search sessions..." />
      </Panel.Header>

      <Panel.Body padding="tight">
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-3 py-2.5 mb-3 rounded-xl border border-dashed border-border-base/50 text-13-medium text-text-weak hover:text-text-interactive-base hover:border-text-interactive-base/30 hover:bg-surface-interactive-base/5 transition-all duration-150 cursor-pointer"
          onClick={newSession}
        >
          <Icon name="plus" size="small" />
          <span>New session</span>
        </button>
        <Show
          when={sessions().length > 0}
          fallback={
            <Panel.Empty icon="message-square" title={search() ? `No sessions match "${search()}"` : "No sessions"} />
          }
        >
          <div class="grid grid-cols-2 gap-2 pt-1">
            <Show when={pinnedSessions().length > 0}>
              <div class="col-span-2 px-0.5">
                <span class="text-11-medium text-text-weak uppercase tracking-wider">Pinned</span>
              </div>
              <For each={pinnedSessions()}>
                {(session, index) => (
                  <SessionCard
                    session={session}
                    index={index}
                    expanded={expandedCard() === session.id}
                    onNavigate={navigateToSession}
                    onArchive={archiveSession}
                    onTogglePin={togglePin}
                    onToggleExpand={toggleExpand}
                    onRename={renameSession}
                  />
                )}
              </For>
            </Show>
            <Show when={pinnedSessions().length > 0 && unpinnedSessions().length > 0}>
              <div class="col-span-2 px-0.5 pt-1">
                <span class="text-11-medium text-text-weak uppercase tracking-wider">Recent</span>
              </div>
            </Show>
            <For each={unpinnedSessions()}>
              {(session, index) => (
                <SessionCard
                  session={session}
                  index={index}
                  expanded={expandedCard() === session.id}
                  onNavigate={navigateToSession}
                  onArchive={archiveSession}
                  onTogglePin={togglePin}
                  onToggleExpand={toggleExpand}
                  onRename={renameSession}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={sessionTotal() > 0 || currentPage() > 1}>
          <div class="flex items-center justify-between mt-3 px-0.5">
            <span class="text-11-regular text-text-weak">
              {sessionTotal()} session{sessionTotal() !== 1 ? "s" : ""}
            </span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="px-2 py-1 text-11-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover rounded-md transition-colors disabled:opacity-40 disabled:cursor-default"
                disabled={currentPage() <= 1 || loading()}
                onClick={() => goToPage(currentPage() - 1)}
              >
                Previous
              </button>
              <span class="text-11-regular text-text-weak">
                {currentPage()} / {totalPages()}
              </span>
              <button
                type="button"
                class="px-2 py-1 text-11-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover rounded-md transition-colors disabled:opacity-40 disabled:cursor-default"
                disabled={currentPage() >= totalPages() || loading()}
                onClick={() => goToPage(currentPage() + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </Show>
      </Panel.Body>
    </Panel.Root>
  )
}

function SessionCard(props: {
  session: Session
  index: () => number
  expanded: boolean
  onNavigate: (session: Session) => void
  onArchive: (session: Session) => void
  onTogglePin: (session: Session) => void
  onToggleExpand: (sessionID: string) => void
  onRename: (session: Session, title: string) => void
}) {
  const params = useParams()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const notification = useNotification()

  const isActive = () => props.session.id === params.id
  const isPinned = () => props.session.pinned && props.session.pinned > 0
  const [childStore] = globalSync.child(props.session.scope.directory!)

  const sessionNotifications = createMemo(() => notification.session.unseen(props.session.id))
  const hasError = createMemo(() => sessionNotifications().some((n) => n.type === "error"))
  const hasPermissions = createMemo(() => {
    const permissions = childStore.permission?.[props.session.id] ?? []
    if (permissions.length > 0) return true
    const children = childStore.session.filter((s: Session) => s.parentID === props.session.id)
    return children.some((child: Session) => (childStore.permission?.[child.id] ?? []).length > 0)
  })
  const isWorking = createMemo(() => {
    if (isActive()) return false
    if (hasPermissions()) return false
    const status = childStore.session_status[props.session.id]
    return status?.type === "busy" || status?.type === "retry"
  })
  const updatedAt = () => props.session.time.updated ?? props.session.time.created

  const [renaming, setRenaming] = createSignal(false)
  const [renameValue, setRenameValue] = createSignal("")

  function startRename() {
    setRenameValue(props.session.title || "")
    setRenaming(true)
  }

  function commitRename() {
    const value = renameValue().trim()
    setRenaming(false)
    if (value && value !== props.session.title) {
      props.onRename(props.session, value)
    }
  }

  function cancelRename() {
    setRenaming(false)
  }

  return (
    <div
      draggable={!props.expanded}
      onDragStart={(event) => setSessionDragData(event, props.session)}
      classList={{
        "group/card relative flex flex-col rounded-xl transition-all overflow-hidden border h-[4.75rem]": true,
        "cursor-grab active:cursor-grabbing": !props.expanded,
        "bg-surface-raised-base border-border-base/30 hover:bg-surface-raised-base-hover hover:border-border-base/50 hover:-translate-y-0.5 hover:shadow-md":
          !props.expanded && !isActive(),
        "bg-surface-raised-base border-border-base/30 hover:bg-surface-raised-base-hover hover:border-border-base/50":
          !props.expanded && isActive(),
        "bg-surface-inset-base border-border-base/50 ring-1 ring-border-base/30 cursor-default": props.expanded,
        "ring-1 ring-text-interactive-base/30 border-text-interactive-base/25": isActive() && !props.expanded,
      }}
      style={{
        animation: `cardPopIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both`,
        "animation-delay": `${props.index() * 50}ms`,
      }}
      onMouseEnter={() => layout.nav.prefetchSession(props.session, "high")}
    >
      <Show
        when={props.expanded}
        fallback={
          <>
            {/* Main Clickable Area (Enters Session) */}
            <div
              class="p-3 w-full h-full cursor-pointer flex flex-col justify-between"
              onClick={() => props.onNavigate(props.session)}
            >
              <div class="flex items-start gap-2">
                <div class="mt-0.5">
                  <StatusIndicator
                    working={isWorking()}
                    permissions={hasPermissions()}
                    error={hasError()}
                    notifications={sessionNotifications().length}
                  />
                </div>
                <span
                  classList={{
                    "text-13-medium line-clamp-1 flex-1 min-w-0 pr-12": true,
                    "text-text-strong": isActive(),
                    "text-text-base": !isActive(),
                  }}
                >
                  {props.session.title || "New session"}
                </span>
              </div>

              <div class="flex items-center pl-4">
                <span class="text-11-regular text-text-weak group-hover/card:text-text-base transition-colors">
                  {relativeTime(updatedAt())}
                </span>
              </div>
            </div>

            {/* Floating Action Buttons (Top Right) */}
            <div
              class="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity z-10"
              classList={{ "opacity-100": !!isPinned() }}
            >
              {/* Pin Button */}
              <button
                type="button"
                classList={{
                  "flex items-center justify-center size-7 rounded-md transition-all duration-200 cursor-pointer": true,
                  "text-text-interactive-base bg-surface-raised-base ring-1 ring-border-interactive-base/50":
                    !!isPinned(),
                  "text-icon-weak hover:text-text-base bg-transparent hover:bg-surface-raised-base hover:shadow hover:ring-1 hover:ring-border-base":
                    !isPinned(),
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onTogglePin(props.session)
                }}
                title={isPinned() ? "Unpin session" : "Pin session"}
              >
                <Icon name="pin" size="small" />
              </button>

              {/* Settings Button */}
              <button
                type="button"
                class="flex items-center justify-center size-7 rounded-md text-icon-weak hover:text-text-base bg-transparent hover:bg-surface-raised-base hover:shadow hover:ring-1 hover:ring-border-base transition-all duration-200 cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  startRename()
                  props.onToggleExpand(props.session.id)
                }}
                title="Session settings"
              >
                <Icon name="settings" size="small" />
              </button>
            </div>
          </>
        }
      >
        {/* Edit / Management Mode (Replaces main content without changing height) */}
        <div class="p-2 w-full h-full flex flex-col justify-between" onClick={(e) => e.stopPropagation()}>
          <div class="flex items-center gap-2">
            <input
              ref={(el) => requestAnimationFrame(() => el.focus())}
              type="text"
              class="flex-1 min-w-0 px-2 py-1 rounded-md border border-border-base bg-surface-base text-13-medium text-text-strong outline-none focus:border-border-interactive-base transition-all"
              value={renameValue()}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitRename()
                  props.onToggleExpand(props.session.id)
                }
                if (e.key === "Escape") {
                  cancelRename()
                  props.onToggleExpand(props.session.id)
                }
              }}
              onBlur={() => {
                commitRename()
              }}
              placeholder="Session title"
            />
          </div>

          <div class="flex items-center justify-between px-1">
            <button
              type="button"
              class="flex items-center gap-1.5 py-1 text-11-medium text-text-weak hover:text-text-base transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                cancelRename()
                props.onToggleExpand(props.session.id)
              }}
            >
              <span>Done</span>
            </button>

            <button
              type="button"
              class="flex items-center gap-1.5 px-2 py-1 rounded text-11-medium text-text-diff-delete-weak hover:text-text-diff-delete-base hover:bg-text-diff-delete-base/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                props.onArchive(props.session)
              }}
              title="Archive session"
            >
              <Icon name="archive" size="small" />
              <span>Archive</span>
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

function StatusIndicator(props: { working: boolean; permissions: boolean; error: boolean; notifications: number }) {
  return (
    <div class="w-2.5 shrink-0 flex items-center justify-center">
      <Show when={props.working}>
        <Spinner class="size-3" />
      </Show>
      <Show when={!props.working && props.permissions}>
        <div class="size-1.5 rounded-full bg-surface-warning-strong" />
      </Show>
      <Show when={!props.working && !props.permissions && props.error}>
        <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
      </Show>
      <Show when={!props.working && !props.permissions && !props.error && props.notifications > 0}>
        <div class="size-1.5 rounded-full bg-text-interactive-base" />
      </Show>
    </div>
  )
}
