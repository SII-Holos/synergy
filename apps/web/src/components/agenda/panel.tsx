import { translateDescriptor } from "@/locales/translate"
import { AgendaTaskList } from "./task-list"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { agendaActionConfirm } from "@/components/dialog/confirm-copy"
import { AppPanel, capturePanelFocusReturn } from "@/components/app-panel"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { useWorkspaceMobileHeaderClose } from "@/components/workspace/mobile-header-close"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { AgendaItem, AgendaRunLog } from "@ericsanchezok/synergy-sdk/client"
import { CalendarGrid, type ViewMode } from "./calendar"
import { AgendaFormDialog } from "./form"
import { agendaRange, forecastAgenda, filterAgendaTasks, type AgendaTaskFilter, type CalendarEvent } from "./forecast"
import { addDays, startOfDay } from "./date"
import { ActivityView } from "./activity-view"
import {
  defaultAgendaActivityState,
  mergeAgendaActivityPage,
  normalizeAgendaActivityError,
  requestAgendaActivity,
  type AgendaActivityState,
} from "./activity-state"
import {
  agendaRunStatusTone,
  agendaRunTriggerLabel,
  agendaStatusTone,
  formatAgendaDuration,
  makeTriggerSummary,
  agendaStatusLabel,
  agendaRunStatusLabel,
} from "./shared"
import "./agenda-dialog.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { A } from "./agenda-i18n"

import { AgendaDetailActions, type AgendaAction } from "./detail-actions"

type PanelTab = "schedule" | "tasks" | "activity"

export function AgendaPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const params = useParams()
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }, values?: Record<string, unknown>) =>
    i18n._(values ? { ...d, values } : d)

  const [tab, setTab] = createSignal<PanelTab>("schedule")
  const scrollPositions = new Map<PanelTab, number>()
  let scrollArea: HTMLDivElement | undefined
  let scrollOwner: PanelTab = "schedule"
  function selectTab(value: PanelTab) {
    if (value === tab()) return
    if (scrollOwner === tab()) scrollPositions.set(tab(), scrollArea?.scrollTop ?? 0)
    setTab(value)
    requestAnimationFrame(() => {
      if (tab() !== value || !scrollArea?.isConnected) return
      scrollArea.scrollTop = scrollPositions.get(value) ?? 0
      scrollOwner = value
    })
  }
  const onCloseWorkspace = useWorkspaceMobileHeaderClose()
  let detailDialogID: string | undefined
  const [activeDetailItemID, setActiveDetailItemID] = createSignal<string>()
  const runsRequests = new Map<string, number>()
  onCleanup(() => {
    runsRequests.clear()
    if (detailDialogID) dialog.close(detailDialogID)
  })
  const [runsError, setRunsError] = createSignal(new Set<string>())
  const [runsCache, setRunsCache] = createSignal<Record<string, AgendaRunLog[]>>({})
  const [actionLoading, setActionLoading] = createSignal<Set<string>>(new Set())
  const [actionDone, setActionDone] = createSignal<Set<string>>(new Set())

  const [viewMode, setViewMode] = createSignal<ViewMode>("list")
  const [anchor, setAnchor] = createSignal(Date.now())
  const [scopeFilter, setScopeFilter] = createSignal("")
  const [taskQuery, setTaskQuery] = createSignal("")
  const [taskFilter, setTaskFilter] = createSignal<AgendaTaskFilter>("all")
  const [now, setNow] = createSignal(Date.now())
  const clock = window.setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => window.clearInterval(clock))
  let searchInput: HTMLInputElement | undefined

  const [activity, setActivity] = createSignal<AgendaActivityState>(defaultAgendaActivityState())
  const [activityLoading, setActivityLoading] = createSignal(false)
  const [activityQuery, setActivityQuery] = createSignal("")
  const [activityError, setActivityError] = createSignal<string | null>(null)

  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  const items = createMemo(() => globalSync.agenda)

  const matchingItems = createMemo(() => filterAgendaTasks(items(), { query: taskQuery(), scopeID: scopeFilter() }))
  const taskItems = createMemo(() =>
    filterAgendaTasks(matchingItems(), { query: "", scopeID: "", filter: taskFilter() }),
  )
  const forecast = createMemo(() => forecastAgenda(matchingItems(), agendaRange(anchor(), viewMode()), { now: now() }))
  const historyScope = () => scopeFilter() || directory() || "home"
  const scopeLabel = (item: AgendaItem) =>
    globalSync.data.scope.find((scope) => scope.id === item.origin.scope.id)?.name ??
    (item.origin.scope.type === "home" ? _({ id: "app.sidebar.section.home", message: "Home" }) : item.origin.scope.id)
  function clearFilters() {
    setTaskQuery("")
    setTaskFilter("all")
    setScopeFilter("")
    searchInput?.focus()
  }

  function itemById(id: string): AgendaItem | undefined {
    return items().find((i) => i.id === id)
  }

  function directoryForItem(item: AgendaItem): string {
    return item.origin.scope.id
  }

  async function loadRuns(id: string) {
    const item = itemById(id)
    const scopeID = item ? directoryForItem(item) : directory()
    if (!scopeID) return
    const request = (runsRequests.get(id) ?? 0) + 1
    runsRequests.set(id, request)
    const isCurrent = () => runsRequests.get(id) === request && itemById(id)?.origin.scope.id === scopeID
    setRunsError((previous) => {
      const next = new Set(previous)
      next.delete(id)
      return next
    })
    try {
      const result = await sdk.client.agenda.runs({ id, scopeID }, { throwOnError: true })
      if (!isCurrent()) return
      setRunsCache((previous) => ({ ...previous, [id]: result.data ?? [] }))
    } catch {
      if (!isCurrent()) return
      setRunsError((previous) => new Set(previous).add(id))
    }
  }

  const detailHistoryRevision = createMemo(() => {
    const id = activeDetailItemID()
    const item = id ? itemById(id) : undefined
    if (!item) return undefined
    return JSON.stringify([
      id,
      item.origin.scope.id,
      item.state?.lastRunAt,
      item.state?.lastRunStatus,
      item.state?.runCount,
    ])
  })
  createEffect(
    on(detailHistoryRevision, () => {
      const id = activeDetailItemID()
      if (id) void loadRuns(id)
    }),
  )

  async function performAction(id: string, action: AgendaAction, options?: { throwOnError?: boolean }) {
    if ([...actionLoading()].some((key) => key.startsWith(`${id}-`))) return
    const item = itemById(id)
    const dir = item ? directoryForItem(item) : directory()
    if (!dir) return
    setActionLoading((prev) => new Set(prev).add(`${id}-${action}`))
    try {
      const ops: Record<string, () => Promise<unknown>> = {
        trigger: () => sdk.client.agenda.trigger({ id, scopeID: dir }, { throwOnError: true }),
        activate: () => sdk.client.agenda.activate({ id, scopeID: dir }, { throwOnError: true }),
        pause: () => sdk.client.agenda.pause({ id, scopeID: dir }, { throwOnError: true }),
        complete: () => sdk.client.agenda.complete({ id, scopeID: dir }, { throwOnError: true }),
        cancel: () => sdk.client.agenda.cancel({ id, scopeID: dir }, { throwOnError: true }),
        remove: () => sdk.client.agenda.remove({ id, scopeID: dir }, { throwOnError: true }),
      }
      await ops[action]()
      if (action === "remove") {
        runsRequests.delete(id)
        setRunsCache((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      } else if (activeDetailItemID() === id) void loadRuns(id)
      if (action === "trigger") {
        showToast({
          type: "success",
          title: _({ id: "app.agenda.action.submitted", message: "Execution submitted" }),
          description: _({ id: "app.agenda.action.submittedHint", message: "Check History for the execution result." }),
        })
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
      const errMsg =
        error instanceof Error ? error.message : typeof error === "string" && error ? error : _(A.actionRequestFailed)
      showToast({
        type: "error",
        title: _(A.actionFailed),
        description: errMsg,
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
    if (item) return directoryForItem(item) ?? directory() ?? "home"
    return scopeFilter() || directory() || "home"
  }

  function openForm(item?: AgendaItem) {
    const restoreFocus = capturePanelFocusReturn()
    let formID: string | undefined
    const open = item && detailDialogID ? dialog.push : dialog.show
    formID = open(
      () => <AgendaFormDialog directory={formDirectory(item)} item={item} onClose={() => dialog.close(formID)} />,
      restoreFocus,
    )
  }

  function openCreate() {
    openForm()
  }

  function openEdit(item: AgendaItem) {
    openForm(item)
  }

  function openDetail(item: AgendaItem, occurrence?: CalendarEvent) {
    const restoreFocus = capturePanelFocusReturn()
    const current = () => itemById(item.id) ?? item
    detailDialogID = dialog.show(
      () => (
        <Dialog
          size="wide"
          class="app-panel-detail-dialog agenda-detail-dialog"
          title={current().title}
          footer={
            <div class="agenda-detail-actions">
              <button type="button" class="agenda-secondary-action" onClick={() => openEdit(current())}>
                {_(A.detailEdit)}
              </button>
              <AgendaDetailActions
                item={current()}
                isLoading={isLoading}
                isDone={isDone}
                onAction={(action) => requestAction(current(), action)}
                _={_}
              />
            </div>
          }
        >
          <AgendaDetails
            item={current()}
            occurrence={occurrence}
            now={now()}
            scopeName={
              globalSync.data.scope.find((scope) => scope.id === current().origin.scope.id)?.name ??
              (current().origin.scope.type === "home"
                ? _({ id: "app.sidebar.section.home", message: "Home" })
                : current().origin.scope.id)
            }
            runs={runsCache()[item.id]}
            runsError={runsError().has(item.id)}
            onRetry={() => void loadRuns(item.id)}
            _={_}
          />
        </Dialog>
      ),
      () => {
        detailDialogID = undefined
        setActiveDetailItemID(undefined)
        restoreFocus()
      },
    )
    setActiveDetailItemID(item.id)
  }

  function requestAction(item: AgendaItem, action: AgendaAction) {
    if (action === "cancel" || action === "remove") {
      confirm.show({
        ...agendaActionConfirm(action, item.title),
        onConfirm: () => performAction(item.id, action, { throwOnError: true }),
        onConfirmed: () => {
          if (action === "remove" && activeDetailItemID() === item.id && detailDialogID) dialog.close(detailDialogID)
        },
      })
      return
    }
    void performAction(item.id, action)
  }

  function handleEventClick(event: CalendarEvent) {
    const item = itemById(event.itemId)
    if (item) openDetail(item, event)
  }

  let activityRequest = 0
  let activityContext = ""
  onCleanup(() => {
    activityRequest++
  })
  async function loadActivity(options?: { reset?: boolean; append?: boolean; query?: string }) {
    if (!sdk?.client?.agenda) return
    const scopeID = historyScope()
    const query = (options?.query ?? activityQuery()).trim()
    const context = JSON.stringify([scopeID, query])
    if (activityLoading() && context === activityContext) return
    const changed = context !== activityContext
    const request = ++activityRequest
    activityContext = context
    if (changed) setActivity(defaultAgendaActivityState(activity().limit))
    setActivityLoading(true)
    setActivityError(null)
    const current = () => request === activityRequest && historyScope() === scopeID && activityQuery().trim() === query
    try {
      const page = await requestAgendaActivity({
        client: sdk.client,
        scopeID,
        query,
        append: !changed && options?.append,
        state: activity(),
      })
      if (current())
        setActivity((previous) => mergeAgendaActivityPage({ previous, page, append: !changed && options?.append }))
    } catch (error) {
      if (current()) setActivityError(normalizeAgendaActivityError(error, _(A.activityUnavailable)))
    } finally {
      if (request === activityRequest) setActivityLoading(false)
    }
  }

  createEffect(
    on([tab, directory, scopeFilter], ([currentTab]) => {
      if (currentTab === "activity") void loadActivity()
    }),
  )

  function navigateToSession(sessionID: string, scopeID: string) {
    navigate(`/${base64Encode(scopeID)}/session/${sessionID}`)
  }

  return (
    <AppPanel.Root>
      <AppPanel.Content>
        <WorkspaceMobileHeader onClose={onCloseWorkspace} />
        <AppPanel.Header class="agenda-header">
          <div class="agenda-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>{_(A.panelTitle)}</AppPanel.Title>
              <button type="button" class="agenda-create-action app-panel-control" onClick={openCreate}>
                <Icon name={getSemanticIcon("action.add")} size="small" />
                <span>{_(A.newAgenda)}</span>
              </button>
            </AppPanel.HeaderRow>
            <AppPanel.Tabs
              id="agenda"
              label={_(A.panelTitle)}
              items={[
                { id: "schedule", label: _(A.scheduleTab) },
                { id: "tasks", label: _({ id: "app.agenda.panel.tab.tasks", message: "Tasks" }) },
                { id: "activity", label: _(A.activityTab) },
              ]}
              active={tab()}
              onChange={(value) => selectTab(value as PanelTab)}
            />
          </div>
        </AppPanel.Header>
        <AppPanel.Body
          ref={(element) => {
            scrollArea = element
          }}
          padding={false}
          class="agenda-body"
          tab={{ id: "agenda", value: tab() }}
        >
          <div class="agenda-stage">
            <p class="app-panel-copy text-text-weak">
              {tab() === "schedule"
                ? _({
                    id: "app.agenda.arrangements.description",
                    message:
                      "See when your enabled tasks are expected to run. Select a date to change the displayed range.",
                  })
                : tab() === "tasks"
                  ? _({
                      id: "app.agenda.tasks.description",
                      message: "Manage all task rules, including manual, event-triggered, disabled and archived tasks.",
                    })
                  : _({
                      id: "app.agenda.activity.description",
                      message: "Review actual executions, results and related sessions, newest first.",
                    })}
            </p>
            <div class="agenda-page-tools">
              <div class="agenda-scope-filter app-panel-control">
                <span>{_({ id: "app.agenda.scope.filter", message: "Scope" })}</span>
                <MenuField
                  ariaLabel={_({ id: "app.agenda.scope.filter", message: "Scope" })}
                  value={tab() === "activity" ? historyScope() : scopeFilter()}
                  triggerClass="menu-field-trigger agenda-scope-select"
                  options={[
                    ...(tab() !== "activity"
                      ? [{ value: "", label: _({ id: "app.agenda.scope.all", message: "All Scopes" }) }]
                      : []),
                    { value: "home", label: _({ id: "app.sidebar.section.home", message: "Home" }) },
                    ...globalSync.data.scope
                      .filter((scope) => scope.id !== "home")
                      .map((scope) => ({ value: scope.id, label: scope.name || scope.id })),
                  ]}
                  onChange={setScopeFilter}
                />
              </div>
              <Show when={tab() !== "activity"}>
                <div class="agenda-search">
                  <input
                    ref={searchInput}
                    value={taskQuery()}
                    aria-label={_({ id: "app.agenda.tasks.search", message: "Search tasks" })}
                    placeholder={_({ id: "app.agenda.tasks.search", message: "Search tasks" })}
                    onInput={(event) => setTaskQuery(event.currentTarget.value)}
                  />
                  <Show when={taskQuery()}>
                    <button
                      type="button"
                      class="agenda-secondary-action"
                      onClick={() => {
                        setTaskQuery("")
                        searchInput?.focus()
                      }}
                    >
                      {_({ id: "app.agenda.search.clear", message: "Clear search" })}
                    </button>
                  </Show>
                </div>
                <Show when={scopeFilter() || taskQuery() || (tab() === "tasks" && taskFilter() !== "all")}>
                  <button type="button" class="agenda-secondary-action" onClick={clearFilters}>
                    {_({ id: "app.agenda.filters.clear", message: "Clear filters" })}
                  </button>
                </Show>
              </Show>
            </div>
            <Show when={tab() === "schedule"}>
              <Show when={forecast().limited.length || forecast().invalid.length || forecast().relative.length}>
                <div class="agenda-forecast-warning app-panel-caption" role="status">
                  <Show when={forecast().relative.length}>
                    <p>
                      {_({
                        id: "app.agenda.arrangements.relative",
                        message:
                          "Some interval or delayed tasks depend on activation and execution times; only their known next trigger is shown.",
                      })}
                    </p>
                  </Show>
                  <Show when={forecast().limited.length}>
                    <p>
                      {_(
                        {
                          id: "app.agenda.arrangements.limited",
                          message:
                            "Partial preview: {count} task rules exceed this range's limit (200 cron or 500 interval times per trigger). Narrow the range to see more.",
                        },
                        { count: forecast().limited.length },
                      )}
                    </p>
                  </Show>
                  <Show when={forecast().invalid.length}>
                    <p>
                      {_(
                        {
                          id: "app.agenda.arrangements.invalid",
                          message: "{count} task rules could not be predicted. Review their trigger settings in Tasks.",
                        },
                        { count: forecast().invalid.length },
                      )}
                    </p>
                  </Show>
                </div>
              </Show>
              <CalendarGrid
                viewMode={viewMode()}
                anchor={anchor()}
                events={forecast().events}
                now={now()}
                scopeLabel={(event) => {
                  const item = itemById(event.itemId)
                  return item ? scopeLabel(item) : ""
                }}
                onViewModeChange={setViewMode}
                onAnchorChange={setAnchor}
                onEventClick={handleEventClick}
                onHistory={() => selectTab("activity")}
              />
            </Show>
            <Show when={tab() === "tasks"}>
              <AgendaTaskList
                items={taskItems()}
                filter={taskFilter()}
                onFilterChange={setTaskFilter}
                onSelect={(item) => openDetail(item)}
                onAction={requestAction}
                isLoading={isLoading}
                scopeLabel={scopeLabel}
                onClear={clearFilters}
                filtered={!!scopeFilter() || !!taskQuery() || taskFilter() !== "all"}
                now={now()}
              />
            </Show>
            <Show when={tab() === "activity"}>
              <ActivityView
                items={activity().items}
                total={activity().total}
                hasMore={activity().hasMore}
                loading={activityLoading()}
                query={activityQuery()}
                error={activityError()}
                onQueryChange={(value) => {
                  setActivityQuery(value)
                  void loadActivity({ reset: true, query: value })
                }}
                onRetry={() => void loadActivity({ query: activityQuery() })}
                onRefresh={() => void loadActivity()}
                onLoadMore={() => void loadActivity({ append: true })}
                onNavigate={navigateToSession}
                onItemClick={(id) => {
                  const item = itemById(id)
                  if (item) openDetail(item)
                }}
              />
            </Show>
          </div>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}

function AgendaDetails(props: {
  item: AgendaItem
  occurrence?: CalendarEvent
  now: number
  scopeName: string
  runs: AgendaRunLog[] | undefined
  runsError: boolean
  onRetry: () => void
  _: (d: { id: string; message: string }, values?: Record<string, unknown>) => string
}) {
  const { i18n, fmt } = useLocale()
  const { _ } = props
  const triggerSummary = (triggers: AgendaItem["triggers"]) =>
    makeTriggerSummary(triggers, _, (time) => fmt.dateTime(time))

  const state = () => props.item.state
  const preview = createMemo(() =>
    forecastAgenda(
      [props.item],
      { start: startOfDay(props.now), end: addDays(startOfDay(props.now), 7) },
      { now: props.now, preview: true },
    ),
  )
  return (
    <div class="agenda-details">
      <div class="agenda-detail-body flex-1 min-h-0 overflow-y-auto px-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div class="flex flex-col gap-3">
          <Show when={props.occurrence}>
            {(occurrence) => (
              <div class="agenda-occurrence-detail">
                <span class="app-panel-caption text-text-weak">
                  {_({ id: "app.agenda.detail.expectedTrigger", message: "Expected trigger" })}
                </span>
                <time class="app-panel-section-title" dateTime={new Date(occurrence().time).toISOString()}>
                  {fmt.dateTime(occurrence().time, { dateStyle: "full", timeStyle: "short" })}
                </time>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.agenda.detail.expectedHint",
                    message: "This is a predicted time, not an execution record. No execution duration is implied.",
                  })}
                </p>
                <Show when={props.item.status !== "active"}>
                  <p class="app-panel-caption text-text-weak">
                    {_({
                      id: "app.agenda.detail.noLongerEnabled",
                      message: "This task is no longer enabled and will not run at this time.",
                    })}
                  </p>
                </Show>
              </div>
            )}
          </Show>
          <p class="app-panel-caption text-text-weak">{props.scopeName}</p>
          <div class="agenda-detail-title-row">
            <span class={`agenda-detail-status ${agendaStatusTone(props.item.status)}`}>
              {translateDescriptor(agendaStatusLabel(props.item.status), i18n)}
            </span>
          </div>

          <Show when={props.item.description}>
            <p class="app-panel-copy text-text-weak leading-relaxed">{props.item.description}</p>
          </Show>

          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="agenda-detail-chip">{triggerSummary(props.item.triggers)}</span>
            <Show when={state()?.runCount}>
              <span class="agenda-detail-chip">{_(A.detailRuns, { count: state()!.runCount! })}</span>
            </Show>
            <Show when={state()?.consecutiveErrors && state()!.consecutiveErrors! > 0}>
              <span class="agenda-detail-chip agenda-detail-chip-danger">
                {_(A.detailErrors, { count: state()!.consecutiveErrors! })}
              </span>
            </Show>
            <Show when={props.item.createdBy === "agent"}>
              <span class="agenda-detail-chip">{_(A.detailAgent)}</span>
            </Show>
          </div>

          <Show when={props.item.status === "active" && state()?.nextRunAt && state()!.nextRunAt! >= props.now}>
            <div class="agenda-detail-meta">{_(A.detailNext, { time: fmt.dateTime(state()!.nextRunAt!) })}</div>
          </Show>

          <Show when={state()?.lastRunAt}>
            <div class="agenda-detail-meta">
              {_(A.detailLastRun, { date: absoluteDate(fmt, state()!.lastRunAt!) })}
              <Show when={state()?.lastRunStatus}>
                {" · "}
                <span class={agendaRunStatusTone(state()!.lastRunStatus!)}>
                  {translateDescriptor(agendaRunStatusLabel(state()!.lastRunStatus!), i18n)}
                </span>
              </Show>
              <Show when={state()?.lastRunDuration != null}>
                {" · "}
                {formatAgendaDuration(state()!.lastRunDuration!)}
              </Show>
            </div>
          </Show>
          <Show when={props.item.triggers?.some((trigger) => ["at", "every", "cron", "delay"].includes(trigger.type))}>
            <details class="agenda-detail-trigger-details">
              <summary class="app-panel-control">
                {_({ id: "app.agenda.detail.rulePreview", message: "Rule preview · next 7 days" })}
              </summary>
              <p class="app-panel-caption text-text-weak">
                {props.item.status === "active"
                  ? _({
                      id: "app.agenda.detail.previewHint",
                      message: "Predicted times for this rule. See History for actual executions.",
                    })
                  : _({
                      id: "app.agenda.detail.disabledPreview",
                      message: "This rule is disabled. These times are a preview only; the task will not run.",
                    })}
              </p>
              <Show when={preview().relative.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.agenda.detail.relativePreview",
                    message:
                      "Interval and delayed times depend on when the task is enabled and runs. Only an enabled task's known next time can be previewed.",
                  })}
                </p>
              </Show>
              <ul class="agenda-rule-preview">
                <For each={preview().events.slice(0, 8)}>
                  {(event) => (
                    <li class="app-panel-caption">
                      <time dateTime={new Date(event.time).toISOString()}>{fmt.dateTime(event.time)}</time>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={!preview().events.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({ id: "app.agenda.detail.noPreview", message: "No predictable time within the next 7 days." })}
                </p>
              </Show>
              <Show when={preview().events.length > 8 || preview().limited.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({ id: "app.agenda.detail.previewFirst", message: "Showing the first 8 times only." })}
                </p>
              </Show>
              <Show when={preview().invalid.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.agenda.detail.previewInvalid",
                    message: "Some trigger settings could not be predicted.",
                  })}
                </p>
              </Show>
            </details>
          </Show>

          <Show when={state()?.lastRunError}>
            <div class="app-panel-caption text-text-diff-delete-base bg-text-diff-delete-base/6 rounded-[0.95rem] px-3 py-2 ring-1 ring-inset ring-text-diff-delete-base/10 line-clamp-3">
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
              <div class="agenda-detail-section-label">{_(A.detailTaskLabel)}</div>
              <p class="app-panel-copy text-text-weak leading-relaxed whitespace-pre-wrap">{props.item.prompt}</p>
              <Show when={props.item.agent}>
                <span class="agenda-detail-meta mt-1.5 block">
                  {_(A.detailAgentLabel, { agent: props.item.agent! })}
                </span>
              </Show>
            </div>
          </Show>

          <Show when={props.item.triggers?.some((trigger) => trigger.type === "cron")}>
            <details class="agenda-detail-trigger-details">
              <summary class="app-panel-control">
                {_({ id: "app.agenda.rawTriggers", message: "Trigger expressions" })}
              </summary>
              <For each={props.item.triggers}>
                {(trigger) => (
                  <Show when={trigger.type === "cron"}>
                    <p class="app-panel-caption break-words">
                      {trigger.type === "cron"
                        ? `${trigger.expr} · ${trigger.tz || Intl.DateTimeFormat().resolvedOptions().timeZone}`
                        : ""}
                    </p>
                  </Show>
                )}
              </For>
            </details>
          </Show>
          <Show when={props.runsError}>
            <div class="agenda-history-error" role="alert">
              <span>{_({ id: "app.agenda.detail.historyFailed", message: "Unable to load execution history." })}</span>
              <button type="button" class="agenda-secondary-action" onClick={props.onRetry}>
                {_({ id: "app.agenda.detail.retry", message: "Retry" })}
              </button>
            </div>
          </Show>
          <Show when={props.runs} fallback={!props.runsError ? <Spinner class="size-3.5 my-1" /> : undefined}>
            {(runs) => (
              <Show when={runs().length > 0}>
                <div class="agenda-detail-section">
                  <div class="agenda-detail-section-label">{_(A.detailRecentRuns)}</div>
                  <For each={runs().slice(0, 8)}>{(run) => <RunRow run={run} />}</For>
                </div>
              </Show>
            )}
          </Show>
          <div class="agenda-detail-footer">
            {_(A.detailCreated, { date: absoluteDate(fmt, props.item.time.created) })}
            <Show when={props.item.time.updated !== props.item.time.created}>
              {" · "}
              {_(A.detailUpdated, { date: absoluteDate(fmt, props.item.time.updated) })}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function RunRow(props: { run: AgendaRunLog }) {
  const { i18n, fmt } = useLocale()
  return (
    <div class="agenda-run-row">
      <span class={`shrink-0 ${agendaRunStatusTone(props.run.status)}`}>
        <span aria-hidden="true">{props.run.status === "ok" ? "✓" : props.run.status === "error" ? "✗" : "–"}</span>{" "}
        {translateDescriptor(agendaRunStatusLabel(props.run.status), i18n)}
      </span>
      <span class="text-text-weaker shrink-0">
        {translateDescriptor(agendaRunTriggerLabel(props.run.trigger.type), i18n)}
      </span>
      <Show when={props.run.duration !== undefined}>
        <span class="text-text-weaker shrink-0">{formatAgendaDuration(props.run.duration!)}</span>
      </Show>
      <span class="flex-1 min-w-0 text-text-weak truncate">
        <Show when={props.run.error} fallback="">
          <span class="text-text-diff-delete-base">{props.run.error}</span>
        </Show>
      </span>
      <span class="text-text-weaker shrink-0">{relativeTime(fmt, props.run.time.started)}</span>
    </div>
  )
}
