import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useLayout, SESSION_PAGE_SIZE } from "@/context/layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePanel } from "@/context/panel"
import { useNotification } from "@/context/notification"
import { Panel } from "@/components/panel"
import { getScopeLabel } from "@/utils/scope"
import { ActiveZone } from "@/components/scopes/active-zone"
import { SessionRow } from "@/components/scopes/session-row"
import { SessionToolbar } from "@/components/scopes/session-toolbar"
import { PaginationBar } from "@/components/scopes/pagination-bar"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function SessionListView(props: { worktree: string }) {
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const params = useParams()
  const panel = usePanel()
  const notification = useNotification()

  // Local pagination state — independent from the global store.session
  const [pagedSessions, setPagedSessions] = createSignal<Session[]>([])
  const [pagedTotal, setPagedTotal] = createSignal(0)
  const [search, setSearch] = createSignal("")
  const [filter, setFilter] = createSignal<"all" | "pinned">("all")
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pageSize, setPageSize] = createSignal(SESSION_PAGE_SIZE)
  const [loading, setLoading] = createSignal(false)

  let searchTimer: ReturnType<typeof setTimeout> | undefined

  function fetchPage(
    page: number,
    opts?: { searchQuery?: string; filterValue?: "all" | "pinned"; pageSizeValue?: number },
  ) {
    const dir = props.worktree
    if (!dir) return
    setLoading(true)
    const searchQuery = opts?.searchQuery ?? search()
    const filterValue = opts?.filterValue ?? filter()
    const size = opts?.pageSizeValue ?? pageSize()
    const offset = (page - 1) * size
    const sdk = createSynergyClient({ baseUrl: globalSDK.url, directory: dir, throwOnError: true })
    sdk.session
      .list({
        offset,
        limit: size,
        search: searchQuery || undefined,
        pinned: filterValue === "pinned" ? true : undefined,
      })
      .then((x) => {
        const result = x.data!
        setPagedSessions((result.data ?? []).filter((s) => !!s?.id && !s.time?.archived))
        setPagedTotal(result.total)
      })
      .catch((err) => console.error("Failed to fetch session page", err))
      .finally(() => setLoading(false))
  }

  function handleSearch(value: string) {
    setSearch(value)
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      setCurrentPage(1)
      fetchPage(1, { searchQuery: value })
    }, 300)
  }

  function handleFilterChange(value: "all" | "pinned") {
    setFilter(value)
    setCurrentPage(1)
    fetchPage(1, { filterValue: value })
  }

  function handlePageSizeChange(size: number) {
    setPageSize(size)
    setCurrentPage(1)
    fetchPage(1, { pageSizeValue: size })
  }

  function goToPage(page: number) {
    const total = totalPages()
    if (page < 1 || page > total) return
    setCurrentPage(page)
    fetchPage(page)
  }

  onMount(() => {
    layout.scopes.open(props.worktree)
    fetchPage(1)
  })

  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer)
  })

  const scope = createMemo(() =>
    layout.scopes.list().find((p) => p.worktree === props.worktree || p.sandboxes?.includes(props.worktree)),
  )

  const scopeName = createMemo(() => getScopeLabel(scope(), props.worktree))

  // Full session list from global store — for Active Zone (SSE-maintained, not paginated)
  const allSessions = createMemo(() => layout.nav.projectSessions(scope()))
  const childStore = createMemo(() => layout.nav.childStoreForScope(scope()))

  const totalPages = createMemo(() => Math.max(1, Math.ceil(pagedTotal() / pageSize())))

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
    fetchPage(currentPage())
  }

  async function togglePin(session: Session) {
    const isPinned = session.pinned && session.pinned > 0
    await layout.nav.pinSession(session, !isPinned)
    fetchPage(currentPage())
  }

  async function renameSession(session: Session, title: string) {
    await globalSDK.client.session.update({
      directory: session.scope.directory,
      sessionID: session.id,
      title,
    })
    fetchPage(currentPage())
  }

  function newSession() {
    navigate(`/${base64Encode(props.worktree)}/session`)
    panel.close()
  }

  function getSessionState(session: Session) {
    const store = childStore()
    if (!store)
      return { isWorking: false, hasPermission: false, hasError: false, hasNotification: false, notificationCount: 0 }

    const status = store.session_status[session.id]
    const isWorking = status?.type === "busy" || status?.type === "retry"
    const hasPermission = (store.permission[session.id] ?? []).length > 0
    const unseen = notification.session.unseen(session.id)
    const hasError = unseen.some((n) => n.type === "error")
    const hasNotification = unseen.length > 0
    return { isWorking, hasPermission, hasError, hasNotification, notificationCount: unseen.length }
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
          <button
            type="button"
            class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-text-interactive-base hover:bg-surface-interactive-base/8 transition-colors ml-1"
            onClick={newSession}
            title="New session"
          >
            <Icon name="plus" size="small" />
          </button>
        </Panel.HeaderRow>
      </Panel.Header>

      {/* Active Zone — real-time working/pending sessions, reads from full store */}
      <Show when={childStore()}>
        {(store) => (
          <ActiveZone
            sessions={allSessions()}
            childStore={store()}
            notification={notification}
            onSelectSession={navigateToSession}
          />
        )}
      </Show>

      {/* Toolbar — search, filter, page size */}
      <SessionToolbar
        search={search()}
        onSearch={handleSearch}
        filter={filter()}
        onFilterChange={handleFilterChange}
        pageSize={pageSize()}
        onPageSizeChange={handlePageSizeChange}
      />

      {/* Session Table — paginated, local data */}
      <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Show
          when={pagedSessions().length > 0}
          fallback={
            <Panel.Empty icon="message-square" title={search() ? `No sessions match "${search()}"` : "No sessions"} />
          }
        >
          <For each={pagedSessions()}>
            {(session, index) => {
              const state = getSessionState(session)
              const isActive = session.id === params.id
              return (
                <SessionRow
                  session={session}
                  isActive={isActive}
                  isWorking={state.isWorking}
                  hasPermission={state.hasPermission}
                  hasError={state.hasError}
                  hasNotification={state.hasNotification}
                  notificationCount={state.notificationCount}
                  even={index() % 2 === 0}
                  onSelect={() => navigateToSession(session)}
                  onTogglePin={() => togglePin(session)}
                  onArchive={() => archiveSession(session)}
                  onRename={(title) => renameSession(session, title)}
                />
              )
            }}
          </For>
        </Show>
      </div>

      {/* Sticky Pagination */}
      <Show when={pagedTotal() > 0 || currentPage() > 1}>
        <PaginationBar
          total={pagedTotal()}
          currentPage={currentPage()}
          totalPages={totalPages()}
          pageSize={pageSize()}
          onPageChange={goToPage}
          loading={loading()}
        />
      </Show>
    </Panel.Root>
  )
}
