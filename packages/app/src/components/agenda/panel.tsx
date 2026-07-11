import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { agendaActionConfirm } from "@/components/dialog/confirm-copy"
import { AppPanel } from "@/components/app-panel"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { useWorkspaceMobileHeaderClose } from "@/components/workspace/mobile-header-close"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { AgendaItem, AgendaRunLog } from "@ericsanchezok/synergy-sdk/client"
import { CalendarGrid, type ViewMode } from "./calendar"
import { MiniCalendar } from "./mini-calendar"
import { AgendaForm } from "./form"
import { expandItems, hasTimeTriggers, type CalendarEvent } from "./expand"
import { ActivityView } from "./activity-view"
import {
  defaultAgendaActivityState,
  mergeAgendaActivityPage,
  normalizeAgendaActivityError,
  requestAgendaActivity,
  type AgendaActivityState,
} from "./activity-state"
import { agendaRunStatusTone, agendaStatusTone, formatAgendaDuration } from "./shared"
import "./agenda-dialog.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

type AgendaAction = "trigger" | "activate" | "pause" | "complete" | "cancel" | "remove"

function errorDescription(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Request failed"
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
          if ("command" in w) return `poll: ${w.command}`
          if ("tool" in w) return `tool: ${w.tool}`
          return `watch: ${w.glob}`
        }
        default:
          return "unknown"
      }
    })
    .join(", ")
}

type PanelTab = "schedule" | "activity"

export function AgendaPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const params = useParams()

  const [tab, setTab] = createSignal<PanelTab>("schedule")
  const onCloseWorkspace = useWorkspaceMobileHeaderClose()
  const [popoverItem, setPopoverItem] = createSignal<AgendaItem | undefined>()
  const [popoverRect, setPopoverRect] = createSignal<DOMRect | undefined>()
  const [runsCache, setRunsCache] = createSignal<Record<string, AgendaRunLog[]>>({})
  const [actionLoading, setActionLoading] = createSignal<Set<string>>(new Set())
  const [actionDone, setActionDone] = createSignal<Set<string>>(new Set())

  const [viewMode, setViewMode] = createSignal<ViewMode>("week")
  const [anchor, setAnchor] = createSignal(Date.now())
  const [calendarRange, setCalendarRange] = createSignal<{ start: number; end: number }>({ start: 0, end: 0 })

  const [activity, setActivity] = createSignal<AgendaActivityState>(defaultAgendaActivityState())
  const [activityLoading, setActivityLoading] = createSignal(false)
  const [activityQuery, setActivityQuery] = createSignal("")
  const [activityError, setActivityError] = createSignal<string | null>(null)

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
    if (item.origin?.scope?.type === "home") return "home"
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

  async function performAction(id: string, action: AgendaAction, options?: { throwOnError?: boolean }) {
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
    } catch (error) {
      if (options?.throwOnError) throw error
      showToast({
        type: "error",
        title: "Agenda action failed",
        description: errorDescription(error),
      })
    } finally {
      setActionLoading((prev) => {
        const next = new Set(prev)
        next.delete(`${id}-${action}`)
        return next
      })
    }
  }

  const isLoading = (id: string, action: string) => actionLoading().has(`${id}-${action}`)
  const isDone = (id: string, action: string) => actionDone().has(`${id}-${action}`)

  function formDirectory(item?: AgendaItem): string {
    if (item) return directoryForItem(item) ?? directory() ?? globalSync.data.paths.home
    return directory() ?? globalSync.data.paths.home
  }

  function openForm(item?: AgendaItem) {
    dialog.show(() => (
      <Dialog class="agenda-form-dialog" title={item ? "Edit Agenda" : "New Agenda"}>
        <AgendaForm directory={formDirectory(item)} item={item} presentation="dialog" onBack={() => dialog.close()} />
      </Dialog>
    ))
  }

  function openCreate() {
    openForm()
  }

  function openEdit(item: AgendaItem) {
    openForm(item)
  }

  function openDetail(item: AgendaItem, rect?: DOMRect) {
    setPopoverRect(rect)
    setPopoverItem(item)
    loadRuns(item.id)
  }

  function requestAction(item: AgendaItem, action: AgendaAction) {
    if (action === "cancel" || action === "remove") {
      confirm.show({
        ...agendaActionConfirm(action, item.title),
        onConfirm: () => performAction(item.id, action, { throwOnError: true }),
      })
      return
    }
    void performAction(item.id, action)
  }

  function handleEventClick(event: CalendarEvent, e?: MouseEvent) {
    const rect = e ? (e.target as HTMLElement).getBoundingClientRect() : undefined
    const item = itemById(event.itemId)
    if (item) openDetail(item, rect)
  }

  function handleDateClick(ts: number) {
    setAnchor(ts)
  }

  async function loadActivity(options?: { reset?: boolean; append?: boolean; query?: string }) {
    if (activityLoading()) return
    if (!sdk?.client?.agenda) return
    setActivityLoading(true)
    setActivityError(null)
    try {
      const reset = options?.reset ?? false
      const append = options?.append ?? false
      const query = options?.query ?? activityQuery()
      const page = await requestAgendaActivity({
        client: sdk.client,
        directory: directory() ?? globalSync.data.paths.home,
        scopeID: directory() === "home" ? "home" : undefined,
        query,
        append,
        state: activity(),
      })

      setActivity((prev) => mergeAgendaActivityPage({ previous: prev, page, append }))

      if (reset) {
        setActivityQuery(query)
      }
    } catch (error: unknown) {
      setActivityError(normalizeAgendaActivityError(error))
      setActivity(defaultAgendaActivityState(activity().limit))
    }
    setActivityLoading(false)
  }

  createEffect(
    on(tab, (t) => {
      if (t === "activity") void loadActivity()
    }),
  )

  function navigateToSession(sessionID: string, scopeID: string) {
    const dir = scopeID === "home" ? "home" : directory()
    if (!dir) return
    navigate(`/${base64Encode(dir)}/session/${sessionID}`)
  }

  return (
    <AppPanel.Root>
      <AppPanel.Content>
        <WorkspaceMobileHeader onClose={onCloseWorkspace} />
        <AppPanel.Header class="agenda-header">
          <div class="agenda-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>Agenda</AppPanel.Title>
              <button
                type="button"
                class="inline-flex h-9 items-center gap-2 rounded-xl bg-text-strong px-3.5 text-13-medium text-background-base ring-1 ring-inset ring-border-weaker-selected shadow-sm transition-colors hover:bg-text-base"
                onClick={openCreate}
              >
                <Icon name={getSemanticIcon("action.add")} size="small" class="text-background-base" />
                <span>New Agenda</span>
              </button>
            </AppPanel.HeaderRow>
            <AppPanel.SegmentedNav
              items={[
                { id: "schedule", label: "Schedule" },
                { id: "activity", label: "History" },
              ]}
              active={tab()}
              onChange={(id) => setTab(id as PanelTab)}
            />
          </div>
        </AppPanel.Header>

        <Show when={tab() === "schedule"}>
          <AppPanel.Body padding={false} class="agenda-body">
            <div class="agenda-stage">
              <div class="grid w-full grid-cols-1 items-stretch gap-3 pb-1 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
                <div class="agenda-main-surface h-full p-3.5">
                  <MiniCalendar anchor={anchor()} viewMode={viewMode()} onDateClick={handleDateClick} />
                </div>
                <div class="agenda-main-surface min-w-0 flex h-full flex-col p-3">
                  <Show
                    when={todoItems().length > 0}
                    fallback={
                      <div class="agenda-inner-surface flex min-h-0 flex-1 items-center justify-center px-3 py-4">
                        <span class="text-10-medium text-text-weaker/60">No todo items</span>
                      </div>
                    }
                  >
                    <div class="flex items-center justify-between gap-2 mb-2 px-0.5">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Todo</span>
                        <span class="inline-flex items-center rounded-full bg-surface-raised-base px-2 py-0.5 text-[10px] font-medium text-text-weaker">
                          {todoItems().length}
                        </span>
                      </div>
                    </div>
                    <div class="min-h-0 flex-1 overflow-y-auto flex flex-col gap-1.5 [scrollbar-width:thin]">
                      <For each={todoItems()}>
                        {(item) => (
                          <TodoCard
                            item={item}
                            onClick={(e) => openDetail(item, (e.target as HTMLElement).getBoundingClientRect())}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>

              <div class="relative flex min-h-[720px] flex-1 flex-col">
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
                  <Portal>
                    <DetailPopover
                      anchor={popoverRect()}
                      item={popoverItem()!}
                      runs={runsCache()[popoverItem()!.id]}
                      isLoading={isLoading}
                      isDone={isDone}
                      onClose={() => setPopoverItem(undefined)}
                      onAction={(action) => requestAction(popoverItem()!, action)}
                      onEdit={() => {
                        const pi = popoverItem()!
                        setPopoverItem(undefined)
                        openEdit(pi)
                      }}
                    />
                  </Portal>
                </Show>
              </div>
            </div>
          </AppPanel.Body>
        </Show>

        <Show when={tab() === "activity"}>
          <AppPanel.Body padding={false} class="agenda-body">
            <div class="agenda-stage">
              <ActivityView
                items={activity().items}
                total={activity().total}
                hasMore={activity().hasMore}
                loading={activityLoading()}
                query={activityQuery()}
                error={activityError()}
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
            </div>
          </AppPanel.Body>
        </Show>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}

function TodoCard(props: { item: AgendaItem; onClick: (e: MouseEvent) => void }) {
  return (
    <div
      class="agenda-inner-surface flex cursor-pointer items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-surface-raised-base-hover"
      onClick={props.onClick}
    >
      <span
        class={`shrink-0 w-1.5 h-1.5 rounded-full ${props.item.status === "active" ? "bg-icon-success-base" : props.item.status === "paused" ? "bg-icon-warning-base" : props.item.status === "done" ? "bg-text-weaker" : "bg-border-base"}`}
      />
      <span class="min-w-0 flex-1 truncate text-12-regular text-text-strong">{props.item.title}</span>
      <span class="inline-flex shrink-0 items-center rounded-full bg-surface-inset-base px-2 py-0.5 text-[9px] font-medium text-text-weaker">
        {triggerSummary(props.item.triggers)}
      </span>
    </div>
  )
}

function DetailPopover(props: {
  anchor?: DOMRect
  item: AgendaItem
  runs: AgendaRunLog[] | undefined
  isLoading: (id: string, action: string) => boolean
  isDone: (id: string, action: string) => boolean
  onClose: () => void
  onAction: (action: AgendaAction) => void
  onEdit: () => void
}) {
  const pos = () => {
    const a = props.anchor
    if (!a) return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
    const cardW = 360
    const cardH = 480
    let left = a.left + a.width / 2 - cardW / 2
    const vw = window.innerWidth
    if (left < 12) left = 12
    if (left + cardW > vw - 12) left = vw - cardW - 12
    let top = a.bottom + 8
    const vh = window.innerHeight
    if (top + cardH > vh - 16) top = a.top - cardH - 8
    if (top < 8) top = 8
    return { top: `${top}px`, left: `${left}px` }
  }
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
    <div
      ref={cardRef}
      class="agenda-detail-popover workbench-popover-surface pointer-events-auto fixed z-[102] w-full max-w-sm max-h-[calc(100vh-32px)] flex flex-col overflow-hidden rounded-[1.35rem] border border-border-base/40 bg-background-base animate-in fade-in slide-in-from-top-2 duration-150"
      style={pos()}
    >
      <div class="shrink-0 flex items-center gap-1 px-3.5 pt-3 pb-2">
        <button
          type="button"
          class="size-7 flex items-center justify-center rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
          onClick={props.onEdit}
          title="Edit"
        >
          <Icon name={getSemanticIcon("action.rename")} size="small" />
        </button>
        <ActionIconBtn
          icon={getSemanticIcon("action.remove")}
          title="Delete"
          loading={props.isLoading(props.item.id, "remove")}
          onClick={() => props.onAction("remove")}
          danger
        />
        <div class="flex-1" />
        <button
          type="button"
          class="size-7 flex items-center justify-center rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
          onClick={props.onClose}
          title="Close"
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      </div>

      <div class="agenda-detail-body flex-1 min-h-0 overflow-y-auto px-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div class="flex flex-col gap-3">
          <div class="agenda-detail-title-row">
            <span class="agenda-detail-title">{props.item.title}</span>
            <span class={`agenda-detail-status ${agendaStatusTone(props.item.status)}`}>{props.item.status}</span>
          </div>

          <Show when={props.item.description}>
            <p class="text-12-regular text-text-weak leading-relaxed">{props.item.description}</p>
          </Show>

          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="agenda-detail-chip">{triggerSummary(props.item.triggers)}</span>
            <Show when={state()?.runCount}>
              <span class="agenda-detail-chip">{state()!.runCount} runs</span>
            </Show>
            <Show when={state()?.consecutiveErrors && state()!.consecutiveErrors! > 0}>
              <span class="agenda-detail-chip agenda-detail-chip-danger">{state()!.consecutiveErrors} errors</span>
            </Show>
            <Show when={props.item.createdBy === "agent"}>
              <span class="agenda-detail-chip">agent</span>
            </Show>
          </div>

          <Show when={state()?.nextRunAt}>
            <div class="agenda-detail-meta">Next: {relativeTime(state()!.nextRunAt!)}</div>
          </Show>

          <Show when={state()?.lastRunAt}>
            <div class="agenda-detail-meta">
              Last run: {absoluteDate(state()!.lastRunAt!)}
              <Show when={state()?.lastRunStatus}>
                {" · "}
                <span class={agendaRunStatusTone(state()!.lastRunStatus!)}>{state()!.lastRunStatus}</span>
              </Show>
              <Show when={state()?.lastRunDuration}>
                {" · "}
                {formatAgendaDuration(state()!.lastRunDuration!)}
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
              <For each={props.item.tags}>{(tag) => <span class="agenda-detail-chip">#{tag}</span>}</For>
            </div>
          </Show>

          <Show when={props.item.prompt}>
            <div class="agenda-detail-section">
              <div class="agenda-detail-section-label">Task</div>
              <p class="text-11-regular text-text-weak leading-relaxed whitespace-pre-wrap line-clamp-4">
                {props.item.prompt}
              </p>
              <Show when={props.item.agent}>
                <span class="agenda-detail-meta mt-1.5 block">Agent: {props.item.agent}</span>
              </Show>
            </div>
          </Show>

          <ActionBar item={props.item} isLoading={props.isLoading} isDone={props.isDone} onAction={props.onAction} />

          <Show when={props.runs} fallback={<Spinner class="size-3.5 my-1" />}>
            {(runs) => (
              <Show when={runs().length > 0}>
                <div class="agenda-detail-section">
                  <div class="agenda-detail-section-label">Recent runs</div>
                  <For each={runs().slice(0, 8)}>{(run) => <RunRow run={run} />}</For>
                </div>
              </Show>
            )}
          </Show>

          <div class="agenda-detail-footer">
            Created {absoluteDate(props.item.time.created)}
            <Show when={props.item.time.updated !== props.item.time.created}>
              {" · updated "}
              {absoluteDate(props.item.time.updated)}
            </Show>
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
        "text-icon-weak-base hover:text-text-diff-delete-base hover:bg-text-diff-delete-base/10":
          !!props.danger && !props.loading,
        "text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover": !props.danger && !props.loading,
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
  onAction: (action: AgendaAction) => void
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
        "border-border-base/45 bg-text-strong text-background-base hover:bg-text-base":
          variant() === "primary" && !props.loading && !done(),
        "border-text-diff-delete-base/25 bg-text-diff-delete-base/6 text-text-diff-delete-base hover:bg-text-diff-delete-base/10":
          variant() === "danger" && !props.loading && !done(),
        "border-border-base/45 bg-surface-raised-base text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
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
    <div class="agenda-run-row">
      <span class={`shrink-0 ${agendaRunStatusTone(props.run.status)}`}>
        {props.run.status === "ok" ? "✓" : props.run.status === "error" ? "✗" : "–"}
      </span>
      <span class="text-text-weaker shrink-0">{props.run.trigger.type}</span>
      <Show when={props.run.duration}>
        <span class="text-text-weaker shrink-0">{formatAgendaDuration(props.run.duration!)}</span>
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
