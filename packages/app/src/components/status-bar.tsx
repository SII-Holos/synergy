import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useHolos } from "@/context/holos"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { SessionLspIndicator, SessionMcpIndicator, SessionCortexIndicator } from "@/components/session"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
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

function runtimeLabel(status: SessionStatus | undefined, waiting: boolean) {
  if (waiting) return "waiting"
  if (!status || status.type === "idle") return "idle"
  if (status.type === "busy") return status.description || "running"
  if (status.type === "retry") return `retry ${status.attempt}`
  return "idle"
}

function serverStatusLabel(healthy: boolean | undefined) {
  if (healthy === true) return "active"
  if (healthy === false) return "unavailable"
  return "unknown"
}

function iconButtonClass(tone?: "base" | "danger" | "success") {
  return {
    "relative size-7 rounded-full flex items-center justify-center shrink-0 transition-colors hover:bg-surface-raised-base-hover": true,
    "text-icon-base": !tone || tone === "base",
    "text-icon-critical-base": tone === "danger",
    "text-icon-success-base": tone === "success",
  }
}

// ─── Holos icon button ────────────────────────────────────────────

function HolosIconButton(props: { onClick: () => void }) {
  const holos = useHolos()
  const label = createMemo(() => holosLabel(holos))
  const dot = createMemo(() => holosTone(holos))

  return (
    <Tooltip placement="top" value={label()}>
      <button type="button" classList={iconButtonClass()} onClick={props.onClick}>
        <Icon name={getSemanticIcon("connection.holos")} size="small" />
        <div
          classList={{
            ...statusDotClass(dot()),
            "absolute bottom-0 right-0": true,
            "shadow-[0_0_0_1px_var(--color-surface-raised-base)]": true,
          }}
        />
      </button>
    </Tooltip>
  )
}

// ─── Workspace icon button ────────────────────────────────────────

function WorkspaceIconButton(props: { isWorktree: boolean; workspaceName: string; onClick: () => void }) {
  const icon = () => getSemanticIcon(props.isWorktree ? "workspace.worktree" : "workspace.main")
  const tooltip = () => (props.isWorktree ? `Worktree: ${props.workspaceName}` : "Main checkout")

  return (
    <Tooltip placement="top" value={tooltip()}>
      <button type="button" classList={iconButtonClass(props.isWorktree ? "success" : "base")} onClick={props.onClick}>
        <Icon name={icon()} size="small" />
      </button>
    </Tooltip>
  )
}

// ─── Branch icon button ───────────────────────────────────────────

function BranchIconButton(props: { branch: string; onClick: () => void }) {
  return (
    <Tooltip placement="top" value={`Branch: ${props.branch}`}>
      <button type="button" classList={iconButtonClass()} onClick={props.onClick}>
        <Icon name={getSemanticIcon("workspace.branch")} size="small" />
      </button>
    </Tooltip>
  )
}

// ─── Runtime icon button ──────────────────────────────────────────

function RuntimeIconButton(props: { status: SessionStatus | undefined; waiting: boolean; onClick: () => void }) {
  const icon = () => {
    if (props.waiting) return getSemanticIcon("session.waiting")
    if (props.status?.type === "busy") return getSemanticIcon("session.running")
    return getSemanticIcon("session.idle")
  }
  const tooltip = () => `Runtime: ${runtimeLabel(props.status, props.waiting)}`
  const tone = () => (props.waiting ? ("danger" as const) : ("base" as const))

  return (
    <Tooltip placement="top" value={tooltip()}>
      <button type="button" classList={iconButtonClass(tone())} onClick={props.onClick}>
        <Icon name={icon()} size="small" />
      </button>
    </Tooltip>
  )
}

// ─── Panel components ─────────────────────────────────────────────

function PanelSection(props: { title: string; children: JSX.Element }) {
  return (
    <div class="mb-3 last:mb-0">
      <div class="text-11-medium text-text-weaker uppercase tracking-wider mb-1">{props.title}</div>
      <div class="space-y-0.5">{props.children}</div>
    </div>
  )
}

function PanelRow(props: { children: JSX.Element }) {
  return <div class="text-12-regular text-text-base">{props.children}</div>
}

function PanelIconRow(props: { icon: string; label: string; tone?: "base" | "danger" }) {
  return (
    <div class="flex items-center gap-2 text-12-regular">
      <Icon
        name={props.icon}
        size="small"
        class={props.tone === "danger" ? "text-icon-critical-base" : "text-icon-weak"}
      />
      <span class={props.tone === "danger" ? "text-text-critical-base" : "text-text-base"}>{props.label}</span>
    </div>
  )
}

// ─── StatusBar ────────────────────────────────────────────────────

export function StatusBar() {
  const params = useParams()
  const globalSync = useGlobalSync()
  const holos = useHolos()
  const server = useServer()
  const sync = useSync()
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
  const isWorktree = () => workspaceType() === "git_worktree"
  const workspaceName = createMemo(() => workspaceField(session(), "name") || (isWorktree() ? "worktree" : "main"))
  const branch = createMemo(() => workspaceField(session(), "branch") || store()?.vcs?.branch)
  const scopeLabel = createMemo(() => getScopeLabel(scope(), directory()))
  const runtime = createMemo(() => runtimeLabel(status(), waiting()))
  const activeConfig = createMemo(() => globalSync.configSets.find((set) => set.active)?.name ?? "default")

  // Inline accessors for panel connection stats
  const lspConnected = () => {
    const lsp = sync.data.lsp ?? []
    return lsp.filter((s) => s.status === "connected").length
  }
  const lspTotal = () => (sync.data.lsp ?? []).length
  const mcpConnected = () => {
    const mcp = sync.data.mcp ?? {}
    return Object.entries(mcp).filter(([, s]) => s.status === "connected").length
  }
  const mcpFailed = () => {
    const mcp = sync.data.mcp ?? {}
    return Object.entries(mcp).filter(([, s]) => s.status === "failed").length
  }
  const mcpTotal = () => Object.keys(sync.data.mcp ?? {}).length
  const cortexRunning = () =>
    params.id ? sync.data.cortex.filter((t) => t.parentSessionID === params.id && t.status === "running").length : 0
  const cortexCompleted = () =>
    params.id
      ? sync.data.cortex.filter(
          (t) => t.parentSessionID === params.id && (t.status === "completed" || t.status === "error"),
        ).length
      : 0

  const openPanel = () => setExpanded(true)

  const panelContent = (
    <div class="w-64">
      <Show when={waiting()}>
        <div class="rounded-xl bg-surface-critical-subtle p-2.5 mb-3">
          <PanelIconRow icon={getSemanticIcon("session.waiting")} label="Permission required" tone="danger" />
        </div>
      </Show>

      <PanelSection title="Workspace">
        <PanelRow>{isWorktree() ? "Git worktree" : "Main checkout"}</PanelRow>
        <PanelRow>{scopeLabel()}</PanelRow>
        <Show when={isWorktree()}>
          <PanelRow>{workspaceName()}</PanelRow>
        </Show>
        <Show when={branch()}>{(b) => <PanelRow>{b()}</PanelRow>}</Show>
      </PanelSection>

      <PanelSection title="Runtime">
        <PanelRow>
          {runtime()}
          <Show when={status()?.type === "busy" && status()?.description}>
            {(desc) => <span class="text-text-weaker"> · {desc()}</span>}
          </Show>
        </PanelRow>
      </PanelSection>

      <PanelSection title="Connections">
        <PanelRow>Holos · {holosLabel(holos)}</PanelRow>
        <Show when={lspTotal() > 0}>
          <PanelRow>LSP · {lspConnected()} active</PanelRow>
        </Show>
        <Show when={mcpTotal() > 0}>
          <PanelRow>
            MCP · {mcpConnected()} connected
            <Show when={mcpFailed() > 0}>
              <span class="text-text-critical-base">, {mcpFailed()} unavailable</span>
            </Show>
          </PanelRow>
        </Show>
        <Show when={cortexRunning() > 0 || cortexCompleted() > 0}>
          <PanelRow>
            Cortex · {cortexCompleted()} done
            <Show when={cortexRunning() > 0}>
              <span class="text-text-interactive-base"> · {cortexRunning()} running</span>
            </Show>
          </PanelRow>
        </Show>
        <PanelRow>
          Server · {server.name} ({serverStatusLabel(server.healthy())})
        </PanelRow>
        <PanelRow>Config · {activeConfig()}</PanelRow>
      </PanelSection>
    </div>
  )

  return (
    <div class="flex flex-col items-center gap-1 py-1 min-w-0 w-full">
      <div class="flex items-center gap-1.5 min-w-0 max-w-full overflow-visible">
        <HolosIconButton onClick={openPanel} />

        <Show when={params.dir}>
          <WorkspaceIconButton isWorktree={isWorktree()} workspaceName={workspaceName()} onClick={openPanel} />
          <Show when={branch()}>{(b) => <BranchIconButton branch={b()} onClick={openPanel} />}</Show>
          <RuntimeIconButton status={status()} waiting={waiting()} onClick={openPanel} />

          <div class="w-px h-4 bg-border-weak" />

          <SessionLspIndicator />
          <SessionMcpIndicator />
          <Show when={params.id}>
            <SessionCortexIndicator sessionID={params.id!} />
          </Show>

          <div class="w-px h-4 bg-border-weak" />

          <Popover
            open={expanded()}
            onOpenChange={setExpanded}
            placement="top"
            gutter={8}
            trigger={
              <Tooltip placement="top" value="Details">
                <button type="button" classList={iconButtonClass()}>
                  <Icon name="panel-bottom-open" size="small" />
                </button>
              </Tooltip>
            }
          >
            {panelContent}
          </Popover>
        </Show>
      </div>
    </div>
  )
}
