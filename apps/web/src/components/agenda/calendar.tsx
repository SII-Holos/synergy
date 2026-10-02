import { calendarKeyDate } from "./calendar-navigation"
import { AppPanel } from "@/components/app-panel"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, onMount, type JSX } from "solid-js"
import type { CalendarEvent } from "./expand"
import {
  startOfDay,
  startOfWeek,
  addDays,
  addMonths,
  monthRange,
  formatHour,
  getMonthNamesShort,
  getDayLabelsShort,
  formatLocaleDate,
} from "./date"
import { A } from "./agenda-i18n"
import { useLocale, type IntlFormatter } from "@/context/locale"

export type ViewMode = "list" | "day" | "week" | "month"

const HOUR_HEIGHT = 58
const TIME_COL = 72
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const EVENT_HEIGHT = 68
const EVENT_SPACING_MS = (EVENT_HEIGHT / HOUR_HEIGHT) * 3_600_000
const MONTH_MAX_EVENTS = 4

interface LayoutEvent {
  event: CalendarEvent
  col: number
  totalCols: number
}

function layoutOverlapping(events: CalendarEvent[]): LayoutEvent[] {
  if (events.length === 0) return []

  const sorted = [...events].sort((a, b) => a.time - b.time)
  const ends: number[] = []
  const cols: number[] = []

  for (const ev of sorted) {
    let placed = -1
    for (let c = 0; c < ends.length; c++) {
      if (ends[c] <= ev.time) {
        placed = c
        break
      }
    }
    if (placed === -1) {
      placed = ends.length
      ends.push(0)
    }
    ends[placed] = ev.time + EVENT_SPACING_MS
    cols.push(placed)
  }

  const groups: { start: number; end: number; indices: number[] }[] = []
  for (let i = 0; i < sorted.length; i++) {
    const evStart = sorted[i].time
    const evEnd = evStart + EVENT_SPACING_MS
    let merged = false
    for (const g of groups) {
      if (evStart < g.end && evEnd > g.start) {
        g.start = Math.min(g.start, evStart)
        g.end = Math.max(g.end, evEnd)
        g.indices.push(i)
        merged = true
        break
      }
    }
    if (!merged) groups.push({ start: evStart, end: evEnd, indices: [i] })
  }

  const totalColsMap = new Map<number, number>()
  for (const g of groups) {
    let maxCol = 0
    for (const idx of g.indices) maxCol = Math.max(maxCol, cols[idx])
    for (const idx of g.indices) totalColsMap.set(idx, maxCol + 1)
  }

  return sorted.map((event, i) => ({
    event,
    col: cols[i],
    totalCols: totalColsMap.get(i) ?? 1,
  }))
}

interface CalendarGridProps {
  viewMode: ViewMode
  anchor: number
  events: CalendarEvent[]
  listContent?: JSX.Element
  onViewModeChange?: (mode: ViewMode) => void
  onAnchorChange?: (anchor: number) => void
  onEventClick?: (event: CalendarEvent, e: MouseEvent) => void
  onRangeChange?: (start: number, end: number) => void
}

function formatDayHeader(ts: number, fmt: IntlFormatter): { label: string; day: number; isToday: boolean } {
  const d = new Date(ts)
  const now = new Date()
  const dayLabels = getDayLabelsShort(fmt)
  return {
    label: dayLabels[d.getDay()],
    day: d.getDate(),
    isToday: d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(),
  }
}

function formatDateRange(weekStart: number, fmt: IntlFormatter): string {
  const s = new Date(weekStart)
  const e = new Date(addDays(weekStart, 6))
  const months = getMonthNamesShort(fmt)
  if (s.getMonth() === e.getMonth()) return `${months[s.getMonth()]} ${s.getDate()} – ${e.getDate()}`
  return `${months[s.getMonth()]} ${s.getDate()} – ${months[e.getMonth()]} ${e.getDate()}`
}

function formatEventTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
}

function eventTop(ts: number, dayStart: number): number {
  return ((ts - dayStart) / 3_600_000) * HOUR_HEIGHT
}

const TIME_EVENT_CLASSES: Record<string, string> = {
  active: "agenda-event-surface",
  paused: "agenda-event-surface agenda-event-paused",
  pending: "agenda-event-surface agenda-event-muted",
  done: "agenda-event-surface agenda-event-muted",
  cancelled: "agenda-event-surface agenda-event-cancelled",
}

const MONTH_DOT_CLASSES: Record<string, string> = {
  active: "bg-icon-success-base",
  paused: "bg-icon-warning-base",
  pending: "bg-text-weaker",
  done: "bg-text-weaker",
  cancelled: "bg-text-diff-delete-base",
}

export function CalendarGrid(props: CalendarGridProps) {
  let scrollRef: HTMLDivElement | undefined
  const { i18n, fmt } = useLocale()
  const weekStart = createMemo(() => startOfWeek(props.anchor))
  const dayStart = createMemo(() => startOfDay(props.anchor))

  const rangeStart = createMemo(() => {
    if (props.viewMode === "month") return monthRange(props.anchor).start
    return props.viewMode === "week" || props.viewMode === "list" ? weekStart() : dayStart()
  })
  const rangeEnd = createMemo(() => {
    if (props.viewMode === "month") return monthRange(props.anchor).end
    return addDays(rangeStart(), props.viewMode === "week" || props.viewMode === "list" ? 7 : 1)
  })

  createEffect(() => {
    props.onRangeChange?.(rangeStart(), rangeEnd())
  })

  const dayColumns = createMemo(() => {
    const count = props.viewMode === "week" || props.viewMode === "list" ? 7 : 1
    const start = props.viewMode === "week" || props.viewMode === "list" ? weekStart() : dayStart()
    const f = fmt
    return Array.from({ length: count }, (_, i) => {
      const ts = addDays(start, i)
      return { ts, ...formatDayHeader(ts, f) }
    })
  })

  const eventsByDay = createMemo(() => {
    const map = new Map<number, CalendarEvent[]>()
    for (const event of props.events) {
      const day = startOfDay(event.time)
      const list = map.get(day)
      if (list) list.push(event)
      else map.set(day, [event])
    }
    return map
  })

  const [nowTs, setNowTs] = createSignal(Date.now())

  createEffect(() => {
    const tick = () => setNowTs(Date.now())
    tick()
    const id = window.setInterval(tick, 60_000)
    onCleanup(() => window.clearInterval(id))
  })

  const currentTimeOffset = createMemo(() => eventTop(nowTs(), startOfDay(nowTs())))

  const currentDayTs = createMemo(() => startOfDay(nowTs()))

  const isCurrentDayVisible = createMemo(() => {
    const now = currentDayTs()
    return now >= rangeStart() && now < rangeEnd()
  })

  function goToday() {
    props.onAnchorChange?.(Date.now())
  }
  function goPrev() {
    if (props.viewMode === "month") props.onAnchorChange?.(addMonths(props.anchor, -1))
    else props.onAnchorChange?.(addDays(props.anchor, props.viewMode === "week" || props.viewMode === "list" ? -7 : -1))
  }
  function goNext() {
    if (props.viewMode === "month") props.onAnchorChange?.(addMonths(props.anchor, 1))
    else props.onAnchorChange?.(addDays(props.anchor, props.viewMode === "week" || props.viewMode === "list" ? 7 : 1))
  }

  function navTitle(): string {
    const f = fmt
    if (props.viewMode === "month") {
      const d = new Date(props.anchor)
      const months = getMonthNamesShort(f)
      return `${months[d.getMonth()]} ${d.getFullYear()}`
    }
    if (props.viewMode === "week" || props.viewMode === "list") return formatDateRange(weekStart(), f)
    const d = new Date(dayStart())
    const months = getMonthNamesShort(f)
    const days = getDayLabelsShort(f)
    return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
  }

  onMount(() => {
    if (scrollRef) {
      const targetHour = Math.max(0, new Date().getHours() - 2)
      scrollRef.scrollTop = targetHour * HOUR_HEIGHT
    }
  })

  return (
    <div class="agenda-calendar flex flex-col flex-1 min-h-0">
      <NavBar
        title={navTitle()}
        viewMode={props.viewMode}
        onToday={goToday}
        onPrev={goPrev}
        onNext={goNext}
        onViewModeChange={props.onViewModeChange}
      />
      <Show when={props.viewMode === "list"}>{props.listContent}</Show>
      <Show when={props.viewMode === "day" || props.viewMode === "week"}>
        <TimeGrid
          ref={(el) => (scrollRef = el)}
          columns={dayColumns()}
          eventsByDay={eventsByDay()}
          currentTimeDayTs={currentDayTs()}
          currentTimeOffset={currentTimeOffset()}
          isCurrentDayVisible={isCurrentDayVisible()}
          onEventClick={props.onEventClick}
        />
      </Show>
      <Show when={props.viewMode === "month"}>
        <MonthGrid
          anchor={props.anchor}
          rangeStart={rangeStart()}
          rangeEnd={rangeEnd()}
          eventsByDay={eventsByDay()}
          onEventClick={props.onEventClick}
          onDateClick={(ts) => {
            props.onAnchorChange?.(ts)
          }}
        />
      </Show>
    </div>
  )
}

function NavBar(props: {
  title: string
  viewMode: ViewMode
  onToday: () => void
  onPrev: () => void
  onNext: () => void
  onViewModeChange?: (mode: ViewMode) => void
}) {
  const { i18n } = useLocale()
  const modes: ViewMode[] = ["list", "day", "week", "month"]
  const labels: Record<ViewMode, () => string> = {
    list: () => i18n._({ id: "app.agenda.calendar.list", message: "List" }),
    day: () => i18n._(A.calendarDay),
    week: () => i18n._(A.calendarWeek),
    month: () => i18n._(A.calendarMonth),
  }

  return (
    <div class="agenda-calendar-frame agenda-calendar-toolbar flex shrink-0 items-center gap-2 px-3.5 py-3">
      <button
        type="button"
        class="workbench-control-surface rounded-full bg-surface-raised-base px-2.5 py-1 app-panel-caption font-medium text-text-strong transition-colors hover:bg-surface-raised-base-hover"
        onClick={props.onToday}
      >
        {i18n._(A.calendarToday)}
      </button>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-full text-text-weak transition-colors hover:bg-surface-raised-base-hover"
        aria-label={i18n._({ id: "app.agenda.calendar.previous", message: "Previous date range" })}
        onClick={props.onPrev}
      >
        ‹
      </button>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-full text-text-weak transition-colors hover:bg-surface-raised-base-hover"
        aria-label={i18n._({ id: "app.agenda.calendar.next", message: "Next date range" })}
        onClick={props.onNext}
      >
        ›
      </button>
      <span class="min-w-max flex-1 whitespace-nowrap app-panel-control text-text-strong">{props.title}</span>
      <AppPanel.Selection
        label={i18n._({ id: "app.agenda.calendar.views", message: "Calendar view" })}
        items={modes.map((mode) => ({ id: mode, label: labels[mode]() }))}
        active={props.viewMode}
        onChange={(mode) => props.onViewModeChange?.(mode as ViewMode)}
      />
    </div>
  )
}

function TimeGrid(props: {
  ref: (el: HTMLDivElement) => void
  columns: { ts: number; label: string; day: number; isToday: boolean }[]
  eventsByDay: Map<number, CalendarEvent[]>
  currentTimeDayTs: number
  currentTimeOffset: number
  isCurrentDayVisible: boolean
  onEventClick?: (event: CalendarEvent, e: MouseEvent) => void
}) {
  const layouts = createMemo(
    () => new Map(props.columns.map((col) => [col.ts, layoutOverlapping(props.eventsByDay.get(col.ts) ?? [])])),
  )
  const columnWidths = createMemo(() =>
    props.columns.map((col) => Math.max(120, ...(layouts().get(col.ts) ?? []).map((le) => le.totalCols * 96))),
  )
  const colTemplate = () =>
    `${TIME_COL}px ${columnWidths()
      .map((width) => `minmax(${width}px, 1fr)`)
      .join(" ")}`

  return (
    <div class="agenda-calendar-frame agenda-calendar-body flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={props.ref}
        class="agenda-grid-scroll flex-1 min-h-0 overflow-auto"
        style={{ "scroll-padding-top": props.columns.length > 1 ? "56px" : undefined }}
      >
        <div style={{ "min-width": `${TIME_COL + columnWidths().reduce((sum, width) => sum + width, 0)}px` }}>
          <Show when={props.columns.length > 1}>
            <div
              class="agenda-time-header grid shrink-0 bg-transparent"
              style={{ "grid-template-columns": colTemplate() }}
            >
              <div />
              <For each={props.columns}>
                {(col) => (
                  <div
                    classList={{
                      "agenda-day-header-cell flex flex-col items-center py-1.5 text-center": true,
                      "text-text-strong": col.isToday,
                    }}
                  >
                    <span class="app-panel-caption font-medium text-text-weaker">{col.label}</span>
                    <span
                      classList={{
                        "app-panel-caption font-medium w-6 h-6 flex items-center justify-center rounded-full": true,
                        "bg-text-strong text-background-base ring-1 ring-border-weaker-selected": col.isToday,
                        "text-text-strong": !col.isToday,
                      }}
                    >
                      {col.day}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div
            class="agenda-grid-surface relative grid"
            style={{ "grid-template-columns": colTemplate(), height: `${24 * HOUR_HEIGHT + EVENT_HEIGHT}px` }}
          >
            <div class="relative">
              <For each={HOURS}>
                {(h) => (
                  <div
                    class="agenda-time-label absolute app-panel-caption font-medium text-text-weaker leading-none"
                    style={{ top: `${h * HOUR_HEIGHT}px` }}
                  >
                    {h > 0 ? formatHour(h) : ""}
                  </div>
                )}
              </For>
            </div>

            <For each={props.columns}>
              {(col) => {
                const laid = () => layouts().get(col.ts) ?? []
                return (
                  <div class="agenda-day-column relative">
                    <For each={HOURS}>
                      {(h) => (
                        <div
                          class="agenda-hour-line absolute left-0 right-0"
                          style={{ top: `${h * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px` }}
                        />
                      )}
                    </For>

                    <For each={laid()}>
                      {(le) => {
                        const top = eventTop(le.event.time, col.ts)
                        const classes = TIME_EVENT_CLASSES[le.event.status] ?? TIME_EVENT_CLASSES.active
                        const widthPct = 100 / le.totalCols
                        const leftPct = le.col * widthPct
                        return (
                          <div
                            class="absolute"
                            style={{
                              top: `${top}px`,
                              height: `${EVENT_HEIGHT}px`,
                              left: `calc(${leftPct}% + 2px)`,
                              width: `calc(${widthPct}% - 4px)`,
                            }}
                          >
                            <Tooltip
                              class="h-full"
                              value={
                                <div>
                                  {le.event.title}
                                  <br />
                                  {formatEventTime(le.event.time)}
                                </div>
                              }
                            >
                              <button
                                type="button"
                                class={`agenda-time-event focus-visible:outline-2 focus-visible:outline-border-interactive-focus cursor-pointer rounded-md transition-opacity hover:opacity-90 ${classes}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  props.onEventClick?.(le.event, e)
                                }}
                              >
                                <span class="agenda-time-event-title app-panel-row-title text-text-strong">
                                  {le.event.title}
                                </span>
                                <time
                                  class="app-panel-caption text-text-weak"
                                  dateTime={new Date(le.event.time).toISOString()}
                                >
                                  {formatEventTime(le.event.time)}
                                </time>
                              </button>
                            </Tooltip>
                          </div>
                        )
                      }}
                    </For>
                    <Show when={props.isCurrentDayVisible && col.ts === props.currentTimeDayTs}>
                      <div
                        class="absolute z-10 pointer-events-none flex items-center left-0 right-0"
                        style={{ top: `${props.currentTimeOffset}px` }}
                      >
                        <div class="w-2 h-2 rounded-full bg-text-diff-delete-base -ml-1 shrink-0" />
                        <div class="flex-1 h-[1.5px] bg-text-diff-delete-base" />
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}

function MonthGrid(props: {
  anchor: number
  rangeStart: number
  rangeEnd: number
  eventsByDay: Map<number, CalendarEvent[]>
  onEventClick?: (event: CalendarEvent, e: MouseEvent) => void
  onDateClick?: (ts: number) => void
}) {
  const { i18n, fmt } = useLocale()
  const today = createMemo(() => startOfDay(Date.now()))
  const anchorMonth = createMemo(() => new Date(props.anchor).getMonth())
  const dayLabels = createMemo(() => getDayLabelsShort(fmt))
  const weeks = createMemo(() => {
    const result: { ts: number; day: number; isCurrentMonth: boolean; isToday: boolean }[][] = []
    let cursor = props.rangeStart
    while (cursor < props.rangeEnd) {
      const week: (typeof result)[number] = []
      for (let d = 0; d < 7; d++) {
        const date = new Date(cursor)
        week.push({
          ts: cursor,
          day: date.getDate(),
          isCurrentMonth: date.getMonth() === anchorMonth(),
          isToday: cursor === today(),
        })
        cursor = addDays(cursor, 1)
      }
      result.push(week)
    }
    return result
  })

  return (
    <div class="agenda-calendar-frame agenda-calendar-body min-h-0 flex-1 overflow-y-auto">
      <div class="agenda-month-header grid grid-cols-7 bg-transparent">
        <For each={dayLabels()}>
          {(label) => <div class="py-2.5 text-center app-panel-caption font-medium text-text-weaker">{label}</div>}
        </For>
      </div>
      <div class="agenda-grid-surface grid grid-cols-7">
        <For each={weeks()}>
          {(week) => (
            <For each={week}>
              {(cell) => {
                const events = createMemo(() => props.eventsByDay.get(cell.ts) ?? [])
                const visible = createMemo(() => events().slice(0, MONTH_MAX_EVENTS))
                const overflow = createMemo(() => Math.max(0, events().length - MONTH_MAX_EVENTS))
                return (
                  <div class="agenda-month-cell min-h-[118px] cursor-pointer px-2 py-1.5 transition-colors hover:bg-surface-raised-base-hover">
                    <button
                      type="button"
                      aria-label={fmt.date(cell.ts, { dateStyle: "full" })}
                      aria-pressed={cell.ts === startOfDay(props.anchor)}
                      aria-current={cell.isToday ? "date" : undefined}
                      tabindex={cell.ts === startOfDay(props.anchor) ? 0 : -1}
                      data-date={cell.ts}
                      onKeyDown={(event) => {
                        const next = calendarKeyDate(cell.ts, event.key, event.shiftKey)
                        if (next === undefined) return
                        event.preventDefault()
                        props.onDateClick?.(next)
                        requestAnimationFrame(() =>
                          document
                            .querySelector<HTMLButtonElement>(`.agenda-month-cell [data-date="${next}"]`)
                            ?.focus(),
                        )
                      }}
                      onClick={() => props.onDateClick?.(cell.ts)}
                      classList={{
                        "mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full app-panel-caption font-medium": true,
                        "bg-text-strong text-background-base ring-1 ring-border-weaker-selected": cell.isToday,
                        "text-text-strong": !cell.isToday && cell.isCurrentMonth,
                        "text-text-weak": !cell.isToday && !cell.isCurrentMonth,
                      }}
                    >
                      {cell.day}
                    </button>
                    <span class="agenda-month-count app-panel-caption" aria-hidden="true">
                      {events().length || ""}
                    </span>
                    <div class="agenda-month-events flex flex-col gap-0.5">
                      <For each={visible()}>
                        {(event) => (
                          <button
                            type="button"
                            class="text-left focus-visible:outline-2 focus-visible:outline-border-interactive-focus flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface-raised-base-hover"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onEventClick?.(event, e)
                            }}
                          >
                            <div
                              class={`w-1 h-1 rounded-full shrink-0 ${MONTH_DOT_CLASSES[event.status] ?? MONTH_DOT_CLASSES.active}`}
                            />
                            <span class="shrink-0 app-panel-caption text-text-weaker">
                              {formatEventTime(event.time)}
                            </span>
                            <span class="truncate app-panel-caption text-text-weak">{event.title}</span>
                          </button>
                        )}
                      </For>
                      <Show when={overflow() > 0}>
                        <button
                          type="button"
                          class="text-left px-0.5 app-panel-caption text-text-weaker"
                          onClick={() => props.onDateClick?.(cell.ts)}
                        >
                          {i18n._({ ...A.calendarMore, values: { count: overflow() } })}
                        </button>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          )}
        </For>
      </div>
      <section class="agenda-month-day-list">
        <h3 class="app-panel-section-title text-text-strong">{fmt.date(props.anchor, { dateStyle: "full" })}</h3>
        <p class="app-panel-caption text-text-weak">
          {i18n._({ id: "app.agenda.calendar.planned", message: "Planned executions" })}
        </p>
        <For each={props.eventsByDay.get(startOfDay(props.anchor)) ?? []}>
          {(event) => (
            <button
              type="button"
              class="agenda-month-day-event"
              aria-haspopup="dialog"
              onClick={(mouse) => props.onEventClick?.(event, mouse)}
            >
              <time class="app-panel-caption text-text-weak">{formatEventTime(event.time)}</time>
              <span class="app-panel-row-title text-text-strong">{event.title}</span>
            </button>
          )}
        </For>
        <Show when={!props.eventsByDay.get(startOfDay(props.anchor))?.length}>
          <p class="app-panel-caption text-text-weak">
            {i18n._({ id: "app.agenda.calendar.dayEmpty", message: "No planned executions on this date" })}
          </p>
        </Show>
      </section>
    </div>
  )
}
