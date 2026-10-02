import { createMemo, createSignal, For, Show } from "solid-js"
import { AppPanel } from "@/components/app-panel"
import { useLocale } from "@/context/locale"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { calendarKeyDate } from "./calendar-navigation"
import { addDays, addMonths, getDayLabelsShort, startOfDay } from "./date"
import { agendaRange, type AgendaViewMode, type CalendarEvent } from "./forecast"
import { MiniCalendar } from "./mini-calendar"
import { A } from "./agenda-i18n"
import "./calendar.css"

export type ViewMode = AgendaViewMode

export function CalendarGrid(props: {
  viewMode: ViewMode
  anchor: number
  events: CalendarEvent[]
  now?: number
  scopeLabel?: (event: CalendarEvent) => string
  onViewModeChange?: (mode: ViewMode) => void
  onAnchorChange?: (anchor: number) => void
  onEventClick?: (event: CalendarEvent, e: MouseEvent) => void
  onHistory?: () => void
}) {
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }, values?: Record<string, unknown>) => i18n._({ ...d, values })
  const range = createMemo(() => agendaRange(props.anchor, props.viewMode))
  const [dateOpen, setDateOpen] = createSignal(false)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const days = createMemo(() => {
    const count =
      props.viewMode === "month"
        ? Math.round((range().end - range().start) / 86_400_000)
        : props.viewMode === "day"
          ? 1
          : 7
    return Array.from({ length: count }, (_, index) => addDays(range().start, index))
  })
  const eventsByDay = createMemo(() => {
    const map = new Map<number, CalendarEvent[]>()
    for (const event of [...props.events].sort((a, b) => a.time - b.time)) {
      if (event.time < range().start || event.time >= range().end) continue
      const day = startOfDay(event.time)
      map.set(day, [...(map.get(day) ?? []), event])
    }
    return map
  })
  const selected = () => startOfDay(props.anchor)
  const visibleCount = () => [...eventsByDay().values()].reduce((count, events) => count + events.length, 0)
  const selectedEvents = () => eventsByDay().get(selected()) ?? []
  const dateTitle = () => {
    if (props.viewMode === "month") return fmt.date(props.anchor, { year: "numeric", month: "long" })
    if (props.viewMode === "week")
      return _(
        { id: "app.agenda.arrangements.weekRange", message: "{start} – {end}" },
        {
          start: fmt.date(range().start, { month: "short", day: "numeric" }),
          end: fmt.date(addDays(range().start, 6), { month: "short", day: "numeric", year: "numeric" }),
        },
      )
    if (props.viewMode === "list")
      return _(
        { id: "app.agenda.arrangements.listRange", message: "7 days from {date}" },
        { date: fmt.date(props.anchor, { year: "numeric", month: "short", day: "numeric" }) },
      )
    return fmt.date(props.anchor, { year: "numeric", month: "short", day: "numeric", weekday: "short" })
  }
  const previous = () =>
    props.viewMode === "month"
      ? _({ id: "app.agenda.calendar.previousMonth", message: "Previous month" })
      : props.viewMode === "day"
        ? _({ id: "app.agenda.calendar.previousDay", message: "Previous day" })
        : _({ id: "app.agenda.calendar.previousWeek", message: "Previous 7 days" })
  const next = () =>
    props.viewMode === "month"
      ? _({ id: "app.agenda.calendar.nextMonth", message: "Next month" })
      : props.viewMode === "day"
        ? _({ id: "app.agenda.calendar.nextDay", message: "Next day" })
        : _({ id: "app.agenda.calendar.nextWeek", message: "Next 7 days" })
  function move(direction: number) {
    props.onAnchorChange?.(
      props.viewMode === "month"
        ? addMonths(props.anchor, direction)
        : addDays(props.anchor, direction * (props.viewMode === "day" ? 1 : 7)),
    )
  }
  function selectDay(day: number, keyboard?: KeyboardEvent) {
    props.onAnchorChange?.(day)
    if (keyboard)
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-agenda-date="${day}"]`)?.focus())
  }
  const empty = () => (
    <div class="agenda-arrangement-empty">
      <p class="app-panel-row-title">
        {_({ id: "app.agenda.arrangements.empty", message: "No upcoming arrangements in this range" })}
      </p>
      <p class="app-panel-caption text-text-weak">
        {range().end <= (props.now ?? Date.now())
          ? _({
              id: "app.agenda.arrangements.pastHint",
              message: "This period is in the past. History contains actual executions.",
            })
          : _({
              id: "app.agenda.arrangements.emptyHint",
              message:
                "Only enabled tasks with future trigger times appear here. Manual and event-triggered tasks are in Tasks.",
            })}
      </p>
      <Show when={props.onHistory && range().end <= (props.now ?? Date.now())}>
        <button type="button" class="agenda-secondary-action" onClick={props.onHistory}>
          {_({ id: "app.agenda.arrangements.openHistory", message: "View execution history" })}
        </button>
      </Show>
    </div>
  )
  const eventList = (events: CalendarEvent[]) => (
    <OccurrenceList events={events} scopeLabel={props.scopeLabel} onSelect={props.onEventClick} empty={empty()} />
  )

  return (
    <div class="agenda-calendar">
      <div class="agenda-calendar-toolbar">
        <div class="agenda-date-navigation">
          <button type="button" class="agenda-secondary-action" onClick={() => props.onAnchorChange?.(Date.now())}>
            {_(A.calendarToday)}
          </button>
          <button type="button" class="agenda-icon-action" aria-label={previous()} onClick={() => move(-1)}>
            <Icon name={getSemanticIcon("navigation.back")} size="small" />
          </button>
          <button type="button" class="agenda-icon-action" aria-label={next()} onClick={() => move(1)}>
            <Icon name={getSemanticIcon("navigation.forward")} size="small" />
          </button>
          <Popover
            open={dateOpen()}
            onOpenChange={setDateOpen}
            title={_({ id: "app.agenda.calendar.chooseDate", message: "Choose a date" })}
            class="agenda-calendar-picker"
            placement="bottom-start"
            triggerAs={(triggerProps) => (
              <button {...triggerProps} type="button" class="agenda-range-button app-panel-control">
                <span>{dateTitle()}</span>
                <Icon name={getSemanticIcon("navigation.expand")} size="small" class="rotate-90" />
              </button>
            )}
          >
            <MiniCalendar
              anchor={props.anchor}
              onDateNavigate={(day) => props.onAnchorChange?.(day)}
              onDateClick={(day) => {
                props.onAnchorChange?.(day)
                setDateOpen(false)
              }}
            />
          </Popover>
        </div>
        <AppPanel.Selection
          label={_({ id: "app.agenda.calendar.views", message: "Calendar view" })}
          items={[
            { id: "list", label: _({ id: "app.agenda.calendar.list", message: "List" }) },
            { id: "day", label: _(A.calendarDay) },
            { id: "week", label: _(A.calendarWeek) },
            { id: "month", label: _(A.calendarMonth) },
          ]}
          active={props.viewMode}
          onChange={(mode) => props.onViewModeChange?.(mode as ViewMode)}
        />
      </div>
      <div class="agenda-arrangement-context app-panel-caption text-text-weak">
        <span>
          {_({ id: "app.agenda.arrangements.predicted", message: "Expected trigger times · {timezone}" }, { timezone })}
        </span>
        <span>
          {_(
            {
              id: "app.agenda.arrangements.count",
              message: "{count, plural, one {# upcoming trigger} other {# upcoming triggers}}",
            },
            { count: visibleCount() },
          )}
        </span>
      </div>

      <Show when={props.viewMode === "list"}>
        <Show when={visibleCount()} fallback={empty()}>
          <For each={days().filter((day) => eventsByDay().has(day))}>
            {(day) => (
              <section class="agenda-date-section">
                <h2 class="app-panel-section-title">{fmt.date(day, { dateStyle: "full" })}</h2>
                {eventList(eventsByDay().get(day) ?? [])}
              </section>
            )}
          </For>
        </Show>
      </Show>
      <Show when={props.viewMode === "day"}>
        <section class="agenda-day-agenda">{eventList(selectedEvents())}</section>
      </Show>
      <Show when={props.viewMode === "week"}>
        <div class="agenda-week-overview">
          <For each={days()}>
            {(day) => (
              <div class="agenda-week-column">
                <button
                  type="button"
                  class="agenda-week-date"
                  aria-pressed={day === selected()}
                  aria-current={day === startOfDay(props.now ?? Date.now()) ? "date" : undefined}
                  onClick={() => selectDay(day)}
                >
                  <span class="app-panel-caption">{fmt.date(day, { weekday: "short" })}</span>
                  <span class="app-panel-section-title">{new Date(day).getDate()}</span>
                  <span class="app-panel-caption text-text-weak">{eventsByDay().get(day)?.length || "—"}</span>
                </button>
                <div class="agenda-week-events">{eventList(eventsByDay().get(day) ?? [])}</div>
              </div>
            )}
          </For>
        </div>
        <section class="agenda-week-day-list agenda-date-section">
          <h2 class="app-panel-section-title">{fmt.date(selected(), { dateStyle: "full" })}</h2>
          {eventList(selectedEvents())}
        </section>
      </Show>
      <Show when={props.viewMode === "month"}>
        <div class="agenda-month-overview">
          <div class="agenda-month-header">
            <For each={getDayLabelsShort(fmt)}>{(label) => <span class="app-panel-caption">{label}</span>}</For>
          </div>
          <div class="agenda-month-grid">
            <For each={days()}>
              {(day) => {
                const events = () => eventsByDay().get(day) ?? []
                return (
                  <div
                    class="agenda-month-cell"
                    data-current-month={new Date(day).getMonth() === new Date(props.anchor).getMonth()}
                  >
                    <button
                      type="button"
                      class="agenda-month-date"
                      aria-label={fmt.date(day, { dateStyle: "full" })}
                      aria-pressed={day === selected()}
                      aria-current={day === startOfDay(props.now ?? Date.now()) ? "date" : undefined}
                      tabindex={day === selected() ? 0 : -1}
                      data-agenda-date={day}
                      onClick={() => selectDay(day)}
                      onKeyDown={(event) => {
                        const next = calendarKeyDate(day, event.key, event.shiftKey)
                        if (next !== undefined) {
                          event.preventDefault()
                          selectDay(next, event)
                        }
                      }}
                    >
                      {new Date(day).getDate()}
                      <span class="agenda-month-count app-panel-caption">{events().length || ""}</span>
                    </button>
                    <div class="agenda-month-events">
                      <For each={events().slice(0, 3)}>
                        {(event) => (
                          <Tooltip value={event.title}>
                            <button
                              type="button"
                              class="agenda-month-occurrence"
                              aria-haspopup="dialog"
                              onClick={(e) => props.onEventClick?.(event, e)}
                            >
                              <time class="app-panel-caption" dateTime={new Date(event.time).toISOString()}>
                                {fmt.time(event.time, { hour: "2-digit", minute: "2-digit", hour12: false })}
                              </time>
                              <span class="app-panel-caption line-clamp-2">{event.title}</span>
                            </button>
                          </Tooltip>
                        )}
                      </For>
                      <Show when={events().length > 3}>
                        <button
                          type="button"
                          class="agenda-month-more app-panel-caption"
                          onClick={() => selectDay(day)}
                        >
                          {_(A.calendarMore, { count: events().length - 3 })}
                        </button>
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
        <section class="agenda-month-day-list agenda-date-section">
          <h2 class="app-panel-section-title">{fmt.date(selected(), { dateStyle: "full" })}</h2>
          {eventList(selectedEvents())}
        </section>
      </Show>
    </div>
  )
}

function OccurrenceList(props: {
  events: CalendarEvent[]
  scopeLabel?: (event: CalendarEvent) => string
  onSelect?: (event: CalendarEvent, e: MouseEvent) => void
  empty: import("solid-js").JSX.Element
}) {
  const { fmt } = useLocale()
  return (
    <div class="agenda-occurrences" data-panel-list>
      <Show when={props.events.length} fallback={props.empty}>
        <For each={props.events}>
          {(event) => (
            <Tooltip value={event.title}>
              <button
                type="button"
                class="agenda-occurrence"
                data-panel-item={event.id}
                data-panel-focus-entry
                aria-haspopup="dialog"
                onClick={(e) => props.onSelect?.(event, e)}
              >
                <time class="app-panel-control" dateTime={new Date(event.time).toISOString()}>
                  {fmt.time(event.time, { hour: "2-digit", minute: "2-digit", hour12: false })}
                </time>
                <span class="agenda-occurrence-dot" aria-hidden="true" />
                <span class="agenda-occurrence-copy">
                  <span class="app-panel-row-title line-clamp-2">{event.title}</span>
                  <Show when={props.scopeLabel}>
                    <span class="app-panel-caption text-text-weak">{props.scopeLabel?.(event)}</span>
                  </Show>
                </span>
              </button>
            </Tooltip>
          )}
        </For>
      </Show>
    </div>
  )
}
