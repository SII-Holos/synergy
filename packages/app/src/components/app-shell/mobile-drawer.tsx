import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useLayout, type LocalScope, SESSION_PAGE_SIZE } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { useWorkbenchPanels } from "@/context/workbench"
import { holosLogoPath } from "@/utils/brand-assets"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { getScopeLabel, isHomeScope } from "@/utils/scope"
import { ActiveZone } from "@/components/scopes/active-zone"
import { SessionRow } from "@/components/scopes/session-row"
import { PaginationBar } from "@/components/scopes/pagination-bar"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { archiveSessionConfirm } from "@/components/dialog/confirm-copy"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"

export function MobileDrawer() {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams()
  const notification = useNotification()
  const theme = useTheme()

  const [drilldown, setDrilldown] = createSignal<LocalScope | null>(null)
  let drawerRef!: HTMLDivElement
  let closeButtonRef!: HTMLButtonElement

  const currentDir = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  function close() {
    layout.mobileSidebar.hide()
    setDrilldown(null)
  }

  function navigateAndClose(path: string) {
    navigate(path)
    close()
  }

  createEffect(() => {
    if (!layout.mobileSidebar.opened()) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    queueMicrotask(() => closeButtonRef?.focus())

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== "Tab") return

      const focusable = Array.from(
        drawerRef.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown)
      previousFocus?.focus()
    })
  })

  return (
    <Show when={layout.mobileSidebar.opened()}>
      <div class="fixed inset-0 z-[100] flex md:hidden">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-surface-overlay"
          style={{ animation: "mobileDrawerFadeIn 200ms ease-out both" }}
          onClick={close}
        />
        {/* Drawer panel */}
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          class="relative w-[85vw] max-w-80 h-full bg-background-stronger flex flex-col shadow-2xl safe-left"
          style={{ animation: "mobileDrawerSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1) both" }}
        >
          {/* Header */}
          <div class="flex items-center justify-between px-4 h-12 shrink-0 border-b border-border-weaker-base/60 safe-top">
            <A href="/" class="flex items-center gap-2" onClick={close}>
              <img src={holosLogoPath(theme.mode())} alt="Holos" class="size-6 shrink-0" />
              <span class="text-14-medium text-text-strong">Synergy</span>
            </A>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close navigation"
              class="flex items-center justify-center size-8 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
              onClick={close}
            >
              <Icon name={getSemanticIcon("action.close")} size="normal" />
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 min-h-0 overflow-y-auto safe-bottom">
            <Show
              when={drilldown()}
              fallback={
                <ScopeListView
                  currentDir={currentDir()}
                  onSelectScope={setDrilldown}
                  onNavigateHome={() => navigateAndClose(`/${base64Encode("home")}/session`)}
                  onClose={close}
                />
              }
            >
              {(scope) => (
                <SessionListDrawerView
                  scope={scope()}
                  currentSessionID={params.id}
                  notification={notification}
                  onBack={() => setDrilldown(null)}
                  onSelectSession={(session) => {
                    const scopeKey = session.scope.type === "home" ? "home" : session.scope.directory!
                    navigateAndClose(`/${base64Encode(scopeKey)}/session/${session.id}`)
                  }}
                  onNewSession={() => navigateAndClose(`/${base64Encode(scope().worktree)}/session`)}
                  onClose={close}
                />
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

interface DrawerTool {
  id: string
  label: string
  icon: SemanticIconTokenName
  href?: string
  panelId?: string
}

const DRAWER_TOOLS: DrawerTool[] = [
  { id: "agenda", label: "Agenda", icon: "agenda.main", href: "/agenda" },
  { id: "library", label: "Library", icon: "library.main", href: "/library" },
  { id: "performance", label: "Performance", icon: "performance.main", href: "/performance" },
  { id: "plugins", label: "Plugins", icon: "plugins.main", href: "/plugins/marketplace" },
  { id: "notes", label: "Notes", icon: "notes.main", panelId: "notes" },
  { id: "browser", label: "Browser", icon: "browser.main", panelId: "browser" },
]

function ScopeListView(props: {
  currentDir: string | undefined
  onSelectScope: (scope: LocalScope) => void
  onNavigateHome: () => void
  onClose: () => void
}) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const workbench = useWorkbenchPanels()

  const scopes = createMemo(() => {
    const homePath = globalSync.data.paths?.home
    const seen = new Set<string>()
    return layout.scopes.list().filter((s) => {
      if (s.worktree === homePath) return false
      if (seen.has(s.worktree)) return false
      seen.add(s.worktree)
      return true
    })
  })

  const isHomeActive = createMemo(() => (props.currentDir ? isHomeScope(props.currentDir) : false))

  return (
    <div class="py-2">
      {/* Home */}
      <button
        type="button"
        classList={{
          "w-full flex items-center gap-3 px-4 py-2.5 transition-colors": true,
          "bg-surface-raised-base-hover text-text-strong": isHomeActive(),
          "text-text-base hover:bg-surface-raised-base-hover": !isHomeActive(),
        }}
        onClick={props.onNavigateHome}
      >
        <Icon name={getSemanticIcon("navigation.home")} size="normal" class="shrink-0" />
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
                "bg-surface-raised-base-hover": isActive(),
                "hover:bg-surface-raised-base-hover": !isActive(),
              }}
              onClick={() => props.onSelectScope(scope)}
            >
              <Icon name={getSemanticIcon("workspace.main")} size="normal" class="shrink-0" />
              <span
                classList={{
                  "text-14-medium truncate": true,
                  "text-text-strong": isActive(),
                  "text-text-base": !isActive(),
                }}
              >
                {getScopeLabel(scope)}
              </span>
              <Icon
                name={getSemanticIcon("navigation.expand")}
                size="small"
                class="ml-auto shrink-0 text-icon-weak-base"
              />
            </button>
          )
        }}
      </For>

      {/* Divider */}
      <div class="mx-4 my-2 border-t border-border-weaker-base/60" />

      {/* Tools */}
      <div class="px-4 pb-1.5">
        <span class="text-11-medium text-text-weak uppercase tracking-wider">Tools</span>
      </div>
      <div class="grid grid-cols-3 gap-1 px-3 pb-2">
        <For each={DRAWER_TOOLS}>
          {(tool) => {
            const hasSession = createMemo(() => !!params.id)
            const isDisabled = createMemo(() => tool.panelId === "browser" && !hasSession())
            const isActive = createMemo(() => {
              if (isDisabled()) return false
              if (tool.panelId) {
                const side = workbench.surface("side")
                return side.opened() && side.activeTab()?.panelId === tool.panelId
              }
              if (tool.id === "plugins") return location.pathname.startsWith(tool.href ?? "")
              return location.pathname === tool.href
            })

            return (
              <button
                type="button"
                disabled={isDisabled()}
                classList={{
                  "flex flex-col items-center gap-1 py-2.5 rounded-xl transition-colors": true,
                  "bg-surface-raised-base-hover text-text-strong": isActive(),
                  "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                    !isActive() && !isDisabled(),
                  "opacity-50 cursor-not-allowed": isDisabled(),
                }}
                onClick={() => {
                  if (isDisabled()) return
                  if (tool.panelId) {
                    void workbench.openPanel(tool.panelId, { reuseExisting: true })
                    props.onClose()
                    return
                  }
                  navigate(tool.href!)
                  props.onClose()
                }}
              >
                <Icon name={getSemanticIcon(tool.icon)} size="normal" />
                <span class="text-[10px] font-medium leading-none">{tool.label}</span>
              </button>
            )
          }}
        </For>
      </div>
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
  onClose: () => void
}) {
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const navigate = useNavigate()
  const confirm = useConfirm()
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
    const isWorking = status?.type === "busy" || status?.type === "retry" || status?.type === "recovering"
    const hasPermission = (store.permission[session.id] ?? []).length > 0
    const unseen = props.notification.session.unseen(session.id)
    const hasError = unseen.some((n) => n.type === "error")
    const hasNotification = unseen.length > 0
    return { isWorking, hasPermission, hasError, hasNotification, notificationCount: unseen.length }
  }

  function archiveSession(session: Session) {
    confirm.show({
      ...archiveSessionConfirm(session.title),
      onConfirm: async () => {
        const nextSession = await layout.nav.archiveSession(session)
        setPagedSessions((prev) => prev.filter((item) => item.id !== session.id))
        setPagedTotal((prev) => Math.max(0, prev - 1))
        fetchPage(currentPage())

        if (session.id !== props.currentSessionID) return
        if (nextSession) {
          const nextScopeKey = nextSession.scope.type === "home" ? "home" : nextSession.scope.directory!
          navigate(`/${base64Encode(nextScopeKey)}/session/${nextSession.id}`)
        } else {
          const scopeKey = session.scope.type === "home" ? "home" : session.scope.directory!
          navigate(`/${base64Encode(scopeKey)}/session`)
        }
        props.onClose()
      },
    })
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
          <Icon name={getSemanticIcon("navigation.back")} size="small" />
          <span class="text-12-medium">Projects</span>
        </button>
        <span class="flex-1" />
        <span class="text-13-medium text-text-strong truncate max-w-40">{scopeName()}</span>
      </div>

      {/* New session */}
      <button
        type="button"
        class="flex items-center gap-2.5 mx-3 mt-2.5 mb-1 px-3 py-2 rounded-xl border border-dashed border-border-base/50 text-13-medium text-text-weak hover:text-text-strong hover:border-border-base hover:bg-surface-raised-base-hover transition-all"
        onClick={props.onNewSession}
      >
        <Icon name={getSemanticIcon("action.add")} size="small" />
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
                onArchive={() => archiveSession(session)}
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
