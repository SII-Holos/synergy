import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useHolos } from "@/context/holos"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { ContextBar } from "@/components/context-bar"
import { SessionLspIndicator, SessionMcpIndicator, SessionCortexIndicator } from "@/components/session"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { getScopeLabel } from "@/utils/scope"
import { relativeTime } from "@/utils/time"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { resolveRuntimeIconState, runtimeLabel } from "./status-bar-runtime"
import { sessionActivityTime, sortChildSessionsByActivity } from "./status-bar-subsession"

function statusDotClass(status: "success" | "danger" | "muted" | "active") {
  return {
    "size-1 rounded-full ring-1 ring-inset ring-border-weaker-base": true,
    "bg-icon-success-base text-icon-success-base animate-[statusbarDotPulse_3s_ease-in-out_infinite]":
      status === "success",
    "bg-icon-critical-base text-icon-critical-base animate-[statusbarDotPulse_1.5s_ease-in-out_infinite]":
      status === "danger",
    "bg-icon-base text-icon-base animate-[statusbarDotPulse_2s_ease-in-out_infinite]": status === "active",
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

function HolosIconButton() {
  const holos = useHolos()
  const label = createMemo(() => holosLabel(holos))
  const dot = createMemo(() => holosTone(holos))

  return (
    <Tooltip placement="top" value={label()}>
      <button type="button" classList={iconButtonClass()}>
        <Icon name={getSemanticIcon("connection.holos")} size="small" class="translate-y-px" />
        <div
          classList={{
            ...statusDotClass(dot()),
            "absolute bottom-1 right-1": true,
          }}
        />
      </button>
    </Tooltip>
  )
}

// ─── Workspace icon button ────────────────────────────────────────

function WorkspaceIconButton(props: { isWorktree: boolean; workspaceName: string }) {
  const icon = () => getSemanticIcon(props.isWorktree ? "workspace.worktree" : "workspace.main")
  const tooltip = () => (props.isWorktree ? `Worktree: ${props.workspaceName}` : "Main checkout")

  return (
    <Tooltip placement="top" value={tooltip()}>
      <button type="button" classList={iconButtonClass(props.isWorktree ? "success" : "base")}>
        <Icon name={icon()} size="small" />
      </button>
    </Tooltip>
  )
}

// ─── Branch icon button ───────────────────────────────────────────

function BranchIconButton(props: { branch: string }) {
  return (
    <Tooltip placement="top" value={`Branch: ${props.branch}`}>
      <button type="button" classList={iconButtonClass()}>
        <Icon name={getSemanticIcon("workspace.branch")} size="small" />
      </button>
    </Tooltip>
  )
}

// ─── Runtime icon button ──────────────────────────────────────────

function RuntimeIconButton(props: { status: SessionStatus | undefined; waiting: boolean }) {
  const runtimeState = createMemo(() => resolveRuntimeIconState(props.status, props.waiting))

  async function copyRetryError() {
    const copyText = runtimeState().copyText
    if (!copyText) return

    try {
      await navigator.clipboard.writeText(copyText)
      showToast({ type: "success", title: "Retry error copied" })
    } catch {
      showToast({ type: "error", title: "Copy failed", description: "Unable to copy the retry error." })
    }
  }

  return (
    <Tooltip placement="top" value={runtimeState().tooltip}>
      <button
        type="button"
        classList={iconButtonClass(runtimeState().tone)}
        onClick={() => void copyRetryError()}
        aria-label={runtimeState().copyText ? "Copy retry error" : runtimeState().tooltip}
      >
        <span classList={{ "sb-session-icon-pulse": runtimeState().pulse }}>
          <Icon name={runtimeState().icon} size="small" class="translate-y-0.5" />
        </span>
      </button>
    </Tooltip>
  )
}

// ─── Subsessions button ───────────────────────────────────────────

function SubsessionsButton(props: {
  sessions: Session[]
  statusFor: (sessionID: string) => { label: string; icon: IconName; tone: "base" | "active" | "danger" }
  onSelect: (session: Session) => void
}) {
  const [open, setOpen] = createSignal(false)
  const count = () => props.sessions.length

  function preview(session: Session): string | undefined {
    return session.lastExchange?.assistant ?? session.lastExchange?.user
  }

  function rowIconClass(tone: "base" | "active" | "danger") {
    if (tone === "active") return "text-text-interactive-base animate-pulse"
    if (tone === "danger") return "text-icon-critical-base"
    return "text-icon-weak"
  }

  return (
    <Show when={count() > 0}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement="top"
        gutter={8}
        trigger={
          <Tooltip placement="top" value={`${count()} subsession${count() !== 1 ? "s" : ""}`}>
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 rounded-full px-2 text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
              aria-label={`${count()} subsession${count() !== 1 ? "s" : ""}`}
            >
              <Icon name={getSemanticIcon("session.child")} size="small" />
              <span class="statusbar-indicator-value text-text-weak">{count()}</span>
            </button>
          </Tooltip>
        }
      >
        <div class="w-80">
          <div class="mb-2 flex items-center justify-between gap-3 border-b border-border-weaker-base/50 pb-2">
            <span class="text-12-medium text-text-base">Subsessions</span>
            <span class="text-11-regular text-text-subtle">{count()} total</span>
          </div>
          <div class="max-h-80 overflow-y-auto pr-1 [scrollbar-width:thin]">
            <For each={props.sessions}>
              {(session) => {
                const status = createMemo(() => props.statusFor(session.id))
                return (
                  <button
                    type="button"
                    class="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-raised-base-hover"
                    onClick={() => {
                      setOpen(false)
                      props.onSelect(session)
                    }}
                  >
                    <Icon name={status().icon} size="small" class={rowIconClass(status().tone)} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-12-medium text-text-base">{session.title || "New session"}</span>
                      <Show when={preview(session)}>
                        {(text) => <span class="mt-0.5 block truncate text-11-regular text-text-weak">{text()}</span>}
                      </Show>
                    </span>
                    <span class="flex shrink-0 flex-col items-end gap-0.5">
                      <Show when={status().tone !== "base"}>
                        <span
                          classList={{
                            "text-10-medium": true,
                            "text-text-interactive-base": status().tone === "active",
                            "text-text-critical-base": status().tone === "danger",
                          }}
                        >
                          {status().label}
                        </span>
                      </Show>
                      <span class="text-10-regular text-text-subtle">{relativeTime(sessionActivityTime(session))}</span>
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Popover>
    </Show>
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

function PanelIconRow(props: { icon: IconName; label: string; tone?: "base" | "danger" }) {
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
  const navigate = useNavigate()
  const globalSync = useGlobalSync()
  const holos = useHolos()
  const server = useServer()
  const sync = useSync()
  const [expanded, setExpanded] = createSignal(false)

  const directory = createMemo(() => decodeDirectory(params.dir))
  const store = createMemo(() => {
    const dir = directory()
    if (!dir || dir === "home") return undefined
    return globalSync.peekScopeState(dir)?.[0]
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
  const childSessions = createMemo(() => {
    const id = params.id
    const current = store()
    if (!id || !current) return []
    return sortChildSessionsByActivity(current.session.filter((item) => item.parentID === id))
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
  const retryMessage = createMemo(() => {
    const current = status()
    return current?.type === "retry" ? current.message.trim() : undefined
  })

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
  const childSessionStatus = (sessionID: string) => {
    const current = store()
    const status = current?.session_status[sessionID]
    const waiting = !!current?.permission[sessionID]?.length || !!current?.question[sessionID]?.length
    if (waiting) return { label: "waiting", icon: getSemanticIcon("session.waiting"), tone: "danger" as const }
    if (status?.type === "busy" || status?.type === "retry" || status?.type === "recovering")
      return { label: "running", icon: getSemanticIcon("session.running"), tone: "active" as const }
    return { label: "idle", icon: getSemanticIcon("session.child"), tone: "base" as const }
  }

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
          <Show when={status()?.type === "busy" && (status() as Extract<SessionStatus, { type: "busy" }>)?.description}>
            {(desc) => <span class="text-text-weaker"> · {desc()}</span>}
          </Show>
        </PanelRow>
        <Show when={retryMessage()}>
          {(message) => (
            <PanelRow>
              <span class="text-text-critical-base break-words">{message()}</span>
            </PanelRow>
          )}
        </Show>
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
      </PanelSection>
    </div>
  )

  return (
    <div class="flex flex-col items-center gap-1 py-1 min-w-0 w-full">
      <div class="statusbar-glass flex items-center gap-1.5 min-w-0 max-w-full overflow-hidden px-2 py-1.5 rounded-full">
        <HolosIconButton />

        <Show when={params.dir}>
          <WorkspaceIconButton isWorktree={isWorktree()} workspaceName={workspaceName()} />
          <Show when={branch()}>{(b) => <BranchIconButton branch={b()} />}</Show>
          <RuntimeIconButton status={status()} waiting={waiting()} />

          <div class="w-px h-4 bg-border-weak" />

          <SessionLspIndicator />
          <SessionMcpIndicator />
          <Show when={params.id}>
            <SessionCortexIndicator sessionID={params.id!} />
            <SubsessionsButton
              sessions={childSessions()}
              statusFor={childSessionStatus}
              onSelect={(child) => navigate(`/${params.dir}/session/${child.id}`)}
            />
            <ContextBar />
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
                  <Icon name={getSemanticIcon("app.statusBar.toggle")} size="small" />
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
