import { createMemo, createSignal, For, Show } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { useLocale } from "@/context/locale"
import { S } from "./stats-i18n"

const HEATMAP_STYLE = `
@keyframes heatmapCellEnter {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.94);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
`

const LEVEL_COLORS = [
  "var(--surface-inset-base)",
  "color-mix(in srgb, var(--chart-series-3) 28%, transparent)",
  "color-mix(in srgb, var(--chart-series-3) 48%, transparent)",
  "color-mix(in srgb, var(--chart-series-3) 68%, transparent)",
  "var(--chart-series-3)",
] as const
const LEVEL_BORDERS = [
  "var(--border-weaker-base)",
  "color-mix(in srgb, var(--chart-series-3) 35%, transparent)",
  "color-mix(in srgb, var(--chart-series-3) 55%, transparent)",
  "color-mix(in srgb, var(--chart-series-3) 75%, transparent)",
  "var(--chart-series-3)",
] as const

type Range = "24h" | "7d" | "30d" | "90d" | "all"
type DayCell = {
  key: string
  label: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}
type HourCell = DayCell & {
  dayLabel: string
}

function clampLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio < 0.25) return 1
  if (ratio < 0.5) return 2
  if (ratio < 0.75) return 3
  return 4
}

function formatDay(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatHourKey(date: Date) {
  return `${formatDay(date)}T${String(date.getHours()).padStart(2, "0")}`
}

function addHours(date: Date, delta: number) {
  const copy = new Date(date)
  copy.setHours(copy.getHours() + delta, 0, 0, 0)
  return copy
}

function startOfCurrentHour() {
  const now = new Date()
  now.setMinutes(0, 0, 0)
  return now
}

function formatHourTick(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`
}

function DayView(props: { cells: DayCell[]; columns: number }) {
  return (
    <div class="mt-4 rounded-[1.4rem] bg-surface-base/34 p-3 ring-1 ring-inset ring-border-weaker-base">
      <div class="grid gap-1.5" style={{ "grid-template-columns": `repeat(${props.columns}, minmax(0, 1fr))` }}>
        <For each={props.cells}>
          {(cell, index) => (
            <div
              class="aspect-square min-h-4 rounded-[8px] border transition-transform duration-150 hover:-translate-y-px hover:scale-[1.03]"
              style={{
                "background-color": LEVEL_COLORS[cell.level],
                "border-color": LEVEL_BORDERS[cell.level],
                animation: `heatmapCellEnter 280ms cubic-bezier(0.22, 1, 0.36, 1) ${index() * 8}ms both`,
              }}
              title={cell.label}
            />
          )}
        </For>
      </div>
    </div>
  )
}

function HourView(props: { rows: Array<{ label: string; cells: HourCell[] }> }) {
  const HOUR_LABELS = [0, 6, 12, 18, 23] as const
  return (
    <div class="mt-4 rounded-[1.4rem] bg-surface-base/34 p-3 ring-1 ring-inset ring-border-weaker-base">
      <div
        class="grid items-center gap-x-1.5 gap-y-2"
        style={{ "grid-template-columns": "auto repeat(24, minmax(0, 1fr))" }}
      >
        <div />
        <For each={Array.from({ length: 24 }, (_, hour): number => hour)}>
          {(hour) => (
            <div class="text-center text-[9px] font-medium text-text-weaker">
              {HOUR_LABELS.some((value) => value === hour) ? formatHourTick(hour) : ""}
            </div>
          )}
        </For>

        <For each={props.rows}>
          {(row, rowIndex) => (
            <>
              <div class="pr-2 text-[10px] font-medium text-text-weak">{row.label}</div>
              <For each={row.cells}>
                {(cell, cellIndex) => (
                  <div
                    class="aspect-square min-h-3 rounded-[6px] border transition-transform duration-150 hover:-translate-y-px hover:scale-[1.03]"
                    style={{
                      "background-color": LEVEL_COLORS[cell.level],
                      "border-color": LEVEL_BORDERS[cell.level],
                      animation: `heatmapCellEnter 260ms cubic-bezier(0.22, 1, 0.36, 1) ${(rowIndex() * 24 + cellIndex()) * 4}ms both`,
                    }}
                    title={cell.label}
                  />
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </div>
  )
}

export function ActivityHeatmap(props: {
  days: StatsSnapshot["timeSeries"]["days"]
  hours?: Array<{ hour: string; turns: number }>
}) {
  const { i18n, fmt } = useLocale()
  const [range, setRange] = createSignal<Range>("7d")
  const legendLevels = createMemo(() => [0, 1, 2, 3, 4] as const)
  const availableHours = createMemo(() => props.hours ?? [])

  const ranges = createMemo(() => [
    { label: i18n._(S.heatmapRange24h.id), value: "24h" as const },
    { label: i18n._(S.heatmapRange7d.id), value: "7d" as const },
    { label: i18n._(S.heatmapRange30d.id), value: "30d" as const },
    { label: i18n._(S.heatmapRange90d.id), value: "90d" as const },
    { label: i18n._(S.heatmapRangeAll.id), value: "all" as const },
  ])

  const requestedGranularity = createMemo(() => {
    const selectedRange = range()
    return selectedRange === "24h" || selectedRange === "7d" ? "hour" : "day"
  })

  const granularity = createMemo(() => {
    if (requestedGranularity() === "hour" && availableHours().length > 0) return "hour"
    return "day"
  })

  const filteredDays = createMemo(() => {
    const selectedRange = range()
    if (selectedRange === "all") return props.days
    if (selectedRange === "24h") return props.days.slice(-1)
    if (selectedRange === "7d") return props.days.slice(-7)
    if (selectedRange === "30d") return props.days.slice(-30)
    return props.days.slice(-90)
  })

  const dayCells = createMemo<DayCell[]>(() => {
    const days = filteredDays()
    const max = Math.max(...days.map((day) => day.turns), 0)
    return days.map((day) => ({
      key: day.day,
      value: day.turns,
      level: clampLevel(day.turns, max),
      label: i18n._(S.heatmapCellLabel.id, { date: day.day, turns: fmt.number(day.turns) }),
    }))
  })

  const hourRows = createMemo<Array<{ label: string; cells: HourCell[] }>>(() => {
    const selectedRange = range()
    if (granularity() !== "hour") return []

    const hoursByKey = new Map(availableHours().map((hour) => [hour.hour, hour.turns]))
    const totalHours = selectedRange === "24h" ? 24 : 24 * 7
    const end = startOfCurrentHour()
    const cells: HourCell[] = []

    for (let index = totalHours - 1; index >= 0; index--) {
      const date = addHours(end, -index)
      const key = formatHourKey(date)
      const value = hoursByKey.get(key) ?? 0
      cells.push({
        key,
        value,
        level: 0,
        dayLabel: fmt.date(date, { weekday: "short", month: "short", day: "numeric" }),
        label: i18n._(S.heatmapCellLabelHour.id, {
          date: fmt.date(date, { month: "short", day: "numeric" }),
          time: formatHourTick(date.getHours()),
          turns: fmt.number(value),
        }),
      })
    }

    const max = Math.max(...cells.map((cell) => cell.value), 0)
    const leveled = cells.map((cell) => ({ ...cell, level: clampLevel(cell.value, max) }))
    const rows: Array<{ label: string; cells: HourCell[] }> = []

    for (let rowIndex = 0; rowIndex < leveled.length; rowIndex += 24) {
      const rowCells = leveled.slice(rowIndex, rowIndex + 24)
      rows.push({
        label: selectedRange === "24h" ? i18n._(S.heatmapToday.id) : (rowCells[0]?.dayLabel ?? ""),
        cells: rowCells,
      })
    }

    return rows
  })

  const totalLabel = createMemo(() => {
    if (granularity() === "hour") {
      const cells = hourRows().flatMap((row) => row.cells)
      const totalTurns = cells.reduce((sum, cell) => sum + cell.value, 0)
      const activeHours = cells.filter((cell) => cell.value > 0).length
      return i18n._(S.heatmapTurnsSummary.id, {
        turns: fmt.number(totalTurns),
        active: fmt.number(activeHours),
        unit: i18n._(S.heatmapUnitHours.id),
      })
    }

    const days = filteredDays()
    const totalTurns = days.reduce((sum, day) => sum + day.turns, 0)
    const activeDays = days.filter((day) => day.turns > 0).length
    return i18n._(S.heatmapTurnsSummary.id, {
      turns: fmt.number(totalTurns),
      active: fmt.number(activeDays),
      unit: i18n._(S.heatmapUnitDays.id),
    })
  })

  const subtitle = createMemo(() =>
    granularity() === "hour" ? i18n._(S.heatmapHourSubtitle.id) : i18n._(S.heatmapDaySubtitle.id),
  )

  const dayColumns = createMemo(() => {
    const selectedRange = range()
    const count = Math.max(dayCells().length, 1)
    if (selectedRange === "24h") return 1
    if (selectedRange === "7d") return Math.min(7, count)
    if (selectedRange === "30d") return 15
    if (selectedRange === "90d") return 18
    return Math.min(22, Math.max(12, Math.ceil(Math.sqrt(count * 3))))
  })

  const edgeLabels = createMemo(() => {
    const cells = dayCells()
    return {
      start: cells[0]?.key ?? "",
      end: cells[cells.length - 1]?.key ?? "",
    }
  })

  return (
    <>
      <style>{HEATMAP_STYLE}</style>
      <section class="rounded-2xl bg-surface-raised-base px-4 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-14-semibold tracking-tight text-text-base">{totalLabel()}</h3>
            <p class="mt-1 text-11-regular text-text-weak">{subtitle()}</p>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <For each={ranges()}>
              {(item) => {
                const active = () => range() === item.value
                return (
                  <button
                    type="button"
                    class={`rounded-full px-2.5 py-1 text-11-medium transition-all duration-200 ${
                      active()
                        ? "bg-surface-interactive-solid text-text-on-interactive-base shadow-sm"
                        : "bg-surface-inset-base/70 text-text-weak hover:bg-surface-inset-base hover:text-text-base"
                    }`}
                    onClick={() => setRange(item.value)}
                  >
                    {item.label}
                  </button>
                )
              }}
            </For>
          </div>
        </div>

        <Show
          when={granularity() === "hour" ? hourRows().length > 0 : dayCells().length > 0}
          fallback={
            <div class="mt-4 flex h-32 items-center justify-center rounded-2xl bg-surface-inset-base/45 text-12-medium text-text-weak">
              {i18n._(S.heatmapEmpty.id)}
            </div>
          }
        >
          <Show when={granularity() === "hour"} fallback={<DayView cells={dayCells()} columns={dayColumns()} />}>
            <HourView rows={hourRows()} />
          </Show>

          <div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-[10px] font-medium text-text-weaker">
            <div class="flex items-center gap-2">
              <span>{granularity() === "hour" ? i18n._(S.heatmapHourView.id) : i18n._(S.heatmapDayView.id)}</span>
              <span class="text-text-weaker/70">•</span>
              <span>
                {granularity() === "hour"
                  ? i18n._(S.heatmapRows.id, { n: hourRows().length })
                  : i18n._(S.heatmapCells.id, { n: dayCells().length })}
              </span>
            </div>
            <Show when={granularity() === "day" && dayCells().length > 1}>
              <div class="flex items-center gap-2">
                <span>{edgeLabels().start}</span>
                <span class="text-text-weaker/70">→</span>
                <span>{edgeLabels().end}</span>
              </div>
            </Show>
            <div class="flex items-center gap-2">
              <span>{i18n._(S.heatmapQuiet.id)}</span>
              <div class="flex items-center gap-1">
                <For each={legendLevels()}>
                  {(level) => (
                    <span
                      class="h-3.5 w-3.5 rounded-[5px] border"
                      style={{
                        "background-color": LEVEL_COLORS[level],
                        "border-color": LEVEL_BORDERS[level],
                      }}
                    />
                  )}
                </For>
              </div>
              <span>{i18n._(S.heatmapBusy.id)}</span>
            </div>
          </div>
        </Show>
      </section>
    </>
  )
}
