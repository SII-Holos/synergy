import { translateDescriptor } from "@/locales/translate"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { useLocale } from "@/context/locale"
import { AppPanel } from "@/components/app-panel"
import { A } from "./agenda-i18n"
import { makeTriggerSummary, agendaStatusTone, agendaStatuses as statuses } from "./shared"
import { agendaSeries, type AgendaSeriesFilter } from "./series"
import type { CalendarEvent } from "./expand"

export function AgendaSeriesList(props: {
  items: AgendaItem[]
  events: CalendarEvent[]
  onSelect: (item: AgendaItem, rect: DOMRect) => void
  onAction?: (item: AgendaItem, action: "trigger" | "pause" | "activate") => void
  scopeLabel?: (item: AgendaItem) => string
  isLoading?: (id: string, action: "trigger" | "pause" | "activate") => boolean
}) {
  const { i18n, fmt } = useLocale()
  const [filter, setFilter] = createSignal<AgendaSeriesFilter>("all")
  const series = createMemo(() => agendaSeries(props.items, props.events, filter()))
  return (
    <div class="flex flex-col gap-3 pt-3" data-panel-list>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <AppPanel.Selection
          label={i18n._({ id: "app.agenda.series.filter", message: "Agenda filter" })}
          items={[
            { id: "all", label: i18n._({ id: "app.agenda.series.all", message: "All series" }) },
            { id: "failed", label: i18n._({ id: "app.agenda.series.failed", message: "Last run failed" }) },
            { id: "pending", label: i18n._(statuses.pending) },
          ]}
          active={filter()}
          onChange={(id) => setFilter(id as AgendaSeriesFilter)}
        />
        <div class="flex items-center gap-3 app-panel-caption text-text-weak">
          <span>
            {i18n._({
              id: "app.agenda.series.resultCount",
              message: "{count, plural, one {# agenda} other {# agendas}}",
              values: { count: series().length },
            })}
          </span>
          <Show when={filter() !== "all"}>
            <button type="button" class="min-h-8 px-2 text-text-interactive-base" onClick={() => setFilter("all")}>
              {i18n._({ id: "app.agenda.series.clearFilters", message: "Clear filters" })}
            </button>
          </Show>
        </div>
      </div>
      <For each={series()}>
        {(row) => (
          <article
            data-panel-item={row.item.id}
            class="agenda-main-surface agenda-series-row p-4 flex flex-col gap-1.5"
          >
            <button
              type="button"
              class="flex gap-3 items-center text-left"
              data-panel-focus-entry
              aria-haspopup="dialog"
              onClick={(event) => props.onSelect(row.item, event.currentTarget.getBoundingClientRect())}
            >
              <span class="flex-1 min-w-0 app-panel-row-title text-text-strong break-words line-clamp-2">
                {row.item.title}
              </span>
              <span class={`rounded-md px-2 py-1 app-panel-caption shrink-0 ${agendaStatusTone(row.item.status)}`}>
                {translateDescriptor(statuses[row.item.status], i18n)}
              </span>
            </button>
            <span class="app-panel-caption text-text-weak">
              <Show when={props.scopeLabel}>
                <span>{props.scopeLabel?.(row.item)} · </span>
              </Show>
              {makeTriggerSummary(row.item.triggers, (descriptor: { id: string; message: string }, values) =>
                i18n._({ ...descriptor, values }),
              )}
            </span>
            <Show when={row.item.state?.nextRunAt}>
              {(time) => (
                <span class="app-panel-caption text-text-base">
                  {i18n._({
                    id: "app.agenda.series.next",
                    message: "Next run: {time}",
                    values: { time: fmt.dateTime(time()) },
                  })}
                </span>
              )}
            </Show>
            <div class="app-panel-caption text-text-weak">
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
            <Show when={row.times.length}>
              <details class="app-panel-caption text-text-weak">
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
            <Show
              when={
                props.onAction &&
                (row.item.status === "active" || row.item.status === "pending" || row.item.status === "paused")
              }
            >
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="agenda-secondary-action"
                  disabled={props.isLoading?.(row.item.id, "trigger")}
                  onClick={() => props.onAction?.(row.item, "trigger")}
                >
                  {i18n._(A.actionTrigger)}
                </button>
                <button
                  type="button"
                  class="agenda-secondary-action"
                  disabled={props.isLoading?.(row.item.id, row.item.status === "active" ? "pause" : "activate")}
                  onClick={() => props.onAction?.(row.item, row.item.status === "active" ? "pause" : "activate")}
                >
                  {i18n._(row.item.status === "active" ? A.actionPause : A.actionActivate)}
                </button>
              </div>
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
