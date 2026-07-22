import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { FlipList } from "./flip-list"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { sidebar } from "@/locales/messages"
import { BRAND_ASSETS, brandAssetPath, holosLogoPath } from "@/utils/brand-assets"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import { useHolos } from "@/context/holos"
import { useProjectDirectoryPicker } from "@/components/dialog/project-directory-picker"
import { DialogScopeEdit } from "@/components/dialog/dialog-scope-edit"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { archiveProjectConfirm } from "@/components/dialog/confirm-copy"
import type { LocalScope, NavEntry } from "@/context/layout"
import type { HolosAccountMeta } from "@ericsanchezok/synergy-sdk/client"
import { usePlatform } from "@/context/platform"
import { useProductUpdate } from "@/context/product-update"
import { useHolosAgentActions } from "@/components/holos/agent-actions"
import { SettingsDialog } from "@/components/settings"
import { listNavigation, navigationEntryLabel, subscribeNavigation, type NavigationEntry } from "@/plugin"
import { selectAppAttention, type AppAttentionNotice } from "./app-attention"
import {
  resolveSessionVisualState,
  scopeKeyForNavEntry,
  type SessionVisualStore,
} from "@/components/sidebar/session-visual-state"
import { SidebarAttentionNotice } from "./sidebar-attention-notice"
import "./sidebar.css"
import {
  partitionScopeNavigation,
  deriveChannelAccountActions,
  type ChannelAccount,
  type ChannelAccountStatus,
} from "@/context/layout/nav"
import {
  channelAccountStatusLabel,
  channelAccountGroupLabel,
  channelAccountActionStates,
  diagnosticsFilename,
  shouldRenderChannelAccountSection,
  managedProjectRouteTarget,
} from "./channel-account-model"

const ORPHAN_CHAT_GROUP_ID = "__orphan__"

interface SidebarProps {
  onSearchOpen: () => void
}

function getStoreForEntry(
  globalSync: ReturnType<typeof useGlobalSync>,
  entry: NavEntry,
): SessionVisualStore | undefined {
  const scopeKey = scopeKeyForNavEntry(entry, globalSync.data.scope)
  if (!scopeKey) return undefined
  return globalSync.peekScopeState(scopeKey)?.[0]
}

function sessionIconClassList(visual?: { tone?: string; pulse?: boolean }) {
  const tone = visual?.tone
  return {
    "sb-session-icon-wrap": true,
    "sb-session-icon-active-tone": tone === "active",
    "sb-session-icon-waiting-tone": tone === "waiting",
    "sb-session-icon-worktree-tone": tone === "worktree",
    "sb-session-icon-muted-tone": tone === "muted",
    "sb-session-icon-blueprint-tone": tone === "blueprint",
    "sb-session-icon-blueprint-running-tone": tone === "blueprint-running",
    "sb-session-icon-blueprint-waiting-tone": tone === "blueprint-waiting",
    "sb-session-icon-blueprint-audit-tone": tone === "blueprint-audit",
    "sb-session-icon-pulse": !!visual?.pulse,
  }
}

export function Sidebar(props: SidebarProps) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const confirm = useConfirm()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const { pickProjectDirectories } = useProjectDirectoryPicker()
  const productUpdate = useProductUpdate()
  const { _ } = useLingui()

  const isExpanded = () => layout.sidebar.opened()
  const isDark = () => theme.mode() === "dark"
  const recentEntries = createMemo(() => layout.nav.recentEntries())
  const hasMoreForProject = (scope: LocalScope) => layout.nav.navEntries()[scope.worktree]?.nextCursor != null
  const hasMoreRecent = createMemo(() => layout.nav.hasMoreRecent())
  const [navigationRegistryVersion, setNavigationRegistryVersion] = createSignal(0)
  const sidebarNavigation = createMemo(() => {
    navigationRegistryVersion()
    return listNavigation("sidebar")
  })
  const isNavigationActive = (entry: NavigationEntry) =>
    entry.active?.(location.pathname) ?? location.pathname === entry.path
  const navigationIcon = (entry: NavigationEntry) =>
    entry.icon ?? (entry.iconToken ? getSemanticIcon(entry.iconToken) : getSemanticIcon("plugins.main"))
  const navigationLabel = (entry: NavigationEntry) => navigationEntryLabel(entry, _)
  const providerNames = createMemo(() =>
    Object.fromEntries([
      ...globalSync.data.provider.all.map((provider) => [provider.id, provider.name]),
      ["github", "GitHub"],
    ]),
  )
  const attention = createMemo(() =>
    selectAppAttention({
      productUpdate: productUpdate.notice(),
      authHealth: globalSync.data.provider.authHealth ?? {},
      providerNames: providerNames(),
    }),
  )

  const runAttentionAction = (notice: AppAttentionNotice) => {
    const action = notice.action
    if (action.type === "product-update") {
      void productUpdate.runNoticeAction()
      return
    }
    dialog.show(() => (
      <SettingsDialog
        initialTab={action.section}
        providerFocusID={action.section === "providers" ? action.providerID : undefined}
      />
    ))
  }

  const [recentSectionOpen, setRecentSectionOpen] = createSignal(true)
  const [homeSectionOpen, setHomeSectionOpen] = createSignal(false)
  const [channelSectionOpen, setChannelSectionOpen] = createSignal(false)
  const [feishuGroupOpen, setFeishuGroupOpen] = createSignal(true)
  const [backgroundSectionOpen, setBackgroundSectionOpen] = createSignal(false)
  const [githubSectionOpen, setGitHubSectionOpen] = createSignal(false)
  const [projectsFlyoutOpen, setProjectsFlyoutOpen] = createSignal(false)
  const [projectsSectionOpen, setProjectsSectionOpen] = createSignal(true)
  const [channelAccountsOpen, setChannelAccountsOpen] = createSignal(false)

  const managedWorktrees = createMemo(() => {
    const accounts = layout.channelProjection().channelAccounts
    return new Set(accounts.flatMap((a) => a.projects.map((p) => p.directory)))
  })
  const genericScopeWorktrees = createMemo(() => scopeWorktrees().filter((wt) => !managedWorktrees().has(wt)))

  const scopes = createMemo(() => layout.scopes.list())
  const scopeWorktrees = createMemo(() => scopes().map((scope) => scope.worktree))
  const scopeByWorktree = createMemo(() => new Map(scopes().map((scope) => [scope.worktree, scope])))

  onCleanup(subscribeNavigation(() => setNavigationRegistryVersion((version) => version + 1)))
  const hasExpandedProject = createMemo(() => scopes().some((s) => s.expanded))
  const channelEntries = createMemo(() => layout.nav.rootNavEntries("channel"))

  const channelGroupedEntries = createMemo(() => {
    const entries = channelEntries()
    const groups = new Map<string, NavEntry[]>()
    let orphanSessions: NavEntry[] = []

    for (const entry of entries) {
      const key = entry.chatId
      if (!key) {
        orphanSessions.push(entry)
        continue
      }
      const existing = groups.get(key)
      if (existing) {
        existing.push(entry)
      } else {
        groups.set(key, [entry])
      }
    }

    const result = Array.from(groups.entries())
      .map(([chatId, sessions]) => {
        const first = sessions[0]!
        const typePrefix = first.chatType === "group" ? "[G] " : first.chatType === "dm" ? "[D] " : ""
        return {
          chatId,
          name: `${typePrefix}${first.chatName ?? chatId.slice(-8)}`,
          sessions: sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
        }
      })
      .sort((a, b) => {
        const aTime = a.sessions[0]!.lastActivityAt
        const bTime = b.sessions[0]!.lastActivityAt
        return bTime - aTime
      })

    if (orphanSessions.length > 0) {
      result.push({
        chatId: ORPHAN_CHAT_GROUP_ID,
        name: _(sidebar.orphanGroup),
        sessions: orphanSessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      })
    }

    return result
  })

  const dir = createMemo(() => {
    if (params.dir) {
      try {
        return atob(params.dir)
      } catch {
        return undefined
      }
    }
    return undefined
  })
  const currentDirectory = createMemo(() => (dir() === "home" ? undefined : dir()))
  const handleChannelAccountRefresh = async (account: ChannelAccount) => {
    try {
      await globalSDK.client.channel.refreshProjects({
        channelType: account.channelType,
        accountId: account.accountId,
      })
    } catch (err) {
      console.warn("Channel account refresh failed", err)
    }
  }

  const handleChannelAccountDiagnostics = async (account: ChannelAccount) => {
    try {
      const response = await globalSDK.client.channel.downloadDiagnostics({
        channelType: account.channelType,
        accountId: account.accountId,
      })
      const data = response.data
      if (!data) return
      const blob =
        data instanceof Blob
          ? data
          : new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], {
              type: "application/x-ndjson",
            })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = diagnosticsFilename(account)
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.warn("Channel account diagnostics download failed", err)
    }
  }

  const handleNewSession = () => {
    navigate(`/${base64Encode("home")}/session`)
  }

  const handleProjectClick = (worktree: string) => {
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const handleProjectToggle = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    if (layout.scopes.isSupplemental(scope)) {
      layout.scopes.toggleSupplementalExpand(scope.worktree)
      return
    }
    if (scope.expanded) {
      layout.scopes.collapse(scope.worktree)
    } else {
      layout.scopes.expand(scope.worktree)
    }
  }

  const handleCollapseAllProjects = (e: MouseEvent) => {
    e.stopPropagation()
    for (const scope of scopes()) {
      if (scope.expanded) layout.scopes.collapse(scope.worktree)
    }
  }

  const handleProjectArchive = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    const scopeID = scope.id
    const worktree = scope.worktree
    if (!scopeID) return
    confirm.show({
      ...archiveProjectConfirm(getScopeLabel(scope)),
      onConfirm: async () => {
        await globalSDK.client.scope.remove({ path_scopeID: scopeID })
        layout.scopes.close(worktree)
      },
    })
  }

  const handleProjectEdit = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    dialog.show(() => <DialogScopeEdit scope={scope} />)
  }

  const handleProjectPlus = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    navigate(`/${base64Encode(scope.worktree)}/session`)
  }
  const handleProjectPin = (scope: LocalScope) => {
    layout.scopes.pinScope(scope)
  }

  const handleAddProject = async () => {
    const result = await pickProjectDirectories({
      title: _(sidebar.addProjectDialogTitle),
      multiple: true,
    })
    if (!result) return
    for (const dir of result.directoryPaths) {
      layout.scopes.open(dir)
    }
  }

  const handleSessionClick = (scope: LocalScope, entry: NavEntry) => {
    navigate(`/${base64Encode(scope.worktree)}/session/${entry.id}`)
  }

  const resolveEntryRouteDirectory = (entry: NavEntry): string => {
    if (entry.scopeID === "home" || entry.scopeType === "home") return "home"
    const metadata = globalSync.data.scope.find((s) => s.id === entry.scopeID)
    if (metadata?.worktree) return metadata.worktree
    return entry.scopeID
  }

  const handleNavEntryClick = (entry: NavEntry) => {
    navigate(`/${base64Encode(resolveEntryRouteDirectory(entry))}/session/${entry.id}`)
  }

  const handleFlyoutSessionClick = (entry: NavEntry, worktree: string) => {
    setProjectsFlyoutOpen(false)
    navigate(`/${base64Encode(worktree === "home" ? "home" : worktree)}/session/${entry.id}`)
  }

  return (
    <div
      classList={{
        "sb-root": true,
        "sb-collapsed": !isExpanded(),
        "sb-expanded": isExpanded(),
      }}
    >
      {/* Header: Logo + expand toggle */}
      <div class="sb-header">
        <Show
          when={isExpanded()}
          fallback={
            <Tooltip value={_(sidebar.expand)} placement="right">
              <button
                type="button"
                class="sb-collapsed-toggle"
                aria-label={_(sidebar.expand)}
                onClick={() => layout.sidebar.toggle()}
              >
                <img
                  src={holosLogoPath(isDark() ? "dark" : "light")}
                  alt={_(sidebar.logoAlt)}
                  class="sb-collapsed-logo"
                  draggable={false}
                />
                <Icon name={getSemanticIcon("app.sidebar.open")} size="normal" class="sb-collapsed-toggle-icon" />
              </button>
            </Tooltip>
          }
        >
          <A href={`/${base64Encode("home")}/session`} class="sb-logo">
            <img
              src={holosLogoPath(isDark() ? "dark" : "light")}
              alt={_(sidebar.logoAlt)}
              class="sb-logo-img"
              draggable={false}
            />
            <span class="sb-logo-text">{_(sidebar.logoAlt)}</span>
          </A>
          <div class="sb-header-actions">
            <Tooltip value={_(sidebar.search)} placement="right">
              <button type="button" class="sb-icon-btn" aria-label={_(sidebar.search)} onClick={props.onSearchOpen}>
                <Icon name={getSemanticIcon("action.search")} size="normal" />
              </button>
            </Tooltip>
            <Tooltip value={_(sidebar.collapse)} placement="right">
              <button
                type="button"
                class="sb-icon-btn"
                aria-label={_(sidebar.collapse)}
                onClick={() => layout.sidebar.toggle()}
              >
                <Icon name={getSemanticIcon("app.sidebar.close")} size="normal" />
              </button>
            </Tooltip>
          </div>
        </Show>
      </div>

      {/* Collapsed search button — only visible when sidebar is collapsed */}
      <Show when={!isExpanded()}>
        <div class="sb-collapsed-search">
          <Tooltip value={_(sidebar.search)} placement="right">
            <button type="button" class="sb-icon-btn" aria-label={_(sidebar.search)} onClick={props.onSearchOpen}>
              <Icon name={getSemanticIcon("action.search")} size="normal" />
            </button>
          </Tooltip>
        </div>
      </Show>

      {/* Action buttons */}
      <div class="sb-actions">
        <Tooltip value={_(sidebar.newSession)} placement="right">
          <button type="button" class="sb-action-btn" aria-label={_(sidebar.newSession)} onClick={handleNewSession}>
            <Icon name={getSemanticIcon("session.new")} size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">{_(sidebar.newSessionShort)}</span>
            </Show>
          </button>
        </Tooltip>
      </div>

      {/* Global feature buttons */}
      <div class="sb-globals">
        <For each={sidebarNavigation()}>
          {(entry) => (
            <Tooltip value={navigationLabel(entry)} placement="right">
              <button
                type="button"
                aria-label={navigationLabel(entry)}
                classList={{
                  "sb-global-btn": true,
                  "sb-global-active": isNavigationActive(entry),
                }}
                onClick={() => navigate(entry.path)}
              >
                <Icon name={navigationIcon(entry)} size="normal" />
                <Show when={isExpanded()}>
                  <span class="sb-action-label">{navigationLabel(entry)}</span>
                </Show>
              </button>
            </Tooltip>
          )}
        </For>
      </div>

      {/* Unified scroll region */}
      <Show
        when={isExpanded()}
        fallback={
          <div class="sb-projects-collapsed">
            <Tooltip value={_(sidebar.projects)} placement="right">
              <button
                type="button"
                aria-label={_(sidebar.projects)}
                classList={{
                  "sb-icon-btn": true,
                  "sb-projects-flyout-trigger": true,
                }}
                onClick={() => setProjectsFlyoutOpen((v) => !v)}
              >
                <Icon name={getSemanticIcon("workspace.add")} size="normal" />
              </button>
            </Tooltip>
          </div>
        }
      >
        <div class="sb-scroll">
          <Show
            when={layout.nav.scopeIndexLoaded()}
            fallback={
              <div class="flex flex-col items-center justify-center h-full min-h-[200px] gap-3">
                <Spinner class="text-text-weak size-8" />
                <span class="text-text-weak text-xs">{_(sidebar.loadingProjects)}</span>
              </div>
            }
          >
            {/* Recent */}
            <div class="sb-root-section">
              <div
                class="sb-projects-header"
                onClick={() => setRecentSectionOpen((v) => !v)}
                role="button"
                tabindex="0"
              >
                <span class="sb-section-title">{_(sidebar.recent)}</span>
                <Icon
                  name={recentSectionOpen() ? "chevron-down" : "chevron-right"}
                  size="small"
                  class="sb-section-chevron"
                />
              </div>
              <Show when={recentSectionOpen()}>
                <Show
                  when={recentEntries().length > 0}
                  fallback={<div class="sb-section-empty">{_(sidebar.noRecentSessions)}</div>}
                >
                  <SidebarSessionList
                    entries={recentEntries()}
                    activeID={params.id}
                    onSessionClick={handleNavEntryClick}
                  />
                  <Show when={hasMoreRecent()}>
                    <button type="button" class="sb-load-more-btn" onClick={() => layout.nav.loadMoreNav("__recent__")}>
                      {_(sidebar.loadMore)}
                    </button>
                  </Show>
                </Show>
              </Show>
            </div>

            {/* Home */}
            <RootNavSection
              title={_(sidebar.home)}
              open={homeSectionOpen}
              onToggle={() => setHomeSectionOpen((v) => !v)}
              entries={layout.nav.rootNavEntries("home")}
              hasMore={layout.nav.hasMoreRootNavSection("home")}
              onLoadMore={() => layout.nav.loadMoreRootNavSection("home")}
              activeID={params.id}
              onSessionClick={handleNavEntryClick}
            />

            {/* Channel */}
            <div class="sb-root-section">
              <div
                class="sb-projects-header"
                onClick={() => setChannelSectionOpen((v) => !v)}
                role="button"
                tabindex="0"
              >
                <span class="sb-section-title">{_(sidebar.channel)}</span>
                <Icon
                  name={channelSectionOpen() ? "chevron-down" : "chevron-right"}
                  size="small"
                  class="sb-section-chevron"
                />
              </div>
              <Show when={channelSectionOpen()}>
                <Show
                  when={channelGroupedEntries().length > 0}
                  fallback={<div class="sb-section-empty">{_(sidebar.noSessions)}</div>}
                >
                  <div class="sb-session-group">
                    <div
                      class="sb-session-group-header"
                      onClick={() => setFeishuGroupOpen((v) => !v)}
                      role="button"
                      tabindex="0"
                    >
                      <Icon
                        name={feishuGroupOpen() ? "chevron-down" : "chevron-right"}
                        size="small"
                        class="sb-section-chevron"
                      />
                      <span>{_(sidebar.channelFeishu)}</span>
                    </div>
                    <Show when={feishuGroupOpen()}>
                      <For each={channelGroupedEntries()}>
                        {(group) => (
                          <ChannelChatPartnerGroup
                            name={group.name}
                            sessions={group.sessions}
                            activeID={params.id}
                            onSessionClick={handleNavEntryClick}
                          />
                        )}
                      </For>
                    </Show>
                  </div>
                  <Show when={layout.nav.hasMoreRootNavSection("channel")}>
                    <button
                      type="button"
                      class="sb-load-more-btn"
                      onClick={() => layout.nav.loadMoreRootNavSection("channel")}
                    >
                      {_(sidebar.loadMore)}
                    </button>
                  </Show>
                </Show>
              </Show>
            </div>

            {/* Channel Accounts */}
            <Show when={shouldRenderChannelAccountSection(layout.channelProjection().channelAccounts)}>
              <div class="sb-root-section">
                <div
                  class="sb-projects-header"
                  onClick={() => setChannelAccountsOpen((v) => !v)}
                  role="button"
                  tabindex="0"
                >
                  <span class="sb-section-title">{_(sidebar.channelAccounts)}</span>
                  <Icon
                    name={channelAccountsOpen() ? "chevron-down" : "chevron-right"}
                    size="small"
                    class="sb-section-chevron"
                  />
                </div>
                <Show when={channelAccountsOpen()}>
                  <Show
                    when={layout.channelProjection().channelAccounts.length > 0}
                    fallback={<div class="sb-section-empty">{_(sidebar.noSessions)}</div>}
                  >
                    <For each={layout.channelProjection().channelAccounts}>
                      {(account) => (
                        <ChannelAccountGroup
                          account={account}
                          onRefresh={(acct) => void handleChannelAccountRefresh(acct)}
                          onDiagnostics={(acct) => void handleChannelAccountDiagnostics(acct)}
                          _={_}
                        />
                      )}
                    </For>
                  </Show>
                </Show>
              </div>
            </Show>

            {/* Background */}
            <RootNavSection
              title={_(sidebar.background)}
              open={backgroundSectionOpen}
              onToggle={() => setBackgroundSectionOpen((v) => !v)}
              entries={layout.nav.rootNavEntries("background")}
              hasMore={layout.nav.hasMoreRootNavSection("background")}
              onLoadMore={() => layout.nav.loadMoreRootNavSection("background")}
              activeID={params.id}
              onSessionClick={handleNavEntryClick}
            />

            {/* GitHub */}
            <Show when={layout.nav.githubConfigured()}>
              <RootNavSection
                title={_(sidebar.github)}
                open={githubSectionOpen}
                onToggle={() => setGitHubSectionOpen((value) => !value)}
                entries={layout.nav.githubEntries()}
                hasMore={layout.nav.hasMoreGitHub()}
                onLoadMore={() => layout.nav.loadMoreGitHub()}
                activeID={params.id}
                onSessionClick={handleNavEntryClick}
              />
            </Show>

            {/* Projects */}
            <div class="sb-projects">
              <div
                class="sb-projects-header"
                onClick={() => setProjectsSectionOpen((v) => !v)}
                role="button"
                tabindex="0"
              >
                <span class="sb-section-title">{_(sidebar.projects)}</span>
                <Icon
                  name={projectsSectionOpen() ? "chevron-down" : "chevron-right"}
                  size="small"
                  class="sb-section-chevron"
                />
                <span class="sb-projects-header-spacer" />
                <Show when={hasExpandedProject()}>
                  <Tooltip value={_(sidebar.collapseAllProjects)} placement="top">
                    <button
                      type="button"
                      class="sb-projects-header-expand-all"
                      aria-label={_(sidebar.collapseAllProjects)}
                      onClick={(e) => handleCollapseAllProjects(e)}
                    >
                      <Icon name={getSemanticIcon("navigation.collapse")} size="small" />
                    </button>
                  </Tooltip>
                </Show>
                <Tooltip value={_(sidebar.addProject)} placement="top">
                  <button
                    type="button"
                    class="sb-projects-header-plus"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleAddProject()
                    }}
                  >
                    <Icon name={getSemanticIcon("action.add")} size="small" />
                  </button>
                </Tooltip>
              </div>

              <Show when={projectsSectionOpen()}>
                <FlipList entries={genericScopeWorktrees()} selector="[data-scope-id]" dataKey="scopeId">
                  <For each={genericScopeWorktrees()}>
                    {(worktree) => (
                      <SidebarProjectGroup
                        scope={() => scopeByWorktree().get(worktree)}
                        activeID={params.id}
                        currentDirectory={currentDirectory()}
                        isSupplemental={(scope) => layout.scopes.isSupplemental(scope)}
                        navLoaded={(scope) => !!layout.nav.navEntries()[scope.worktree]}
                        projectNavEntries={(scope) => layout.nav.projectNavEntries(scope)}
                        hasMoreForProject={hasMoreForProject}
                        onProjectToggle={handleProjectToggle}
                        onProjectClick={handleProjectClick}
                        onProjectPlus={handleProjectPlus}
                        onProjectEdit={handleProjectEdit}
                        onProjectArchive={handleProjectArchive}
                        onProjectPin={handleProjectPin}
                        onLoadScopeNav={(scope) => layout.nav.loadScopeNav(scope.worktree)}
                        onLoadMore={(scope) => layout.nav.loadMoreNav(scope.worktree)}
                        activeSessionID={params.id}
                        onSessionClick={handleSessionClick}
                        _={_}
                      />
                    )}
                  </For>
                </FlipList>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <SidebarAttentionNotice notice={attention()} isExpanded={isExpanded()} onAction={runAttentionAction} />

      {/* Bottom: Agent Hub */}
      <SidebarAgentHub isExpanded={isExpanded()} globalSDK={globalSDK} />

      {/* Projects flyout (collapsed mode only) */}
      <Show when={!isExpanded() && projectsFlyoutOpen()}>
        <div class="sb-projects-flyout-backdrop" onClick={() => setProjectsFlyoutOpen(false)} />
        <div class="sb-projects-flyout">
          <div class="sb-flyout-header">{_(sidebar.projectsFlyout)}</div>
          <For each={scopes()}>
            {(scope) => {
              const sessions = createMemo(() => layout.nav.projectNavEntries(scope))
              return (
                <div class="sb-flyout-project-group">
                  <button
                    type="button"
                    class="sb-flyout-project-row"
                    onClick={() => {
                      setProjectsFlyoutOpen(false)
                      handleProjectClick(scope.worktree)
                    }}
                  >
                    <Icon name={getSemanticIcon("workspace.main")} size="small" />
                    <span class="sb-flyout-project-name">{getScopeLabel(scope)}</span>
                  </button>
                  <SidebarSessionList
                    entries={sessions()}
                    scope={scope}
                    activeID={params.id}
                    flyout
                    onSessionClick={(session) => handleFlyoutSessionClick(session, scope.worktree)}
                  />
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function SidebarProjectGroup(props: {
  scope: () => LocalScope | undefined
  activeID?: string
  currentDirectory?: string
  isSupplemental: (scope: LocalScope) => boolean
  navLoaded: (scope: LocalScope) => boolean
  projectNavEntries: (scope: LocalScope) => NavEntry[]
  hasMoreForProject: (scope: LocalScope) => boolean
  onProjectToggle: (event: MouseEvent, scope: LocalScope) => void
  onProjectClick: (worktree: string) => void
  onProjectPlus: (event: MouseEvent, scope: LocalScope) => void
  onProjectEdit: (event: MouseEvent, scope: LocalScope) => void
  onProjectArchive: (event: MouseEvent, scope: LocalScope) => void
  onProjectPin: (scope: LocalScope) => void
  onLoadScopeNav: (scope: LocalScope) => void
  onLoadMore: (scope: LocalScope) => void
  activeSessionID?: string
  onSessionClick: (scope: LocalScope, entry: NavEntry) => void
  _: ReturnType<typeof useLingui>["_"]
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const isSupplemental = createMemo(() => {
    const scope = props.scope()
    return scope ? props.isSupplemental(scope) : false
  })
  const navLoaded = createMemo(() => {
    const scope = props.scope()
    return scope ? props.navLoaded(scope) : false
  })
  const entries = createMemo(() => {
    const scope = props.scope()
    return scope ? props.projectNavEntries(scope) : []
  })
  const activeSessionVisible = createMemo(() => {
    const scope = props.scope()
    const activeID = props.activeSessionID
    if (!scope?.expanded || !activeID) return false
    if (isSupplemental() && !navLoaded()) return false
    return entries().some((entry) => entry.id === activeID)
  })
  const isActive = createMemo(() => {
    const scope = props.scope()
    return !!scope && scope.worktree === props.currentDirectory && !activeSessionVisible()
  })

  return (
    <Show when={props.scope()}>
      <div class="sb-project-group" data-scope-id={props.scope()?.id || props.scope()?.worktree}>
        <div
          classList={{
            "sb-project-row": true,
            "sb-project-active": isActive(),
            "sb-project-expanded": !!props.scope()?.expanded,
          }}
        >
          <button
            type="button"
            class="sb-project-chevron-btn"
            aria-label={props.scope()?.expanded ? props._(sidebar.collapseProject) : props._(sidebar.expandProject)}
            aria-expanded={props.scope()?.expanded}
            onClick={(event) => {
              const scope = props.scope()
              if (scope) props.onProjectToggle(event, scope)
            }}
          >
            <Icon name={props.scope()?.expanded ? "chevron-down" : "chevron-right"} size="small" />
          </button>
          <button
            type="button"
            class="sb-project-body"
            onClick={() => {
              const scope = props.scope()
              if (scope) props.onProjectClick(scope.worktree)
            }}
          >
            <Icon name={getSemanticIcon("workspace.main")} size="normal" class="sb-project-folder" />
            <span class="sb-project-name">{props.scope() ? getScopeLabel(props.scope()!) : ""}</span>
          </button>
          <div class="sb-project-actions">
            <button
              type="button"
              classList={{
                "sb-project-menu-btn": true,
                "sb-project-menu-active": menuOpen(),
              }}
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen((value) => !value)
              }}
            >
              <Icon name={getSemanticIcon("action.more")} size="small" />
            </button>
            <button
              type="button"
              class="sb-project-plus-btn"
              onClick={(event) => {
                const scope = props.scope()
                if (scope) props.onProjectPlus(event, scope)
              }}
            >
              <Icon name={getSemanticIcon("notes.create")} size="small" />
            </button>
            <Show when={menuOpen()}>
              <>
                <div class="sb-project-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div class="sb-project-menu">
                  <button
                    type="button"
                    class="sb-menu-item"
                    onClick={() => {
                      const scope = props.scope()
                      if (scope) {
                        setMenuOpen(false)
                        props.onProjectPin(scope)
                      }
                    }}
                  >
                    <Icon name={getSemanticIcon("action.pin")} size="small" />
                    <span>{props.scope()?.pinned ? props._(sidebar.unpin) : props._(sidebar.pin)}</span>
                  </button>
                  <button
                    type="button"
                    class="sb-menu-item"
                    onClick={(event) => {
                      const scope = props.scope()
                      if (scope) props.onProjectEdit(event, scope)
                    }}
                  >
                    <Icon name={getSemanticIcon("action.rename")} size="small" />
                    <span>{props._(sidebar.edit)}</span>
                  </button>
                  <button
                    type="button"
                    class="sb-menu-item sb-menu-item-danger"
                    onClick={(event) => {
                      const scope = props.scope()
                      if (scope) props.onProjectArchive(event, scope)
                    }}
                  >
                    <Icon name={getSemanticIcon("action.remove")} size="small" />
                    <span>{props._(sidebar.archive)}</span>
                  </button>
                </div>
              </>
            </Show>
          </div>
        </div>

        <Show when={props.scope()?.expanded}>
          <Show
            when={!isSupplemental()}
            fallback={
              <Show
                when={navLoaded()}
                fallback={
                  <div class="sb-sessions">
                    <button
                      type="button"
                      class="sb-load-more-btn"
                      onClick={() => {
                        const scope = props.scope()
                        if (scope) props.onLoadScopeNav(scope)
                      }}
                    >
                      {props._(sidebar.loadSessions)}
                    </button>
                  </div>
                }
              >
                <GroupedSessionList
                  entries={entries()}
                  scope={props.scope()}
                  activeID={props.activeID}
                  onSessionClick={(entry) => {
                    const scope = props.scope()
                    if (scope) props.onSessionClick(scope, entry)
                  }}
                />
                <Show when={props.scope() && props.hasMoreForProject(props.scope()!)}>
                  <div class="sb-sessions">
                    <button
                      type="button"
                      class="sb-load-more-btn"
                      onClick={() => {
                        const scope = props.scope()
                        if (scope) props.onLoadMore(scope)
                      }}
                    >
                      {props._(sidebar.loadMore)}
                    </button>
                  </div>
                </Show>
              </Show>
            }
          >
            <Show
              when={navLoaded()}
              fallback={
                <div class="sb-sessions">
                  <For each={Array(6)}>{() => <div class="sb-session-skeleton" />}</For>
                </div>
              }
            >
              <GroupedSessionList
                entries={entries()}
                scope={props.scope()}
                activeID={props.activeID}
                onSessionClick={(entry) => {
                  const scope = props.scope()
                  if (scope) props.onSessionClick(scope, entry)
                }}
              />
              <Show when={props.scope() && props.hasMoreForProject(props.scope()!)}>
                <div class="sb-sessions">
                  <button
                    type="button"
                    class="sb-load-more-btn"
                    onClick={() => {
                      const scope = props.scope()
                      if (scope) props.onLoadMore(scope)
                    }}
                  >
                    {props._(sidebar.loadMore)}
                  </button>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </Show>
  )
}

function SidebarSessionList(props: {
  entries: NavEntry[]
  scope?: LocalScope
  activeID?: string
  flyout?: boolean
  stopPropagation?: boolean
  onSessionClick: (entry: NavEntry) => void
}) {
  const entryIDs = createMemo(() => props.entries.map((entry) => entry.id))
  const entryByID = createMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])))

  return (
    <FlipList entries={entryIDs()} class={props.flyout ? "sb-flyout-sessions" : "sb-sessions"}>
      <For each={entryIDs()}>
        {(id) => {
          const entry = createMemo(() => entryByID().get(id))
          return (
            <Show when={entry()}>
              <SidebarSessionRow
                entry={entry()!}
                scope={props.scope}
                active={id === props.activeID}
                flyout={props.flyout}
                onClick={(event) => {
                  const navEntry = entry()
                  if (!navEntry) return
                  if (props.stopPropagation) event.stopPropagation()
                  props.onSessionClick(navEntry)
                }}
              />
            </Show>
          )
        }}
      </For>
    </FlipList>
  )
}

// --- RootNavSection: reusable collapsible section for Home / Channel / Background / GitHub ---

function RootNavSection(props: {
  title: string
  open: () => boolean
  onToggle: () => void
  entries: NavEntry[]
  hasMore: boolean
  onLoadMore: () => void
  activeID?: string
  onSessionClick: (entry: NavEntry) => void
}) {
  const { _ } = useLingui()
  return (
    <div class="sb-root-section">
      <div class="sb-projects-header" onClick={props.onToggle} role="button" tabindex="0">
        <span class="sb-section-title">{props.title}</span>
        <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
      </div>
      <Show when={props.open()}>
        <Show when={props.entries.length > 0} fallback={<div class="sb-section-empty">{_(sidebar.noSessions)}</div>}>
          <SidebarSessionList entries={props.entries} activeID={props.activeID} onSessionClick={props.onSessionClick} />
          <Show when={props.hasMore}>
            <button type="button" class="sb-load-more-btn" onClick={props.onLoadMore}>
              {_(sidebar.loadMore)}
            </button>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function GroupedSessionList(props: {
  entries: NavEntry[]
  scope?: LocalScope
  activeID?: string
  onSessionClick: (entry: NavEntry) => void
}) {
  const entries = createMemo(() => props.entries.filter((entry) => entry.category === "project"))

  return (
    <SidebarSessionList
      entries={entries()}
      scope={props.scope}
      activeID={props.activeID}
      stopPropagation
      onSessionClick={props.onSessionClick}
    />
  )
}

function ChannelChatPartnerGroup(props: {
  name: string
  sessions: NavEntry[]
  activeID?: string
  onSessionClick: (entry: NavEntry) => void
}) {
  const [open, setOpen] = createSignal(true)

  return (
    <div class="sb-channel-partner-group">
      <div class="sb-session-group-header" onClick={() => setOpen((v) => !v)} role="button" tabindex="0">
        <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
        <span>{props.name}</span>
      </div>
      <Show when={open()}>
        <SidebarSessionList entries={props.sessions} activeID={props.activeID} onSessionClick={props.onSessionClick} />
      </Show>
    </div>
  )
}

function ChannelAccountGroup(props: {
  account: ChannelAccount
  onRefresh: (account: ChannelAccount) => void
  onDiagnostics: (account: ChannelAccount) => void
  _: ReturnType<typeof useLingui>["_"]
}) {
  const navigate = useNavigate()
  const [open, setOpen] = createSignal(true)
  const actions = createMemo(() => deriveChannelAccountActions(props.account.channelType))
  const actionStates = createMemo(() => channelAccountActionStates(props.account, actions()))
  const groupLabel = createMemo(() => channelAccountGroupLabel(props.account))
  const statusLabel = createMemo(() =>
    props.account.status ? channelAccountStatusLabel(props.account.status) : undefined,
  )

  return (
    <div class="sb-channel-account-group">
      <div class="sb-channel-account-header">
        <div class="sb-session-group-header" onClick={() => setOpen((v) => !v)} role="button" tabindex="0">
          <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
          <span>{groupLabel()}</span>
          <Show when={statusLabel()}>
            <span class="sb-channel-account-status">{props._(statusLabel()!)}</span>
          </Show>
        </div>
        <div class="sb-channel-account-actions">
          <For each={actionStates()}>
            {(actionState) => (
              <Tooltip value={props._(actionState.label)} placement="top">
                <button
                  type="button"
                  class="sb-channel-account-action-btn"
                  aria-label={props._(actionState.label)}
                  disabled={actionState.disabled}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (actionState.action === "refreshProjects") {
                      props.onRefresh(props.account)
                    } else if (actionState.action === "downloadDiagnostics") {
                      props.onDiagnostics(props.account)
                    }
                  }}
                >
                  <Icon
                    name={
                      actionState.action === "refreshProjects"
                        ? getSemanticIcon("action.refresh")
                        : getSemanticIcon("action.download")
                    }
                    size="small"
                  />
                </button>
              </Tooltip>
            )}
          </For>
        </div>
      </div>
      <Show when={open()}>
        <Show
          when={props.account.projects.length > 0}
          fallback={<div class="sb-section-empty">{props._(sidebar.noSessions)}</div>}
        >
          <For each={props.account.projects}>
            {(project) => {
              const target = createMemo(() => managedProjectRouteTarget(project))
              return (
                <Show when={target()}>
                  <button
                    type="button"
                    class="sb-channel-managed-project"
                    onClick={() => {
                      const t = target()
                      if (!t) return
                      navigate(`/${base64Encode(t.worktree)}/session`)
                    }}
                  >
                    <Icon name={getSemanticIcon("workspace.main")} size="small" />
                    <span>{project.name || project.scopeID}</span>
                  </button>
                </Show>
              )
            }}
          </For>
        </Show>
      </Show>
    </div>
  )
}

function SidebarSessionRow(props: {
  entry: NavEntry
  active: boolean
  scope?: LocalScope
  flyout?: boolean
  onClick: (event: MouseEvent) => void
}) {
  const { _ } = useLingui()
  const lingui = useLingui()
  const globalSync = useGlobalSync()

  const visual = createMemo(() => {
    if (props.scope) return resolveSessionVisualState(globalSync.peekScopeState(props.scope.worktree)?.[0], props.entry)
    return resolveSessionVisualState(getStoreForEntry(globalSync, props.entry), props.entry)
  })

  const sessionTooltip = createMemo(() => {
    const v = visual()
    return v ? lingui._(v.label) : ""
  })

  return (
    <button
      type="button"
      classList={{
        "sb-session-row": !props.flyout,
        "sb-flyout-session-row": !!props.flyout,
        "sb-session-active": props.active,
      }}
      data-session-id={props.entry.id}
      onClick={props.onClick}
    >
      <span classList={{ ...sessionIconClassList(visual()) }} title={sessionTooltip()}>
        <Icon
          name={visual()?.icon ?? "loader"}
          size="small"
          class={props.flyout ? "sb-flyout-session-icon" : "sb-session-icon"}
        />
        <Show when={visual()?.completionUnread}>
          <span class="sb-session-completion-dot" />
        </Show>
      </span>
      <span class={props.flyout ? "sb-flyout-session-title" : "sb-session-title"}>
        {props.entry.title || _(sidebar.untitled)}
      </span>
    </button>
  )
}

// --- SidebarAgentHub: bottom avatar/identity trigger + dropdown menu ---

function SidebarAgentHub(props: { isExpanded: boolean; globalSDK: ReturnType<typeof useGlobalSDK> }) {
  const holos = useHolos()
  const platform = usePlatform()
  const dialog = useDialog()
  const agentActions = useHolosAgentActions(props.globalSDK)
  const { _ } = useLingui()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [agentSwitcherOpen, setAgentSwitcherOpen] = createSignal(false)
  const [holosStatusOpen, setHolosStatusOpen] = createSignal(false)

  const avatarSrc = () => holos.state.social.profile?.avatarUrl || brandAssetPath(BRAND_ASSETS.synergy.productIcon)
  const activeAgentId = () => holos.state.identity.activeAccount?.agentId ?? holos.state.identity.agentId ?? undefined
  const activeAgentShortID = () => activeAgentId()?.slice(0, 8)

  const displayName = () => {
    if (!holos.loaded) return "Synergy"
    const profileName = holos.state.social.profile?.name
    if (holos.state.identity.loggedIn && profileName) return profileName
    if (holos.state.identity.loggedIn && activeAgentShortID()) return `Agent ${activeAgentShortID()}`
    return "Synergy"
  }

  const displayDescription = () => {
    if (!holos.loaded) return _(sidebar.loadingIdentity)
    if (!holos.state.identity.loggedIn) return _(sidebar.localWorkspace)
    if (holos.state.social.profileError) return _(sidebar.profileUnavailable)
    const description = holos.state.social.profile?.description?.trim()
    if (description) return description
    return holos.state.connection.status === "connected" ? _(sidebar.connectedToHolos) : holosMenuRightLabel()
  }

  const connectionTone = () => {
    if (!holos.loaded || !holos.state.identity.loggedIn) return "muted" as const
    if (holos.state.connection.status === "connected") return "success" as const
    if (holos.state.connection.status === "connecting") return "active" as const
    if (holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected")
      return "danger" as const
    return "muted" as const
  }

  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") setMenuOpen(false)
  }

  onCleanup(() => {
    document.removeEventListener("keydown", handleEscape)
  })

  const openMenu = () => {
    setMenuOpen(true)
    document.addEventListener("keydown", handleEscape)
  }

  const closeMenu = () => {
    setMenuOpen(false)
    setAgentSwitcherOpen(false)
    setHolosStatusOpen(false)
    document.removeEventListener("keydown", handleEscape)
  }

  const toggleMenu = () => {
    if (menuOpen()) {
      closeMenu()
    } else {
      openMenu()
    }
  }
  const holosMenuRightLabel = () => {
    if (!holos.state.identity.loggedIn) return _(sidebar.signIn)
    if (holos.state.connection.status === "connected") return _(sidebar.connected)
    if (holos.state.connection.status === "connecting") return _(sidebar.connecting)
    if (holos.state.connection.status === "failed") return _(sidebar.connectionFailed)
    if (holos.state.connection.status === "disconnected") return _(sidebar.disconnected)
    if (holos.state.connection.status === "disabled") return _(sidebar.disabled)
    return _(sidebar.notAvailable)
  }

  const holosMenuDisabled = () => {
    if (!holos.loaded) return true
    if (holos.state.connection.status === "connecting") return true
    return false
  }

  const isActiveAccount = (agentId: string) => activeAgentId() === agentId

  const accountProfile = (account: HolosAccountMeta) =>
    account.profile ?? (isActiveAccount(account.agentId) ? holos.state.social.profile : undefined)

  const accountLabel = (account: HolosAccountMeta) =>
    accountProfile(account)?.name || `Agent ${account.agentId.slice(0, 8)}`

  const accountDescription = (account: HolosAccountMeta) => {
    const description = accountProfile(account)?.description?.trim()
    if (description) return description
    if (account.profileError) return _(sidebar.profileUnavailable)
    return isActiveAccount(account.agentId) ? displayDescription() : _(sidebar.savedOnDevice)
  }

  const handleSwitchAccount = async (agentId: string) => {
    await agentActions.switchAgent(agentId)
    closeMenu()
  }

  const handleHolosClick = () => {
    if (!holos.loaded) return
    closeMenu()
    void agentActions.createAgent()
  }

  const openImportExistingAgentDialog = () => {
    closeMenu()
    agentActions.importAgent()
  }

  const openSettings = (initialTab: string, providerFocusID?: string) => {
    closeMenu()
    dialog.show(() => <SettingsDialog initialTab={initialTab} providerFocusID={providerFocusID} />)
  }

  const openRepository = () => {
    closeMenu()
    platform.openLink("https://github.com/SII-Holos/synergy")
  }

  const logout = () => {
    closeMenu()
    void agentActions.logoutActiveAgent()
  }
  const showHolosStatus = () =>
    holos.state.identity.loggedIn &&
    (holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected")

  const toggleAccountCard = () => {
    if (showHolosStatus()) {
      setHolosStatusOpen((value) => !value)
      setAgentSwitcherOpen(false)
    } else if (holos.state.identity.loggedIn) {
      setAgentSwitcherOpen((value) => !value)
      setHolosStatusOpen(false)
    } else {
      setAgentSwitcherOpen((value) => !value)
      setHolosStatusOpen(false)
    }
  }

  const handleReconnect = () => {
    void agentActions.reconnect()
  }

  return (
    <div class="sidebar-account-hub">
      <Tooltip value={_(sidebar.agent)} placement="right" inactive={props.isExpanded}>
        <button
          type="button"
          aria-label={_(sidebar.agentMenu)}
          classList={{
            "sidebar-account-trigger": true,
            "sidebar-account-trigger--expanded": menuOpen(),
            "sidebar-account-trigger--collapsed": !props.isExpanded,
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          aria-controls="sidebar-account-menu"
          onClick={toggleMenu}
        >
          <span class="sidebar-account-avatarWrap" data-tone={connectionTone()}>
            <img src={avatarSrc()} alt="" class="sidebar-account-avatar" />
            <span class="sidebar-account-avatarStatus" />
          </span>
          <Show when={props.isExpanded}>
            <div class="sidebar-account-identity">
              <span class="sidebar-account-name">{displayName()}</span>
              <span class="sidebar-account-subtitle">{displayDescription()}</span>
            </div>
            <Icon name={menuOpen() ? "chevron-up" : "chevron-down"} size="small" class="sidebar-account-chevron" />
          </Show>
        </button>
      </Tooltip>

      <Show when={menuOpen()}>
        <div class="sidebar-account-menu-backdrop" onClick={closeMenu} />
        <div id="sidebar-account-menu" class="sidebar-account-menu" role="menu">
          <div class="sidebar-account-card">
            <button
              type="button"
              class="sidebar-account-card-main"
              onClick={toggleAccountCard}
              aria-expanded={agentSwitcherOpen() || holosStatusOpen()}
            >
              <span class="sidebar-account-avatarWrap" data-tone={connectionTone()}>
                <img src={avatarSrc()} alt="" class="sidebar-account-avatar" />
                <span class="sidebar-account-avatarStatus" />
              </span>
              <span class="sidebar-account-card-copy">
                <span class="sidebar-account-card-name">{displayName()}</span>
                <span class="sidebar-account-card-description">{displayDescription()}</span>
                <span class="sidebar-account-card-meta">{activeAgentShortID() ?? sidebar.noAgent.message}</span>
              </span>
              <Icon name={agentSwitcherOpen() || holosStatusOpen() ? "chevron-up" : "chevron-down"} size="small" />
            </button>
          </div>

          <Show when={agentSwitcherOpen()}>
            <div class="sidebar-account-popover" role="menu">
              <For each={holos.state.identity.accounts}>
                {(account) => (
                  <button
                    type="button"
                    classList={{
                      "sidebar-account-menuItem": true,
                      "sidebar-account-menuItem--account": true,
                      "sidebar-account-menuItem--active": isActiveAccount(account.agentId),
                    }}
                    role="menuitem"
                    onClick={() => {
                      if (!isActiveAccount(account.agentId)) {
                        void handleSwitchAccount(account.agentId)
                      }
                    }}
                  >
                    <Icon
                      name={
                        isActiveAccount(account.agentId)
                          ? getSemanticIcon("state.success")
                          : getSemanticIcon("state.empty")
                      }
                      size="small"
                    />
                    <span class="sidebar-account-menuCopy">
                      <span>{accountLabel(account)}</span>
                      <span>{accountDescription(account)}</span>
                    </span>
                  </button>
                )}
              </For>
              <button
                type="button"
                class="sidebar-account-menuItem sidebar-account-menuItem--add"
                role="menuitem"
                onClick={() => {
                  closeMenu()
                  void agentActions.createAgent()
                }}
              >
                <Icon name={getSemanticIcon("account.create")} size="small" />
                <span>{_(sidebar.createAgent)}</span>
              </button>
              <button
                type="button"
                class="sidebar-account-menuItem sidebar-account-menuItem--add"
                role="menuitem"
                onClick={openImportExistingAgentDialog}
              >
                <Icon name={getSemanticIcon("account.import")} size="small" />
                <span>{_(sidebar.importAgent)}</span>
              </button>
            </div>
          </Show>

          <Show when={holosStatusOpen()}>
            <div class="sidebar-account-popover" role="menu">
              <div class="sidebar-account-section-label">{_(sidebar.holosConnection)}</div>
              <div class="sidebar-holos-status-panel">
                <div class="sidebar-holos-status-row">
                  <Icon name={getSemanticIcon("holos.main")} size="small" />
                  <span>{_(sidebar.holosLogin)}</span>
                  <span
                    class="sidebar-account-menuStatus"
                    data-tone={holos.state.identity.loggedIn ? "success" : "muted"}
                  >
                    {holos.state.identity.loggedIn ? `Agent ${activeAgentShortID()}` : _(sidebar.notLoggedIn)}
                  </span>
                </div>
                <div class="sidebar-holos-status-row">
                  <Icon name={getSemanticIcon("providers.main")} size="small" />
                  <span>{_(sidebar.holosService)}</span>
                  <span class="sidebar-account-menuStatus" data-tone={connectionTone()}>
                    {holosMenuRightLabel()}
                  </span>
                </div>
                <Show when={holos.state.connection.error}>
                  <div class="sidebar-holos-status-error">{holos.state.connection.error}</div>
                </Show>
                <Show when={showHolosStatus()}>
                  <button
                    type="button"
                    class="sidebar-account-menuItem sidebar-holos-reconnect-btn"
                    role="menuitem"
                    onClick={handleReconnect}
                  >
                    <Icon name={getSemanticIcon("action.refresh")} size="small" />
                    <span>{_(sidebar.reconnect)}</span>
                  </button>
                </Show>
              </div>
            </div>
          </Show>

          <Show
            when={holos.state.identity.loggedIn}
            fallback={
              <>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  disabled={holosMenuDisabled()}
                  onClick={handleHolosClick}
                >
                  <Icon name={getSemanticIcon("account.create")} size="small" />
                  <span>{_(sidebar.createAgent)}</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={openImportExistingAgentDialog}
                >
                  <Icon name={getSemanticIcon("account.import")} size="small" />
                  <span>{_(sidebar.importAgent)}</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={() => openSettings("general")}
                >
                  <Icon name={getSemanticIcon("settings.general")} size="small" />
                  <span>{_(sidebar.settings)}</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={() => openSettings("providers")}
                >
                  <Icon name={getSemanticIcon("providers.main")} size="small" />
                  <span>{_(sidebar.providers)}</span>
                </button>
                <button type="button" class="sidebar-account-menuItem" role="menuitem" onClick={openRepository}>
                  <Icon name={getSemanticIcon("github.main")} size="small" />
                  <span>{_(sidebar.repository)}</span>
                  <Icon name={getSemanticIcon("action.open")} size="small" class="sidebar-account-menuTrailingIcon" />
                </button>
              </>
            }
          >
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("account")}
            >
              <Icon name={getSemanticIcon("settings.account")} size="small" />
              <span>{_(sidebar.account)}</span>
            </button>
            <Show when={showHolosStatus()}>
              <button type="button" class="sidebar-account-menuItem" role="menuitem" onClick={handleReconnect}>
                <Icon name={getSemanticIcon("action.refresh")} size="small" />
                <span>{_(sidebar.reconnect)}</span>
              </button>
            </Show>
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("general")}
            >
              <Icon name={getSemanticIcon("settings.general")} size="small" />
              <span>{_(sidebar.settings)}</span>
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("providers")}
            >
              <Icon name={getSemanticIcon("providers.main")} size="small" />
              <span>{_(sidebar.providers)}</span>
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("usage")}
            >
              <Icon name={getSemanticIcon("settings.usage")} size="small" />
              <span>{_(sidebar.usage)}</span>
            </button>
            <button type="button" class="sidebar-account-menuItem" role="menuitem" onClick={openRepository}>
              <Icon name={getSemanticIcon("github.main")} size="small" />
              <span>{_(sidebar.repository)}</span>
              <Icon name={getSemanticIcon("action.open")} size="small" class="sidebar-account-menuTrailingIcon" />
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem sidebar-account-menuItem--danger"
              role="menuitem"
              onClick={logout}
            >
              <Icon name={getSemanticIcon("account.logout")} size="small" />
              <span>{_(sidebar.logout)}</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
