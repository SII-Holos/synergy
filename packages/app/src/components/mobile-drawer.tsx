import { createMemo, createSignal, For, Show, onMount } from "solid-js"
import { A, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useLayout, getAvatarColors, type LocalScope, SESSION_PAGE_SIZE } from "@/context/layout"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { assetPath } from "@/utils/proxy"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { getScopeLabel, isGlobalScope } from "@/utils/scope"
import { ActiveZone } from "@/components/scopes/active-zone"
import { SessionRow } from "@/components/scopes/session-row"
import { PaginationBar } from "@/components/scopes/pagination-bar"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function MobileDrawer() {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams()
  const notification = useNotification()
  const theme = useTheme()

  const [drilldown, setDrilldown] = createSignal<LocalScope | null>(null)

  const currentDir = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  function close() {
    layout.mobileSidebar.hide()
    setDrilldown(null)
  }

  function navigateAndClose(path: string) {
    navigate(path)
    close()
  }

  return (
    <Show when={layout.mobileSidebar.opened()}>
      <div class="fixed inset-0 z-[100] flex md:hidden">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-black/40"
          style={{ animation: "mobileDrawerFadeIn 200ms ease-out both" }}
          onClick={close}
        />
        {/* Drawer panel */}
        <div
          class="relative w-[85vw] max-w-80 h-full bg-background-stronger flex flex-col shadow-2xl"
          style={{ animation: "mobileDrawerSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1) both" }}
        >
          {/* Header */}
          <div class="flex items-center justify-between px-4 h-12 shrink-0 border-b border-border-weaker-base/60">
            <A href="/" class="flex items-center gap-2" onClick={close}>
              <img
                src={theme.mode() === "dark" ? assetPath("/holos-logo-white.svg") : assetPath("/holos-logo.svg")}
                alt="Holos"
                class="size-6 shrink-0"
              />
              <span class="text-14-medium text-text-strong">Synergy</span>
            </A>
            <button
              type="button"
              class="flex items-center justify-center size-8 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
              onClick={close}
            >
              <Icon name="x" size="normal" />
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 min-h-0 overflow-y-auto">
            <Show
              when={drilldown()}
              fallback={
                <ScopeListView
                  currentDir={currentDir()}
                  onSelectScope={setDrilldown}
                  onNavigateHome={() => navigateAndClose(`/${base64Encode("global")}/session`)}
                />
              }
            >
              {(scope) => (
                <SessionListDrawerView
                  scope={scope()}
                  currentSessionID={params.id}
                  notification={notification}
                  onBack={() => setDrilldown(null)}
                  onSelectSession={(session) =>
                    navigateAndClose(`/${base64Encode(session.scope.directory!)}/session/${session.id}`)
                  }
                  onNewSession={() => navigateAndClose(`/${base64Encode(scope().worktree)}/session`)}
                />
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

function ScopeListView(props: {
  currentDir: string | undefined
  onSelectScope: (scope: LocalScope) => void
  onNavigateHome: () => void
}) {
  const layout = useLayout()
  const globalSync = useGlobalSync()

  const scopes = createMemo(() => {
    const homePath = globalSync.data.path?.home
    const seen = new Set<string>()
    return layout.scopes.list().filter((s) => {
      if (s.worktree === homePath) return false
      if (seen.has(s.worktree)) return false
      seen.add(s.worktree)
      return true
    })
  })

  const isHomeActive = createMemo(() => (props.currentDir ? isGlobalScope(props.currentDir) : false))

  return (
    <div class="py-2">
      {/* Home */}
      <button
        type="button"
        classList={{
          "w-full flex items-center gap-3 px-4 py-2.5 transition-colors": true,
          "bg-surface-interactive-base/8 text-text-interactive-base": isHomeActive(),
          "text-text-base hover:bg-surface-raised-base-hover": !isHomeActive(),
        }}
        onClick={props.onNavigateHome}
      >
        <Icon name="home" size="normal" class="shrink-0" />
        <span class="text-14-medium">Home</span>
      </button>

      {/* Divider */}
      <div class="mx-4 my-2 border-t border-border-weaker-base/60" />

      {/* Projects */}
      <div class="px-4 pb-1.5">
        <span class="text-11-medium text-text-weak uppercase tracking-wider">Projects</span>
      </div>
      <For each={scopes()}>
        {(scope) => {
          const colors = createMemo(() => getAvatarColors(scope.icon?.color))
          const isActive = createMemo(() => {
            const dir = props.currentDir
            if (!dir) return false
            return dir === scope.worktree || (scope.sandboxes ?? []).includes(dir)
          })

          return (
            <button
              type="button"
              classList={{
                "w-full flex items-center gap-3 px-4 py-2.5 transition-colors": true,
                "bg-surface-interactive-base/8": isActive(),
                "hover:bg-surface-raised-base-hover": !isActive(),
              }}
              onClick={() => props.onSelectScope(scope)}
            >
              <Avatar
                fallback={getScopeLabel(scope)}
                src={scope.icon?.url}
                size="small"
                background={colors().background}
                foreground={colors().foreground}
              />
              <span
                classList={{
                  "text-14-medium truncate": true,
                  "text-text-interactive-base": isActive(),
                  "text-text-base": !isActive(),
                }}
              >
                {getScopeLabel(scope)}
              </span>
              <Icon name="chevron-right" size="small" class="ml-auto shrink-0 text-icon-weak" />
            </button>
          )
        }}
      </For>
    </div>
  )
}

function SessionListDrawerView(props: {
  scope: LocalScope
  currentSessionID: string | undefined
  notification: ReturnType<typeof useNotification>
  onBack: () => void
  onSelectSession: (session: Session) => void
  onNewSession: () => void
}) {
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const [currentPage, setCurrentPage] = createSignal(1)
  const [loading, setLoading] = createSignal(false)
  const [pagedSessions, setPagedSessions] = createSignal<Session[]>([])
  const [pagedTotal, setPagedTotal] = createSignal(0)

  const allSessions = createMemo(() => layout.nav.projectSessions(props.scope))
  const childStore = createMemo(() => layout.nav.childStoreForScope(props.scope))
  const totalPages = createMemo(() => Math.max(1, Math.ceil(pagedTotal() / SESSION_PAGE_SIZE)))

  const scopeName = createMemo(() => getScopeLabel(props.scope))

  function fetchPage(page: number) {
    setLoading(true)
    const offset = (page - 1) * SESSION_PAGE_SIZE
    const sdk = createSynergyClient({ baseUrl: globalSDK.url, directory: props.scope.worktree, throwOnError: true })
    sdk.session
      .list({ offset, limit: SESSION_PAGE_SIZE })
      .then((x) => {
        const result = x.data!
        setPagedSessions((result.data ?? []).filter((s) => !!s?.id && !s.time?.archived))
        setPagedTotal(result.total)
      })
      .finally(() => setLoading(false))
  }

  onMount(() => fetchPage(1))

  function goToPage(page: number) {
    if (page < 1 || page > totalPages()) return
    setCurrentPage(page)
    fetchPage(page)
  }

  function getSessionState(session: Session) {
    const store = childStore()
    if (!store)
      return { isWorking: false, hasPermission: false, hasError: false, hasNotification: false, notificationCount: 0 }
    const status = store.session_status[session.id]
    const isWorking = status?.type === "busy" || status?.type === "retry"
    const hasPermission = (store.permission[session.id] ?? []).length > 0
    const unseen = props.notification.session.unseen(session.id)
    const hasError = unseen.some((n) => n.type === "error")
    const hasNotification = unseen.length > 0
    return { isWorking, hasPermission, hasError, hasNotification, notificationCount: unseen.length }
  }

  return (
    <div class="flex flex-col h-full">
      {/* Back header */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border-weaker-base/40">
        <button
          type="button"
          class="flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
          onClick={props.onBack}
        >
          <Icon name="arrow-left" size="small" />
          <span class="text-12-medium">Projects</span>
        </button>
        <span class="flex-1" />
        <span class="text-13-medium text-text-strong truncate max-w-40">{scopeName()}</span>
      </div>

      {/* New session */}
      <button
        type="button"
        class="flex items-center gap-2.5 mx-3 mt-2.5 mb-1 px-3 py-2 rounded-xl border border-dashed border-border-base/50 text-13-medium text-text-weak hover:text-text-interactive-base hover:border-text-interactive-base/30 hover:bg-surface-interactive-base/5 transition-all"
        onClick={props.onNewSession}
      >
        <Icon name="plus" size="small" />
        <span>New session</span>
      </button>

      {/* Active Zone */}
      <Show when={childStore()}>
        {(store) => (
          <ActiveZone
            sessions={allSessions()}
            childStore={store()}
            notification={props.notification}
            onSelectSession={props.onSelectSession}
          />
        )}
      </Show>

      {/* Session list */}
      <div class="flex-1 min-h-0 overflow-y-auto">
        <For each={pagedSessions()}>
          {(session) => {
            const state = getSessionState(session)
            return (
              <SessionRow
                session={session}
                isActive={session.id === props.currentSessionID}
                isWorking={state.isWorking}
                hasPermission={state.hasPermission}
                hasError={state.hasError}
                hasNotification={state.hasNotification}
                notificationCount={state.notificationCount}
                onSelect={() => props.onSelectSession(session)}
                onTogglePin={() => layout.nav.pinSession(session, !(session.pinned && session.pinned > 0))}
                onArchive={() => layout.nav.archiveSession(session)}
                onRename={(title) =>
                  globalSDK.client.session.update({ directory: session.scope.directory, sessionID: session.id, title })
                }
              />
            )
          }}
        </For>
        <Show when={pagedSessions().length === 0}>
          <div class="px-4 py-8 text-center text-13-regular text-text-weak">No sessions yet</div>
        </Show>
      </div>

      {/* Pagination */}
      <Show when={pagedTotal() > 0 || currentPage() > 1}>
        <PaginationBar
          total={pagedTotal()}
          currentPage={currentPage()}
          totalPages={totalPages()}
          pageSize={SESSION_PAGE_SIZE}
          onPageChange={goToPage}
          loading={loading()}
        />
      </Show>
    </div>
  )
}
