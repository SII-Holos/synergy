import { createMemo, createSignal, For, Show } from "solid-js"
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
import { DialogSelectDirectory } from "@/components/dialog/dialog-select-directory"
import { DialogScopeEdit } from "@/components/dialog/dialog-scope-edit"
import { DialogConfirm } from "@/components/dialog/dialog-confirm"
import type { LocalScope, NavEntry } from "@/context/layout"
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
  const handleNewSession = async () => {
    await globalSDK.client.channel.app.reset()
    navigate(`/${base64Encode("global")}/session`)
  }

  const handleProjectClick = (worktree: string) => {
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const handleProjectToggle = (e: MouseEvent, scope: LocalScope) => {
    e.stopPropagation()
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
                  alt="Synergy"
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
              alt="Synergy"
              class="sb-logo-img"
            />
            <span class="sb-logo-text">Synergy</span>
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
        <Tooltip value="Holos" placement="right">
          <button
            type="button"
            classList={{
              "sb-global-btn": true,
              "sb-global-active": panel.active() === "holos",
            }}
            onClick={() => panel.toggle("holos")}
          >
            <Icon name="users" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Holos</span>
            </Show>
          </button>
        </Tooltip>
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
        <Tooltip value="Engram" placement="right">
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
              <span class="sb-action-label">Engram</span>
            </Show>
          </button>
        </Tooltip>
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
          {/* Recent */}
          <div class="sb-root-section">
            <div class="sb-projects-header" onClick={() => setRecentSectionOpen((v) => !v)} role="button" tabindex="0">
              <span class="sb-section-title">Recent</span>
              <Icon
                name={recentSectionOpen() ? "chevron-down" : "chevron-right"}
                size="small"
                class="sb-section-chevron"
              />
            </div>
            <Show when={recentSectionOpen()}>
              <Show when={recentEntries().length > 0} fallback={<div class="sb-section-empty">No recent sessions</div>}>
                <div class="sb-sessions">
                  <For each={recentEntries()}>
                    {(entry) => (
                      <button
                        type="button"
                        classList={{
                          "sb-session-row": true,
                          "sb-session-active": entry.id === params.id,
                        }}
                        onClick={() => handleNavEntryClick(entry)}
                      >
                        <SessionRowIcon entry={entry} />
                        <span class="sb-session-title">{entry.title || "Untitled"}</span>
                      </button>
                    )}
                  </For>
                </div>
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
            <div class="sb-projects-header" onClick={() => setChannelSectionOpen((v) => !v)} role="button" tabindex="0">
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
                  <For each={channelEntries()}>
                    {(entry) => (
                      <button
                        type="button"
                        classList={{
                          "sb-session-row": true,
                          "sb-session-active": entry.id === params.id,
                        }}
                        onClick={() => handleNavEntryClick(entry)}
                      >
                        <SessionRowIcon entry={entry} />
                        <span class="sb-session-title">{entry.title || "Untitled"}</span>
                      </button>
                    )}
                  </For>
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
              <For each={scopes()}>
                {(scope) => {
                  const isActive = () => scope.worktree === currentDirectory()
                  const [menuOpen, setMenuOpen] = createSignal(false)

                  return (
                    <div class="sb-project-group">
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
                                <button type="button" class="sb-menu-item" onClick={(e) => handleProjectEdit(e, scope)}>
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
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </div>
      </Show>

      {/* Bottom: Settings, Connect Provider, Theme */}
      <div class="sb-bottom">
        <Tooltip value="Settings" placement="right">
          <button type="button" class="sb-bottom-btn" onClick={() => dialog.show(() => <SettingsDialog />)}>
            <Icon name="settings" size="normal" />
            <span class="sb-bottom-label">Settings</span>
          </button>
        </Tooltip>
        <Tooltip value="Connect Provider" placement="right">
          <button type="button" class="sb-bottom-btn" onClick={() => dialog.show(() => <DialogSelectProvider />)}>
            <Icon name="cable" size="normal" />
            <span class="sb-bottom-label">Connect Provider</span>
          </button>
        </Tooltip>
        <Tooltip value={isDark() ? "Switch to light mode" : "Switch to dark mode"} placement="right">
          <button type="button" class="sb-bottom-btn" onClick={() => theme.setColorScheme(isDark() ? "light" : "dark")}>
            <Icon name={isDark() ? "sun" : "moon"} size="normal" />
            <span class="sb-bottom-label">{isDark() ? "Light" : "Dark"}</span>
          </button>
        </Tooltip>
      </div>

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
          <>
            <div class="sb-sessions">
              <For each={props.entries}>
                {(entry) => (
                  <button
                    type="button"
                    classList={{
                      "sb-session-row": true,
                      "sb-session-active": entry.id === props.activeID,
                    }}
                    onClick={() => props.onSessionClick(entry)}
                  >
                    <SessionRowIcon entry={entry} />
                    <span class="sb-session-title">{entry.title || "Untitled"}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={props.hasMore}>
              <button type="button" class="sb-load-more-btn" onClick={props.onLoadMore}>
                Load more
              </button>
            </Show>
          </>
        </Show>
      </Show>
    </div>
  )
}

// --- GroupedSessionList: renders nav entries grouped by category (project) ---

const CATEGORY_LABELS_PROJECT: Record<string, string> = {
  background: "Background",
  channel: "Channel",
}

function GroupedSessionList(props: {
  entries: NavEntry[]
  scope?: LocalScope
  activeID?: string
  onSessionClick: (entry: NavEntry) => void
}) {
  const labels = CATEGORY_LABELS_PROJECT

  const memo = createMemo(() => {
    const project: NavEntry[] = []
    const groups = new Map<string, NavEntry[]>()
    for (const entry of props.entries) {
      if (entry.category === "project") {
        project.push(entry)
      } else if (labels[entry.category] !== undefined) {
        const key = entry.category
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(entry)
      }
    }
    return { projectEntries: project, groupedEntries: [...groups.entries()] }
  })

  const projectEntries = () => memo().projectEntries
  const groupedEntries = () => memo().groupedEntries

  return (
    <>
      <For each={projectEntries()}>
        {(entry) => (
          <button
            type="button"
            classList={{
              "sb-session-row": true,
              "sb-session-active": entry.id === props.activeID,
            }}
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
      <For each={groupedEntries()}>
        {([category, entries]) => (
          <div class="sb-session-group">
            <div class="sb-session-group-header">{labels[category]}</div>
            <For each={entries}>
              {(entry) => (
                <button
                  type="button"
                  classList={{
                    "sb-session-row": true,
                    "sb-session-active": entry.id === props.activeID,
                  }}
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
          </div>
        )}
      </For>
    </>
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
