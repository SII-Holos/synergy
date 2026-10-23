import { runtimeFeatureAvailable } from "@/components/runtime-features"
import { createMemo, createSignal, For, Show, onMount } from "solid-js"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useLayout, type LocalScope, type NavEntry, SESSION_PAGE_SIZE } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useNotification } from "@/context/notification"
import { useWorkbenchPanels } from "@/context/workbench"
import { holosLogoPath } from "@/utils/brand-assets"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { getScopeLabel, isHomeScope, resolveProjectScope } from "@/utils/scope"
import { isWorkingStatus } from "@/utils/session-status"
import { ActiveZone } from "@/components/scopes/active-zone"
import { sessionScopeRequestFor } from "@/components/session/session-actions"
import { SessionRow } from "@/components/scopes/session-row"
import { PaginationBar } from "@/components/scopes/pagination-bar"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { archiveSessionConfirm } from "@/components/dialog/confirm-copy"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { appShell, sidebar } from "@/locales/messages"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { SettingsDialog } from "@/components/settings"
import { useProjectDirectoryPicker } from "@/components/dialog/project-directory-picker"
import {
  MobileDrawerAddProjectButton,
  MobileDrawerAccountRow,
  MobileDrawerRecent,
  MobileDrawerSettingsButton,
  type MobileDrawerRecentVisual,
} from "./mobile-drawer-root"
import { resolveSessionVisualState } from "@/components/sidebar/session-visual-state"
import { resolveAccountIdentity, type AccountIdentityLabels } from "@/components/holos/account-identity"
import { useHolos } from "@/context/holos"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { useNewTaskNavigation } from "@/components/session/welcome/context"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { MobileDrawerDialog } from "./mobile-drawer-dialog"

export function MobileDrawer(props: { onSearchOpen: () => void }) {
  const layout = useLayout()
  const navigate = useNavigate()
  const newTask = useNewTaskNavigation(navigate)
  const params = useParams()
  const notification = useNotification()
  const theme = useTheme()
  const { _ } = useLingui()

  const [drilldown, setDrilldown] = createSignal<LocalScope | null>(null)

  const currentDir = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  function close() {
    layout.mobileSidebar.hide()
  }

  function navigateAndClose(path: string) {
    navigate(path)
    close()
  }

  // The desktop sidebar starts a task through `newTask`, which also rotates the
  // welcome scene. Navigating to the same route alone would leave a phone user
  // on an unchanged new-task screen with no feedback for the tap.
  function startNewTask(scopeKey: string) {
    newTask(base64Encode(scopeKey))
    close()
  }

  return (
    <MobileDrawerDialog
      open={layout.mobileSidebar.opened()}
      label={_(appShell.navLabel)}
      onClose={close}
      onClosed={() => setDrilldown(null)}
    >
      <div class="mobile-drawer-header safe-top">
        <A href="/" class="mobile-drawer-brand" onClick={close}>
          <img
            src={holosLogoPath(theme.mode())}
            alt={_({ id: "brand.logo.alt", message: "Holos" })}
            class="size-5 shrink-0"
          />
          <div class="flex flex-col">
            <span class="mobile-drawer-label text-text-strong">{_(sidebar.logoAlt)}</span>
            <span class="text-10-regular text-text-weak">
              {_({ id: "brand.workbench.synergy", message: "Synergy workspace" })}
            </span>
          </div>
        </A>
        <button
          type="button"
          data-action="search"
          aria-label={_(appShell.search)}
          class="mobile-drawer-action mobile-drawer-icon-action"
          onClick={() => {
            close()
            props.onSearchOpen()
          }}
        >
          <Icon name={getSemanticIcon("action.search")} size="normal" />
        </button>
        <button
          autofocus
          data-action="close"
          type="button"
          aria-label={_(appShell.closeNav)}
          class="mobile-drawer-action mobile-drawer-icon-action"
          onClick={close}
        >
          <Icon name={getSemanticIcon("action.close")} size="normal" />
        </button>
      </div>

      <div class="flex flex-col flex-1 min-h-0 safe-bottom">
        <Show
          when={drilldown()}
          fallback={
            <ScopeListView
              currentDir={currentDir()}
              onSelectScope={setDrilldown}
              onNavigateHome={() => navigateAndClose(`/${base64Encode("home")}/session`)}
              onNewSession={() => startNewTask(currentDir() ?? "home")}
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
                const scopeKey = session.scope.type === "home" ? "home" : session.scope.id!
                navigateAndClose(`/${base64Encode(scopeKey)}/session/${session.id}`)
              }}
              onNewSession={() => startNewTask(scope().id)}
              onClose={close}
            />
          )}
        </Show>
      </div>
    </MobileDrawerDialog>
  )
}

type DrawerDestinationID = "agenda" | "library" | "performance" | "plugins" | "kanban"
type DrawerPanelID = "notes" | "browser"

const DRAWER_DESTINATIONS: { id: DrawerDestinationID; icon: SemanticIconTokenName; href: string }[] = [
  { id: "agenda", icon: "agenda.main", href: "/agenda" },
  { id: "library", icon: "library.main", href: "/library" },
  { id: "performance", icon: "performance.main", href: "/performance" },
  { id: "plugins", icon: "plugins.main", href: "/plugins/marketplace" },
  { id: "kanban", icon: "kanban.main", href: "/kanban" },
]

const DRAWER_PANELS: { id: DrawerPanelID; icon: SemanticIconTokenName }[] = [
  { id: "notes", icon: "notes.main" },
  { id: "browser", icon: "browser.main" },
]

function ScopeListView(props: {
  currentDir: string | undefined
  onSelectScope: (scope: LocalScope) => void
  onNavigateHome: () => void
  onNewSession: () => void
  onClose: () => void
}) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const workbench = useWorkbenchPanels()
  const { _ } = useLingui()
  const dialog = useDialog()
  const { pickProjectDirectories } = useProjectDirectoryPicker()
  const accountLabels = (): AccountIdentityLabels => ({
    product: _({ id: "brand.workbench.synergy", message: "Synergy workspace" }),
    holosAccount: _({ id: "sidebar.account.holos", message: "HOLOS account" }),
    loading: _(sidebar.loadingIdentity),
    signedOut: _({ id: "sidebar.account.signedOut", message: "Not signed in · local workspace" }),
    profileUnavailable: _(sidebar.profileUnavailable),
    connectedToHolos: _(sidebar.connectedToHolos),
    connecting: _(sidebar.connecting),
    failed: _(sidebar.connectionFailed),
    disconnected: _(sidebar.disconnected),
    disabled: _(sidebar.disabled),
    unavailable: _(sidebar.notAvailable),
  })
  // Derived strings are produced inside the reactive accessor; building them
  // once at mount pins the mount-time locale and the row stops following a
  // locale switch while the rest of the drawer updates.
  const account = () =>
    resolveAccountIdentity({
      hasHolos: globalSDK.capabilities.has("holos"),
      loaded: holos.loaded,
      state: holos.state,
      labels: accountLabels(),
    })
  const accountAvatar = () => account().avatarUrl || brandAssetPath(BRAND_ASSETS.synergy.productIcon)
  const toolLabel = (id: DrawerDestinationID | DrawerPanelID) => {
    if (id === "agenda") return _(appShell.agenda)
    if (id === "library") return _(appShell.library)
    if (id === "performance") return _(appShell.performance)
    if (id === "plugins") return _(appShell.plugins)
    if (id === "kanban") return _(appShell.kanban)
    if (id === "notes") return _(appShell.notes)
    return _(appShell.browser)
  }

  // The typed wrapper keeps the dynamic descriptor call statically resolvable
  // for the localization contract (see script/localization-check.ts).
  const translateSessionState = (descriptor: MessageDescriptor) => _(descriptor)
  const recentVisualFor = (entry: NavEntry): MobileDrawerRecentVisual => {
    const visual = resolveSessionVisualState({
      entry,
      status: globalSync.sessionStatus[entry.id],
      waiting: (globalSync.permissions[entry.id]?.length ?? 0) > 0 || (globalSync.questions[entry.id]?.length ?? 0) > 0,
      runningChildTasks: globalSync.cortex.some(
        (task) => task.parentSessionID === entry.id && task.status === "running",
      ),
    })
    const meaningful = visual.completionUnread || visual.tone !== "default"
    return { visual, label: meaningful ? translateSessionState(visual.label) : "" }
  }

  const resolveEntryRouteDirectory = (entry: NavEntry) => {
    if (entry.scopeID === "home" || entry.scopeType === "home") return "home"
    return globalSync.data.scope.find((scope) => scope.id === entry.scopeID)?.id ?? entry.scopeID
  }

  const selectRecentSession = (entry: NavEntry) => {
    navigate(`/${base64Encode(resolveEntryRouteDirectory(entry))}/session/${entry.id}`)
    props.onClose()
  }

  const addProjects = async () => {
    const result = await pickProjectDirectories({
      title: _(sidebar.addProjectDialogTitle),
      multiple: true,
    })
    if (!result) return
    await Promise.all(result.directoryPaths.map((directory) => layout.scopes.open(directory)))
  }

  const openProjectPicker = () => {
    props.onClose()
    void addProjects()
  }

  const openSettings = (initialTab: "general" | "account") => {
    dialog.push(() => <SettingsDialog initialTab={initialTab} />)
  }

  const scopes = createMemo(() => {
    const homePath = globalSync.data.paths?.home
    const seen = new Set<string>()
    return layout.scopes.list().filter((s) => {
      if (s.id === homePath) return false
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
  })

  const isHomeActive = createMemo(() => (props.currentDir ? isHomeScope(props.currentDir) : false))

  const activeProjectScope = createMemo(() =>
    props.currentDir ? resolveProjectScope(props.currentDir, undefined, scopes()) : undefined,
  )
  const destinations = createMemo(() =>
    DRAWER_DESTINATIONS.filter((tool) => runtimeFeatureAvailable("navigation", tool.id, globalSDK.capabilities.has)),
  )
  const panels = createMemo(() => DRAWER_PANELS.filter((panel) => !!workbench.getPanel(panel.id)))

  return (
    <div class="mobile-drawer-root">
      <div class="shrink-0 px-4 pb-2">
        <button
          type="button"
          data-action="new-session"
          class="mobile-drawer-action w-full"
          onClick={props.onNewSession}
        >
          <Icon name={getSemanticIcon("session.new")} size="normal" />
          <span>{_(appShell.newSession)}</span>
        </button>
      </div>
      <div class="mobile-drawer-scroll">
        <Tabs defaultValue="recent" class="navigation-collections" variant="pill">
          <Tabs.List aria-label={_(appShell.navLabel)}>
            <Tabs.Trigger value="recent">{_(sidebar.recent)}</Tabs.Trigger>
            <Tabs.Trigger value="projects">{_(sidebar.projects)}</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="recent">
            <MobileDrawerRecent
              label={_(sidebar.recent)}
              emptyLabel={_(sidebar.noRecentSessions)}
              loadMoreLabel={_(sidebar.loadMore)}
              untitledLabel={_(sidebar.untitled)}
              draftLabel={_(sidebar.draftBadge)}
              hasDraft={(id) => globalSDK.drafts.hasDraftSession(id)}
              entries={layout.nav.recentEntries()}
              currentSessionID={params.id}
              visualFor={recentVisualFor}
              hasMore={layout.nav.hasMoreRecent()}
              onSelect={selectRecentSession}
              onLoadMore={() => void layout.nav.loadMoreNav("__recent__")}
              groups={{ pinned: _(appShell.pinned), today: _(appShell.today), earlier: _(appShell.earlier) }}
            />
          </Tabs.Content>
          <Tabs.Content value="projects">
            <div class="px-4">
              <button
                type="button"
                class="mobile-drawer-action w-full"
                aria-current={isHomeActive() ? "page" : undefined}
                onClick={props.onNavigateHome}
              >
                <Icon name={getSemanticIcon("navigation.home")} size="normal" class="shrink-0" />
                <span>{_(appShell.home)}</span>
              </button>

              <div class="py-1">
                <MobileDrawerAddProjectButton label={_(sidebar.addProject)} onClick={openProjectPicker} />
              </div>

              <For each={scopes()}>
                {(scope) => {
                  const isActive = createMemo(() => activeProjectScope()?.id === scope.id)

                  return (
                    <button
                      type="button"
                      class="mobile-drawer-action w-full"
                      aria-current={isActive() ? "page" : undefined}
                      onClick={() => props.onSelectScope(scope)}
                    >
                      <Icon name={getSemanticIcon("workspace.main")} size="normal" class="shrink-0" />
                      <span class="truncate">{getScopeLabel(scope)}</span>
                      <Icon
                        name={getSemanticIcon("navigation.expand")}
                        size="small"
                        class="ml-auto shrink-0 text-icon-weak-base"
                      />
                    </button>
                  )
                }}
              </For>
            </div>
          </Tabs.Content>
        </Tabs>
        <div class="mobile-drawer-footer">
          <Show when={destinations().length > 0}>
            <nav class="mobile-drawer-tools" aria-label={_(appShell.toolsSection)}>
              <For each={destinations()}>
                {(tool) => (
                  <A
                    href={tool.href}
                    class="mobile-drawer-action"
                    aria-current={
                      (
                        tool.id === "plugins"
                          ? location.pathname.startsWith("/plugins")
                          : location.pathname === tool.href
                      )
                        ? "page"
                        : undefined
                    }
                    onClick={props.onClose}
                  >
                    <Icon name={getSemanticIcon(tool.icon)} size="normal" />
                    <span>{toolLabel(tool.id)}</span>
                  </A>
                )}
              </For>
            </nav>
          </Show>
          <Show when={panels().length > 0}>
            <div
              class="mobile-drawer-panels"
              role="group"
              aria-label={_({ id: "app.shell.mobile.panels.label", message: "Workspace panels" })}
            >
              <div class="mobile-drawer-section-label" aria-hidden="true">
                {_({ id: "app.shell.mobile.panels.label", message: "Workspace panels" })}
              </div>
              <div class="mobile-drawer-tools">
                <For each={panels()}>
                  {(tool) => {
                    const isDisabled = createMemo(() => tool.id === "browser" && !params.id)
                    const isActive = createMemo(() => {
                      if (isDisabled()) return false
                      const side = workbench.surface("side")
                      return side.opened() && side.activeTab()?.panelId === tool.id
                    })

                    return (
                      <button
                        type="button"
                        disabled={isDisabled()}
                        class="mobile-drawer-action"
                        aria-pressed={isActive()}
                        onClick={() => {
                          if (isDisabled()) return
                          void workbench.openPanel(tool.id, { reuseExisting: true })
                          props.onClose()
                        }}
                      >
                        <Icon name={getSemanticIcon(tool.icon)} size="normal" />
                        <span>{toolLabel(tool.id)}</span>
                      </button>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <div class="mobile-drawer-account">
        <MobileDrawerAccountRow
          name={account().name}
          description={account().description}
          avatarSrc={accountAvatar()}
          onClick={globalSDK.capabilities.has("holos") ? () => openSettings("account") : undefined}
        />
        <MobileDrawerSettingsButton label={_(sidebar.settings)} onClick={() => openSettings("general")} />
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
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { _ } = useLingui()
  const [currentPage, setCurrentPage] = createSignal(1)
  const [loading, setLoading] = createSignal(false)
  const [pagedSessions, setPagedSessions] = createSignal<Session[]>([])
  const [pagedTotal, setPagedTotal] = createSignal(0)

  const allSessions = createMemo(() => layout.nav.projectSessions(props.scope))
  const totalPages = createMemo(() => Math.max(1, Math.ceil(pagedTotal() / SESSION_PAGE_SIZE)))

  const scopeName = createMemo(() => getScopeLabel(props.scope))

  function fetchPage(page: number) {
    setLoading(true)
    const offset = (page - 1) * SESSION_PAGE_SIZE
    const sdk = createSynergyClient({ baseUrl: globalSDK.url, scopeID: props.scope.id, throwOnError: true })
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
    const isWorking = isWorkingStatus(globalSync.sessionStatus[session.id])
    const hasPermission = (globalSync.permissions[session.id]?.length ?? 0) > 0
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
          const nextScopeKey = nextSession.scope.type === "home" ? "home" : nextSession.scope.id!
          navigate(`/${base64Encode(nextScopeKey)}/session/${nextSession.id}`)
        } else {
          const scopeKey = session.scope.type === "home" ? "home" : session.scope.id!
          navigate(`/${base64Encode(scopeKey)}/session`)
        }
        props.onClose()
      },
    })
  }

  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-2 px-4 py-2 border-b border-border-weaker-base/40">
        <button type="button" class="mobile-drawer-action" onClick={props.onBack}>
          <Icon name={getSemanticIcon("navigation.back")} size="normal" />
          <span>{_(appShell.projects)}</span>
        </button>
        <span class="flex-1" />
        <span class="mobile-drawer-label text-text-strong truncate max-w-40">{scopeName()}</span>
      </div>

      <button type="button" class="mobile-drawer-action mx-4 my-2" onClick={props.onNewSession}>
        <Icon name={getSemanticIcon("session.new")} size="normal" />
        <span>{_(appShell.newSession)}</span>
      </button>

      <ActiveZone
        sessions={allSessions()}
        runtime={globalSync}
        notification={props.notification}
        onSelectSession={props.onSelectSession}
      />

      <div class="flex-1 min-h-0 overflow-y-auto">
        <For each={pagedSessions()}>
          {(session) => {
            const state = getSessionState(session)
            return (
              <SessionRow
                session={session}
                hasDraft={globalSDK.drafts.hasDraftSession(session.id)}
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
                  globalSDK.client.session.update({
                    ...sessionScopeRequestFor(session),
                    sessionID: session.id,
                    title,
                  })
                }
              />
            )
          }}
        </For>
        <Show when={pagedSessions().length === 0}>
          <div class="mobile-drawer-label px-4 py-8 text-center text-text-weak">{_(appShell.noSessions)}</div>
        </Show>
      </div>

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
