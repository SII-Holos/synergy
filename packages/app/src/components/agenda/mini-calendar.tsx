import { createEffect, createMemo, createSignal, For } from "solid-js"
import { startOfDay, startOfWeek, addDays, addMonths, MONTH_NAMES_SHORT, DAY_LABELS_MINI } from "./date"

import type { ViewMode } from "./calendar"

interface MiniCalendarProps {
  anchor: number
  viewMode: ViewMode
  onDateClick?: (date: number) => void
}

export function MiniCalendar(props: MiniCalendarProps) {
  const [displayMonth, setDisplayMonth] = createSignal(startOfDay(props.anchor))

  createEffect(() => {
    setDisplayMonth(startOfDay(props.anchor))
  })

  const headerLabel = createMemo(() => {
    const d = new Date(displayMonth())
    return `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getFullYear()}`
  })

  const today = createMemo(() => startOfDay(Date.now()))

  const anchorDay = createMemo(() => startOfDay(props.anchor))

  const anchorWeekStart = createMemo(() => startOfWeek(props.anchor))

  const gridDays = createMemo(() => {
    const d = new Date(displayMonth())
    const first = new Date(d.getFullYear(), d.getMonth(), 1)
    first.setHours(0, 0, 0, 0)
    const gridStart = startOfWeek(first.getTime())
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    last.setHours(0, 0, 0, 0)
    const gridEnd = addDays(startOfWeek(last.getTime()), 7)
    const days: number[] = []
    let cur = gridStart
    while (cur < gridEnd) {
      days.push(cur)
      cur = addDays(cur, 1)
    }
    return days
  })

  const gridWeeks = createMemo(() => {
    const days = gridDays()
    const weeks: number[][] = []
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7))
    }
    return weeks
  })

  const currentMonth = createMemo(() => new Date(displayMonth()).getMonth())

  function prevMonth() {
    setDisplayMonth((m) => addMonths(m, -1))
  }

  function nextMonth() {
    setDisplayMonth((m) => addMonths(m, 1))
  }

  function isInAnchorWeek(ts: number): boolean {
    return props.viewMode === "week" && ts >= anchorWeekStart() && ts < addDays(anchorWeekStart(), 7)
  }

  function cellClass(ts: number): string {
    const isToday = ts === today()
    const isCurrentMonth = new Date(ts).getMonth() === currentMonth()
    const isAnchorDay = ts === anchorDay() && props.viewMode === "day"
    const inWeek = isInAnchorWeek(ts)

    if (isToday) {
      return "bg-surface-interactive-solid text-text-on-interactive-base ring-1 ring-border-interactive-base/35 shadow-[0_2px_8px_rgba(56,88,182,0.16)]"
    }
    if (isAnchorDay) {
      return "bg-surface-interactive-selected text-text-interactive-base ring-1 ring-inset ring-border-interactive-base/30"
    }

    const base = isCurrentMonth ? "text-text-base" : "text-text-weaker/40"
    if (inWeek) {
      return `bg-surface-interactive-selected-weak/85 ${base}`
    }
    return `${base} hover:bg-surface-raised-base-hover/70`
  }

  function weekRowClass(ts: number): string {
    return isInAnchorWeek(ts)
      ? "rounded-[0.9rem] bg-surface-inset-base/55 ring-1 ring-inset ring-border-interactive-base/12 shadow-[inset_0_1px_0_rgba(214,204,190,0.05)]"
      : ""
  }

  return (
    <div class="flex flex-col gap-2 select-none min-w-[224px]">
      <div class="flex items-center justify-between px-0.5">
        <span class="text-11-medium text-text-strong">{headerLabel()}</span>
        <div class="flex items-center gap-1 rounded-full bg-surface-raised-base/92 p-0.5 ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
          <button
            type="button"
            class="size-5 flex items-center justify-center rounded-full text-text-weaker hover:text-text-weak hover:bg-surface-raised-base-hover transition-colors"
            onClick={prevMonth}
          >
            ‹
          </button>
          <button
            type="button"
            class="size-5 flex items-center justify-center rounded-full text-text-weaker hover:text-text-weak hover:bg-surface-raised-base-hover transition-colors"
            onClick={nextMonth}
          >
            ›
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-1.5 rounded-[1rem] bg-surface-raised-base/92 p-2 ring-1 ring-inset ring-border-base/42 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
        <div class="grid grid-cols-7">
          <For each={DAY_LABELS_MINI}>
            {(label) => (
              <div class="w-7 h-6 flex items-center justify-center text-10-medium text-text-weaker">{label}</div>
            )}
          </For>
        </div>

        <For each={gridWeeks()}>
          {(week) => (
            <div class={`grid grid-cols-7 gap-0.5 px-0.5 py-0.5 ${weekRowClass(week[0])}`}>
              <For each={week}>
                {(ts) => (
                  <button
                    type="button"
                    class={`w-7 h-7 flex items-center justify-center rounded-full text-[11px] leading-none transition-colors ${cellClass(ts)}`}
                    onClick={() => props.onDateClick?.(ts)}
                  >
                    {new Date(ts).getDate()}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
