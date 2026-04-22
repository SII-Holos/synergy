import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { Panel } from "@/components/panel"
import { relativeTime, absoluteDate } from "@/utils/time"
import type {
  AgendaActivityEntry,
  AgendaActivityPage,
  AgendaItem,
  AgendaRunLog,
} from "@ericsanchezok/synergy-sdk/client"
import { CalendarGrid, type ViewMode } from "./calendar"
import { MiniCalendar } from "./mini-calendar"
import { AgendaForm } from "./form"
import { expandItems, hasTimeTriggers, type CalendarEvent } from "./expand"
import { ViewTab } from "../engram/shared"
import { ActivityView } from "./activity-view"

const statusColors: Record<string, string> = {
  active: "bg-icon-success-base/12 text-icon-success-base ring-1 ring-inset ring-icon-success-base/15",
  paused: "bg-icon-warning-base/14 text-icon-warning-base ring-1 ring-inset ring-icon-warning-base/15",
  pending:
    "bg-surface-interactive-selected-weak text-text-interactive-base ring-1 ring-inset ring-border-interactive-base/15",
  done: "bg-surface-inset-base/85 text-text-weak ring-1 ring-inset ring-border-base/40",
  cancelled: "bg-text-diff-delete-base/12 text-text-diff-delete-base ring-1 ring-inset ring-text-diff-delete-base/12",
}

const runStatusColors: Record<string, string> = {
  ok: "text-icon-success-base",
  error: "text-text-diff-delete-base",
  skipped: "text-text-weaker",
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function triggerSummary(triggers: AgendaItem["triggers"]): string {
  if (!triggers || triggers.length === 0) return "Manual"
  return triggers
    .map((t) => {
      switch (t.type) {
        case "cron":
          return `cron: ${t.expr}`
        case "every":
          return `every ${t.interval}`
        case "at":
          return `at ${new Date(t.at).toLocaleString()}`
        case "delay":
          return `delay ${t.delay}`
        case "watch": {
          const w = t.watch
          if (w.kind === "poll") return `poll: ${w.command}`
          if (w.kind === "tool") return `tool: ${w.tool}`
          return `watch: ${w.glob}`
        }
        default:
          return "unknown"
      }
    })
    .join(", ")
}

type PanelView = "main" | "form"
type PanelTab = "schedule" | "activity"

type AgendaActivityState = {
  items: AgendaActivityEntry[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export function AgendaPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams()

  const [view, setView] = createSignal<PanelView>("main")
  const [tab, setTab] = createSignal<PanelTab>("schedule")
  const [editingItem, setEditingItem] = createSignal<AgendaItem | undefined>()
  const [popoverItem, setPopoverItem] = createSignal<AgendaItem | undefined>()
  const [runsCache, setRunsCache] = createSignal<Record<string, AgendaRunLog[]>>({})
  const [actionLoading, setActionLoading] = createSignal<Set<string>>(new Set())
  const [actionDone, setActionDone] = createSignal<Set<string>>(new Set())

  const [viewMode, setViewMode] = createSignal<ViewMode>("week")
  const [anchor, setAnchor] = createSignal(Date.now())
  const [calendarRange, setCalendarRange] = createSignal<{ start: number; end: number }>({ start: 0, end: 0 })

  const [activity, setActivity] = createSignal<AgendaActivityState>({
    items: [],
    total: 0,
    offset: 0,
    limit: 25,
    hasMore: false,
  })
  const [activityLoading, setActivityLoading] = createSignal(false)
  const [activityQuery, setActivityQuery] = createSignal("")

  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  const items = createMemo(() => globalSync.agenda)

  const todoItems = createMemo(() => items().filter((item) => !hasTimeTriggers(item)))
  const scheduleItems = createMemo(() => items().filter((item) => hasTimeTriggers(item)))

  const calendarEvents = createMemo(() => {
    const range = calendarRange()
    if (!range.start || !range.end) return []
    return expandItems(scheduleItems(), range.start, range.end)
  })

  function itemById(id: string): AgendaItem | undefined {
    return items().find((i) => i.id === id)
  }

  function directoryForItem(item: AgendaItem): string | undefined {
    if (item.origin?.scope?.type === "global") return "global"
    return item.origin?.scope?.directory ?? item.origin?.scope?.worktree ?? directory()
  }

  async function loadRuns(id: string) {
    if (runsCache()[id]) return
    const item = itemById(id)
    const dir = item ? directoryForItem(item) : directory()
    if (!dir) return
    try {
      const result = await sdk.client.agenda.runs({ id, directory: dir })
      if (result.data) setRunsCache((prev) => ({ ...prev, [id]: result.data as AgendaRunLog[] }))
    } catch {}
  }

  async function performAction(
    id: string,
    action: "trigger" | "activate" | "pause" | "complete" | "cancel" | "remove",
  ) {
    const item = itemById(id)
    const dir = item ? directoryForItem(item) : directory()
    if (!dir) return
    setActionLoading((prev) => new Set(prev).add(`${id}-${action}`))
    try {
      const ops: Record<string, () => Promise<unknown>> = {
        trigger: () => sdk.client.agenda.trigger({ id, directory: dir }),
        activate: () => sdk.client.agenda.activate({ id, directory: dir }),
        pause: () => sdk.client.agenda.pause({ id, directory: dir }),
        complete: () => sdk.client.agenda.complete({ id, directory: dir }),
        cancel: () => sdk.client.agenda.cancel({ id, directory: dir }),
        remove: () => sdk.client.agenda.remove({ id, directory: dir }),
      }
      await ops[action]()
      setRunsCache((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (action === "remove" && popoverItem()?.id === id) setPopoverItem(undefined)
      if (action === "trigger") {
        const key = `${id}-${action}`
        setActionDone((prev) => new Set(prev).add(key))
        setTimeout(
          () =>
            setActionDone((prev) => {
              const next = new Set(prev)
              next.delete(key)
              return next
            }),
          2000,
        )
      }
    } catch {}
    setActionLoading((prev) => {
      const next = new Set(prev)
      next.delete(`${id}-${action}`)
      return next
    })
  }

  const isLoading = (id: string, action: string) => actionLoading().has(`${id}-${action}`)
  const isDone = (id: string, action: string) => actionDone().has(`${id}-${action}`)

  async function refresh() {
    await globalSync.loadGlobalAgenda()
    const pi = popoverItem()
    if (pi) {
      setRunsCache((prev) => {
        const next = { ...prev }
        delete next[pi.id]
        return next
      })
      loadRuns(pi.id)
    }
    if (tab() === "activity") void loadActivity({ reset: true })
  }

  function formDirectory(): string {
    const item = editingItem()
    if (item) return directoryForItem(item) ?? directory() ?? globalSync.data.path.home
    return directory() ?? globalSync.data.path.home
  }

  function openCreate() {
    setEditingItem(undefined)
    setView("form")
  }

  function openEdit(item: AgendaItem) {
    setEditingItem(item)
    setView("form")
  }

  function openDetail(item: AgendaItem) {
    setPopoverItem(item)
    loadRuns(item.id)
  }

  function handleEventClick(event: CalendarEvent) {
    const item = itemById(event.itemId)
    if (item) openDetail(item)
  }

  function handleDateClick(ts: number) {
    setAnchor(ts)
  }

  async function loadActivity(options?: { reset?: boolean; append?: boolean; query?: string }) {
    if (activityLoading()) return
    setActivityLoading(true)
    try {
      const reset = options?.reset ?? false
      const append = options?.append ?? false
      const query = options?.query ?? activityQuery()
      const currentOffset = append ? activity().offset + activity().items.length : 0
      const scopeID = directory() === "global" ? "global" : undefined

      const res = await sdk.client.agenda.activity({
        directory: directory() ?? globalSync.data.path.home,
        scopeID,
        query: query || undefined,
        offset: currentOffset,
        limit: activity().limit,
      })

      const page = (res.data as AgendaActivityPage | undefined) ?? {
        items: [],
        total: 0,
        offset: 0,
        limit: activity().limit,
        hasMore: false,
      }

      setActivity((prev) => ({
        items: append ? [...prev.items, ...page.items] : page.items,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
      }))

      if (reset) {
        setActivityQuery(query)
      }
    } catch {}
    setActivityLoading(false)
  }

  createEffect(() => {
    if (tab() === "activity") void loadActivity()
  })

  function navigateToSession(sessionID: string, scopeID: string) {
    const dir = scopeID === "global" ? "global" : directory()
    if (!dir) return
    navigate(`/${base64Encode(dir)}/session/${sessionID}`)
  }

  return (
    <Panel.Root>
      <Show when={view() === "form"}>
        <AgendaForm directory={formDirectory()} item={editingItem()} onBack={() => setView("main")} />
      </Show>

      <Show when={view() === "main"}>
        <Panel.Header>
          <Panel.HeaderRow>
            <div class="flex items-center flex-1 min-w-0 gap-0.5 rounded-[1rem] bg-surface-inset-base/42 p-0.75 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
              <ViewTab active={tab() === "schedule"} onClick={() => setTab("schedule")}>
                Schedule
              </ViewTab>
              <ViewTab active={tab() === "activity"} onClick={() => setTab("activity")}>
                Activity
              </ViewTab>
            </div>
            <Panel.Actions>
              <Panel.Action icon="refresh-ccw" title="Refresh" onClick={refresh} />
              <Panel.Action icon="plus" title="New item" onClick={openCreate} />
            </Panel.Actions>
          </Panel.HeaderRow>
        </Panel.Header>

        <Show when={tab() === "schedule"}>
          <div class="flex gap-3 px-3 py-2.5 border-b border-border-weaker-base/45 shrink-0">
            <div class="shrink-0 rounded-[1.15rem] bg-surface-inset-base/42 p-3 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
              <MiniCalendar anchor={anchor()} viewMode={viewMode()} onDateClick={handleDateClick} />
            </div>
            <div class="flex-1 min-w-0 flex flex-col min-h-0 rounded-[1.15rem] bg-surface-inset-base/38 p-3 ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
              <Show
                when={todoItems().length > 0}
                fallback={
                  <div class="flex-1 flex items-center justify-center rounded-[0.95rem] bg-surface-raised-base/88 px-3 py-4 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
                    <span class="text-10-medium text-text-weaker/60">No todo items</span>
                  </div>
                }
              >
                <div class="flex items-center justify-between gap-2 mb-2 px-0.5">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Todo</span>
                    <span class="inline-flex items-center rounded-full bg-surface-raised-stronger-non-alpha px-2 py-0.5 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/45">
                      {todoItems().length}
                    </span>
                  </div>
                </div>
                <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 rounded-[0.95rem] bg-surface-raised-base/90 p-1.5 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
                  <For each={todoItems()}>{(item) => <TodoCard item={item} onClick={() => openDetail(item)} />}</For>
                </div>
              </Show>
            </div>
          </div>

          <div class="flex flex-col flex-1 min-h-0 relative px-3 pb-3 pt-2.5">
            <CalendarGrid
              viewMode={viewMode()}
              anchor={anchor()}
              events={calendarEvents()}
              onViewModeChange={setViewMode}
              onAnchorChange={setAnchor}
              onEventClick={handleEventClick}
              onRangeChange={(start, end) => setCalendarRange({ start, end })}
            />

            <Show when={popoverItem()}>
              {(pi) => {
                const liveItem = createMemo(() => itemById(pi().id) ?? pi())
                return (
                  <DetailPopover
                    item={liveItem()}
                    runs={runsCache()[liveItem().id]}
                    isLoading={isLoading}
                    isDone={isDone}
                    onClose={() => setPopoverItem(undefined)}
                    onAction={(action) => performAction(liveItem().id, action)}
                    onEdit={() => {
                      setPopoverItem(undefined)
                      openEdit(liveItem())
                    }}
                  />
                )
              }}
            </Show>
          </div>
        </Show>

        <Show when={tab() === "activity"}>
          <ActivityView
            items={activity().items}
            total={activity().total}
            hasMore={activity().hasMore}
            loading={activityLoading()}
            query={activityQuery()}
            onQueryChange={(value: string) => {
              setActivityQuery(value)
              void loadActivity({ reset: true, query: value })
            }}
            onLoadMore={() => void loadActivity({ append: true })}
            onNavigate={navigateToSession}
            onItemClick={(itemId) => {
              const item = itemById(itemId)
              if (item) openDetail(item)
            }}
          />
        </Show>
      </Show>
    </Panel.Root>
  )
}

function TodoCard(props: { item: AgendaItem; onClick: () => void }) {
  return (
    <div
      class="flex items-center gap-2.5 rounded-[0.9rem] bg-surface-raised-base/92 px-2.5 py-2 ring-1 ring-inset ring-border-base/35 hover:bg-surface-raised-base transition-colors cursor-pointer shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]"
      onClick={props.onClick}
    >
      <span
        class={`shrink-0 w-1.5 h-1.5 rounded-full ${props.item.status === "active" ? "bg-icon-success-base" : props.item.status === "paused" ? "bg-icon-warning-base" : props.item.status === "done" ? "bg-text-weaker" : "bg-border-interactive-base"}`}
      />
      <span class="text-11-regular text-text-strong flex-1 min-w-0 truncate">{props.item.title}</span>
      <span class="inline-flex items-center rounded-full bg-surface-inset-base/72 px-2 py-0.5 text-[9px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/35 shrink-0">
        {triggerSummary(props.item.triggers)}
      </span>
    </div>
  )
}

function DetailPopover(props: {
  item: AgendaItem
  runs: AgendaRunLog[] | undefined
  isLoading: (id: string, action: string) => boolean
  isDone: (id: string, action: string) => boolean
  onClose: () => void
  onAction: (action: "trigger" | "activate" | "pause" | "complete" | "cancel" | "remove") => void
  onEdit: () => void
}) {
  let cardRef: HTMLDivElement | undefined
  const state = () => props.item.state

  createEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (cardRef && !cardRef.contains(e.target as Node)) props.onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose()
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    })
  })

  return (
    <div class="absolute inset-0 z-20 flex items-start justify-center pt-8 px-4 pointer-events-none">
      <div
        ref={cardRef}
        class="pointer-events-auto w-full max-w-sm max-h-[calc(100%-16px)] flex flex-col overflow-hidden rounded-[1.35rem] border border-border-base/70 bg-background-base/90 backdrop-blur-xl shadow-[0_20px_54px_-38px_color-mix(in_srgb,var(--surface-brand-base)_24%,transparent)] animate-in fade-in slide-in-from-top-2 duration-150"
      >
        <div class="shrink-0 flex items-center gap-1 px-3.5 pt-3 pb-2">
          <button
            type="button"
            class="size-7 flex items-center justify-center rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={props.onEdit}
            title="Edit"
          >
            <Icon name="pen-line" size="small" />
          </button>
          <Show when={props.item.status !== "cancelled"}>
            <ActionIconBtn
              icon="trash-2"
              title="Delete"
              loading={props.isLoading(props.item.id, "remove")}
              onClick={() => props.onAction("remove")}
              danger
            />
          </Show>
          <div class="flex-1" />
          <button
            type="button"
            class="size-7 flex items-center justify-center rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={props.onClose}
            title="Close"
          >
            <Icon name="x" size="small" />
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto px-3.5 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div class="flex flex-col gap-3 rounded-[1.1rem] bg-surface-raised-base/94 px-3.5 py-3.5 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
            <div class="flex items-start gap-2">
              <span class="text-13-medium text-text-strong flex-1 min-w-0 leading-snug">{props.item.title}</span>
              <span
                class={`px-1.5 py-0.5 rounded-md text-10-medium shrink-0 ${statusColors[props.item.status] ?? "bg-surface-inset-base text-text-weak"}`}
              >
                {props.item.status}
              </span>
            </div>

            <Show when={props.item.description}>
              <p class="text-12-regular text-text-weak leading-relaxed">{props.item.description}</p>
            </Show>

            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="px-2 py-0.5 rounded-full bg-surface-inset-base/78 text-10-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                {triggerSummary(props.item.triggers)}
              </span>
              <Show when={state()?.runCount}>
                <span class="px-2 py-0.5 rounded-full bg-surface-inset-base/78 text-10-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                  {state()!.runCount} runs
                </span>
              </Show>
              <Show when={state()?.consecutiveErrors && state()!.consecutiveErrors! > 0}>
                <span class="px-2 py-0.5 rounded-full bg-text-diff-delete-base/12 text-10-medium text-text-diff-delete-base ring-1 ring-inset ring-text-diff-delete-base/12">
                  {state()!.consecutiveErrors} errors
                </span>
              </Show>
              <Show when={props.item.createdBy === "agent"}>
                <span class="px-2 py-0.5 rounded-full bg-surface-interactive-selected-weak text-10-medium text-text-interactive-base ring-1 ring-inset ring-border-interactive-base/15">
                  agent
                </span>
              </Show>
            </div>

            <Show when={state()?.nextRunAt}>
              <div class="text-11-regular text-text-weaker">Next: {relativeTime(state()!.nextRunAt!)}</div>
            </Show>

            <Show when={state()?.lastRunAt}>
              <div class="text-11-regular text-text-weaker">
                Last run: {absoluteDate(state()!.lastRunAt!)}
                <Show when={state()?.lastRunStatus}>
                  {" · "}
                  <span class={runStatusColors[state()!.lastRunStatus!] ?? ""}>{state()!.lastRunStatus}</span>
                </Show>
                <Show when={state()?.lastRunDuration}>
                  {" · "}
                  {formatDuration(state()!.lastRunDuration!)}
                </Show>
              </div>
            </Show>

            <Show when={state()?.lastRunError}>
              <div class="text-11-regular text-text-diff-delete-base bg-text-diff-delete-base/6 rounded-[0.95rem] px-3 py-2 ring-1 ring-inset ring-text-diff-delete-base/10 line-clamp-3">
                {state()!.lastRunError}
              </div>
            </Show>

            <Show when={props.item.tags && props.item.tags.length > 0}>
              <div class="flex items-center gap-1.5 flex-wrap">
                <For each={props.item.tags}>
                  {(tag) => (
                    <span class="px-2 py-0.5 rounded-full bg-surface-inset-base/78 text-10-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                      #{tag}
                    </span>
                  )}
                </For>
              </div>
            </Show>

            <Show when={props.item.prompt}>
              <div class="overflow-hidden rounded-[1rem] bg-surface-inset-base/42 ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
                <div class="px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker border-b border-border-weaker-base/45">
                  Task
                </div>
                <div class="px-3 py-2.5">
                  <p class="text-11-regular text-text-weak leading-relaxed whitespace-pre-wrap line-clamp-4">
                    {props.item.prompt}
                  </p>
                  <Show when={props.item.agent}>
                    <span class="text-10-medium text-text-weaker mt-1.5 block">Agent: {props.item.agent}</span>
                  </Show>
                </div>
              </div>
            </Show>

            <ActionBar item={props.item} isLoading={props.isLoading} isDone={props.isDone} onAction={props.onAction} />

            <Show when={props.runs} fallback={<Spinner class="size-3.5 my-1" />}>
              {(runs) => (
                <Show when={runs().length > 0}>
                  <div class="overflow-hidden rounded-[1rem] bg-surface-inset-base/42 ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
                    <div class="px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker border-b border-border-weaker-base/45">
                      Recent runs
                    </div>
                    <div>
                      <For each={runs().slice(0, 8)}>{(run) => <RunRow run={run} />}</For>
                    </div>
                  </div>
                </Show>
              )}
            </Show>

            <div class="text-10-regular text-text-weaker">
              Created {absoluteDate(props.item.time.created)}
              <Show when={props.item.time.updated !== props.item.time.created}>
                {" · updated "}
                {absoluteDate(props.item.time.updated)}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionIconBtn(props: {
  icon: IconName
  title: string
  loading: boolean
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      classList={{
        "size-7 flex items-center justify-center rounded-lg transition-colors": true,
        "text-icon-weak hover:text-text-diff-delete-base hover:bg-text-diff-delete-base/10":
          !!props.danger && !props.loading,
        "text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover": !props.danger && !props.loading,
        "opacity-40 pointer-events-none": props.loading,
      }}
      onClick={props.onClick}
      disabled={props.loading}
      title={props.title}
    >
      <Show when={props.loading} fallback={<Icon name={props.icon} size="small" />}>
        <Spinner class="size-3" />
      </Show>
    </button>
  )
}

function ActionBar(props: {
  item: AgendaItem
  isLoading: (id: string, action: string) => boolean
  isDone: (id: string, action: string) => boolean
  onAction: (action: "trigger" | "activate" | "pause" | "complete" | "cancel" | "remove") => void
}) {
  const status = () => props.item.status

  const hasActions = () => status() !== "cancelled"

  return (
    <Show when={hasActions()}>
      <div class="flex items-center gap-1.5 flex-wrap">
        <Show when={status() === "active" || status() === "paused" || status() === "pending"}>
          <ActionButton
            label="Trigger"
            loading={props.isLoading(props.item.id, "trigger")}
            done={props.isDone(props.item.id, "trigger")}
            onClick={() => props.onAction("trigger")}
            variant="primary"
          />
        </Show>
        <Show when={status() === "paused" || status() === "pending"}>
          <ActionButton
            label="Activate"
            loading={props.isLoading(props.item.id, "activate")}
            onClick={() => props.onAction("activate")}
          />
        </Show>
        <Show when={status() === "active"}>
          <ActionButton
            label="Pause"
            loading={props.isLoading(props.item.id, "pause")}
            onClick={() => props.onAction("pause")}
          />
        </Show>
        <Show when={status() !== "done" && status() !== "cancelled"}>
          <ActionButton
            label="Complete"
            loading={props.isLoading(props.item.id, "complete")}
            onClick={() => props.onAction("complete")}
          />
        </Show>
        <Show when={status() !== "cancelled"}>
          <ActionButton
            label="Cancel"
            loading={props.isLoading(props.item.id, "cancel")}
            onClick={() => props.onAction("cancel")}
            variant="danger"
          />
        </Show>
      </div>
    </Show>
  )
}

function ActionButton(props: {
  label: string
  loading: boolean
  done?: boolean
  onClick: () => void
  variant?: "primary" | "danger" | "default"
}) {
  const variant = () => props.variant ?? "default"
  const done = () => props.done ?? false

  return (
    <button
      type="button"
      classList={{
        "px-2.5 py-1 rounded-full text-11-medium border transition-colors": true,
        "border-icon-success-base/25 bg-icon-success-base/8 text-icon-success-base": done(),
        "border-border-interactive-base/25 bg-surface-interactive-selected-weak text-text-interactive-base hover:bg-surface-interactive-selected":
          variant() === "primary" && !props.loading && !done(),
        "border-text-diff-delete-base/25 bg-text-diff-delete-base/6 text-text-diff-delete-base hover:bg-text-diff-delete-base/10":
          variant() === "danger" && !props.loading && !done(),
        "border-border-base/45 bg-surface-raised-base/88 text-text-weak hover:text-text-base hover:bg-surface-raised-base":
          variant() === "default" && !props.loading && !done(),
        "opacity-50 pointer-events-none": props.loading || done(),
      }}
      onClick={props.onClick}
      disabled={props.loading || done()}
    >
      <Show when={props.loading} fallback={done() ? `${props.label} ✓` : props.label}>
        <Spinner class="size-3 inline-block mr-1" />
        {props.label}
      </Show>
    </button>
  )
}

function RunRow(props: { run: AgendaRunLog }) {
  return (
    <div class="flex items-center gap-2 px-3 py-1.5 text-11-regular border-b border-border-weaker-base/30 last:border-b-0">
      <span class={`shrink-0 ${runStatusColors[props.run.status] ?? "text-text-weaker"}`}>
        {props.run.status === "ok" ? "✓" : props.run.status === "error" ? "✗" : "–"}
      </span>
      <span class="text-text-weaker shrink-0">{props.run.trigger.type}</span>
      <Show when={props.run.duration}>
        <span class="text-text-weaker shrink-0">{formatDuration(props.run.duration!)}</span>
      </Show>
      <span class="flex-1 min-w-0 text-text-weak truncate">
        <Show when={props.run.error} fallback="">
          <span class="text-text-diff-delete-base">{props.run.error}</span>
        </Show>
      </span>
      <span class="text-text-weaker shrink-0">{relativeTime(props.run.time.started)}</span>
    </div>
  )
}
