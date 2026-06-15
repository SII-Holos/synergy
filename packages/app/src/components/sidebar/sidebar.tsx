import { createMemo, createSignal, For, Show } from "solid-js"
import { A, useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePanel } from "@/context/panel"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { assetPath } from "@/utils/proxy"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import { relativeTime } from "@/utils/time"
import { DialogSettings } from "@/components/dialog/dialog-settings"
import { DialogSelectProvider } from "@/components/dialog/dialog-select-provider"
import { DialogSelectDirectory } from "@/components/dialog/dialog-select-directory"
import { DialogScopeEdit } from "@/components/dialog/dialog-scope-edit"
import { DialogConfirm } from "@/components/dialog/dialog-confirm"
import type { LocalScope } from "@/context/layout"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import "./sidebar.css"

interface SidebarProps {
  onSearchOpen: () => void
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

  const [projectsFlyoutOpen, setProjectsFlyoutOpen] = createSignal(false)
  const [projectsSectionOpen, setProjectsSectionOpen] = createSignal(true)

  const scopes = createMemo(() => layout.scopes.list())
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
  const isGlobal = () => !dir() || dir() === "global" || !currentDirectory()

  const handleNewSession = async () => {
    if (isGlobal()) {
      showToast({ title: "New Session", description: "Global sessions are coming soon." })
      return
    }
    const scope = scopes().find((s) => s.worktree === currentDirectory())
    if (scope) {
      navigate(`/${base64Encode(scope.worktree)}/session`)
    }
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

  const handleSessionClick = (scope: LocalScope, session: Session) => {
    navigate(`/${base64Encode(scope.worktree)}/session/${session.id}`)
  }

  const handleFlyoutSessionClick = (session: Session) => {
    setProjectsFlyoutOpen(false)
    navigate(`/${base64Encode(session.scope.directory!)}/session/${session.id}`)
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
              <Icon name="pen-line" size="normal" />
              <span class="sb-action-label">New session</span>
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
        <Tooltip value="Notes" placement="right">
          <button
            type="button"
            classList={{
              "sb-global-btn": true,
              "sb-global-active": panel.active() === "note",
            }}
            onClick={() => panel.toggle("note")}
          >
            <Icon name="notebook-pen" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Notes</span>
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
            <Icon name="clipboard-list" size="normal" />
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
            <Icon name="brain" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Engram</span>
            </Show>
          </button>
        </Tooltip>
      </div>

      {/* Projects: collapsed mode = single icon with flyout, expanded = full section */}
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
        <div class="sb-projects">
          <div class="sb-projects-header" onClick={() => setProjectsSectionOpen((v) => !v)} role="button" tabindex="0">
            <Icon
              name={projectsSectionOpen() ? "chevron-down" : "chevron-right"}
              size="small"
              class="sb-section-chevron"
            />
            <span class="sb-section-title">Projects</span>
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
                      <button type="button" class="sb-project-body" onClick={() => handleProjectClick(scope.worktree)}>
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
                        <button type="button" class="sb-project-plus-btn" onClick={(e) => handleProjectPlus(e, scope)}>
                          <Icon name="plus" size="small" />
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
                        <For each={layout.nav.projectSessions(scope).slice(0, 20)}>
                          {(session) => (
                            <button
                              type="button"
                              classList={{
                                "sb-session-row": true,
                                "sb-session-active": session.id === params.id,
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSessionClick(scope, session)
                              }}
                            >
                              <Icon name="message-circle" size="small" class="sb-session-icon" />
                              <span class="sb-session-title">{session.title || "Untitled"}</span>
                              <span class="sb-session-time">
                                {relativeTime(session.time.updated ?? session.time.created)}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </Show>

      {/* Bottom: Settings, Connect Provider, Theme */}
      <div class="sb-bottom">
        <Tooltip value="Settings" placement="right">
          <button type="button" class="sb-bottom-btn" onClick={() => dialog.show(() => <DialogSettings />)}>
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
              const sessions = createMemo(() => layout.nav.projectSessions(scope).slice(0, 20))
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
                        onClick={() => handleFlyoutSessionClick(session)}
                      >
                        <Icon name="message-circle" size="small" class="sb-flyout-session-icon" />
                        <span class="sb-flyout-session-title">{session.title || "Untitled"}</span>
                        <span class="sb-flyout-session-time">
                          {relativeTime(session.time.updated ?? session.time.created)}
                        </span>
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
