import { For, Show } from "solid-js"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { AppPanel } from "@/components/app-panel"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { A } from "./agenda-i18n"
import {
  agendaRunStatusLabel,
  agendaRunStatusTone,
  agendaStatuses,
  agendaStatusTone,
  makeTriggerSummary,
  triggerActionLabel,
} from "./shared"
import type { AgendaTaskFilter } from "./forecast"

export function AgendaTaskList(props: {
  items: AgendaItem[]
  filter: AgendaTaskFilter
  onFilterChange: (filter: AgendaTaskFilter) => void
  onSelect: (item: AgendaItem) => void
  onAction?: (item: AgendaItem, action: "trigger" | "pause" | "activate") => void
  scopeLabel: (item: AgendaItem) => string
  isLoading?: (id: string, action: string) => boolean
  onClear: () => void
  filtered: boolean
  now: number
}) {
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }, values?: Record<string, unknown>) => i18n._({ ...d, values })
  return (
    <div class="agenda-task-list" data-panel-list>
      <div class="agenda-task-toolbar">
        <AppPanel.Selection
          label={_({ id: "app.agenda.tasks.filter", message: "Task status" })}
          items={[
            { id: "all", label: _({ id: "app.agenda.tasks.all", message: "All" }) },
            { id: "active", label: _(agendaStatuses.active) },
            { id: "pending", label: _(agendaStatuses.pending) },
            { id: "paused", label: _(agendaStatuses.paused) },
            { id: "archived", label: _({ id: "app.agenda.tasks.archived", message: "Finished" }) },
            { id: "failed", label: _({ id: "app.agenda.tasks.failed", message: "Last run failed" }) },
          ]}
          active={props.filter}
          onChange={(filter) => props.onFilterChange(filter as AgendaTaskFilter)}
        />
        <div class="flex items-center gap-2 app-panel-caption text-text-weak">
          <Show when={props.filtered}>
            <button type="button" class="agenda-secondary-action" onClick={props.onClear}>
              {_({ id: "app.agenda.filters.clear", message: "Clear filters" })}
            </button>
          </Show>
          {_(
            { id: "app.agenda.tasks.count", message: "{count, plural, one {# task} other {# tasks}}" },
            { count: props.items.length },
          )}
        </div>
      </div>
      <For each={props.items}>
        {(item) => (
          <article class="agenda-task-row" data-panel-item={item.id}>
            <div class="agenda-task-content">
              <button
                type="button"
                class="agenda-task-title app-panel-row-title"
                data-panel-focus-entry
                aria-haspopup="dialog"
                onClick={() => props.onSelect(item)}
              >
                <span class="line-clamp-2 break-words">{item.title}</span>
                <span class={`agenda-detail-status app-panel-caption ${agendaStatusTone(item.status)}`}>
                  {translateDescriptor(agendaStatuses[item.status], i18n)}
                </span>
              </button>
              <p class="app-panel-caption text-text-weak">
                {props.scopeLabel(item)} · {makeTriggerSummary(item.triggers, _, (time) => fmt.dateTime(time))}
              </p>
              <Show when={item.status === "active" && item.state?.nextRunAt && item.state.nextRunAt >= props.now}>
                <p class="app-panel-caption text-text-base">
                  {_(A.detailNext, { time: fmt.dateTime(item.state!.nextRunAt!) })}
                </p>
              </Show>
              <Show
                when={item.state?.lastRunAt != null}
                fallback={
                  <p class="app-panel-caption text-text-weak">
                    {_({ id: "app.agenda.tasks.noRuns", message: "No execution record" })}
                  </p>
                }
              >
                <p class="app-panel-caption text-text-weak">
                  {_(A.detailLastRun, { date: fmt.dateTime(item.state!.lastRunAt!) })}
                  {" · "}
                  {item.state?.lastRunStatus ? (
                    <span class={agendaRunStatusTone(item.state.lastRunStatus)}>
                      {translateDescriptor(agendaRunStatusLabel(item.state.lastRunStatus), i18n)}
                    </span>
                  ) : (
                    <span>{_({ id: "app.agenda.tasks.unknownResult", message: "Result unavailable" })}</span>
                  )}
                </p>
              </Show>
              <Show when={item.state?.lastRunStatus === "error" && item.state.lastRunError}>
                <p class="app-panel-caption text-text-on-critical-base line-clamp-2">{item.state!.lastRunError}</p>
              </Show>
            </div>
            <Show when={props.onAction && ["active", "pending", "paused"].includes(item.status)}>
              <div class="agenda-task-actions">
                <button
                  type="button"
                  class="agenda-secondary-action"
                  disabled={props.isLoading?.(item.id, "trigger")}
                  onClick={() => props.onAction?.(item, "trigger")}
                >
                  {translateDescriptor(triggerActionLabel(item.status), i18n)}
                </button>
                <button
                  type="button"
                  class="agenda-secondary-action"
                  disabled={props.isLoading?.(item.id, item.status === "active" ? "pause" : "activate")}
                  onClick={() => props.onAction?.(item, item.status === "active" ? "pause" : "activate")}
                >
                  {_(item.status === "active" ? A.actionPause : A.actionActivate)}
                </button>
              </div>
            </Show>
          </article>
        )}
      </For>
      <Show when={!props.items.length}>
        <AppPanel.Empty
          icon={getSemanticIcon("agenda.main")}
          title={_({ id: "app.agenda.tasks.empty", message: "No tasks to display" })}
          description={_({
            id: "app.agenda.tasks.emptyHint",
            message: "Create a task or clear filters to see your rules.",
          })}
          action={
            props.filtered ? (
              <button type="button" class="agenda-secondary-action" onClick={props.onClear}>
                {_({ id: "app.agenda.filters.clear", message: "Clear filters" })}
              </button>
            ) : undefined
          }
        />
      </Show>
    </div>
  )
}
