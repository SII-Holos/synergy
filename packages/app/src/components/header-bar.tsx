import { A, useNavigate, useParams } from "@solidjs/router"
import { createMemo, createResource, createEffect, For, JSX, onCleanup, Show } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useCommand } from "@/context/command"
import { usePanel } from "@/context/panel"
import { useLayout, getAvatarColors } from "@/context/layout"
import { useRecentSessions, type RecentSessionItem } from "@/context/recent-sessions"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"

import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { createStore } from "solid-js/store"
import { DialogSettings } from "@/components/dialog/dialog-settings"
import { DialogSessionExport } from "@/components/dialog/dialog-session-export"
import { getScopeLabel, isGlobalScope } from "@/utils/scope"
import { isHolosSession } from "@/utils/session"
import { relativeTime } from "@/utils/time"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import "./header-bar.css"

function SessionStateBadge(props: { item: RecentSessionItem }) {
  return (
    <Show when={props.item.badge}>
      {(badge) => <span class={`sid-state-badge is-${badge().tone}`}>{badge().label}</span>}
    </Show>
  )
}

function sessionDetails(item: RecentSessionItem, title: string, scopeLabel: string): JSX.Element {
  return (
    <div class="flex max-w-80 flex-col gap-1.5 py-1">
      <div class="flex items-center gap-2">
        <span class="text-13-medium text-text-strong truncate">{title}</span>
        <span class="text-11-regular text-text-subtle whitespace-nowrap">{relativeTime(item.recentAt)}</span>
      </div>
      <div class="text-11-regular text-text-subtle">{scopeLabel}</div>
      <Show when={item.badge}>{(badge) => <div class="text-11-regular text-text-weak">{badge().label}</div>}</Show>
      <Show when={item.preview.userText}>
        <div class="text-12-regular text-text-base line-clamp-2">You: {item.preview.userText}</div>
      </Show>
      <Show when={item.preview.assistantText}>
        <div class="text-12-regular text-text-weak line-clamp-2">AI: {item.preview.assistantText}</div>
      </Show>
    </div>
  )
}

function RecentSessionRow(props: { item: RecentSessionItem; onSelect: (item: RecentSessionItem) => void }) {
  const recent = useRecentSessions()
  const scopeLabel = createMemo(() => recent.scopeLabel(props.item.scope))
  const title = createMemo(() => recent.sessionTitle(props.item))
  const colors = createMemo(() => getAvatarColors(props.item.scope.icon?.color))

  return (
    <Tooltip value={sessionDetails(props.item, title(), scopeLabel())} placement="right">
      <button
        type="button"
        classList={{
          "sid-row": true,
          "is-current": props.item.isCurrent,
        }}
        onMouseEnter={() => recent.prefetch(props.item)}
        onFocus={() => recent.prefetch(props.item)}
        onClick={() => props.onSelect(props.item)}
      >
        <Avatar
          fallback={scopeLabel()}
          src={props.item.scope.icon?.url}
          size="small"
          background={colors().background}
          foreground={colors().foreground}
        />
        <div class="min-w-0 flex-1 text-left">
          <div class="sid-row-topline">
            <span class="sid-row-title truncate">{title()}</span>
            <SessionStateBadge item={props.item} />
          </div>
          <div class="sid-row-subtitle truncate">
            {scopeLabel()} ·{" "}
            {props.item.preview.userText || props.item.preview.assistantText || relativeTime(props.item.recentAt)}
          </div>
        </div>
      </button>
    </Tooltip>
  )
}

function SessionIdentitySwitcher() {
  const params = useParams()
  const navigate = useNavigate()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const recent = useRecentSessions()
  const [store, setStore] = createStore({ open: false })
  let rootRef: HTMLDivElement | undefined

  const projectDirectory = createMemo(() => (params.dir ? base64Decode(params.dir) : ""))
  const isGlobal = createMemo(() => (params.dir ? isGlobalScope(base64Decode(params.dir)) : false))

  const currentSession = createMemo(() => {
    const dir = projectDirectory()
    if (!dir) return undefined
    const [child] = globalSync.child(dir)
    return child.session.find((s: Session) => s.id === params.id)
  })

  const isHolosConversation = createMemo(() => isHolosSession(currentSession()))
  const [holosContact] = createResource(
    () => {
      const session = currentSession()
      return isHolosSession(session) ? session.endpoint.agentId : undefined
    },
    async (contactId) => {
      const res = await globalSDK.client.holos.contact.get({ id: contactId })
      return res.data
    },
  )

  const recentItems = createMemo(() => recent.list())
  const currentScope = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return undefined
    return globalSync.data.scope.find(
      (scope) => scope.worktree === directory || (scope.sandboxes ?? []).includes(directory),
    )
  })
  const projectLabel = createMemo(() => getScopeLabel(currentScope(), projectDirectory()))
  const sessionTitle = createMemo(() => {
    if (isGlobal()) return "Home"
    if (isHolosConversation()) {
      const contact = holosContact()
      if (contact) return contact.name || contact.id
    }
    return currentSession()?.title || "New session"
  })
  const summary = createMemo(() => recent.summary().label)

  const close = () => {
    setStore("open", false)
  }

  const onSelect = (item: RecentSessionItem) => {
    const directory = item.session.scope.directory
    if (!directory) return
    navigate(`/${base64Encode(directory)}/session/${item.session.id}`)
    close()
  }

  createEffect(() => {
    if (recentItems().length === 0) close()
  })

  createEffect(() => {
    if (typeof document === "undefined") return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef?.contains(target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    })
  })

  return (
    <div ref={rootRef} class="sid-switcher">
      <button
        type="button"
        classList={{
          "sid-trigger": true,
          "is-open": store.open,
        }}
        onClick={() => {
          if (store.open) {
            close()
            return
          }
          setStore("open", true)
        }}
      >
        <div class="sid-trigger-copy min-w-0">
          <Show
            when={!isGlobal()}
            fallback={
              <div class="sid-trigger-home-row">
                <span class="sid-trigger-home-title truncate">Home</span>
                <span class="sid-trigger-home-summary shrink-0">{summary()}</span>
              </div>
            }
          >
            <div class="sid-trigger-meta-row">
              <span class="sid-trigger-project truncate">{projectLabel()}</span>
              <span class="sid-trigger-summary shrink-0">{summary()}</span>
            </div>
            <div class="sid-trigger-title-row">
              <span class="sid-trigger-title truncate">{sessionTitle()}</span>
            </div>
          </Show>
        </div>
        <Show when={recentItems().length > 0}>
          <Icon name={store.open ? "chevron-up" : "chevron-down"} size="small" class="text-icon-weak shrink-0" />
        </Show>
      </button>

      <Show when={store.open && recentItems().length > 0}>
        <div class="sid-menu">
          <div class="sid-menu-header">
            <span class="sid-menu-title">Recent Sessions</span>
            <span class="sid-menu-summary">
              {recentItems().length} recent · {summary()}
            </span>
          </div>
          <For each={recentItems()}>{(item) => <RecentSessionRow item={item} onSelect={onSelect} />}</For>
        </div>
      </Show>
    </div>
  )
}

function PanelToggle(props: { id: string; icon: IconName; label: string }) {
  const panel = usePanel()
  const isActive = () => panel.active() === props.id

  return (
    <Tooltip value={props.label} placement="bottom">
      <button
        type="button"
        classList={{
          "hb-btn": true,
          "hb-btn-active": isActive(),
        }}
        onClick={() => panel.toggle(props.id)}
      >
        <Icon name={props.icon} size="normal" />
      </button>
    </Tooltip>
  )
}

function ThemeToggle() {
  const theme = useTheme()
  const isDark = () => theme.mode() === "dark"

  return (
    <Tooltip value={isDark() ? "Switch to light mode" : "Switch to dark mode"} placement="bottom">
      <button
        type="button"
        class="hb-btn"
        onClick={() => {
          theme.setColorScheme(isDark() ? "light" : "dark")
        }}
      >
        <Icon name={isDark() ? "sun" : "moon"} size="normal" />
      </button>
    </Tooltip>
  )
}

export function HeaderBar() {
  const params = useParams()
  const globalSync = useGlobalSync()
  const panel = usePanel()
  const command = useCommand()
  const dialog = useDialog()
  const navigate = useNavigate()
  const layout = useLayout()
  const theme = useTheme()
  const inDirectory = () => !!params.dir
  const isGlobal = createMemo(() => (params.dir ? isGlobalScope(base64Decode(params.dir)) : false))
  const isHolosConversation = createMemo(() => {
    const dir = params.dir ? base64Decode(params.dir) : ""
    if (!dir) return false
    const [store] = globalSync.child(dir)
    const session = store.session.find((s: Session) => s.id === params.id)
    return isHolosSession(session)
  })

  return (
    <header class="h-11 shrink-0 bg-background-weak flex items-center px-3 justify-between border-b border-border-weaker-base/60 relative z-30">
      <div class="flex items-center gap-1 min-w-0">
        <A
          href="/"
          class="hidden md:flex items-center justify-center size-6 shrink-0 rounded-lg hover:bg-surface-raised-base-hover transition-all"
          onClick={() => panel.close()}
        >
          <img
            src={theme.mode() === "dark" ? "/holos-logo-white.svg" : "/holos-logo.svg"}
            alt="Holos"
            class="size-6 shrink-0 transition-transform duration-300 hover:scale-110 hover:rotate-6"
          />
        </A>
        <button
          type="button"
          class="md:hidden flex items-center justify-center size-8 shrink-0 rounded-lg hover:bg-surface-raised-base-hover transition-all"
          onClick={() => layout.mobileSidebar.toggle()}
        >
          <Icon name="menu" size="normal" class="text-icon-base" />
        </button>

        <Show when={inDirectory()}>
          <SessionIdentitySwitcher />
          <Show when={!isHolosConversation() && !isGlobal()}>
            <TooltipKeybind placement="bottom" title="New session" keybind={command.keybind("session.new")}>
              <A
                href={`/${params.dir}/session`}
                class="flex items-center justify-center size-7 ml-1 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover active:bg-surface-raised-base-active transition-colors"
              >
                <Icon name="plus" size="small" />
              </A>
            </TooltipKeybind>
          </Show>
        </Show>
      </div>

      <div class="hidden md:flex items-center gap-3">
        <div class="flex items-center gap-0.5">
          <Tooltip value="Home" placement="bottom">
            <button
              type="button"
              classList={{
                "hb-btn": true,
                "hb-btn-active": isGlobal(),
              }}
              onClick={() => {
                navigate(`/${base64Encode("global")}/session`)
                panel.close()
              }}
            >
              <Icon name="home" size="normal" />
            </button>
          </Tooltip>
          <PanelToggle id="scopes" icon="layout-grid" label="Projects" />
        </div>

        <div class="hb-sep" />

        <div class="flex items-center gap-0.5">
          <PanelToggle id="note" icon="notebook-pen" label="Notes" />
          <PanelToggle id="lucid" icon="sparkles" label="Lucid" />
          <Show when={inDirectory()}>
            <PanelToggle id="engram" icon="brain" label="Engram" />
            <PanelToggle id="agenda" icon="clipboard-list" label="Agenda" />
          </Show>
          <PanelToggle id="holos" icon="users" label="Holos" />
        </div>

        <div class="hb-sep" />

        <div class="hb-utils flex items-center gap-0.5">
          <Tooltip value="Agora" placement="bottom">
            <a href="https://test.holosai.io/?view=agora" target="_blank" rel="noopener noreferrer" class="hb-btn">
              <Icon name="globe" size="normal" />
            </a>
          </Tooltip>
          <Show when={inDirectory() && params.id}>
            <Tooltip value="Export Session Data" placement="bottom">
              <button type="button" class="hb-btn" onClick={() => dialog.show(() => <DialogSessionExport />)}>
                <Icon name="download" size="normal" />
              </button>
            </Tooltip>
          </Show>
          <Tooltip value="Settings" placement="bottom">
            <button type="button" class="hb-btn" onClick={() => dialog.show(() => <DialogSettings />)}>
              <Icon name="settings" size="normal" />
            </button>
          </Tooltip>
          <ThemeToggle />
        </div>
      </div>

      <div class="flex md:hidden items-center gap-0.5">
        <button type="button" class="hb-btn" onClick={() => dialog.show(() => <DialogSettings />)}>
          <Icon name="settings" size="normal" />
        </button>
        <ThemeToggle />
      </div>
    </header>
  )
}
