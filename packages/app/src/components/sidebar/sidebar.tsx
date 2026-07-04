import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { FlipList } from "@/components/flip-list"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
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
import { listAppPanels, subscribeAppPanels } from "@/plugin"
import {
  resolveSessionVisualState,
  scopeKeyForNavEntry,
  type SessionVisualStore,
} from "@/components/sidebar/session-visual-state"
import "./sidebar.css"

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

  const isExpanded = () => layout.sidebar.opened()
  const isDark = () => theme.mode() === "dark"
  const recentEntries = createMemo(() => layout.nav.recentEntries())
  const hasMoreForProject = (scope: LocalScope) => layout.nav.navEntries()[scope.worktree]?.nextCursor != null
  const hasMoreRecent = createMemo(() => layout.nav.hasMoreRecent())
  const [appPanelRegistryVersion, setAppPanelRegistryVersion] = createSignal(0)
  const pluginAppPanels = createMemo(() => {
    appPanelRegistryVersion()
    return listAppPanels()
  })
  const isPluginsSectionActive = () =>
    location.pathname === "/plugins/marketplace" || /^\/plugins\/[^/]+$/.test(location.pathname)
  const appPanelPath = (pluginId: string, panelId: string) => `/plugins/panels/${pluginId}/${panelId}`

  const [recentSectionOpen, setRecentSectionOpen] = createSignal(true)
  const [homeSectionOpen, setHomeSectionOpen] = createSignal(false)
  const [channelSectionOpen, setChannelSectionOpen] = createSignal(false)
  const [backgroundSectionOpen, setBackgroundSectionOpen] = createSignal(false)
  const [projectsFlyoutOpen, setProjectsFlyoutOpen] = createSignal(false)
  const [projectsSectionOpen, setProjectsSectionOpen] = createSignal(true)

  const scopes = createMemo(() => layout.scopes.list())

  let scopeListRef!: HTMLDivElement
  let prevSnapshot = new Map<string, number>()

  onCleanup(subscribeAppPanels(() => setAppPanelRegistryVersion((version) => version + 1)))

  createEffect(
    on(
      () => scopes().map((s) => s.id || s.worktree),
      () => {
        const container = scopeListRef
        if (!container) return

        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        if (reduceMotion) return

        requestAnimationFrame(() => {
          const items = container.querySelectorAll<HTMLElement>("[data-scope-id]")
          const newSnapshot = new Map<string, number>()
          items.forEach((item) => {
            const id = item.dataset.scopeId!
            newSnapshot.set(id, item.getBoundingClientRect().top)
          })

          if (prevSnapshot.size === 0) {
            prevSnapshot = newSnapshot
            return
          }

          // Cancel any in-flight animations before starting new ones
          items.forEach((it) => {
            if (it.style.transition) {
              it.style.transition = ""
              it.style.transform = ""
              it.style.opacity = ""
            }
          })
          items.forEach((item) => {
            const id = item.dataset.scopeId!
            const oldY = prevSnapshot.get(id)
            const newY = newSnapshot.get(id)

            if (oldY === undefined) {
              // New project: slide in from right + fade in
              item.style.opacity = "0"
              item.style.transform = "translateX(12px)"
              item.style.transition = "none"
              void item.offsetHeight // force reflow
              item.style.transition =
                "opacity 280ms cubic-bezier(0.05, 0.7, 0.1, 1), transform 280ms cubic-bezier(0.05, 0.7, 0.1, 1)"
              item.style.opacity = "1"
              item.style.transform = "translateX(0)"
              item.addEventListener(
                "transitionend",
                () => {
                  item.style.transition = ""
                  item.style.transform = ""
                  item.style.opacity = ""
                },
                { once: true },
              )
              return
            }

            if (newY === undefined) return
            const delta = oldY - newY
            if (Math.abs(delta) < 0.5) return

            // FLIP: invert -> play
            item.style.transform = `translateY(${delta}px)`
            item.style.transition = "none"
            void item.offsetHeight
            item.style.transition = "transform 300ms cubic-bezier(0.2, 0, 0, 1)"
            item.style.transform = "translateY(0)"

            item.addEventListener(
              "transitionend",
              () => {
                item.style.transition = ""
                item.style.transform = ""
              },
              { once: true },
            )
          })

          prevSnapshot = newSnapshot
        })
      },
      { defer: true },
    ),
  )
  const hasExpandedProject = createMemo(() => scopes().some((s) => s.expanded))
  const channelEntries = createMemo(() => layout.nav.rootNavEntries("channel"))

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

  const handleAddProject = async () => {
    const result = await pickProjectDirectories({ title: "Add project", multiple: true })
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
            <Tooltip value="Expand sidebar" placement="right">
              <button
                type="button"
                class="sb-collapsed-toggle"
                aria-label="Expand sidebar"
                onClick={() => layout.sidebar.toggle()}
              >
                <img
                  src={holosLogoPath(isDark() ? "dark" : "light")}
                  alt="HOLOS"
                  class="sb-collapsed-logo"
                  draggable={false}
                />
                <Icon name="panel-left-open" size="normal" class="sb-collapsed-toggle-icon" />
              </button>
            </Tooltip>
          }
        >
          <A href={`/${base64Encode("home")}/session`} class="sb-logo">
            <img src={holosLogoPath(isDark() ? "dark" : "light")} alt="HOLOS" class="sb-logo-img" draggable={false} />
            <span class="sb-logo-text">HOLOS</span>
          </A>
          <div class="sb-header-actions">
            <Tooltip value="Search sessions" placement="right">
              <button type="button" class="sb-icon-btn" aria-label="Search sessions" onClick={props.onSearchOpen}>
                <Icon name="search" size="normal" />
              </button>
            </Tooltip>
            <Tooltip value="Collapse sidebar" placement="right">
              <button
                type="button"
                class="sb-icon-btn"
                aria-label="Collapse sidebar"
                onClick={() => layout.sidebar.toggle()}
              >
                <Icon name="panel-left-close" size="normal" />
              </button>
            </Tooltip>
          </div>
        </Show>
      </div>

      {/* Action buttons (expanded only) */}
      <Show when={isExpanded()}>
        <div class="sb-actions">
          <Tooltip value="New session" placement="right">
            <button type="button" class="sb-action-btn" onClick={handleNewSession}>
              <Icon name="square-pen" size="normal" />
              <span class="sb-action-label">New</span>
            </button>
          </Tooltip>
        </div>
      </Show>

      {/* Global feature buttons */}
      <div class="sb-globals">
        <Tooltip value="Agenda" placement="right">
          <button
            type="button"
            classList={{
              "sb-global-btn": true,
              "sb-global-active": location.pathname === "/agenda",
            }}
            onClick={() => navigate("/agenda")}
          >
            <Icon name="clock" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Agenda</span>
            </Show>
          </button>
        </Tooltip>
        <Tooltip value="Library" placement="right">
          <button
            type="button"
            classList={{
              "sb-global-btn": true,
              "sb-global-active": location.pathname === "/library",
            }}
            onClick={() => navigate("/library")}
          >
            <Icon name="book-open" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Library</span>
            </Show>
          </button>
        </Tooltip>
        <Tooltip value="Plugins" placement="right">
          <button
            type="button"
            classList={{
              "sb-global-btn": true,
              "sb-global-active": isPluginsSectionActive(),
            }}
            onClick={() => navigate("/plugins/marketplace")}
          >
            <Icon name={getSemanticIcon("app.plugins")} size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Plugins</span>
            </Show>
          </button>
        </Tooltip>
        <For each={pluginAppPanels()}>
          {(panel) => (
            <Tooltip value={panel.label} placement="right">
              <button
                type="button"
                classList={{
                  "sb-global-btn": true,
                  "sb-global-active": location.pathname === appPanelPath(panel.pluginId, panel.panelId),
                }}
                onClick={() => navigate(appPanelPath(panel.pluginId, panel.panelId))}
              >
                <Icon name={panel.icon} size="normal" />
                <Show when={isExpanded()}>
                  <span class="sb-action-label">{panel.label}</span>
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
            <Tooltip value="Projects" placement="right">
              <button
                type="button"
                classList={{
                  "sb-icon-btn": true,
                  "sb-projects-flyout-trigger": true,
                }}
                onClick={() => setProjectsFlyoutOpen((v) => !v)}
              >
                <Icon name="folder-plus" size="normal" />
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
                <span class="text-text-weak text-xs">Loading projects…</span>
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
                <span class="sb-section-title">Recent</span>
                <Icon
                  name={recentSectionOpen() ? "chevron-down" : "chevron-right"}
                  size="small"
                  class="sb-section-chevron"
                />
              </div>
              <Show when={recentSectionOpen()}>
                <Show
                  when={recentEntries().length > 0}
                  fallback={<div class="sb-section-empty">No recent sessions</div>}
                >
                  <FlipList entries={recentEntries()} class="sb-sessions">
                    <For each={recentEntries()}>
                      {(entry) => (
                        <SidebarSessionRow
                          entry={entry}
                          active={entry.id === params.id}
                          onClick={() => handleNavEntryClick(entry)}
                        />
                      )}
                    </For>
                  </FlipList>
                  <Show when={hasMoreRecent()}>
                    <button type="button" class="sb-load-more-btn" onClick={() => layout.nav.loadMoreNav("__recent__")}>
                      Load more
                    </button>
                  </Show>
                </Show>
              </Show>
            </div>

            {/* Home */}
            <RootNavSection
              title="Home"
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
                <span class="sb-section-title">Channel</span>
                <Icon
                  name={channelSectionOpen() ? "chevron-down" : "chevron-right"}
                  size="small"
                  class="sb-section-chevron"
                />
              </div>
              <Show when={channelSectionOpen()}>
                <Show when={channelEntries().length > 0} fallback={<div class="sb-section-empty">No sessions</div>}>
                  <div class="sb-session-group">
                    <div class="sb-session-group-header">Feishu</div>
                    <FlipList entries={channelEntries()} class="sb-sessions">
                      <For each={channelEntries()}>
                        {(entry) => (
                          <SidebarSessionRow
                            entry={entry}
                            active={entry.id === params.id}
                            onClick={() => handleNavEntryClick(entry)}
                          />
                        )}
                      </For>
                    </FlipList>
                  </div>
                  <Show when={layout.nav.hasMoreRootNavSection("channel")}>
                    <button
                      type="button"
                      class="sb-load-more-btn"
                      onClick={() => layout.nav.loadMoreRootNavSection("channel")}
                    >
                      Load more
                    </button>
                  </Show>
                </Show>
              </Show>
            </div>

            {/* Background */}
            <RootNavSection
              title="Background"
              open={backgroundSectionOpen}
              onToggle={() => setBackgroundSectionOpen((v) => !v)}
              entries={layout.nav.rootNavEntries("background")}
              hasMore={layout.nav.hasMoreRootNavSection("background")}
              onLoadMore={() => layout.nav.loadMoreRootNavSection("background")}
              activeID={params.id}
              onSessionClick={handleNavEntryClick}
            />

            {/* Projects */}
            <div class="sb-projects">
              <div
                class="sb-projects-header"
                onClick={() => setProjectsSectionOpen((v) => !v)}
                role="button"
                tabindex="0"
              >
                <span class="sb-section-title">Projects</span>
                <Icon
                  name={projectsSectionOpen() ? "chevron-down" : "chevron-right"}
                  size="small"
                  class="sb-section-chevron"
                />
                <span class="sb-projects-header-spacer" />
                <Show when={hasExpandedProject()}>
                  <Tooltip value="Collapse all projects" placement="top">
                    <button
                      type="button"
                      class="sb-projects-header-expand-all"
                      aria-label="Collapse all projects"
                      onClick={(e) => handleCollapseAllProjects(e)}
                    >
                      <Icon name="list-collapse" size="small" />
                    </button>
                  </Tooltip>
                </Show>
                <Tooltip value="Add project" placement="top">
                  <button
                    type="button"
                    class="sb-projects-header-plus"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleAddProject()
                    }}
                  >
                    <Icon name="plus" size="small" />
                  </button>
                </Tooltip>
              </div>

              <Show when={projectsSectionOpen()}>
                <div ref={scopeListRef}>
                  <For each={scopes()}>
                    {(scope) => {
                      const [menuOpen, setMenuOpen] = createSignal(false)
                      const isSupplemental = layout.scopes.isSupplemental(scope)
                      const navLoaded = () => !!layout.nav.navEntries()[scope.worktree]
                      const activeSessionVisible = createMemo(() => {
                        const activeID = params.id
                        if (!scope.expanded || !activeID) return false
                        if (isSupplemental && !navLoaded()) return false
                        return layout.nav.projectNavEntries(scope).some((entry) => entry.id === activeID)
                      })
                      const isActive = createMemo(
                        () => scope.worktree === currentDirectory() && !activeSessionVisible(),
                      )

                      return (
                        <div class="sb-project-group" data-scope-id={scope.id || scope.worktree}>
                          <div
                            classList={{
                              "sb-project-row": true,
                              "sb-project-active": isActive(),
                            }}
                          >
                            <button
                              type="button"
                              class="sb-project-chevron-btn"
                              onClick={(e) => handleProjectToggle(e, scope)}
                            >
                              <Icon name={scope.expanded ? "chevron-down" : "chevron-right"} size="small" />
                            </button>
                            <button
                              type="button"
                              class="sb-project-body"
                              onClick={() => handleProjectClick(scope.worktree)}
                            >
                              <Icon name="folder" size="normal" class="sb-project-folder" />
                              <span class="sb-project-name">{getScopeLabel(scope)}</span>
                            </button>
                            <div class="sb-project-actions">
                              <button
                                type="button"
                                classList={{
                                  "sb-project-menu-btn": true,
                                  "sb-project-menu-active": menuOpen(),
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setMenuOpen((v) => !v)
                                }}
                              >
                                <Icon name="ellipsis" size="small" />
                              </button>
                              <button
                                type="button"
                                class="sb-project-plus-btn"
                                onClick={(e) => handleProjectPlus(e, scope)}
                              >
                                <Icon name="square-pen" size="small" />
                              </button>
                              <Show when={menuOpen()}>
                                <>
                                  <div class="sb-project-menu-backdrop" onClick={() => setMenuOpen(false)} />
                                  <div class="sb-project-menu">
                                    <button type="button" class="sb-menu-item" disabled>
                                      <Icon name="pin" size="small" />
                                      <span>Pin</span>
                                      <span class="sb-menu-disabled-label">Coming soon</span>
                                    </button>
                                    <button
                                      type="button"
                                      class="sb-menu-item"
                                      onClick={(e) => handleProjectEdit(e, scope)}
                                    >
                                      <Icon name="pencil" size="small" />
                                      <span>Edit</span>
                                    </button>
                                    <button
                                      type="button"
                                      class="sb-menu-item sb-menu-item-danger"
                                      onClick={(e) => handleProjectArchive(e, scope)}
                                    >
                                      <Icon name="trash-2" size="small" />
                                      <span>Archive</span>
                                    </button>
                                  </div>
                                </>
                              </Show>
                            </div>
                          </div>

                          {/* Sessions under expanded project */}
                          <Show when={scope.expanded}>
                            <div class="sb-sessions">
                              <Show
                                when={!isSupplemental || navLoaded()}
                                fallback={
                                  <button
                                    type="button"
                                    class="sb-load-more-btn"
                                    onClick={() => layout.nav.loadScopeNav(scope.worktree)}
                                  >
                                    Load sessions
                                  </button>
                                }
                              >
                                <GroupedSessionList
                                  entries={layout.nav.projectNavEntries(scope)}
                                  scope={scope}
                                  activeID={params.id}
                                  onSessionClick={(entry) => handleSessionClick(scope, entry)}
                                />
                                <Show when={hasMoreForProject(scope)}>
                                  <button
                                    type="button"
                                    class="sb-load-more-btn"
                                    onClick={() => layout.nav.loadMoreNav(scope.worktree)}
                                  >
                                    Load more
                                  </button>
                                </Show>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <SidebarUpdateNotice isExpanded={isExpanded()} />

      {/* Bottom: Agent Hub */}
      <SidebarAgentHub isExpanded={isExpanded()} globalSDK={globalSDK} />

      {/* Projects flyout (collapsed mode only) */}
      <Show when={!isExpanded() && projectsFlyoutOpen()}>
        <div class="sb-projects-flyout-backdrop" onClick={() => setProjectsFlyoutOpen(false)} />
        <div class="sb-projects-flyout">
          <div class="sb-flyout-header">Projects</div>
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
                    <Icon name="folder" size="small" />
                    <span class="sb-flyout-project-name">{getScopeLabel(scope)}</span>
                  </button>
                  <For each={sessions()}>
                    {(session) => (
                      <SidebarSessionRow
                        entry={session}
                        scope={scope}
                        active={session.id === params.id}
                        flyout
                        onClick={() => handleFlyoutSessionClick(session, scope.worktree)}
                      />
                    )}
                  </For>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function SidebarUpdateNotice(props: { isExpanded: boolean }) {
  const update = useProductUpdate()
  const notice = update.notice
  const icon = () =>
    notice().action === "install" ? getSemanticIcon("product.update.install") : getSemanticIcon("product.update")

  return (
    <Show when={notice().visible}>
      <div
        classList={{
          "sb-update-notice": true,
          "sb-update-notice--collapsed": !props.isExpanded,
        }}
        data-tone={notice().tone}
        aria-live="polite"
      >
        <Tooltip value={`${notice().title}${notice().detail ? ` — ${notice().detail}` : ""}`} placement="right">
          <button
            type="button"
            class="sb-update-button"
            disabled={!notice().action || notice().busy}
            onClick={() => void update.runNoticeAction()}
          >
            <span class="sb-update-icon">
              <Icon name={icon()} size="small" />
            </span>
            <Show when={props.isExpanded}>
              <span class="sb-update-copy">
                <span class="sb-update-title">{notice().title}</span>
                <span class="sb-update-detail">{notice().detail}</span>
              </span>
              <Show when={notice().actionLabel}>
                <span class="sb-update-action">{notice().busy ? "Working..." : notice().actionLabel}</span>
              </Show>
            </Show>
          </button>
        </Tooltip>
        <Show when={notice().progress != null}>
          <div class="sb-update-progress" aria-hidden="true">
            <span style={{ "--sb-update-progress": `${notice().progress ?? 0}%` }} />
          </div>
        </Show>
      </div>
    </Show>
  )
}

// --- RootNavSection: reusable collapsible section for Home / Channel / Background ---

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
  return (
    <div class="sb-root-section">
      <div class="sb-projects-header" onClick={props.onToggle} role="button" tabindex="0">
        <span class="sb-section-title">{props.title}</span>
        <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
      </div>
      <Show when={props.open()}>
        <Show when={props.entries.length > 0} fallback={<div class="sb-section-empty">No sessions</div>}>
          <FlipList entries={props.entries} class="sb-sessions">
            <For each={props.entries}>
              {(entry) => (
                <SidebarSessionRow
                  entry={entry}
                  active={entry.id === props.activeID}
                  onClick={() => props.onSessionClick(entry)}
                />
              )}
            </For>
          </FlipList>
          <Show when={props.hasMore}>
            <button type="button" class="sb-load-more-btn" onClick={props.onLoadMore}>
              Load more
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
  return (
    <FlipList entries={props.entries} class="sb-sessions">
      <For each={props.entries.filter((e) => e.category === "project")}>
        {(entry) => (
          <SidebarSessionRow
            entry={entry}
            scope={props.scope}
            active={entry.id === props.activeID}
            onClick={(e) => {
              e.stopPropagation()
              props.onSessionClick(entry)
            }}
          />
        )}
      </For>
    </FlipList>
  )
}

function SidebarSessionRow(props: {
  entry: NavEntry
  active: boolean
  scope?: LocalScope
  flyout?: boolean
  onClick: (event: MouseEvent) => void
}) {
  const globalSync = useGlobalSync()

  const visual = createMemo(() => {
    if (props.scope) return resolveSessionVisualState(globalSync.peekScopeState(props.scope.worktree)?.[0], props.entry)
    return resolveSessionVisualState(getStoreForEntry(globalSync, props.entry), props.entry)
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
      <span
        classList={{
          "sb-session-icon-wrap": true,
          "sb-session-icon-active-tone": visual().tone === "active",
          "sb-session-icon-waiting-tone": visual().tone === "waiting",
          "sb-session-icon-worktree-tone": visual().tone === "worktree",
          "sb-session-icon-muted-tone": visual().tone === "muted",
          "sb-session-icon-pulse": !!visual().pulse,
        }}
        title={visual().label}
      >
        <Icon name={visual().icon} size="small" class={props.flyout ? "sb-flyout-session-icon" : "sb-session-icon"} />
        <Show when={visual().completionUnread}>
          <span class="sb-session-completion-dot" />
        </Show>
      </span>
      <span class={props.flyout ? "sb-flyout-session-title" : "sb-session-title"}>
        {props.entry.title || "Untitled"}
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
    if (!holos.loaded) return "Loading identity..."
    if (!holos.state.identity.loggedIn) return "Local workspace"
    if (holos.state.social.profileError) return "Profile unavailable"
    const description = holos.state.social.profile?.description?.trim()
    if (description) return description
    return holos.state.connection.status === "connected" ? "Connected to Holos" : holosMenuRightLabel()
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
    if (!holos.loaded) return "Loading…"
    if (!holos.state.identity.loggedIn) return "Sign in"
    if (holos.state.connection.status === "connected") return "Connected"
    if (holos.state.connection.status === "connecting") return "Connecting…"
    if (holos.state.connection.status === "failed") return "Connection failed"
    if (holos.state.connection.status === "disconnected") return "Disconnected"
    if (holos.state.connection.status === "disabled") return "Disabled"
    return "Not available"
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
    if (account.profileError) return "Profile unavailable"
    return isActiveAccount(account.agentId) ? displayDescription() : "Saved on this device"
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
      <Tooltip value="Agent" placement="right" inactive={props.isExpanded}>
        <button
          type="button"
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
                <span class="sidebar-account-card-meta">{activeAgentShortID() ?? "No agent"}</span>
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
                <span>Create Agent</span>
              </button>
              <button
                type="button"
                class="sidebar-account-menuItem sidebar-account-menuItem--add"
                role="menuitem"
                onClick={openImportExistingAgentDialog}
              >
                <Icon name={getSemanticIcon("account.import")} size="small" />
                <span>Import Agent</span>
              </button>
            </div>
          </Show>

          <Show when={holosStatusOpen()}>
            <div class="sidebar-account-popover" role="menu">
              <div class="sidebar-account-section-label">Holos Connection</div>
              <div class="sidebar-holos-status-panel">
                <div class="sidebar-holos-status-row">
                  <Icon name={getSemanticIcon("connection.holos")} size="small" />
                  <span>Login</span>
                  <span
                    class="sidebar-account-menuStatus"
                    data-tone={holos.state.identity.loggedIn ? "success" : "muted"}
                  >
                    {holos.state.identity.loggedIn ? `Agent ${activeAgentShortID()}` : "Not logged in"}
                  </span>
                </div>
                <div class="sidebar-holos-status-row">
                  <Icon name={getSemanticIcon("settings.providers")} size="small" />
                  <span>Service</span>
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
                    <span>Reconnect</span>
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
                  <span>Create Agent</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={openImportExistingAgentDialog}
                >
                  <Icon name={getSemanticIcon("account.import")} size="small" />
                  <span>Import Agent</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={() => openSettings("general")}
                >
                  <Icon name={getSemanticIcon("settings.general")} size="small" />
                  <span>Settings</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={() => openSettings("providers")}
                >
                  <Icon name={getSemanticIcon("settings.providers")} size="small" />
                  <span>Providers</span>
                </button>
                <button type="button" class="sidebar-account-menuItem" role="menuitem" onClick={openRepository}>
                  <Icon name={getSemanticIcon("account.repository")} size="small" />
                  <span>Repository</span>
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
              <span>Account</span>
            </button>
            <Show when={showHolosStatus()}>
              <button type="button" class="sidebar-account-menuItem" role="menuitem" onClick={handleReconnect}>
                <Icon name={getSemanticIcon("action.refresh")} size="small" />
                <span>Reconnect</span>
              </button>
            </Show>
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("general")}
            >
              <Icon name={getSemanticIcon("settings.general")} size="small" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("providers")}
            >
              <Icon name={getSemanticIcon("settings.providers")} size="small" />
              <span>Providers</span>
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem"
              role="menuitem"
              onClick={() => openSettings("usage")}
            >
              <Icon name={getSemanticIcon("settings.usage")} size="small" />
              <span>Usage</span>
            </button>
            <button type="button" class="sidebar-account-menuItem" role="menuitem" onClick={openRepository}>
              <Icon name={getSemanticIcon("account.repository")} size="small" />
              <span>Repository</span>
              <Icon name={getSemanticIcon("action.open")} size="small" class="sidebar-account-menuTrailingIcon" />
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem sidebar-account-menuItem--danger"
              role="menuitem"
              onClick={logout}
            >
              <Icon name={getSemanticIcon("account.logout")} size="small" />
              <span>Log out</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
