import { createMemo, createSignal, For, Show } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { buildCalendarWeeksFromDays, type CalendarWeek } from "./model"

const HEATMAP_STYLE = `
@keyframes heatmapCellEnter {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.92);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
`

const LEVEL_COLORS = ["rgba(120, 130, 120, 0.14)", "#193d2b", "#25663f", "#2f8b4f", "#52b46f"] as const
const LEVEL_BORDERS = [
  "rgba(255,255,255,0.04)",
  "rgba(93, 188, 123, 0.16)",
  "rgba(101, 206, 133, 0.24)",
  "rgba(114, 224, 147, 0.3)",
  "rgba(140, 242, 171, 0.38)",
] as const
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""] as const
const RANGES = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: "all" },
] as const

type Range = 30 | 90 | "all"

export function ActivityHeatmap(props: { days: StatsSnapshot["timeSeries"]["days"] }) {
  const [range, setRange] = createSignal<Range>(90)
  const legendLevels = createMemo(() => [0, 1, 2, 3, 4] as const)

  const filteredDays = createMemo(() => {
    const selectedRange = range()
    if (selectedRange === "all") return props.days
    return props.days.slice(-selectedRange)
  })

  const weeks = createMemo<CalendarWeek[]>(() => {
    const selectedRange = range()
    return buildCalendarWeeksFromDays(props.days, selectedRange === "all" ? undefined : selectedRange)
  })

  const totalLabel = createMemo(() => {
    const days = filteredDays()
    const totalTurns = days.reduce((sum, day) => sum + day.turns, 0)
    const activeDays = days.filter((day) => day.turns > 0).length
    return `${totalTurns.toLocaleString()} turns across ${activeDays.toLocaleString()} active days`
  })

  return (
    <>
      <style>{HEATMAP_STYLE}</style>
      <section class="mt-5 rounded-2xl bg-surface-raised-base px-4 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-14-semibold tracking-tight text-text-base">{totalLabel()}</h3>
            <p class="mt-1 text-11-regular text-text-weak">Daily contribution activity</p>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <For each={RANGES}>
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
          when={weeks().length > 0}
          fallback={
            <div class="mt-4 flex h-32 items-center justify-center rounded-2xl bg-surface-inset-base/45 text-12-medium text-text-weak">
              No daily activity yet
            </div>
          }
        >
          <div class="mt-4 overflow-x-auto pb-1">
            <div class="min-w-max">
              <div class="flex items-start gap-2.5">
                <div class="w-8 shrink-0 pt-5">
                  <For each={WEEKDAY_LABELS}>
                    {(label) => (
                      <div class="mb-1 flex h-3.5 items-center justify-end pr-1 text-[10px] font-medium text-text-weaker last:mb-0">
                        {label}
                      </div>
                    )}
                  </For>
                </div>

                <div>
                  <div class="mb-1 flex gap-1 pl-px">
                    <For each={weeks()}>
                      {(week) => (
                        <div class="relative h-4 w-3.5 shrink-0">
                          <Show when={week.monthLabel}>
                            <span class="absolute left-0 top-0 whitespace-nowrap text-[10px] font-medium text-text-weaker">
                              {week.monthLabel}
                            </span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>

                  <div class="flex gap-1">
                    <For each={weeks()}>
                      {(week, weekIndex) => (
                        <div class="flex shrink-0 flex-col gap-1">
                          <For each={week.cells}>
                            {(cell, dayIndex) => (
                              <Show when={cell} fallback={<div class="h-3.5 w-3.5 rounded-[5px] opacity-0" />}>
                                {(value) => (
                                  <div
                                    class="h-3.5 w-3.5 cursor-default rounded-[5px] border transition-transform duration-150 hover:-translate-y-px hover:scale-[1.08]"
                                    style={{
                                      "background-color": LEVEL_COLORS[value().level],
                                      "border-color": LEVEL_BORDERS[value().level],
                                      animation: `heatmapCellEnter 320ms cubic-bezier(0.22, 1, 0.36, 1) ${(weekIndex() * 7 + dayIndex()) * 12}ms both`,
                                      "box-shadow":
                                        value().level > 0
                                          ? "inset 0 1px 0 rgba(255,255,255,0.08)"
                                          : "inset 0 1px 0 rgba(255,255,255,0.03)",
                                    }}
                                    title={value().dateLabel}
                                  />
                                )}
                              </Show>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="mt-4 flex items-center justify-end gap-2 text-[10px] font-medium text-text-weaker">
            <span>Less</span>
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
            <span>More</span>
          </div>
        </Show>
      </section>
    </>
  )
}
