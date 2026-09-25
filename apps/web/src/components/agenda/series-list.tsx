import { translateDescriptor } from "@/locales/translate"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { useLocale } from "@/context/locale"
import { AppPanel } from "@/components/app-panel"
import { A } from "./agenda-i18n"
import { agendaSeries, type AgendaSeriesFilter } from "./series"
import type { CalendarEvent } from "./expand"

const statuses = {
  active: { id: "app.agenda.series.active", message: "Active" },
  paused: { id: "app.agenda.series.paused", message: "Paused" },
  pending: { id: "app.agenda.series.pending", message: "Pending" },
  done: { id: "app.agenda.series.done", message: "Done" },
  cancelled: { id: "app.agenda.series.cancelled", message: "Cancelled" },
}

export function AgendaSeriesList(props: {
  items: AgendaItem[]
  events: CalendarEvent[]
  onSelect: (item: AgendaItem, rect: DOMRect) => void
}) {
  const { i18n, fmt } = useLocale()
  const [filter, setFilter] = createSignal<AgendaSeriesFilter>("all")
  const series = createMemo(() => agendaSeries(props.items, props.events, filter()))
  return (
    <div class="flex flex-col gap-3 pt-3">
      <AppPanel.SegmentedNav
        items={[
          { id: "all", label: i18n._({ id: "app.agenda.series.all", message: "All series" }) },
          { id: "failed", label: i18n._({ id: "app.agenda.series.failed", message: "Last run failed" }) },
          { id: "pending", label: i18n._(statuses.pending) },
        ]}
        active={filter()}
        onChange={(id) => setFilter(id as AgendaSeriesFilter)}
      />
      <For each={series()}>
        {(row) => (
          <article class="agenda-main-surface p-4 flex flex-col gap-2">
            <button
              type="button"
              class="flex gap-3 items-center text-left"
              onClick={(event) => props.onSelect(row.item, event.currentTarget.getBoundingClientRect())}
            >
              <span class="flex-1 min-w-0 text-14-medium text-text-strong break-words">{row.item.title}</span>
              <span class="text-12-regular text-text-weak shrink-0">
                {translateDescriptor(statuses[row.item.status], i18n)}
              </span>
            </button>
            <div class="text-12-regular text-text-weak">
              <Show
                when={row.item.state?.lastRunAt}
                fallback={<span>{i18n._({ id: "app.agenda.series.noRuns", message: "No run record available" })}</span>}
              >
                {(time) => <span>{i18n._({ ...A.detailLastRun, values: { date: fmt.dateTime(time()) } })}</span>}
              </Show>
              <Show when={row.item.state?.lastRunStatus === "error"}>
                <span class="block text-text-on-critical-base">
                  {row.item.state?.lastRunError ||
                    i18n._({ id: "app.agenda.series.failed", message: "Last run failed" })}
                </span>
              </Show>
              <Show when={row.item.state?.lastRunAt && !row.item.state?.lastRunStatus}>
                <span class="block">
                  {i18n._({ id: "app.agenda.series.missingStatus", message: "Latest run status unavailable" })}
                </span>
              </Show>
            </div>
            <Show
              when={row.times.length}
              fallback={
                <span class="text-12-regular text-text-weak">
                  {i18n._({ id: "app.agenda.series.noTimes", message: "No planned times in this range" })}
                </span>
              }
            >
              <details class="text-12-regular text-text-weak">
                <summary class="cursor-pointer py-1">
                  {i18n._({
                    id: "app.agenda.series.previewCount",
                    message: "Preview {count, plural, one {# planned time} other {# planned times}}",
                    values: { count: row.times.length },
                  })}
                </summary>
                <p class="py-2">
                  {i18n._({
                    id: "app.agenda.series.previewHint",
                    message: "Planned times are a preview. See History for completed runs.",
                  })}
                </p>
                <ul class="max-h-48 overflow-y-auto flex flex-col gap-1">
                  <For each={row.times}>{(time) => <li>{fmt.dateTime(time)}</li>}</For>
                </ul>
              </details>
            </Show>
          </article>
        )}
      </For>
      <Show when={!series().length}>
        <p class="p-6 text-center text-text-weak">
          {i18n._({ id: "app.agenda.series.empty", message: "No matching agenda items" })}
        </p>
      </Show>
    </div>
  )
}
