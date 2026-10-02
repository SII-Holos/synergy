import { calendarKeyDate } from "./calendar-navigation"
import { createEffect, createMemo, createSignal, For } from "solid-js"
import { startOfDay, startOfWeek, addDays, addMonths, getMonthNamesShort, getDayLabelsMini } from "./date"
import { useLocale } from "@/context/locale"

interface MiniCalendarProps {
  anchor: number
  onDateClick?: (date: number) => void
  onDateNavigate?: (date: number) => void
}

export function MiniCalendar(props: MiniCalendarProps) {
  const { fmt, i18n } = useLocale()
  const [displayMonth, setDisplayMonth] = createSignal(startOfDay(props.anchor))

  const monthNames = createMemo(() => getMonthNamesShort(fmt))
  const dayLabels = createMemo(() => getDayLabelsMini(fmt))

  createEffect(() => {
    setDisplayMonth(startOfDay(props.anchor))
  })

  const headerLabel = createMemo(() => {
    const d = new Date(displayMonth())
    return `${monthNames()[d.getMonth()]} ${d.getFullYear()}`
  })

  const today = createMemo(() => startOfDay(Date.now()))

  const anchorDay = createMemo(() => startOfDay(props.anchor))

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

  const rovingDay = createMemo(() => (gridDays().includes(anchorDay()) ? anchorDay() : displayMonth()))

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

  function cellClass(ts: number): string {
    const isToday = ts === today()
    const isCurrentMonth = new Date(ts).getMonth() === currentMonth()
    const isAnchorDay = ts === anchorDay()

    if (isToday) {
      return "bg-text-strong text-background-base ring-1 ring-border-weaker-selected"
    }
    if (isAnchorDay) {
      return "workbench-selected-surface text-text-strong"
    }

    const base = isCurrentMonth ? "text-text-base" : "text-text-weak"
    return `${base} hover:bg-surface-raised-base-hover`
  }

  return (
    <div class="flex min-w-[304px] select-none flex-col gap-3">
      <div class="flex items-center justify-between px-0.5">
        <span class="app-panel-control text-text-strong">{headerLabel()}</span>
        <div class="flex items-center gap-1 rounded-full bg-surface-raised-base p-0.5">
          <button
            type="button"
            class="agenda-calendar-navigation flex size-8 items-center justify-center rounded-lg text-text-weaker transition-colors hover:bg-surface-raised-base-hover hover:text-text-weak"
            aria-label={i18n._({ id: "app.agenda.calendar.previousMonth", message: "Previous month" })}
            onClick={prevMonth}
          >
            ‹
          </button>
          <button
            type="button"
            class="agenda-calendar-navigation flex size-8 items-center justify-center rounded-lg text-text-weaker transition-colors hover:bg-surface-raised-base-hover hover:text-text-weak"
            aria-label={i18n._({ id: "app.agenda.calendar.nextMonth", message: "Next month" })}
            onClick={nextMonth}
          >
            ›
          </button>
        </div>
      </div>

      <div class="agenda-inner-surface flex flex-col gap-1.5 p-2.5">
        <div class="grid grid-cols-7">
          <For each={dayLabels()}>
            {(label) => (
              <div class="flex h-7 w-10 items-center justify-center app-panel-caption font-medium text-text-weaker">
                {label}
              </div>
            )}
          </For>
        </div>

        <For each={gridWeeks()}>
          {(week) => (
            <div class="grid grid-cols-7 gap-0.5 px-0.5 py-0.5">
              <For each={week}>
                {(ts) => (
                  <button
                    type="button"
                    class={`flex h-9 w-10 items-center justify-center rounded-lg app-panel-caption font-medium leading-none transition-colors ${cellClass(ts)}`}
                    aria-label={fmt.date(ts, { dateStyle: "full" })}
                    aria-pressed={ts === anchorDay()}
                    aria-current={ts === today() ? "date" : undefined}
                    tabindex={ts === rovingDay() ? 0 : -1}
                    data-mini-date={ts}
                    onKeyDown={(event) => {
                      const next = calendarKeyDate(ts, event.key, event.shiftKey)
                      if (next === undefined) return
                      event.preventDefault()
                      ;(props.onDateNavigate ?? props.onDateClick)?.(next)
                      requestAnimationFrame(() =>
                        document.querySelector<HTMLButtonElement>(`[data-mini-date="${next}"]`)?.focus(),
                      )
                    }}
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
