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
import { DialogSettings } from "@/components/dialog/dialog-settings"
import { DialogSelectProvider } from "@/components/dialog/dialog-select-provider"
import { DialogScopeEdit } from "@/components/dialog/dialog-scope-edit"
import { DialogConfirm } from "@/components/dialog/dialog-confirm"
import type { LocalScope } from "@/context/layout"
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
        <A href={`/${base64Encode("global")}/session`} class="sb-logo" onClick={() => panel.close()}>
          <img
            src={isDark() ? assetPath("/holos-logo-white.svg") : assetPath("/holos-logo.svg")}
            alt="Synergy"
            class="sb-logo-img"
          />
          <Show when={isExpanded()}>
            <span class="sb-logo-text">Synergy</span>
          </Show>
        </A>
        <Tooltip value={isExpanded() ? "Collapse sidebar" : "Expand sidebar"} placement="right">
          <button type="button" class="sb-icon-btn" onClick={() => layout.sidebar.toggle()}>
            <Icon name={isExpanded() ? "panel-left-close" : "panel-left-open"} size="normal" />
          </button>
        </Tooltip>
      </div>

      {/* Action buttons */}
      <div class="sb-actions">
        <Tooltip value="New session" placement="right">
          <button type="button" class="sb-action-btn" onClick={handleNewSession}>
            <Icon name="plus" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">New session</span>
            </Show>
          </button>
        </Tooltip>

        <Tooltip value="Search sessions" placement="right">
          <button type="button" class="sb-action-btn" onClick={props.onSearchOpen}>
            <Icon name="search" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Search</span>
            </Show>
          </button>
        </Tooltip>
      </div>

      {/* Global feature buttons: Holos, Notes, Agenda, Engram */}
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

      {/* Projects section */}
      <div class="sb-projects">
        <Show when={isExpanded()}>
          <div class="sb-section-label">Projects</div>
        </Show>
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
                  <button type="button" class="sb-project-chevron-btn" onClick={(e) => handleProjectToggle(e, scope)}>
                    <Icon name={scope.expanded ? "chevron-down" : "chevron-right"} size="small" />
                  </button>
                  <button type="button" class="sb-project-body" onClick={() => handleProjectClick(scope.worktree)}>
                    <Icon name="folder" size="normal" class="sb-project-folder" />
                    <Show when={isExpanded()}>
                      <span class="sb-project-name">{getScopeLabel(scope)}</span>
                    </Show>
                  </button>
                  <Show when={isExpanded()}>
                    <div class="sb-project-actions">
                      <button type="button" class="sb-project-plus-btn" onClick={(e) => handleProjectPlus(e, scope)}>
                        <Icon name="plus" size="small" />
                      </button>
                      <button
                        type="button"
                        class="sb-project-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpen((v) => !v)
                        }}
                      >
                        <Icon name="ellipsis" size="small" />
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
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>

      {/* Spacer */}
      <div class="sb-spacer" />

      {/* Bottom: Settings, Connect Provider, Theme */}
      <div class="sb-bottom">
        <Tooltip value="Settings" placement="right">
          <button type="button" class="sb-icon-btn" onClick={() => dialog.show(() => <DialogSettings />)}>
            <Icon name="settings" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Settings</span>
            </Show>
          </button>
        </Tooltip>
        <Tooltip value="Connect Provider" placement="right">
          <button type="button" class="sb-icon-btn" onClick={() => dialog.show(() => <DialogSelectProvider />)}>
            <Icon name="cable" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Connect Provider</span>
            </Show>
          </button>
        </Tooltip>
        <Tooltip value={isDark() ? "Switch to light mode" : "Switch to dark mode"} placement="right">
          <button type="button" class="sb-icon-btn" onClick={() => theme.setColorScheme(isDark() ? "light" : "dark")}>
            <Icon name={isDark() ? "sun" : "moon"} size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">{isDark() ? "Light" : "Dark"}</span>
            </Show>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
