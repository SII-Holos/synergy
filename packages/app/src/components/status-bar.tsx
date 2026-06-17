import { createMemo, createSignal, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useHolos } from "@/context/holos"
import { useServer } from "@/context/server"
import { SessionLspIndicator, SessionMcpIndicator, SessionCortexIndicator } from "@/components/session"
import { useGlobalSync } from "@/context/global-sync"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import type { Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"

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

function holosLabel(holos: ReturnType<typeof useHolos>) {
  if (!holos.loaded) return "Holos loading"
  if (!holos.state.identity.loggedIn) return "Holos signed out"
  if (holos.state.connection.status === "connected") return "Holos connected"
  if (holos.state.connection.status === "connecting") return "Holos connecting"
  if (holos.state.connection.status === "failed") return "Holos failed"
  if (holos.state.connection.status === "disconnected") return "Holos disconnected"
  if (holos.state.connection.status === "disabled") return "Holos disabled"
  return "Holos unknown"
}

function holosTone(holos: ReturnType<typeof useHolos>) {
  if (!holos.loaded || !holos.state.identity.loggedIn) return "muted" as const
  if (holos.state.connection.status === "connected") return "success" as const
  if (holos.state.connection.status === "connecting") return "active" as const
  if (holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected")
    return "danger" as const
  return "muted" as const
}

function HolosStatusIndicator() {
  const holos = useHolos()
  const label = createMemo(() => holosLabel(holos))
  const dot = createMemo(() => holosTone(holos))

  return (
    <div
      class="flex items-center gap-2 h-7 px-2.5 rounded-full transition-colors hover:bg-surface-raised-base-hover shrink-0"
      title={label()}
    >
      <div classList={statusDotClass(dot())} />
      <span class="text-12-medium text-text-base">Holos</span>
    </div>
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
  if (root && path === root) return "main checkout"
  if (root && path.startsWith(root)) return path.slice(root.length + 1)
  return path.replace(/^\/Users\/[^/]+\//, "~/")
}
function endpointLabel(session: Session | undefined) {
  const endpoint = session?.endpoint
  if (!endpoint) return "Web"
  if (endpoint.kind === "holos") return "Holos"
  return endpoint.channel.type
}

function runtimeLabel(status: SessionStatus | undefined, waiting: boolean) {
  if (waiting) return "waiting"
  if (!status || status.type === "idle") return "idle"
  if (status.type === "busy") return status.description || "running"
  if (status.type === "retry") return `retry ${status.attempt}`
  return "idle"
}

function runtimeTone(_status: SessionStatus | undefined, waiting: boolean): "base" | "danger" {
  if (waiting) return "danger"
  return "base"
}

function DetailRow(props: { label: string; value: string | undefined }) {
  return (
    <div class="grid grid-cols-[88px_minmax(0,1fr)] gap-3 text-12-regular">
      <div class="text-text-weaker">{props.label}</div>
      <div class="text-text-base break-all" title={props.value || undefined}>
        {props.value || "—"}
      </div>
    </div>
  )
}

function DetailGroup(props: { title: string; children: any }) {
  return (
    <div class="space-y-1.5 min-w-0">
      <div class="text-12-medium text-text-weak">{props.title}</div>
      {props.children}
    </div>
  )
}

function StatusPill(props: { icon?: IconName; label: string; tone?: "base" | "danger" | "active"; class?: string }) {
  return (
    <div
      classList={{
        "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-12-medium whitespace-nowrap transition-colors shrink-0": true,
        [props.class || ""]: !!props.class,
        "bg-surface-raised-base text-text-base hover:bg-surface-raised-base-hover":
          !props.tone || props.tone === "base" || props.tone === "active",
        "bg-surface-critical-subtle text-text-critical-base hover:bg-surface-critical-base": props.tone === "danger",
      }}
      title={props.label}
    >
      <Show when={props.icon}>{(icon) => <Icon name={icon()} size="small" class="text-current" />}</Show>
      <span>{props.label}</span>
    </div>
  )
}

function serverStatusLabel(healthy: boolean | undefined) {
  if (healthy === true) return "active"
  if (healthy === false) return "unavailable"
  return "unknown"
}

export function StatusBar() {
  const params = useParams()
  const globalSync = useGlobalSync()
  const holos = useHolos()
  const server = useServer()
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
  const activeConfig = createMemo(() => globalSync.configSets.find((set) => set.active)?.name ?? "default")

  return (
    <div class="flex flex-col items-center gap-1 py-1 min-w-0 w-full">
      <Show when={params.dir}>
        <div
          class="grid w-[min(900px,calc(100vw-2rem))] transition-[grid-template-rows,opacity,transform] duration-300 ease-out"
          classList={{ "-translate-y-1": !expanded(), "translate-y-0": expanded() }}
          style={{ "grid-template-rows": expanded() ? "1fr" : "0fr", opacity: expanded() ? 1 : 0 }}
        >
          <div class="overflow-hidden min-h-0">
            <div class="rounded-2xl border border-border-base bg-surface-raised-stronger-non-alpha/95 shadow-lg p-3 backdrop-blur-md">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-x-5 gap-y-3">
                <DetailGroup title="Workspace">
                  <DetailRow label="Scope" value={scopeLabel()} />
                  <DetailRow label="Type" value={isWorktree() ? "git worktree" : "main"} />
                  <DetailRow label="Name" value={workspaceName()} />
                  <DetailRow label="Branch" value={branch()} />
                </DetailGroup>
                <DetailGroup title="Session">
                  <DetailRow label="Runtime" value={runtime()} />
                  <DetailRow label="Path" value={shortPath(workspacePath(), scope()?.worktree || directory())} />
                  <DetailRow label="Parent" value={session()?.parentID ? "child session" : "root session"} />
                  <DetailRow label="Endpoint" value={endpointLabel(session())} />
                </DetailGroup>
                <DetailGroup title="Connection">
                  <DetailRow label="Holos" value={holosLabel(holos)} />
                  <DetailRow label="Server" value={`${server.name} · ${serverStatusLabel(server.healthy())}`} />
                  <DetailRow label="Config" value={activeConfig()} />
                </DetailGroup>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <div
        class="flex flex-wrap items-center justify-center gap-2 min-w-0 max-w-full overflow-visible"
        style={{ "max-width": "min(100%, 900px)" }}
      >
        <HolosStatusIndicator />
        <Show when={params.dir}>
          <button
            type="button"
            class="flex flex-wrap items-center justify-center gap-1.5 rounded-full px-1 py-0.5 transition-colors hover:bg-surface-raised-base-hover"
            onClick={() => setExpanded((value) => !value)}
          >
            <StatusPill
              icon={isWorktree() ? "git-branch" : "home"}
              label={isWorktree() ? `worktree · ${workspaceName()}` : "main"}
              tone={isWorktree() ? "active" : "base"}
            />
            <Show when={branch()}>{(value) => <StatusPill icon="git-branch" label={value()} />}</Show>
            <StatusPill label={runtime()} tone={runtimeTone(status(), waiting())} />
            <Icon name={expanded() ? "chevron-down" : "chevron-up"} size="small" class="text-icon-weak mx-1 shrink-0" />
          </button>
        </Show>
        <Show when={params.dir}>
          <div class="flex items-center gap-0.5 shrink-0">
            <SessionLspIndicator />
            <SessionMcpIndicator />
            <Show when={params.id}>
              <SessionCortexIndicator sessionID={params.id!} />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
