import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useHolos } from "@/context/holos"
import { useHolosAgentActions } from "@/components/holos/agent-actions"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { ContextBar } from "./context-bar"
import { SessionLspIndicator, SessionMcpIndicator, SessionCortexIndicator } from "@/components/session"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useLocale } from "@/context/locale"
import { getScopeLabel } from "@/utils/scope"
import { relativeTime } from "@/utils/time"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { resolveRuntimeIconState, runtimeLabel } from "./runtime"
import {
  normalizeSubsessionSearch,
  resolveSubsessionStatus,
  sessionActivityTime,
  subsessionCursorParams,
  subsessionRangeLabel,
  type SubsessionCursor,
} from "./subsession"

function statusDotClass(status: "success" | "danger" | "muted" | "active") {
  return {
    "size-1 rounded-full ring-1 ring-inset ring-border-weaker-base": true,
    "bg-icon-success-base text-icon-success-base animate-[statusbarDotPulse_3s_ease-in-out_infinite]":
      status === "success",
    "bg-icon-critical-base text-icon-critical-base animate-[statusbarDotPulse_1.5s_ease-in-out_infinite]":
      status === "danger",
    "bg-icon-base text-icon-base animate-[statusbarDotPulse_2s_ease-in-out_infinite]": status === "active",
    "bg-border-strong-base text-border-strong-base": status === "muted",
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
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const agentActions = useHolosAgentActions(globalSDK)
  const label = createMemo(() => holosLabel(holos))
  const dot = createMemo(() => holosTone(holos))
  const [open, setOpen] = createSignal(false)

  const activeAgentShortID = () => holos.state.identity.agentId?.slice(0, 8)
  const needReconnect = () =>
    holos.state.identity.loggedIn &&
    (holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected")

  const handleReconnect = () => {
    void agentActions.reconnect()
  }

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="top"
      gutter={8}
      trigger={
        <Tooltip placement="top" value={label()}>
          <button type="button" classList={iconButtonClass()}>
            <Icon name={getSemanticIcon("holos.main")} size="small" class="translate-y-px" />
            <div
              classList={{
                ...statusDotClass(dot()),
                "absolute bottom-1 right-1": true,
              }}
            />
          </button>
        </Tooltip>
      }
    >
      <div class="w-56">
        <div class="text-12-medium text-text-base border-b border-border-weaker-base/60 px-1 pb-2 mb-2">Holos</div>
        <div class="space-y-0.5 mb-2">
          <div class="flex items-center gap-2 px-1 text-12-regular text-text-base">
            <span class="text-text-weak w-14 shrink-0">Login</span>
            <span class={holos.state.identity.loggedIn ? "text-text-on-success-base" : "text-text-subtle"}>
              {holos.state.identity.loggedIn ? `Agent ${activeAgentShortID()}` : "Not logged in"}
            </span>
          </div>
          <div class="flex items-center gap-2 px-1 text-12-regular text-text-base">
            <span class="text-text-weak w-14 shrink-0">Service</span>
            <span
              classList={{
                "text-text-on-success-base": holos.state.connection.status === "connected",
                "text-text-interactive-base": holos.state.connection.status === "connecting",
                "text-text-on-critical-base":
                  holos.state.connection.status === "failed" || holos.state.connection.status === "disconnected",
                "text-text-subtle": !["connected", "connecting", "failed", "disconnected"].includes(
                  holos.state.connection.status,
                ),
              }}
            >
              {holosLabel(holos).replace("Holos ", "")}
            </span>
          </div>
          <Show when={holos.state.connection.error}>
            <div class="px-1 py-1 text-11-regular text-text-on-critical-base break-words">
              {holos.state.connection.error}
            </div>
          </Show>
        </div>
        <Show when={needReconnect()}>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-12-medium text-text-on-success-base transition-colors hover:bg-surface-raised-base-hover"
            onClick={handleReconnect}
          >
            <Icon name={getSemanticIcon("action.refresh")} size="small" />
            <span>Reconnect</span>
          </button>
        </Show>
      </div>
    </Popover>
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
  const copyRetryError = createCopyController({
    text: () => runtimeState().copyText,
    copyLabel: "Copy retry error",
    failureDescription: "Unable to copy the retry error.",
  })
  const tooltip = createMemo(() => (runtimeState().copyText ? copyRetryError.tooltip() : runtimeState().tooltip))
  const icon = createMemo(() =>
    runtimeState().copyText && copyRetryError.state() !== "idle" ? copyRetryError.icon() : runtimeState().icon,
  )

  return (
    <Tooltip placement="top" value={tooltip()}>
      <button
        type="button"
        classList={iconButtonClass(runtimeState().tone)}
        data-copy-state={copyRetryError.state()}
        onClick={() => {
          if (runtimeState().copyText) void copyRetryError.copy()
        }}
        aria-label={runtimeState().copyText ? "Copy retry error" : runtimeState().tooltip}
      >
        <span classList={{ "sb-session-icon-pulse": runtimeState().pulse }}>
          <Icon name={icon()} size="small" class="translate-y-0.5" />
        </span>
      </button>
    </Tooltip>
  )
}

// ─── Subsessions button ───────────────────────────────────────────

function SubsessionsButton(props: {
  sessionID: string
  statusFor: (sessionID: string) => { label: string; icon: IconName; tone: "base" | "active" | "danger" }
  onSelect: (session: Session) => void
}) {
  const pageSize = 8
  const sdk = useSDK()
  const { fmt } = useLocale()
  const [open, setOpen] = createSignal(false)
  const [items, setItems] = createSignal<Session[]>([])
  const [total, setTotal] = createSignal<number | undefined>()
  const [nextCursor, setNextCursor] = createSignal<SubsessionCursor | null>(null)
  const [pageIndex, setPageIndex] = createSignal(0)
  const [startCursors, setStartCursors] = createSignal<(SubsessionCursor | null)[]>([null])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [debouncedSearch, setDebouncedSearch] = createSignal("")
  let requestSeq = 0

  function preview(session: Session): string | undefined {
    return session.lastExchange?.assistant ?? session.lastExchange?.user
  }

  function rowIconClass(tone: "base" | "active" | "danger") {
    if (tone === "active") return "text-text-interactive-base animate-pulse"
    if (tone === "danger") return "text-icon-critical-base"
    return "text-icon-weak-base"
  }

  function resetPageState() {
    requestSeq += 1
    setItems([])
    setTotal(undefined)
    setNextCursor(null)
    setPageIndex(0)
    setStartCursors([null])
    setLoading(false)
    setError(false)
  }

  async function loadPage(input: {
    pageIndex: number
    cursor: SubsessionCursor | null
    starts?: (SubsessionCursor | null)[]
    query?: string
    sessionID?: string
  }) {
    const sessionID = input.sessionID ?? props.sessionID
    if (!sessionID) return
    const query = input.query ?? debouncedSearch()

    const seq = ++requestSeq
    setLoading(true)
    setError(false)

    try {
      const response = await sdk.client.session.children({
        sessionID,
        limit: pageSize,
        search: query || undefined,
        ...subsessionCursorParams(input.cursor),
      })
      const page = response.data
      if (!page) throw new Error("Missing subsession page response")
      if (seq !== requestSeq) return

      setItems(page.items)
      setTotal(page.total)
      setNextCursor(page.nextCursor)
      setPageIndex(input.pageIndex)
      if (input.starts) setStartCursors(input.starts)
      setLoading(false)
    } catch {
      if (seq !== requestSeq) return
      setLoading(false)
      setError(true)
    }
  }

  createEffect((previousID: string | undefined) => {
    const sessionID = props.sessionID
    if (previousID !== undefined && previousID !== sessionID) {
      setOpen(false)
      setSearch("")
      setDebouncedSearch("")
      resetPageState()
    }
    return sessionID
  })

  createEffect(() => {
    const value = search()
    const timer = setTimeout(() => setDebouncedSearch(normalizeSubsessionSearch(value)), 300)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    const sessionID = props.sessionID
    const active = open()
    const query = debouncedSearch()
    if (!active) return

    setItems([])
    setTotal(undefined)
    setNextCursor(null)
    setPageIndex(0)
    setStartCursors([null])
    setError(false)
    void loadPage({ pageIndex: 0, cursor: null, starts: [null], query, sessionID })
  })

  function nextPage() {
    const cursor = nextCursor()
    if (!cursor || loading()) return
    const next = pageIndex() + 1
    const starts = [...startCursors()]
    starts[next] = cursor
    void loadPage({ pageIndex: next, cursor, starts })
  }

  function previousPage() {
    if (pageIndex() === 0 || loading()) return
    const previous = pageIndex() - 1
    void loadPage({ pageIndex: previous, cursor: startCursors()[previous] ?? null })
  }

  const tooltip = () => {
    const loadedTotal = total()
    if (loadedTotal === undefined) return "Subsessions"
    return `${loadedTotal} subsession${loadedTotal !== 1 ? "s" : ""}`
  }
  const rangeText = () => subsessionRangeLabel(pageIndex(), pageSize, items().length, total() ?? 0)
  const emptyText = () => (debouncedSearch() ? "No matching subsessions" : "No subsessions yet")

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="top-end"
      gutter={10}
      class="statusbar-subsession-popover"
      trigger={
        <Tooltip placement="top" value={tooltip()}>
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-full px-2 text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
            aria-label={tooltip()}
          >
            <Icon name={getSemanticIcon("session.child")} size="small" />
            <Show when={total() !== undefined && total()! > 0}>
              <span class="statusbar-indicator-value text-text-weak">{total()}</span>
            </Show>
          </button>
        </Tooltip>
      }
    >
      <div class="min-w-0">
        <div class="flex items-center justify-between gap-3 border-b border-border-weaker-base/60 px-1 pb-2">
          <span class="truncate text-12-medium text-text-base">Subsessions</span>
          <span class="shrink-0 text-11-regular text-text-subtle">
            <Show when={total() !== undefined} fallback="Loading">
              {total()} total
            </Show>
          </span>
        </div>

        <label class="mt-2 flex h-8 items-center gap-2 rounded-md bg-[var(--workbench-input-bg,var(--input-base))] px-2 text-text-subtle ring-1 ring-inset ring-border-weaker-base focus-within:ring-border-strong-base">
          <Icon name={getSemanticIcon("action.search")} size="small" class="shrink-0 text-icon-weak-base" />
          <input
            value={search()}
            placeholder="Search subsessions..."
            class="min-w-0 flex-1 bg-transparent text-12-regular text-text-base placeholder:text-text-subtle focus:outline-none"
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>

        <div class="mt-2 min-h-44 max-h-72 overflow-y-auto [scrollbar-width:thin]">
          <Show
            when={!loading() || items().length > 0}
            fallback={<div class="px-2 py-8 text-center text-12-regular text-text-subtle">Loading subsessions</div>}
          >
            <Show
              when={!error()}
              fallback={
                <div class="flex min-h-32 flex-col items-center justify-center gap-2 px-2 py-6 text-center">
                  <div class="text-12-medium text-text-base">Couldn’t load subsessions</div>
                  <button
                    type="button"
                    class="rounded-md px-2 py-1 text-12-medium text-text-interactive-base transition-colors hover:bg-surface-raised-base-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base"
                    onClick={() =>
                      void loadPage({
                        pageIndex: pageIndex(),
                        cursor: startCursors()[pageIndex()] ?? null,
                      })
                    }
                  >
                    Retry
                  </button>
                </div>
              }
            >
              <Show
                when={items().length > 0}
                fallback={<div class="px-2 py-8 text-center text-12-regular text-text-subtle">{emptyText()}</div>}
              >
                <For each={items()}>
                  {(session) => {
                    const status = createMemo(() => props.statusFor(session.id))
                    return (
                      <button
                        type="button"
                        class="grid w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)_4.5rem] items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-raised-base-hover focus:outline-none focus-visible:bg-surface-raised-base-hover focus-visible:ring-1 focus-visible:ring-border-strong-base"
                        onClick={() => {
                          setOpen(false)
                          props.onSelect(session)
                        }}
                      >
                        <Icon name={status().icon} size="small" class={`mt-0.5 ${rowIconClass(status().tone)}`} />
                        <span class="min-w-0">
                          <span class="block truncate text-12-medium text-text-base">
                            {session.title || "New session"}
                          </span>
                          <Show
                            when={preview(session)}
                            fallback={
                              <span class="mt-0.5 block text-11-regular text-text-subtle">No exchanges yet</span>
                            }
                          >
                            {(text) => (
                              <span class="mt-0.5 block truncate text-11-regular text-text-weak">{text()}</span>
                            )}
                          </Show>
                        </span>
                        <span class="min-w-0 justify-self-end text-right">
                          <Show when={status().tone !== "base"}>
                            <span
                              classList={{
                                "block truncate text-10-medium": true,
                                "text-text-interactive-base": status().tone === "active",
                                "text-text-on-critical-base": status().tone === "danger",
                              }}
                            >
                              {status().label}
                            </span>
                          </Show>
                          <span class="block truncate text-10-regular text-text-subtle">
                            {relativeTime(fmt, sessionActivityTime(session))}
                          </span>
                        </span>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </Show>
        </div>

        <div class="mt-2 flex items-center justify-between gap-2 border-t border-border-weaker-base/60 px-1 pt-2">
          <span class="min-w-0 truncate text-11-regular text-text-subtle">{rangeText()}</span>
          <div class="flex items-center gap-1">
            <Tooltip placement="top" value="Previous">
              <button
                type="button"
                classList={iconButtonClass()}
                disabled={pageIndex() === 0 || loading()}
                aria-label="Previous subsessions page"
                onClick={previousPage}
              >
                <Icon name={getSemanticIcon("navigation.back")} size="small" />
              </button>
            </Tooltip>
            <Tooltip placement="top" value="Next">
              <button
                type="button"
                classList={iconButtonClass()}
                disabled={!nextCursor() || loading()}
                aria-label="Next subsessions page"
                onClick={nextPage}
              >
                <Icon name={getSemanticIcon("navigation.forward")} size="small" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </Popover>
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
        class={props.tone === "danger" ? "text-icon-critical-base" : "text-icon-weak-base"}
      />
      <span class={props.tone === "danger" ? "text-text-on-critical-base" : "text-text-base"}>{props.label}</span>
    </div>
  )
}

// ─── StatusBar ────────────────────────────────────────────────────

export function StatusBar() {
  const params = useParams()
  const navigateToSession = useNavigateToSession()
  const globalSync = useGlobalSync()
  const holos = useHolos()
  const server = useServer()
  const sync = useSync()
  const [expanded, setExpanded] = createSignal(false)

  const directory = createMemo(() => decodeDirectory(params.dir))
  const scope = createMemo(() => {
    if (!sync.data.scopeID) return undefined
    return globalSync.data.scope.find((item) => item.id === sync.data.scopeID)
  })
  const session = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    return sync.data.session.find((item) => item.id === id)
  })
  const status = createMemo(() => (params.id ? sync.data.session_status[params.id] : undefined))
  const waiting = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!sync.data.permission[id]?.length || !!sync.data.question[id]?.length
  })
  const workspaceType = createMemo(() => session()?.workspace?.type ?? "main")
  const isWorktree = () => workspaceType() === "git_worktree"
  const workspaceName = createMemo(() => workspaceField(session(), "name") || (isWorktree() ? "worktree" : "main"))
  const branch = createMemo(() => {
    if (isWorktree()) return workspaceField(session(), "branch")
    return workspaceField(session(), "branch") || sync.data.vcs?.branch
  })
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
    const status = sync.data.session_status[sessionID]
    const waiting = !!sync.data.permission[sessionID]?.length || !!sync.data.question[sessionID]?.length
    const state = resolveSubsessionStatus({
      waiting,
      running: status?.type === "busy" || status?.type === "retry" || status?.type === "recovering",
    })
    if (state === "waiting")
      return { label: "waiting", icon: getSemanticIcon("session.waiting"), tone: "danger" as const }
    if (state === "running")
      return { label: "running", icon: getSemanticIcon("session.running"), tone: "active" as const }
    return { label: "idle", icon: getSemanticIcon("session.child"), tone: "base" as const }
  }

  const openPanel = () => setExpanded(true)

  const panelContent = (
    <div class="w-64">
      <Show when={waiting()}>
        <div class="rounded-xl bg-surface-critical-weak p-2.5 mb-3">
          <PanelIconRow icon={getSemanticIcon("session.waiting")} label="Permission required" tone="danger" />
        </div>
      </Show>

      <PanelSection title="Workspace">
        <PanelRow>{isWorktree() ? "Git worktree" : "Main checkout"}</PanelRow>
        <PanelRow>{scopeLabel()}</PanelRow>
        <Show when={isWorktree()}>
          <PanelRow>{workspaceName()}</PanelRow>
        </Show>
        <Show keyed when={branch()}>
          {(currentBranch) => <PanelRow>{currentBranch}</PanelRow>}
        </Show>
      </PanelSection>

      <PanelSection title="Runtime">
        <PanelRow>
          {runtime()}
          <Show
            keyed
            when={status()?.type === "busy" && (status() as Extract<SessionStatus, { type: "busy" }>)?.description}
          >
            {(desc) => <span class="text-text-weaker"> · {desc}</span>}
          </Show>
        </PanelRow>
        <Show keyed when={retryMessage()}>
          {(message) => (
            <PanelRow>
              <span class="text-text-on-critical-base break-words">{message}</span>
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
              <span class="text-text-on-critical-base">, {mcpFailed()} unavailable</span>
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
          <Show keyed when={branch()}>
            {(currentBranch) => <BranchIconButton branch={currentBranch} />}
          </Show>
          <RuntimeIconButton status={status()} waiting={waiting()} />

          <div class="w-px h-4 bg-border-weak-base" />

          <SessionLspIndicator />
          <SessionMcpIndicator />
          <Show when={params.id}>
            <SessionCortexIndicator sessionID={params.id!} />
            <SubsessionsButton
              sessionID={params.id!}
              statusFor={childSessionStatus}
              onSelect={(child) => navigateToSession(child.id)}
            />
            <ContextBar />
          </Show>

          <div class="w-px h-4 bg-border-weak-base" />

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
