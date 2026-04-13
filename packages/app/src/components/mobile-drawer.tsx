import { createMemo, createSignal, For, Show } from "solid-js"
import { A, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useLayout, getAvatarColors, type LocalScope } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useNotification } from "@/context/notification"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { isGlobalScope } from "@/utils/scope"
import { relativeTime } from "@/utils/time"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

export function MobileDrawer() {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams()
  const notification = useNotification()
  const theme = useTheme()

  const [drilldown, setDrilldown] = createSignal<LocalScope | null>(null)

  const currentDir = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  function close() {
    layout.mobileSidebar.hide()
    setDrilldown(null)
  }

  function navigateAndClose(path: string) {
    navigate(path)
    close()
  }

  return (
    <Show when={layout.mobileSidebar.opened()}>
      <div class="fixed inset-0 z-[100] flex md:hidden">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-black/40"
          style={{ animation: "mobileDrawerFadeIn 200ms ease-out both" }}
          onClick={close}
        />
        {/* Drawer panel */}
        <div
          class="relative w-[85vw] max-w-80 h-full bg-background-stronger flex flex-col shadow-2xl"
          style={{ animation: "mobileDrawerSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1) both" }}
        >
          {/* Header */}
          <div class="flex items-center justify-between px-4 h-12 shrink-0 border-b border-border-weaker-base/60">
            <A href="/" class="flex items-center gap-2" onClick={close}>
              <img
                src={theme.mode() === "dark" ? "/holos-logo-white.svg" : "/holos-logo.svg"}
                alt="Holos"
                class="size-6 shrink-0"
              />
              <span class="text-14-medium text-text-strong">Synergy</span>
            </A>
            <button
              type="button"
              class="flex items-center justify-center size-8 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
              onClick={close}
            >
              <Icon name="x" size="normal" />
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 min-h-0 overflow-y-auto">
            <Show
              when={drilldown()}
              fallback={
                <ScopeListView
                  currentDir={currentDir()}
                  onSelectScope={setDrilldown}
                  onNavigateHome={() => navigateAndClose(`/${base64Encode("global")}/session`)}
                />
              }
            >
              {(scope) => (
                <SessionListDrawerView
                  scope={scope()}
                  currentSessionID={params.id}
                  notification={notification}
                  onBack={() => setDrilldown(null)}
                  onSelectSession={(session) =>
                    navigateAndClose(`/${base64Encode(session.scope.directory!)}/session/${session.id}`)
                  }
                  onNewSession={() => navigateAndClose(`/${base64Encode(scope().worktree)}/session`)}
                />
              )}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

function ScopeListView(props: {
  currentDir: string | undefined
  onSelectScope: (scope: LocalScope) => void
  onNavigateHome: () => void
}) {
  const layout = useLayout()
  const globalSync = useGlobalSync()

  const scopes = createMemo(() => {
    const homePath = globalSync.data.path?.home
    const seen = new Set<string>()
    return layout.scopes.list().filter((s) => {
      if (s.worktree === homePath) return false
      if (seen.has(s.worktree)) return false
      seen.add(s.worktree)
      return true
    })
  })

  const isHomeActive = createMemo(() => (props.currentDir ? isGlobalScope(props.currentDir) : false))

  return (
    <div class="py-2">
      {/* Home */}
      <button
        type="button"
        classList={{
          "w-full flex items-center gap-3 px-4 py-2.5 transition-colors": true,
          "bg-surface-interactive-base/8 text-text-interactive-base": isHomeActive(),
          "text-text-base hover:bg-surface-raised-base-hover": !isHomeActive(),
        }}
        onClick={props.onNavigateHome}
      >
        <Icon name="home" size="normal" class="shrink-0" />
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
          const colors = createMemo(() => getAvatarColors(scope.icon?.color))
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
                "bg-surface-interactive-base/8": isActive(),
                "hover:bg-surface-raised-base-hover": !isActive(),
              }}
              onClick={() => props.onSelectScope(scope)}
            >
              <Avatar
                fallback={scope.name || getFilename(scope.worktree)}
                src={scope.icon?.url}
                size="small"
                background={colors().background}
                foreground={colors().foreground}
              />
              <span
                classList={{
                  "text-14-medium truncate": true,
                  "text-text-interactive-base": isActive(),
                  "text-text-base": !isActive(),
                }}
              >
                {scope.name || getFilename(scope.worktree)}
              </span>
              <Icon name="chevron-right" size="small" class="ml-auto shrink-0 text-icon-weak" />
            </button>
          )
        }}
      </For>
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
}) {
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const [loadingMore, setLoadingMore] = createSignal(false)

  const sessions = createMemo(() => layout.nav.projectSessions(props.scope))
  const hasMore = createMemo(() => layout.nav.projectHasMoreSessions(props.scope))

  const scopeName = createMemo(() => {
    if (isGlobalScope(props.scope.worktree)) return "Home"
    return props.scope.name || getFilename(props.scope.worktree)
  })

  async function loadMore() {
    setLoadingMore(true)
    try {
      await layout.nav.loadMoreSessions(props.scope)
    } finally {
      setLoadingMore(false)
    }
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
          <Icon name="arrow-left" size="small" />
          <span class="text-12-medium">Projects</span>
        </button>
        <span class="flex-1" />
        <span class="text-13-medium text-text-strong truncate max-w-40">{scopeName()}</span>
      </div>

      {/* New session */}
      <button
        type="button"
        class="flex items-center gap-2.5 mx-3 mt-2.5 mb-1 px-3 py-2 rounded-xl border border-dashed border-border-base/50 text-13-medium text-text-weak hover:text-text-interactive-base hover:border-text-interactive-base/30 hover:bg-surface-interactive-base/5 transition-all"
        onClick={props.onNewSession}
      >
        <Icon name="plus" size="small" />
        <span>New session</span>
      </button>

      {/* Session list */}
      <div class="flex-1 min-h-0 overflow-y-auto py-1">
        <For each={sessions()}>
          {(session) => {
            const isActive = () => session.id === props.currentSessionID
            const updatedAt = () => session.time.updated ?? session.time.created
            const [childStore] = globalSync.child(session.scope.directory!)
            const isWorking = createMemo(() => {
              if (isActive()) return false
              const status = childStore.session_status[session.id]
              return status?.type === "busy" || status?.type === "retry"
            })
            const sessionNotifications = createMemo(() => props.notification.session.unseen(session.id))
            const hasNotification = createMemo(() => sessionNotifications().length > 0)

            return (
              <button
                type="button"
                classList={{
                  "w-full flex items-start gap-3 px-4 py-2.5 transition-colors text-left": true,
                  "bg-surface-interactive-base/8": isActive(),
                  "hover:bg-surface-raised-base-hover": !isActive(),
                }}
                onClick={() => props.onSelectSession(session)}
              >
                <div class="w-3 shrink-0 pt-1.5 flex items-center justify-center">
                  <Show when={isWorking()}>
                    <Spinner class="size-3" />
                  </Show>
                  <Show when={!isWorking() && hasNotification()}>
                    <div class="size-1.5 rounded-full bg-text-interactive-base" />
                  </Show>
                </div>
                <div class="flex-1 min-w-0">
                  <div
                    classList={{
                      "text-13-medium truncate": true,
                      "text-text-interactive-base": isActive(),
                      "text-text-base": !isActive(),
                    }}
                  >
                    {session.title || "New session"}
                  </div>
                  <div class="text-11-regular text-text-weak mt-0.5">{relativeTime(updatedAt())}</div>
                </div>
                <Show when={session.pinned && session.pinned > 0}>
                  <Icon name="pin" size="small" class="shrink-0 text-icon-weak mt-0.5" />
                </Show>
              </button>
            )
          }}
        </For>
        <Show when={hasMore()}>
          <button
            type="button"
            class="w-full px-4 py-2 text-12-medium text-text-weak hover:text-text-base transition-colors text-center"
            disabled={loadingMore()}
            onClick={loadMore}
          >
            {loadingMore() ? "Loading..." : "Load more"}
          </button>
        </Show>
        <Show when={sessions().length === 0}>
          <div class="px-4 py-8 text-center text-13-regular text-text-weak">No sessions yet</div>
        </Show>
      </div>
    </div>
  )
}
