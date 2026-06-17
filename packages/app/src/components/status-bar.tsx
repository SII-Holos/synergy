import { createMemo, createSignal, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServer } from "@/context/server"
import { useHolos } from "@/context/holos"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { DialogSelectServer } from "@/components/dialog"
import { SessionLspIndicator, SessionMcpIndicator, SessionCortexIndicator } from "@/components/session"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { SettingsDialog } from "@/components/settings"
import { DropdownMenu } from "@ericsanchezok/synergy-ui/dropdown-menu"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import type { Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"

function ConfigSetStatus() {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(false)
  const [activating, setActivating] = createSignal<string>()

  const activeSet = createMemo(() => globalSync.configSets.find((set) => set.active))

  async function handleActivate(name: string) {
    if (name === activeSet()?.name || activating()) return
    setActivating(name)
    try {
      await globalSDK.client.config.set.activate({ name })
      await globalSync.refreshAllConfigs()
      showToast({ title: "Config Set activated", description: `Using ${name}` })
      setOpen(false)
    } catch (error: any) {
      showToast({ title: "Failed to switch Config Set", description: error.message })
    } finally {
      setActivating(undefined)
    }
  }

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        data-component="button"
        data-size="small"
        data-variant="ghost"
        class="rounded-full px-2.5 h-7 transition-colors hover:bg-surface-raised-base-hover"
      >
        <div class="flex items-center gap-2 min-w-0">
          <Icon name="server" size="small" class="text-icon-base" />
          <span class="text-12-medium text-text-base truncate max-w-24">{activeSet()?.name ?? "default"}</span>
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-52" onClick={(event: MouseEvent) => event.stopPropagation()}>
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>Switch Config Set</DropdownMenu.GroupLabel>
            <For each={globalSync.configSets}>
              {(set) => (
                <DropdownMenu.Item onSelect={() => void handleActivate(set.name)} disabled={!!activating()}>
                  <Icon name={set.active ? "check" : "server"} size="small" class="mr-2" />
                  <DropdownMenu.ItemLabel>
                    <span class="flex items-center gap-2">
                      <span>{set.name}</span>
                      <Show when={activating() === set.name}>
                        <span class="text-text-weak">Switching...</span>
                      </Show>
                    </span>
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            onSelect={() => {
              setOpen(false)
              dialog.show(() => <SettingsDialog initialTab="config-sets" />)
            }}
          >
            <Icon name="settings" size="small" class="mr-2" />
            <DropdownMenu.ItemLabel>Manage in Settings</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function statusDotClass(status: "success" | "danger" | "muted" | "active") {
  return {
    "size-1.5 rounded-full shadow-[0_0_0_2px_color-mix(in_srgb,currentColor_20%,transparent)]": true,
    "bg-icon-success-base text-icon-success-base animate-[statusPulse_3s_ease-in-out_infinite]": status === "success",
    "bg-icon-critical-base text-icon-critical-base animate-[statusPulse_1.5s_ease-in-out_infinite]":
      status === "danger",
    "bg-icon-base text-icon-base animate-[statusPulse_2s_ease-in-out_infinite]": status === "active",
    "bg-border-strong text-border-strong": status === "muted",
  }
}

function HolosStatusIndicator() {
  const holos = useHolos()
  const label = createMemo(() => {
    if (!holos.loaded) return "Holos loading"
    if (!holos.state.identity.loggedIn) return "Holos signed out"
    if (holos.state.connection.status === "connected") return "Holos connected"
    if (holos.state.connection.status === "connecting") return "Holos connecting"
    if (holos.state.connection.status === "failed") return "Holos failed"
    if (holos.state.connection.status === "disconnected") return "Holos disconnected"
    if (holos.state.connection.status === "disabled") return "Holos disabled"
    return "Holos unknown"
  })
  const dot = createMemo(() => {
    if (!holos.loaded || !holos.state.identity.loggedIn) return "muted" as const
    if (holos.state.connection.status === "connected") return "success" as const
    if (holos.state.connection.status === "connecting") return "active" as const
    if (holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected")
      return "danger" as const
    return "muted" as const
  })

  return (
    <Button
      size="small"
      variant="ghost"
      class="rounded-full px-2.5 h-7 transition-colors hover:bg-surface-raised-base-hover"
    >
      <div class="flex items-center gap-2">
        <div classList={statusDotClass(dot())} />
        <span class="text-12-medium text-text-base truncate max-w-28">{label()}</span>
      </div>
    </Button>
  )
}

function decodeDirectory(value: string | undefined) {
  if (!value) return undefined
  try {
    return base64Decode(value)
  } catch {
    return undefined
  }
}

function workspaceField(session: Session | undefined, key: string) {
  const value = session?.workspace?.[key]
  return typeof value === "string" ? value : undefined
}

function shortPath(path: string | undefined, root: string | undefined) {
  if (!path) return "—"
  if (root && path.startsWith(root)) return path === root ? "." : path.slice(root.length + 1)
  return path.replace(/^\/Users\/[^/]+\//, "~/")
}

function runtimeLabel(status: SessionStatus | undefined, waiting: boolean) {
  if (waiting) return "waiting"
  if (!status || status.type === "idle") return "idle"
  if (status.type === "busy") return status.description || "running"
  if (status.type === "retry") return `retry ${status.attempt}`
  return "idle"
}

function runtimeTone(status: SessionStatus | undefined, waiting: boolean): "success" | "danger" | "muted" | "active" {
  if (waiting) return "danger"
  if (!status || status.type === "idle") return "success"
  if (status.type === "busy" || status.type === "retry") return "active"
  return "muted"
}

function DetailRow(props: { label: string; value: string | undefined }) {
  return (
    <div class="grid grid-cols-[88px_minmax(0,1fr)] gap-3 text-12-regular">
      <div class="text-text-weaker">{props.label}</div>
      <div class="text-text-base truncate" title={props.value || undefined}>
        {props.value || "—"}
      </div>
    </div>
  )
}

function StatusPill(props: {
  icon?: IconName
  label: string
  tone?: "base" | "success" | "danger" | "active" | "muted"
}) {
  return (
    <div
      classList={{
        "flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-12-medium whitespace-nowrap": true,
        "border-border-base bg-surface-raised-base text-text-base":
          !props.tone || props.tone === "base" || props.tone === "muted",
        "border-border-success bg-surface-success-subtle text-text-success-base": props.tone === "success",
        "border-border-danger bg-surface-critical-subtle text-text-critical-base": props.tone === "danger",
        "border-border-base bg-surface-raised-base-hover text-text-base": props.tone === "active",
      }}
    >
      <Show when={props.icon}>{(icon) => <Icon name={icon()} size="small" class="text-current" />}</Show>
      <span class="truncate max-w-40">{props.label}</span>
    </div>
  )
}

function SessionContextStatus() {
  const params = useParams()
  const globalSync = useGlobalSync()
  const holos = useHolos()
  const [expanded, setExpanded] = createSignal(false)

  const directory = createMemo(() => decodeDirectory(params.dir))
  const store = createMemo(() => {
    const dir = directory()
    if (!dir || dir === "global") return undefined
    return globalSync.child(dir)[0]
  })
  const scope = createMemo(() => {
    const current = store()
    if (!current?.scopeID) return undefined
    return globalSync.data.scope.find((item) => item.id === current.scopeID)
  })
  const session = createMemo(() => {
    const id = params.id
    const current = store()
    if (!id || !current) return undefined
    return current.session.find((item) => item.id === id)
  })
  const status = createMemo(() => (params.id ? store()?.session_status[params.id] : undefined))
  const waiting = createMemo(() => {
    const id = params.id
    const current = store()
    if (!id || !current) return false
    return !!current.permission[id]?.length || !!current.question[id]?.length
  })
  const workspaceType = createMemo(() => session()?.workspace?.type ?? "main")
  const isWorktree = createMemo(() => workspaceType() === "git_worktree")
  const workspaceName = createMemo(() => workspaceField(session(), "name") || (isWorktree() ? "worktree" : "main"))
  const branch = createMemo(() => workspaceField(session(), "branch") || store()?.vcs?.branch)
  const workspacePath = createMemo(() => session()?.workspace?.path || session()?.scope.directory || directory())
  const scopeLabel = createMemo(() => getScopeLabel(scope(), directory()))
  const runtime = createMemo(() => runtimeLabel(status(), waiting()))
  const holosSummary = createMemo(() => {
    if (!holos.loaded) return "Holos loading"
    if (!holos.state.identity.loggedIn) return "Holos signed out"
    return `Holos ${holos.state.connection.status}`
  })

  return (
    <div class="relative inline-flex min-w-0">
      <div
        class="absolute bottom-full left-1/2 z-30 grid w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 transition-[grid-template-rows,opacity,transform] duration-300 ease-out"
        classList={{ "translate-y-1": !expanded(), "translate-y-0": expanded() }}
        style={{ "grid-template-rows": expanded() ? "1fr" : "0fr", opacity: expanded() ? 1 : 0 }}
      >
        <div class="overflow-hidden min-h-0">
          <div class="mb-1 rounded-2xl border border-border-base bg-surface-raised-stronger-non-alpha/95 shadow-lg p-3 backdrop-blur-md">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div class="space-y-1.5">
                <div class="text-11-medium uppercase tracking-[0.16em] text-text-weaker">Workspace</div>
                <DetailRow label="Scope" value={scopeLabel()} />
                <DetailRow label="Type" value={isWorktree() ? "git worktree" : "main"} />
                <DetailRow label="Name" value={workspaceName()} />
                <DetailRow label="Branch" value={branch()} />
              </div>
              <div class="space-y-1.5">
                <div class="text-11-medium uppercase tracking-[0.16em] text-text-weaker">Session</div>
                <DetailRow label="Runtime" value={runtime()} />
                <DetailRow label="Path" value={shortPath(workspacePath(), scope()?.worktree || directory())} />
                <DetailRow label="Parent" value={session()?.parentID ? "child session" : "root session"} />
                <DetailRow label="Endpoint" value={session()?.endpoint?.kind || "web"} />
              </div>
              <div class="space-y-1.5">
                <div class="text-11-medium uppercase tracking-[0.16em] text-text-weaker">Connection</div>
                <DetailRow label="Holos" value={holosSummary()} />
                <DetailRow label="Server" value="active" />
                <DetailRow label="Config" value={globalSync.configSets.find((set) => set.active)?.name ?? "default"} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="max-w-full min-w-0 flex items-center justify-center gap-1.5 rounded-full px-1 py-0.5 transition-colors hover:bg-surface-raised-base-hover"
        onClick={() => setExpanded((value) => !value)}
      >
        <StatusPill
          icon={isWorktree() ? "git-branch" : "home"}
          label={isWorktree() ? `worktree · ${workspaceName()}` : "main"}
          tone={isWorktree() ? "active" : "base"}
        />
        <Show when={branch()}>{(value) => <StatusPill icon="git-branch" label={value()} />}</Show>
        <StatusPill label={runtime()} tone={runtimeTone(status(), waiting())} />
        <Icon name={expanded() ? "chevron-down" : "chevron-up"} size="small" class="text-icon-weak mx-1" />
      </button>
    </div>
  )
}

export function StatusBar() {
  const params = useParams()
  const server = useServer()
  const dialog = useDialog()

  return (
    <div class="flex items-center justify-center gap-2 py-1 flex-wrap min-w-0">
      <Button
        size="small"
        variant="ghost"
        class="rounded-full px-2.5 h-7 transition-colors hover:bg-surface-raised-base-hover"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div class="flex items-center gap-2">
          <div
            classList={statusDotClass(
              server.healthy() === true ? "success" : server.healthy() === false ? "danger" : "muted",
            )}
          />
          <span class="text-12-medium text-text-base truncate max-w-24">{server.name}</span>
        </div>
      </Button>

      <ConfigSetStatus />
      <HolosStatusIndicator />
      <Show when={params.dir}>
        <SessionContextStatus />
      </Show>

      <Show when={params.dir}>
        <div class="flex items-center gap-0.5">
          <SessionLspIndicator />
          <SessionMcpIndicator />
          <Show when={params.id}>
            <SessionCortexIndicator sessionID={params.id!} />
          </Show>
        </div>
      </Show>
    </div>
  )
}
