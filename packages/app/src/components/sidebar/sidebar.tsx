import { createMemo, createSignal, For, Show } from "solid-js"
import { A, useNavigate, useParams } from "@solidjs/router"
import { useLayout, getAvatarColors } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePanel } from "@/context/panel"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { assetPath } from "@/utils/proxy"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel, isGlobalScope } from "@/utils/scope"
import { DialogSettings } from "@/components/dialog/dialog-settings"
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

  const scopes = createMemo(() => layout.scopes.list())

  const currentDir = createMemo(() => {
    if (!params.dir) return undefined
    const decoded = base64Decode(params.dir)
    return decoded === "global" ? undefined : decoded
  })

  const currentScopeIndex = createMemo(() => {
    const dir = currentDir()
    if (!dir) return -1
    return scopes().findIndex((s) => s.worktree === dir || (s.sandboxes ?? []).includes(dir))
  })

  const handleNewSession = async () => {
    const scope = currentScopeIndex() >= 0 ? scopes()[currentScopeIndex()] : undefined
    if (scope) {
      navigate(`/${base64Encode(scope.worktree)}/session`)
    } else {
      navigate(`/${base64Encode("global")}/session`)
    }
  }

  const handleScopeClick = (worktree: string) => {
    layout.scopes.open(worktree)
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const handleSessionClick = (session: Session) => {
    const dir = session.scope.directory ?? "global"
    navigate(`/${base64Encode(dir)}/session/${session.id}`)
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

      {/* Projects section */}
      <div class="sb-projects">
        <Show when={isExpanded()}>
          <div class="sb-section-label">Projects</div>
        </Show>
        <For each={scopes()}>
          {(scope, idx) => {
            const colors = createMemo(() => getAvatarColors(scope.icon?.color))
            const isActive = () => idx() === currentScopeIndex()
            const sessions = createMemo(() => layout.nav.projectSessions(scope))
            const childInfo = createMemo(() => layout.nav.childInfoForScope(scope))

            return (
              <div class="sb-project-group">
                <button
                  type="button"
                  classList={{
                    "sb-project-btn": true,
                    "sb-project-active": isActive(),
                  }}
                  onClick={() => handleScopeClick(scope.worktree)}
                >
                  <Avatar
                    fallback={getScopeLabel(scope)}
                    src={scope.icon?.url}
                    size="small"
                    background={colors().background}
                    foreground={colors().foreground}
                  />
                  <Show when={isExpanded()}>
                    <span class="sb-project-name">{getScopeLabel(scope)}</span>
                    <Icon
                      name={scope.expanded ? "chevron-down" : "chevron-right"}
                      size="small"
                      class="sb-project-chevron"
                    />
                  </Show>
                </button>

                <Show when={isExpanded() && (scope.expanded || isActive())}>
                  <div class="sb-session-list">
                    <For each={sessions().slice(0, 20)}>
                      {(session) => {
                        const childCount = childInfo()[session.id]?.count ?? 0
                        return (
                          <button
                            type="button"
                            classList={{
                              "sb-session-btn": true,
                              "sb-session-active": session.id === params.id,
                            }}
                            onClick={() => handleSessionClick(session)}
                          >
                            <span class="sb-session-title">{session.title || "New session"}</span>
                            <Show when={childCount > 0}>
                              <span class="sb-session-child-count">{childCount}</span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                    <Show when={sessions().length === 0}>
                      <div class="sb-session-empty">No sessions</div>
                    </Show>
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      {/* Spacer */}
      <div class="sb-spacer" />

      {/* Global feature buttons */}
      <div class="sb-globals">
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
      </div>

      {/* Bottom: Settings + Theme */}
      <div class="sb-bottom">
        <Tooltip value="Settings" placement="right">
          <button type="button" class="sb-icon-btn" onClick={() => dialog.show(() => <DialogSettings />)}>
            <Icon name="settings" size="normal" />
            <Show when={isExpanded()}>
              <span class="sb-action-label">Settings</span>
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
