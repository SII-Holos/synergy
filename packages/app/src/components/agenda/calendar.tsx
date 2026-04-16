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

const HOUR_HEIGHT = 52
const TIME_COL = 48
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const EVENT_DURATION_MS = 30 * 60_000
const MONTH_MAX_EVENTS = 3

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
  onEventClick?: (event: CalendarEvent) => void
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
  active: "bg-surface-interactive-base/80 border-l-icon-interactive-base",
  paused: "bg-icon-warning-base/20 border-l-icon-warning-base",
  pending: "bg-surface-interactive-base/30 border-l-surface-interactive-base",
  done: "bg-surface-inset-base border-l-text-weaker",
  cancelled: "bg-text-diff-delete-base/15 border-l-text-diff-delete-base",
}

const MONTH_DOT_COLORS: Record<string, string> = {
  active: "bg-icon-success-base",
  paused: "bg-icon-warning-base",
  pending: "bg-surface-interactive-base",
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
    <div class="flex flex-col flex-1 min-h-0">
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
    <div class="flex items-center gap-1.5 px-3 py-2 border-b border-border-weaker-base/50 shrink-0">
      <button
        type="button"
        class="px-2 py-0.5 rounded-md text-10-medium text-text-interactive-base bg-surface-interactive-base/10 hover:bg-surface-interactive-base/20 transition-colors"
        onClick={props.onToday}
      >
        Today
      </button>
      <button
        type="button"
        class="px-1 py-0.5 rounded text-text-weak hover:bg-surface-raised-base-hover transition-colors"
        onClick={props.onPrev}
      >
        ‹
      </button>
      <button
        type="button"
        class="px-1 py-0.5 rounded text-text-weak hover:bg-surface-raised-base-hover transition-colors"
        onClick={props.onNext}
      >
        ›
      </button>
      <span class="text-11-medium text-text-strong flex-1 min-w-0 truncate">{props.title}</span>
      <div class="flex items-center rounded-md bg-surface-inset-base overflow-hidden">
        <For each={modes}>
          {(mode) => (
            <button
              type="button"
              classList={{
                "px-2 py-0.5 text-10-medium transition-colors": true,
                "bg-surface-interactive-base/15 text-text-interactive-base": props.viewMode === mode,
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
  onEventClick?: (event: CalendarEvent) => void
}) {
  const colTemplate = () => `${TIME_COL}px repeat(${props.columns.length}, 1fr)`

  return (
    <>
      <Show when={props.columns.length > 1}>
        <div
          class="grid shrink-0 border-b border-border-weaker-base/50"
          style={{ "grid-template-columns": colTemplate() }}
        >
          <div />
          <For each={props.columns}>
            {(col) => (
              <div
                classList={{
                  "flex flex-col items-center py-1.5 text-center": true,
                  "text-text-interactive-base": col.isToday,
                }}
              >
                <span class="text-10-medium text-text-weaker">{col.label}</span>
                <span
                  classList={{
                    "text-12-medium w-6 h-6 flex items-center justify-center rounded-full": true,
                    "bg-surface-interactive-base text-text-on-interactive-base": col.isToday,
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

      <div ref={props.ref} class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div class="grid relative" style={{ "grid-template-columns": colTemplate(), height: `${24 * HOUR_HEIGHT}px` }}>
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
                <div class="relative border-l border-border-weaker-base/30">
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
                          class={`absolute rounded-sm border-l-2 px-1 py-0.5 cursor-pointer overflow-hidden transition-opacity hover:opacity-90 ${colors}`}
                          style={{
                            top: `${top}px`,
                            height: `${Math.max(height, 18)}px`,
                            left: `calc(${leftPct}% + 2px)`,
                            width: `calc(${widthPct}% - 4px)`,
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onEventClick?.(le.event)
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
    </>
  )
}

function MonthGrid(props: {
  anchor: number
  rangeStart: number
  rangeEnd: number
  eventsByDay: Map<number, CalendarEvent[]>
  onEventClick?: (event: CalendarEvent) => void
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
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="grid grid-cols-7 border-b border-border-weaker-base/50">
        <For each={DAY_LABELS_SHORT}>
          {(label) => <div class="py-1.5 text-center text-10-medium text-text-weaker">{label}</div>}
        </For>
      </div>
      <div class="grid grid-cols-7">
        <For each={weeks()}>
          {(week) => (
            <For each={week}>
              {(cell) => {
                const events = createMemo(() => props.eventsByDay.get(cell.ts) ?? [])
                const visible = createMemo(() => events().slice(0, MONTH_MAX_EVENTS))
                const overflow = createMemo(() => Math.max(0, events().length - MONTH_MAX_EVENTS))
                return (
                  <div
                    class="min-h-[72px] border-b border-r border-border-weaker-base/20 px-1 py-0.5 cursor-pointer hover:bg-surface-raised-base-hover/30 transition-colors"
                    onClick={() => props.onDateClick?.(cell.ts)}
                  >
                    <span
                      classList={{
                        "inline-flex items-center justify-center text-11-medium w-5 h-5 rounded-full mb-0.5": true,
                        "bg-surface-interactive-base text-text-on-interactive-base": cell.isToday,
                        "text-text-strong": !cell.isToday && cell.isCurrentMonth,
                        "text-text-weaker/40": !cell.isToday && !cell.isCurrentMonth,
                      }}
                    >
                      {cell.day}
                    </span>
                    <div class="flex flex-col gap-px">
                      <For each={visible()}>
                        {(event) => (
                          <div
                            class="flex items-center gap-1 min-w-0 rounded px-0.5 hover:bg-surface-interactive-base/10 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onEventClick?.(event)
                            }}
                          >
                            <div
                              class={`w-1 h-1 rounded-full shrink-0 ${MONTH_DOT_COLORS[event.status] ?? MONTH_DOT_COLORS.active}`}
                            />
                            <span class="text-[9px] text-text-weaker shrink-0">{formatEventTime(event.time)}</span>
                            <span class="text-[9px] text-text-weak truncate">{event.title}</span>
                          </div>
                        )}
                      </For>
                      <Show when={overflow() > 0}>
                        <span class="text-[9px] text-text-weaker px-0.5">+{overflow()} more</span>
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
