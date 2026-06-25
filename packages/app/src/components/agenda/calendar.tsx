import { createEffect, createMemo, createSignal, For, onCleanup, Show, onMount } from "solid-js"
import type { CalendarEvent } from "./expand"
import {
  startOfDay,
  startOfWeek,
  addDays,
  addMonths,
  monthRange,
  formatHour,
  MONTH_NAMES_SHORT,
  DAY_LABELS_SHORT,
} from "./date"

export type ViewMode = "day" | "week" | "month"

const HOUR_HEIGHT = 58
const TIME_COL = 48
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const EVENT_DURATION_MS = 30 * 60_000
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
    ends[placed] = ev.time + EVENT_DURATION_MS
    cols.push(placed)
  }

  const groups: { start: number; end: number; indices: number[] }[] = []
  for (let i = 0; i < sorted.length; i++) {
    const evStart = sorted[i].time
    const evEnd = evStart + EVENT_DURATION_MS
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
  onViewModeChange?: (mode: ViewMode) => void
  onAnchorChange?: (anchor: number) => void
  onEventClick?: (event: CalendarEvent, e: MouseEvent) => void
  onRangeChange?: (start: number, end: number) => void
}

function formatDayHeader(ts: number): { label: string; day: number; isToday: boolean } {
  const d = new Date(ts)
  const now = new Date()
  return {
    label: DAY_LABELS_SHORT[d.getDay()],
    day: d.getDate(),
    isToday: d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(),
  }
}

function formatDateRange(weekStart: number): string {
  const s = new Date(weekStart)
  const e = new Date(addDays(weekStart, 6))
  if (s.getMonth() === e.getMonth()) return `${MONTH_NAMES_SHORT[s.getMonth()]} ${s.getDate()} – ${e.getDate()}`
  return `${MONTH_NAMES_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTH_NAMES_SHORT[e.getMonth()]} ${e.getDate()}`
}

function formatEventTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
}

function eventTop(ts: number, dayStart: number): number {
  return ((ts - dayStart) / 3_600_000) * HOUR_HEIGHT
}

function eventHeight(): number {
  return (EVENT_DURATION_MS / 3_600_000) * HOUR_HEIGHT
}

const TIME_EVENT_COLORS: Record<string, string> = {
  active:
    "bg-surface-raised-base border border-border-base/45 border-l-text-strong shadow-[inset_0_1px_0_rgba(214,204,190,0.08)]",
  paused: "bg-icon-warning-base/18 border border-icon-warning-base/15 border-l-icon-warning-base",
  pending: "bg-surface-inset-base border border-border-base/38 border-l-text-weaker",
  done: "bg-surface-inset-base/88 border border-border-base/35 border-l-text-weaker",
  cancelled: "bg-text-diff-delete-base/12 border border-text-diff-delete-base/10 border-l-text-diff-delete-base",
}

const MONTH_DOT_COLORS: Record<string, string> = {
  active: "bg-icon-success-base",
  paused: "bg-icon-warning-base",
  pending: "bg-text-weaker",
  done: "bg-text-weaker",
  cancelled: "bg-text-diff-delete-base",
}

export function CalendarGrid(props: CalendarGridProps) {
  let scrollRef: HTMLDivElement | undefined

  const weekStart = createMemo(() => startOfWeek(props.anchor))
  const dayStart = createMemo(() => startOfDay(props.anchor))

  const rangeStart = createMemo(() => {
    if (props.viewMode === "month") return monthRange(props.anchor).start
    return props.viewMode === "week" ? weekStart() : dayStart()
  })
  const rangeEnd = createMemo(() => {
    if (props.viewMode === "month") return monthRange(props.anchor).end
    return addDays(rangeStart(), props.viewMode === "week" ? 7 : 1)
  })

  createEffect(() => {
    props.onRangeChange?.(rangeStart(), rangeEnd())
  })

  const dayColumns = createMemo(() => {
    const count = props.viewMode === "week" ? 7 : 1
    const start = props.viewMode === "week" ? weekStart() : dayStart()
    return Array.from({ length: count }, (_, i) => {
      const ts = addDays(start, i)
      return { ts, ...formatDayHeader(ts) }
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
    else props.onAnchorChange?.(addDays(props.anchor, props.viewMode === "week" ? -7 : -1))
  }
  function goNext() {
    if (props.viewMode === "month") props.onAnchorChange?.(addMonths(props.anchor, 1))
    else props.onAnchorChange?.(addDays(props.anchor, props.viewMode === "week" ? 7 : 1))
  }

  function navTitle(): string {
    if (props.viewMode === "month") {
      const d = new Date(props.anchor)
      return `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getFullYear()}`
    }
    if (props.viewMode === "week") return formatDateRange(weekStart())
    const d = new Date(dayStart())
    return `${DAY_LABELS_SHORT[d.getDay()]}, ${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
  }

  onMount(() => {
    if (scrollRef) {
      const targetHour = Math.max(0, new Date().getHours() - 2)
      scrollRef.scrollTop = targetHour * HOUR_HEIGHT
    }
  })

  return (
    <div classList={{ "flex flex-col flex-1 min-h-0": true, "min-h-[760px]": props.viewMode === "month" }}>
      <NavBar
        title={navTitle()}
        viewMode={props.viewMode}
        onToday={goToday}
        onPrev={goPrev}
        onNext={goNext}
        onViewModeChange={props.onViewModeChange}
      />
      <Show when={props.viewMode !== "month"}>
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
            props.onViewModeChange?.("day")
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
  const modes: ViewMode[] = ["day", "week", "month"]
  const labels: Record<ViewMode, string> = { day: "Day", week: "Week", month: "Month" }

  return (
    <div class="flex shrink-0 items-center gap-2 rounded-xl bg-surface-inset-base px-3.5 py-3 ring-1 ring-inset ring-border-base/45">
      <button
        type="button"
        class="rounded-full bg-surface-raised-base px-2.5 py-1 text-10-medium text-text-strong ring-1 ring-inset ring-border-base/55 transition-colors hover:bg-surface-raised-base-hover"
        onClick={props.onToday}
      >
        Today
      </button>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-full text-text-weak transition-colors hover:bg-surface-raised-base-hover"
        onClick={props.onPrev}
      >
        ‹
      </button>
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-full text-text-weak transition-colors hover:bg-surface-raised-base-hover"
        onClick={props.onNext}
      >
        ›
      </button>
      <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{props.title}</span>
      <div class="flex items-center overflow-hidden rounded-lg bg-surface-raised-base p-0.75 ring-1 ring-inset ring-border-base/45">
        <For each={modes}>
          {(mode) => (
            <button
              type="button"
              classList={{
                "px-2.5 py-1 rounded-md text-11-medium transition-all": true,
                "bg-text-strong text-background-base": props.viewMode === mode,
                "text-text-weaker hover:text-text-weak": props.viewMode !== mode,
              }}
              onClick={() => props.onViewModeChange?.(mode)}
            >
              {labels[mode]}
            </button>
          )}
        </For>
      </div>
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
  const colTemplate = () => `${TIME_COL}px repeat(${props.columns.length}, 1fr)`

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface-raised-base ring-1 ring-inset ring-border-base/45">
      <Show when={props.columns.length > 1}>
        <div
          class="grid shrink-0 border-b border-border-weaker-base/45 bg-surface-inset-base"
          style={{ "grid-template-columns": colTemplate() }}
        >
          <div />
          <For each={props.columns}>
            {(col) => (
              <div
                classList={{
                  "flex flex-col items-center py-1.5 text-center": true,
                  "text-text-strong": col.isToday,
                }}
              >
                <span class="text-10-medium text-text-weaker">{col.label}</span>
                <span
                  classList={{
                    "text-12-medium w-6 h-6 flex items-center justify-center rounded-full": true,
                    "bg-text-strong text-background-base ring-1 ring-white/12": col.isToday,
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

      <div ref={props.ref} class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden rounded-b-[1.15rem]">
        <div
          class="relative grid bg-surface-raised-stronger-non-alpha"
          style={{ "grid-template-columns": colTemplate(), height: `${24 * HOUR_HEIGHT}px` }}
        >
          <div class="relative">
            <For each={HOURS}>
              {(h) => (
                <div
                  class="absolute right-1.5 text-10-medium text-text-weaker leading-none -translate-y-1/2"
                  style={{ top: `${h * HOUR_HEIGHT}px` }}
                >
                  {h > 0 ? formatHour(h) : ""}
                </div>
              )}
            </For>
          </div>

          <For each={props.columns}>
            {(col) => {
              const laid = createMemo(() => layoutOverlapping(props.eventsByDay.get(col.ts) ?? []))
              return (
                <div class="relative border-l border-border-weaker-base/24 first:border-l-0">
                  <For each={HOURS}>
                    {(h) => (
                      <div
                        class="absolute left-0 right-0 border-t border-border-weaker-base/20"
                        style={{ top: `${h * HOUR_HEIGHT}px`, height: `${HOUR_HEIGHT}px` }}
                      />
                    )}
                  </For>

                  <For each={laid()}>
                    {(le) => {
                      const top = eventTop(le.event.time, col.ts)
                      const height = eventHeight()
                      const colors = TIME_EVENT_COLORS[le.event.status] ?? TIME_EVENT_COLORS.active
                      const widthPct = 100 / le.totalCols
                      const leftPct = le.col * widthPct
                      return (
                        <div
                          class={`absolute cursor-pointer overflow-hidden rounded-md border-l-2 px-1.5 py-1 transition-opacity hover:opacity-90 ${colors}`}
                          style={{
                            top: `${top}px`,
                            height: `${Math.max(height, 18)}px`,
                            left: `calc(${leftPct}% + 2px)`,
                            width: `calc(${widthPct}% - 4px)`,
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onEventClick?.(le.event, e)
                          }}
                          title={`${le.event.title}\n${formatEventTime(le.event.time)}`}
                        >
                          <div class="text-10-medium text-text-strong truncate leading-tight">{le.event.title}</div>
                          <Show when={height >= 26}>
                            <div class="text-9 text-text-weak truncate leading-tight">
                              {formatEventTime(le.event.time)}
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              )
            }}
          </For>

          <Show when={props.isCurrentDayVisible}>
            <div
              class="absolute z-10 pointer-events-none flex items-center"
              style={{
                top: `${props.currentTimeOffset}px`,
                left: `calc(${TIME_COL}px + ((100% - ${TIME_COL}px) / ${props.columns.length}) * ${props.columns.findIndex((col) => col.ts === props.currentTimeDayTs)})`,
                width: `calc((100% - ${TIME_COL}px) / ${props.columns.length})`,
              }}
            >
              <div class="w-2 h-2 rounded-full bg-text-diff-delete-base -ml-1 shrink-0" />
              <div class="flex-1 h-[1.5px] bg-text-diff-delete-base" />
            </div>
          </Show>
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
  const today = createMemo(() => startOfDay(Date.now()))
  const anchorMonth = createMemo(() => new Date(props.anchor).getMonth())

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
    <div class="min-h-0 flex-1 overflow-y-auto rounded-xl bg-surface-raised-base ring-1 ring-inset ring-border-base/45">
      <div class="grid grid-cols-7 border-b border-border-weaker-base/45 bg-surface-inset-base">
        <For each={DAY_LABELS_SHORT}>
          {(label) => <div class="py-2.5 text-center text-11-medium text-text-weaker">{label}</div>}
        </For>
      </div>
      <div class="grid grid-cols-7 bg-surface-raised-stronger-non-alpha">
        <For each={weeks()}>
          {(week) => (
            <For each={week}>
              {(cell) => {
                const events = createMemo(() => props.eventsByDay.get(cell.ts) ?? [])
                const visible = createMemo(() => events().slice(0, MONTH_MAX_EVENTS))
                const overflow = createMemo(() => Math.max(0, events().length - MONTH_MAX_EVENTS))
                return (
                  <div
                    class="min-h-[118px] cursor-pointer border-b border-r border-border-weaker-base/20 px-2 py-1.5 transition-colors hover:bg-surface-raised-base-hover/30"
                    onClick={() => props.onDateClick?.(cell.ts)}
                  >
                    <span
                      classList={{
                        "mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-12-medium": true,
                        "bg-text-strong text-background-base ring-1 ring-white/12": cell.isToday,
                        "text-text-strong": !cell.isToday && cell.isCurrentMonth,
                        "text-text-weaker/40": !cell.isToday && !cell.isCurrentMonth,
                      }}
                    >
                      {cell.day}
                    </span>
                    <div class="flex flex-col gap-0.5">
                      <For each={visible()}>
                        {(event) => (
                          <div
                            class="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface-raised-base-hover"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onEventClick?.(event, e)
                            }}
                          >
                            <div
                              class={`w-1 h-1 rounded-full shrink-0 ${MONTH_DOT_COLORS[event.status] ?? MONTH_DOT_COLORS.active}`}
                            />
                            <span class="shrink-0 text-10-regular text-text-weaker">{formatEventTime(event.time)}</span>
                            <span class="truncate text-10-regular text-text-weak">{event.title}</span>
                          </div>
                        )}
                      </For>
                      <Show when={overflow() > 0}>
                        <span class="px-0.5 text-10-regular text-text-weaker">+{overflow()} more</span>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          )}
        </For>
      </div>
    </div>
  )
}
