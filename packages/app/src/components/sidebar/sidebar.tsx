import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { FlipList } from "@/components/flip-list"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { A, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePanel } from "@/context/panel"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { assetPath } from "@/utils/proxy"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import { SettingsDialog } from "@/components/settings"
import { DialogSelectProvider } from "@/components/dialog/dialog-select-provider"
import { useHolos } from "@/context/holos"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { DialogSelectDirectory } from "@/components/dialog/dialog-select-directory"
import { DialogScopeEdit } from "@/components/dialog/dialog-scope-edit"
import { DialogConfirm } from "@/components/dialog/dialog-confirm"
import type { LocalScope, NavEntry } from "@/context/layout"
import { createStore } from "solid-js/store"
import "./sidebar.css"

interface SidebarProps {
  onSearchOpen: () => void
}

type SessionVisualState = {
  icon: IconName
  label: string
  tone: "default" | "active" | "waiting" | "worktree" | "muted"
  pulse?: boolean
}

interface SessionStoreSlice {
  session_status: Record<string, { type?: string } | undefined>
  permission: Record<string, unknown[] | undefined>
  question: Record<string, unknown[] | undefined>
  cortex: { parentSessionID?: string; status?: string }[]
  session: { id: string; parentID?: string; category?: string; workspace?: { type?: string } }[]
}

function resolveSessionVisualState(store: SessionStoreSlice | undefined, entry: NavEntry): SessionVisualState {
  if (store) {
    const status = store.session_status[entry.id]
    const waiting = !!store.permission[entry.id]?.length || !!store.question[entry.id]?.length
    const running = status?.type === "busy" || status?.type === "retry"
    const childTasksRunning = store.cortex.some(
      (task) => task.parentSessionID === entry.id && task.status === "running",
    )
    const fullSession = store.session.find((session) => session.id === entry.id)

    if (entry.category === "home") return { icon: "home", label: "Home session", tone: "default" }
    if (running || childTasksRunning)
      return { icon: getSemanticIcon("session.running"), label: "Running session", tone: "active", pulse: true }
    if (waiting)
      return { icon: getSemanticIcon("session.waiting"), label: "Waiting for you", tone: "waiting", pulse: true }
    if (fullSession?.workspace?.type === "git_worktree")
      return { icon: getSemanticIcon("workspace.worktree"), label: "Worktree session", tone: "worktree" }
    if (entry.parentID) return { icon: getSemanticIcon("session.child"), label: "Child session", tone: "muted" }
    if (entry.category === "background")
      return { icon: getSemanticIcon("session.background"), label: "Background session", tone: "muted" }
    if (entry.category === "channel")
      return { icon: getSemanticIcon("session.channel"), label: "Channel session", tone: "muted" }
    return { icon: getSemanticIcon("session.default"), label: "Session", tone: "default" }
  }
  // Fallback when store is unavailable (category-only)
  if (entry.category === "background")
    return { icon: getSemanticIcon("session.background"), label: "Background session", tone: "muted" }
  if (entry.category === "channel")
    return { icon: getSemanticIcon("session.channel"), label: "Channel session", tone: "muted" }
  if (entry.category === "home") return { icon: "home", label: "Home session", tone: "default" }
  return { icon: getSemanticIcon("session.default"), label: "Session", tone: "default" }
}

function getStoreForEntry(
  globalSync: ReturnType<typeof useGlobalSync>,
  entry: NavEntry,
): SessionStoreSlice | undefined {
  if (entry.scopeType === "global" || entry.scopeID === "global") {
    return globalSync.child("global")[0]
  }
  const scope = globalSync.data.scope.find((s) => s.id === entry.scopeID)
  if (!scope?.worktree) return undefined
  return globalSync.child(scope.worktree)[0]
}

export function Sidebar(props: SidebarProps) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const panel = usePanel()
  const dialog = useDialog()
  const theme = useTheme()
  const navigate = useNavigate()
  const params = useParams()

  const isExpanded = () => layout.sidebar.opened()
  const isDark = () => theme.mode() === "dark"
  const recentEntries = createMemo(() => layout.nav.recentEntries())
  const hasMoreForProject = (scope: LocalScope) => layout.nav.navEntries()[scope.worktree]?.nextCursor != null
  const hasMoreRecent = createMemo(() => layout.nav.hasMoreRecent())

  const [recentSectionOpen, setRecentSectionOpen] = createSignal(true)
  const [homeSectionOpen, setHomeSectionOpen] = createSignal(false)
  const [channelSectionOpen, setChannelSectionOpen] = createSignal(false)
  const [backgroundSectionOpen, setBackgroundSectionOpen] = createSignal(false)
  const [projectsFlyoutOpen, setProjectsFlyoutOpen] = createSignal(false)
  const [projectsSectionOpen, setProjectsSectionOpen] = createSignal(true)

  const scopes = createMemo(() => layout.scopes.list())

  let scopeListRef!: HTMLDivElement
  let prevSnapshot = new Map<string, number>()

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
  const currentDirectory = createMemo(() => (dir() === "global" ? undefined : dir()))
  const handleNewSession = () => {
    navigate(`/${base64Encode("global")}/session`)
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

  const handleProjectDelete = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    dialog.show(() => (
      <DialogConfirm
        title="Delete project"
        description={`Delete "${getScopeLabel(scope)}"? This archives the project on the server.`}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (scope.id) await globalSDK.client.scope.remove({ scopeID: scope.id })
          else await globalSDK.client.scope.remove({ scopeID: scope.worktree })
        }}
      />
    ))
  }

  const handleProjectEdit = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    dialog.show(() => <DialogScopeEdit scope={scope} />)
  }

  const handleProjectPlus = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
    navigate(`/${base64Encode(scope.worktree)}/session`)
  }

  const handleAddProject = () => {
    dialog.show(() => (
      <DialogSelectDirectory
        title="Add project"
        multiple={true}
        showInitGit={true}
        onSelect={async (result) => {
          if (!result) return
          const dirs = Array.isArray(result.directory) ? result.directory : [result.directory]
          for (const dir of dirs) {
            layout.scopes.open(dir)
          }
        }}
      />
    ))
  }

  const handleSessionClick = (scope: LocalScope, entry: NavEntry) => {
    navigate(`/${base64Encode(scope.worktree)}/session/${entry.id}`)
  }

  const resolveEntryRouteDirectory = (entry: NavEntry): string => {
    if (entry.scopeID === "global" || entry.scopeType === "global") return "global"
    const metadata = globalSync.data.scope.find((s) => s.id === entry.scopeID)
    if (metadata?.worktree) return metadata.worktree
    return entry.scopeID
  }

  const handleNavEntryClick = (entry: NavEntry) => {
    navigate(`/${base64Encode(resolveEntryRouteDirectory(entry))}/session/${entry.id}`)
  }

  const handleFlyoutSessionClick = (entry: NavEntry, worktree: string) => {
    setProjectsFlyoutOpen(false)
    navigate(`/${base64Encode(worktree === "global" ? "global" : worktree)}/session/${entry.id}`)
  }

  const sessionVisualState = (scope: LocalScope, entry: NavEntry): SessionVisualState =>
    resolveSessionVisualState(globalSync.child(scope.worktree)[0], entry)

  const SessionIcon = (props: { scope: LocalScope; entry: NavEntry; flyout?: boolean }) => {
    const visual = createMemo(() => sessionVisualState(props.scope, props.entry))
    return (
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
      </span>
    )
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
              <button type="button" class="sb-collapsed-toggle" onClick={() => layout.sidebar.toggle()}>
                <img
                  src={isDark() ? assetPath("/holos-logo-white.svg") : assetPath("/holos-logo.svg")}
                  alt="HOLOS"
                  class="sb-collapsed-logo"
                />
                <Icon name="panel-left-open" size="normal" class="sb-collapsed-toggle-icon" />
              </button>
            </Tooltip>
          }
        >
          <A href={`/${base64Encode("global")}/session`} class="sb-logo" onClick={() => panel.close()}>
            <img
              src={isDark() ? assetPath("/holos-logo-white.svg") : assetPath("/holos-logo.svg")}
              alt="HOLOS"
              class="sb-logo-img"
            />
            <span class="sb-logo-text">HOLOS</span>
          </A>
          <div class="sb-header-actions">
            <Tooltip value="Search sessions" placement="right">
              <button type="button" class="sb-icon-btn" onClick={props.onSearchOpen}>
                <Icon name="search" size="normal" />
              </button>
            </Tooltip>
            <Tooltip value="Collapse sidebar" placement="right">
              <button type="button" class="sb-icon-btn" onClick={() => layout.sidebar.toggle()}>
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
              "sb-global-active": panel.active() === "agenda",
            }}
            onClick={() => panel.toggle("agenda")}
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
              "sb-global-active": panel.active() === "engram",
            }}
            onClick={() => panel.toggle("engram")}
          >
            <Icon name="book-open" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Library</span>
            </Show>
          </button>
        </Tooltip>
      </div>
      <Tooltip value="Plugins" placement="right">
        <button
          type="button"
          classList={{
            "sb-global-btn": true,
            "sb-global-active": params.dir === "plugins",
          }}
          onClick={() => navigate("/plugins/marketplace")}
        >
          <Icon name="package-open" size="normal" />
          <Show when={isExpanded()}>
            <span class="sb-action-label">Plugins</span>
          </Show>
        </button>
      </Tooltip>

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
                        <button
                          type="button"
                          classList={{
                            "sb-session-row": true,
                            "sb-session-active": entry.id === params.id,
                          }}
                          data-session-id={entry.id}
                          onClick={() => handleNavEntryClick(entry)}
                        >
                          <SessionRowIcon entry={entry} />
                          <span class="sb-session-title">{entry.title || "Untitled"}</span>
                        </button>
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
                          <button
                            type="button"
                            classList={{
                              "sb-session-row": true,
                              "sb-session-active": entry.id === params.id,
                            }}
                            data-session-id={entry.id}
                            onClick={() => handleNavEntryClick(entry)}
                          >
                            <SessionRowIcon entry={entry} />
                            <span class="sb-session-title">{entry.title || "Untitled"}</span>
                          </button>
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
                                      onClick={(e) => handleProjectDelete(e, scope)}
                                    >
                                      <Icon name="trash-2" size="small" />
                                      <span>Delete</span>
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

      {/* Bottom: Agent Hub */}
      <SidebarAgentHub isExpanded={isExpanded()} globalSDK={globalSDK} dialog={dialog} />

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
                      <button
                        type="button"
                        classList={{
                          "sb-flyout-session-row": true,
                          "sb-session-active": session.id === params.id,
                        }}
                        onClick={() => handleFlyoutSessionClick(session, scope.worktree)}
                      >
                        <SessionIcon scope={scope} entry={session} flyout />
                        <span class="sb-flyout-session-title">{session.title || "Untitled"}</span>
                      </button>
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
                <button
                  type="button"
                  classList={{
                    "sb-session-row": true,
                    "sb-session-active": entry.id === props.activeID,
                  }}
                  data-session-id={entry.id}
                  onClick={() => props.onSessionClick(entry)}
                >
                  <SessionRowIcon entry={entry} />
                  <span class="sb-session-title">{entry.title || "Untitled"}</span>
                </button>
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
          <button
            type="button"
            classList={{
              "sb-session-row": true,
              "sb-session-active": entry.id === props.activeID,
            }}
            data-session-id={entry.id}
            onClick={(e) => {
              e.stopPropagation()
              props.onSessionClick(entry)
            }}
          >
            <SessionRowIcon entry={entry} scope={props.scope} />
            <span class="sb-session-title">{entry.title || "Untitled"}</span>
          </button>
        )}
      </For>
    </FlipList>
  )
}

function SessionRowIcon(props: { entry: NavEntry; scope?: LocalScope }) {
  const globalSync = useGlobalSync()

  const visual = createMemo(() => {
    if (props.scope) return resolveSessionVisualState(globalSync.child(props.scope.worktree)[0], props.entry)
    return resolveSessionVisualState(getStoreForEntry(globalSync, props.entry), props.entry)
  })

  return (
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
      <Icon name={visual().icon} size="small" class="sb-session-icon" />
    </span>
  )
}

// --- SidebarAgentHub: bottom avatar/identity trigger + dropdown menu ---

function SidebarAgentHub(props: {
  isExpanded: boolean
  globalSDK: ReturnType<typeof useGlobalSDK>
  dialog: ReturnType<typeof useDialog>
}) {
  const holos = useHolos()
  const [menuOpen, setMenuOpen] = createSignal(false)
  let loginMessageHandler: ((event: MessageEvent) => void) | undefined
  let loginMessageTimeout: ReturnType<typeof setTimeout> | undefined

  const avatarSrc = () => assetPath("/agent-avatars/synergy-companion.svg")

  const callbackUrl = () => new URL("/holos/callback", props.globalSDK.url).toString()
  const callbackOrigin = () => new URL(props.globalSDK.url).origin

  const displayName = () => {
    if (!holos.loaded) return "Synergy"
    const profileName = holos.state.social.profile?.name
    if (holos.state.identity.loggedIn && profileName) return profileName
    return "Synergy"
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
    if (loginMessageHandler) window.removeEventListener("message", loginMessageHandler)
    if (loginMessageTimeout) clearTimeout(loginMessageTimeout)
  })

  const openMenu = () => {
    setMenuOpen(true)
    document.addEventListener("keydown", handleEscape)
  }

  const closeMenu = () => {
    setMenuOpen(false)
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

  const hasAccounts = () => holos.state.identity.accounts.length > 0

  const accountLabel = (a: { agentId: string; label: string | null }) => a.label || a.agentId.slice(0, 8)

  const isActiveAccount = (agentId: string) => holos.state.identity.activeAccount?.agentId === agentId

  const handleSwitchAccount = async (agentId: string) => {
    try {
      await props.globalSDK.client.holos.accounts.switch({ agentId }, { throwOnError: true })
      closeMenu()
      void holos.refresh()
      showToast({ type: "success", title: "Agent switched", description: `Switched to ${agentId.slice(0, 8)}` })
    } catch (e) {
      const msg = getErrorMessage(e, "Unable to switch agent.")
      showToast({ type: "error", title: "Agent switch failed", description: msg })
    }
  }

  const handleHolosClick = () => {
    if (!holos.loaded) return
    if (!holos.state.identity.loggedIn) {
      closeMenu()
      startHolosLogin()
      return
    }
    if (holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected") {
      closeMenu()
      void holosReconnect()
      return
    }
  }

  async function startHolosLogin() {
    try {
      const res = await props.globalSDK.client.holos.login({ callbackUrl: callbackUrl() }, { throwOnError: true })
      const authUrl = res.data?.url
      if (!authUrl) {
        showToast({ type: "error", title: "Holos login failed", description: "No login URL returned." })
        return
      }

      if (loginMessageHandler) window.removeEventListener("message", loginMessageHandler)
      if (loginMessageTimeout) clearTimeout(loginMessageTimeout)
      const clearLoginMessageHandler = () => {
        if (loginMessageHandler) window.removeEventListener("message", loginMessageHandler)
        if (loginMessageTimeout) clearTimeout(loginMessageTimeout)
        loginMessageHandler = undefined
        loginMessageTimeout = undefined
      }
      loginMessageHandler = (event: MessageEvent) => {
        if (event.origin !== callbackOrigin()) return
        if (event.data?.type === "holos-login-success") {
          clearLoginMessageHandler()
          void holos.refresh()
          showToast({ type: "success", title: "Holos connected", description: "Your agent is now linked to Holos." })
          return
        }
        if (event.data?.type === "holos-login-failed") {
          clearLoginMessageHandler()
          const errMsg = typeof event.data?.error === "string" ? event.data.error : "Please try again."
          showToast({ type: "error", title: "Holos login failed", description: errMsg })
        }
      }

      window.addEventListener("message", loginMessageHandler)
      const popup = window.open(authUrl, "holos-login", "width=600,height=700")
      loginMessageTimeout = setTimeout(() => {
        clearLoginMessageHandler()
      }, 300_000)
      if (!popup) {
        clearLoginMessageHandler()
        showToast({
          type: "warning",
          title: "Popup blocked",
          description: "Allow popups for this site to sign in to Holos.",
          duration: 8000,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      showToast({ type: "error", title: "Holos login failed", description: msg })
    }
  }

  async function holosReconnect() {
    try {
      await props.globalSDK.client.holos.reconnect({ throwOnError: true })
      void holos.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      showToast({ type: "error", title: "Holos reconnect failed", description: msg })
    }
  }

  const openImportExistingAgentDialog = () => {
    closeMenu()
    props.dialog.show(() => <DialogImportHolosAgent globalSDK={props.globalSDK} onImported={() => holos.refresh()} />)
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
            </div>
            <Icon name={menuOpen() ? "chevron-up" : "chevron-down"} size="small" class="sidebar-account-chevron" />
          </Show>
        </button>
      </Tooltip>

      <Show when={menuOpen()}>
        <div class="sidebar-account-menu-backdrop" onClick={closeMenu} />
        <div id="sidebar-account-menu" class="sidebar-account-menu" role="menu">
          <button
            type="button"
            class="sidebar-account-menuItem"
            role="menuitem"
            onClick={() => {
              closeMenu()
              props.dialog.show(() => <SettingsDialog />)
            }}
          >
            <Icon name="settings" size="small" />
            <span>Settings</span>
          </button>
          <button
            type="button"
            class="sidebar-account-menuItem"
            role="menuitem"
            onClick={() => {
              closeMenu()
              props.dialog.show(() => <DialogSelectProvider />)
            }}
          >
            <Icon name="cable" size="small" />
            <span>Connect Provider</span>
          </button>
          <Show
            when={hasAccounts()}
            fallback={
              <>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  disabled={holosMenuDisabled()}
                  onClick={handleHolosClick}
                >
                  <Icon name={getSemanticIcon("connection.holos")} size="small" />
                  <span>Create Agent</span>
                  <span class="sidebar-account-menuStatus">{holosMenuRightLabel()}</span>
                </button>
                <button
                  type="button"
                  class="sidebar-account-menuItem"
                  role="menuitem"
                  onClick={openImportExistingAgentDialog}
                >
                  <Icon name="key-round" size="small" />
                  <span>Import Agent</span>
                </button>
              </>
            }
          >
            <div class="sidebar-account-section-label">Holos</div>
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
                  <Icon name={isActiveAccount(account.agentId) ? "check" : "circle"} size="small" />
                  <span>{accountLabel(account)}</span>
                  <span class="sidebar-account-menuStatus">
                    {holos.state.connection.status === "connected" && isActiveAccount(account.agentId) ? "Active" : ""}
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
                startHolosLogin()
              }}
            >
              <Icon name="user-plus" size="small" />
              <span>Create Agent</span>
            </button>
            <button
              type="button"
              class="sidebar-account-menuItem sidebar-account-menuItem--add"
              role="menuitem"
              onClick={openImportExistingAgentDialog}
            >
              <Icon name="key-round" size="small" />
              <span>Import Agent</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return fallback
}

function DialogImportHolosAgent(props: {
  globalSDK: ReturnType<typeof useGlobalSDK>
  onImported?: () => void | Promise<void>
}) {
  const dialog = useDialog()
  const [form, setForm] = createStore({
    agentId: "",
    agentSecret: "",
    agentIdError: undefined as string | undefined,
    agentSecretError: undefined as string | undefined,
    submitting: false,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const agentId = form.agentId.trim()
    const agentSecret = form.agentSecret.trim()

    setForm("agentIdError", agentId ? undefined : "Agent ID is required")
    setForm("agentSecretError", agentSecret ? undefined : "Agent secret is required")
    if (!agentId || !agentSecret) return

    setForm("submitting", true)
    try {
      await props.globalSDK.client.holos.credentials({ agentId, agentSecret }, { throwOnError: true })
      await props.onImported?.()
      showToast({
        type: "success",
        title: "Agent imported",
        description: `Imported ${agentId.slice(0, 8)}`,
      })
      dialog.close()
    } catch (err) {
      const message = getErrorMessage(err, "Check the agent ID and secret, then try again.")
      showToast({ type: "error", title: "Import failed", description: message })
    } finally {
      setForm("submitting", false)
    }
  }

  return (
    <Dialog title="Import Agent">
      <form onSubmit={handleSubmit} class="sidebar-agent-import-form">
        <div class="sidebar-agent-import-hero">
          <span class="sidebar-agent-import-icon">
            <Icon name="key-round" size="normal" />
          </span>
          <div class="sidebar-agent-import-heading">
            <span class="sidebar-agent-import-kicker">Holos Agent</span>
            <p>
              Connect an existing agent with its ID and secret. The secret is stored locally and never shown here again.
            </p>
          </div>
        </div>
        <div class="sidebar-agent-import-fields">
          <TextField
            autofocus
            label="Agent ID"
            type="text"
            placeholder="agent_..."
            value={form.agentId}
            onChange={(value) => {
              setForm("agentId", value)
              if (value.trim()) setForm("agentIdError", undefined)
            }}
            validationState={form.agentIdError ? "invalid" : undefined}
            error={form.agentIdError}
            autocomplete="off"
            class="sidebar-agent-import-input"
          />
          <TextField
            label="Agent Secret"
            type="password"
            placeholder="Paste the agent secret"
            value={form.agentSecret}
            onChange={(value) => {
              setForm("agentSecret", value)
              if (value.trim()) setForm("agentSecretError", undefined)
            }}
            validationState={form.agentSecretError ? "invalid" : undefined}
            error={form.agentSecretError}
            autocomplete="off"
            class="sidebar-agent-import-input"
          />
        </div>
        <div class="sidebar-agent-import-note">
          <Icon name="lock-keyhole" size="small" />
          <span>Synergy verifies the secret once, then stores it in your local credential store.</span>
        </div>
        <div class="sidebar-agent-import-actions">
          <Button type="button" variant="ghost" size="small" onClick={() => dialog.close()} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="small" disabled={form.submitting}>
            {form.submitting ? "Importing…" : "Import Agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
