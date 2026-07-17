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
import { ContextStatusButton } from "./context-status-button"
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
import { statusBar as copy } from "@/locales/messages"
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

function holosTooltipLabel(holos: ReturnType<typeof useHolos>, i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (!holos.loaded) return i18n._(copy.holosLoading)
  if (!holos.state.identity.loggedIn) return i18n._(copy.holosSignedOut)
  if (holos.state.connection.status === "connected") return i18n._(copy.holosConnected)
  if (holos.state.connection.status === "connecting") return i18n._(copy.holosConnecting)
  if (holos.state.connection.status === "failed") return i18n._(copy.holosFailed)
  if (holos.state.connection.status === "disconnected") return i18n._(copy.holosDisconnected)
  if (holos.state.connection.status === "disabled") return i18n._(copy.holosDisabled)
  return i18n._(copy.holosUnknown)
}

function holosServiceStatus(holos: ReturnType<typeof useHolos>, i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (!holos.loaded) return i18n._(copy.holosStateLoading)
  if (!holos.state.identity.loggedIn) return i18n._(copy.holosStateSignedOut)
  if (holos.state.connection.status === "connected") return i18n._(copy.holosStateConnected)
  if (holos.state.connection.status === "connecting") return i18n._(copy.holosStateConnecting)
  if (holos.state.connection.status === "failed") return i18n._(copy.holosStateFailed)
  if (holos.state.connection.status === "disconnected") return i18n._(copy.holosStateDisconnected)
  if (holos.state.connection.status === "disabled") return i18n._(copy.holosStateDisabled)
  return i18n._(copy.holosStateUnknown)
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

function serverStatusLabel(healthy: boolean | undefined, i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (healthy === true) return i18n._(copy.serverActive)
  if (healthy === false) return i18n._(copy.serverUnavailable)
  return i18n._(copy.serverUnknown)
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
  const { i18n } = useLocale()
  const label = createMemo(() => holosTooltipLabel(holos, i18n))
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
        <div class="text-12-medium text-text-base border-b border-border-weaker-base/60 px-1 pb-2 mb-2">
          {i18n._(copy.holosTitle)}
        </div>
        <div class="space-y-0.5 mb-2">
          <div class="flex items-center gap-2 px-1 text-12-regular text-text-base">
            <span class="text-text-weak w-14 shrink-0">{i18n._(copy.holosLoginLabel)}</span>
            <span class={holos.state.identity.loggedIn ? "text-text-on-success-base" : "text-text-subtle"}>
              {holos.state.identity.loggedIn
                ? i18n._({ ...copy.holosAgent, values: { id: activeAgentShortID() } })
                : i18n._(copy.notLoggedIn)}
            </span>
          </div>
          <div class="flex items-center gap-2 px-1 text-12-regular text-text-base">
            <span class="text-text-weak w-14 shrink-0">{i18n._(copy.holosServiceLabel)}</span>
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
              {holosServiceStatus(holos, i18n)}
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
            <span>{i18n._(copy.reconnect)}</span>
          </button>
        </Show>
      </div>
    </Popover>
  )
}

// ─── Workspace icon button ────────────────────────────────────────

function WorkspaceIconButton(props: { isWorktree: boolean; workspaceName: string }) {
  const { i18n } = useLocale()
  const icon = () => getSemanticIcon(props.isWorktree ? "workspace.worktree" : "workspace.main")
  const tooltip = () =>
    props.isWorktree
      ? i18n._({ ...copy.worktreeLabel, values: { name: props.workspaceName } })
      : i18n._(copy.mainCheckout)

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
  const { i18n } = useLocale()
  return (
    <Tooltip placement="top" value={i18n._({ ...copy.branchLabel, values: { name: props.branch } })}>
      <button type="button" classList={iconButtonClass()}>
        <Icon name={getSemanticIcon("workspace.branch")} size="small" />
      </button>
    </Tooltip>
  )
}

// ─── Runtime icon button ──────────────────────────────────────────

function RuntimeIconButton(props: { status: SessionStatus | undefined; waiting: boolean }) {
  const { i18n } = useLocale()
  const runtimeState = createMemo(() => resolveRuntimeIconState(props.status, props.waiting, i18n))
  const copyRetryError = createCopyController({
    text: () => runtimeState().copyText,
    copyLabel: i18n._(copy.copyRetryError),
    failureDescription: i18n._(copy.copyRetryErrorFailed),
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
        aria-label={runtimeState().copyText ? i18n._(copy.copyRetryError) : runtimeState().tooltip}
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
  const { fmt, i18n } = useLocale()
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
    if (loadedTotal === undefined) return i18n._(copy.subsessions)
    return i18n._({ ...copy.subsessionsCount, values: { count: loadedTotal } })
  }
  const rangeText = () => subsessionRangeLabel(pageIndex(), pageSize, items().length, total() ?? 0, i18n)
  const emptyText = () => (debouncedSearch() ? i18n._(copy.noMatching) : i18n._(copy.noSubsessions))

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
            onClick={() => setOpen(true)}
            aria-label={tooltip()}
          >
            <Icon name={getSemanticIcon("session.child")} size="small" />
            <Show when={total() !== undefined}>
              <span class="text-11-medium">{total()}</span>
            </Show>
          </button>
        </Tooltip>
      }
    >
      <div class="w-72">
        <div class="flex items-center justify-between gap-2 px-1">
          <span class="truncate text-12-medium text-text-base">{i18n._(copy.subsessions)}</span>
          <span class="shrink-0 text-11-regular text-text-subtle">
            <Show when={total() !== undefined} fallback={i18n._(copy.loading)}>
              {i18n._({ ...copy.total, values: { total: total() } })}
            </Show>
          </span>
        </div>

        <label class="mt-2 flex h-8 items-center gap-2 rounded-md bg-[var(--workbench-input-bg,var(--input-base))] px-2 text-text-subtle ring-1 ring-inset ring-border-weaker-base focus-within:ring-border-strong-base">
          <Icon name={getSemanticIcon("action.search")} size="small" class="shrink-0 text-icon-weak-base" />
          <input
            value={search()}
            placeholder={i18n._(copy.searchPlaceholder)}
            class="min-w-0 flex-1 bg-transparent text-12-regular text-text-base placeholder:text-text-subtle focus:outline-none"
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>

        <div class="mt-2 min-h-44 max-h-72 overflow-y-auto [scrollbar-width:thin]">
          <Show
            when={!loading() || items().length > 0}
            fallback={
              <div class="px-2 py-8 text-center text-12-regular text-text-subtle">
                {i18n._(copy.loadingSubsessions)}
              </div>
            }
          >
            <Show
              when={!error()}
              fallback={
                <div class="flex min-h-32 flex-col items-center justify-center gap-2 px-2 py-6 text-center">
                  <div class="text-12-medium text-text-base">{i18n._(copy.loadError)}</div>
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
                    {i18n._(copy.retry)}
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
                            {session.title || i18n._(copy.newSession)}
                          </span>
                          <Show
                            when={preview(session)}
                            fallback={
                              <span class="mt-0.5 block text-11-regular text-text-subtle">
                                {i18n._(copy.noExchanges)}
                              </span>
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
            <Tooltip placement="top" value={i18n._(copy.previous)}>
              <button
                type="button"
                classList={iconButtonClass()}
                disabled={pageIndex() === 0 || loading()}
                aria-label={i18n._(copy.previousPage)}
                onClick={previousPage}
              >
                <Icon name={getSemanticIcon("navigation.back")} size="small" />
              </button>
            </Tooltip>
            <Tooltip placement="top" value={i18n._(copy.next)}>
              <button
                type="button"
                classList={iconButtonClass()}
                disabled={!nextCursor() || loading()}
                aria-label={i18n._(copy.nextPage)}
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
  const { i18n } = useLocale()
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
  const runtime = createMemo(() => runtimeLabel(status(), waiting(), i18n))
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
      return { label: i18n._(copy.waiting), icon: getSemanticIcon("session.waiting"), tone: "danger" as const }
    if (state === "running")
      return { label: i18n._(copy.running), icon: getSemanticIcon("session.running"), tone: "active" as const }
    return { label: i18n._(copy.idle), icon: getSemanticIcon("session.child"), tone: "base" as const }
  }

  const openPanel = () => setExpanded(true)

  const panelContent = (
    <div class="w-64">
      <Show when={waiting()}>
        <div class="rounded-xl bg-surface-critical-weak p-2.5 mb-3">
          <PanelIconRow
            icon={getSemanticIcon("session.waiting")}
            label={i18n._(copy.permissionRequired)}
            tone="danger"
          />
        </div>
      </Show>

      <PanelSection title={i18n._(copy.workspace)}>
        <PanelRow>{isWorktree() ? i18n._(copy.gitWorktree) : i18n._(copy.mainCheckout)}</PanelRow>
        <PanelRow>{scopeLabel()}</PanelRow>
        <Show when={isWorktree()}>
          <PanelRow>{workspaceName()}</PanelRow>
        </Show>
        <Show keyed when={branch()}>
          {(currentBranch) => <PanelRow>{currentBranch}</PanelRow>}
        </Show>
      </PanelSection>

      <PanelSection title={i18n._(copy.runtime)}>
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

      <PanelSection title={i18n._(copy.connections)}>
        <PanelRow>{holosTooltipLabel(holos, i18n)}</PanelRow>
        <Show when={lspTotal() > 0}>
          <PanelRow>{i18n._({ ...copy.lspActive, values: { connected: lspConnected() } })}</PanelRow>
        </Show>
        <Show when={mcpTotal() > 0}>
          <PanelRow>
            {i18n._({ ...copy.mcpConnected, values: { connected: mcpConnected() } })}
            <Show when={mcpFailed() > 0}>
              <span class="text-text-on-critical-base">
                {i18n._({ ...copy.mcpUnavailable, values: { failed: mcpFailed() } })}
              </span>
            </Show>
          </PanelRow>
        </Show>
        <Show when={cortexRunning() > 0 || cortexCompleted() > 0}>
          <PanelRow>
            {i18n._({ ...copy.cortexDone, values: { completed: cortexCompleted() } })}
            <Show when={cortexRunning() > 0}>
              <span class="text-text-interactive-base">
                {i18n._({ ...copy.cortexRunning, values: { running: cortexRunning() } })}
              </span>
            </Show>
          </PanelRow>
        </Show>
        <PanelRow>
          {i18n._({
            ...copy.serverStatus,
            values: {
              name: server.name,
              status: serverStatusLabel(server.healthy(), i18n),
            },
          })}
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
            <ContextStatusButton />
          </Show>

          <div class="w-px h-4 bg-border-weak-base" />

          <Popover
            open={expanded()}
            onOpenChange={setExpanded}
            placement="top"
            gutter={8}
            trigger={
              <Tooltip placement="top" value={i18n._(copy.details)}>
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
