import { createMemo, For, Show } from "solid-js"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import type { AgendaItem, AgendaRunLog } from "@ericsanchezok/synergy-sdk/client"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { relativeTime, absoluteDate } from "@/utils/time"
import { forecastAgenda, type CalendarEvent } from "./forecast"
import { addDays, startOfDay } from "./date"
import {
  agendaRunStatusTone,
  agendaRunTriggerLabel,
  agendaStatusTone,
  formatAgendaDuration,
  makeTriggerSummary,
  agendaStatusLabel,
  agendaRunStatusLabel,
} from "./shared"
import { A } from "./agenda-i18n"

export function AgendaDetails(props: {
  item: AgendaItem
  occurrence?: CalendarEvent
  now: number
  scopeName: string
  runs: AgendaRunLog[] | undefined
  runsError: boolean
  onRetry: () => void
  _: (d: { id: string; message: string }, values?: Record<string, unknown>) => string
}) {
  const { i18n, fmt } = useLocale()
  const { _ } = props
  const triggerSummary = (triggers: AgendaItem["triggers"]) =>
    makeTriggerSummary(triggers, _, (time) => fmt.dateTime(time))

  const state = () => props.item.state
  const preview = createMemo(() =>
    forecastAgenda(
      [props.item],
      { start: startOfDay(props.now), end: addDays(startOfDay(props.now), 7) },
      { now: props.now, preview: true },
    ),
  )
  return (
    <div class="agenda-details">
      <div class="agenda-detail-body flex-1 min-h-0 overflow-y-auto px-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div class="flex flex-col gap-3">
          <Show when={props.occurrence}>
            {(occurrence) => (
              <div class="agenda-occurrence-detail">
                <span class="app-panel-caption text-text-weak">
                  {_({ id: "app.agenda.detail.expectedTrigger", message: "Expected trigger" })}
                </span>
                <time class="app-panel-section-title" dateTime={new Date(occurrence().time).toISOString()}>
                  {fmt.dateTime(occurrence().time, { dateStyle: "full", timeStyle: "short" })}
                </time>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.agenda.detail.expectedHint",
                    message: "This is a predicted time, not an execution record. No execution duration is implied.",
                  })}
                </p>
                <Show when={props.item.status !== "active"}>
                  <p class="app-panel-caption text-text-weak">
                    {_({
                      id: "app.agenda.detail.noLongerEnabled",
                      message: "This task is no longer enabled and will not run at this time.",
                    })}
                  </p>
                </Show>
              </div>
            )}
          </Show>
          <p class="app-panel-caption text-text-weak">{props.scopeName}</p>
          <div class="agenda-detail-title-row">
            <span class={`agenda-detail-status ${agendaStatusTone(props.item.status)}`}>
              {translateDescriptor(agendaStatusLabel(props.item.status), i18n)}
            </span>
          </div>

          <Show when={props.item.description}>
            <p class="app-panel-copy text-text-weak leading-relaxed">{props.item.description}</p>
          </Show>

          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="agenda-detail-chip">{triggerSummary(props.item.triggers)}</span>
            <Show when={state()?.runCount}>
              <span class="agenda-detail-chip">{_(A.detailRuns, { count: state()!.runCount! })}</span>
            </Show>
            <Show when={state()?.consecutiveErrors && state()!.consecutiveErrors! > 0}>
              <span class="agenda-detail-chip agenda-detail-chip-danger">
                {_(A.detailErrors, { count: state()!.consecutiveErrors! })}
              </span>
            </Show>
            <Show when={props.item.createdBy === "agent"}>
              <span class="agenda-detail-chip">{_(A.detailAgent)}</span>
            </Show>
          </div>

          <Show when={props.item.status === "active" && state()?.nextRunAt && state()!.nextRunAt! >= props.now}>
            <div class="agenda-detail-meta">{_(A.detailNext, { time: fmt.dateTime(state()!.nextRunAt!) })}</div>
          </Show>

          <Show when={state()?.lastRunAt}>
            <div class="agenda-detail-meta">
              {_(A.detailLastRun, { date: absoluteDate(fmt, state()!.lastRunAt!) })}
              <Show when={state()?.lastRunStatus}>
                {" · "}
                <span class={agendaRunStatusTone(state()!.lastRunStatus!)}>
                  {translateDescriptor(agendaRunStatusLabel(state()!.lastRunStatus!), i18n)}
                </span>
              </Show>
              <Show when={state()?.lastRunDuration != null}>
                {" · "}
                {formatAgendaDuration(state()!.lastRunDuration!)}
              </Show>
            </div>
          </Show>
          <Show when={props.item.triggers?.some((trigger) => ["at", "every", "cron", "delay"].includes(trigger.type))}>
            <details class="agenda-detail-trigger-details">
              <summary class="app-panel-control">
                {_({ id: "app.agenda.detail.rulePreview", message: "Rule preview · next 7 days" })}
              </summary>
              <p class="app-panel-caption text-text-weak">
                {props.item.status === "active"
                  ? _({
                      id: "app.agenda.detail.previewHint",
                      message: "Predicted times for this rule. See History for actual executions.",
                    })
                  : _({
                      id: "app.agenda.detail.disabledPreview",
                      message: "This rule is disabled. These times are a preview only; the task will not run.",
                    })}
              </p>
              <Show when={preview().relative.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.agenda.detail.relativePreview",
                    message:
                      "Interval and delayed times depend on when the task is enabled and runs. Only an enabled task's known next time can be previewed.",
                  })}
                </p>
              </Show>
              <ul class="agenda-rule-preview">
                <For each={preview().events.slice(0, 8)}>
                  {(event) => (
                    <li class="app-panel-caption">
                      <time dateTime={new Date(event.time).toISOString()}>{fmt.dateTime(event.time)}</time>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={!preview().events.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({ id: "app.agenda.detail.noPreview", message: "No predictable time within the next 7 days." })}
                </p>
              </Show>
              <Show when={preview().events.length > 8 || preview().limited.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({ id: "app.agenda.detail.previewFirst", message: "Showing the first 8 times only." })}
                </p>
              </Show>
              <Show when={preview().invalid.length}>
                <p class="app-panel-caption text-text-weak">
                  {_({
                    id: "app.agenda.detail.previewInvalid",
                    message: "Some trigger settings could not be predicted.",
                  })}
                </p>
              </Show>
            </details>
          </Show>

          <Show when={state()?.lastRunError}>
            <div class="app-panel-caption text-text-diff-delete-base bg-text-diff-delete-base/6 rounded-[0.95rem] px-3 py-2 ring-1 ring-inset ring-text-diff-delete-base/10 line-clamp-3">
              {state()!.lastRunError}
            </div>
          </Show>

          <Show when={props.item.tags && props.item.tags.length > 0}>
            <div class="flex items-center gap-1.5 flex-wrap">
              <For each={props.item.tags}>{(tag) => <span class="agenda-detail-chip">#{tag}</span>}</For>
            </div>
          </Show>

          <Show when={props.item.prompt}>
            <div class="agenda-detail-section">
              <div class="agenda-detail-section-label">{_(A.detailTaskLabel)}</div>
              <p class="app-panel-copy text-text-weak leading-relaxed whitespace-pre-wrap">{props.item.prompt}</p>
              <Show when={props.item.agent}>
                <span class="agenda-detail-meta mt-1.5 block">
                  {_(A.detailAgentLabel, { agent: props.item.agent! })}
                </span>
              </Show>
            </div>
          </Show>

          <Show when={props.item.triggers?.some((trigger) => trigger.type === "cron")}>
            <details class="agenda-detail-trigger-details">
              <summary class="app-panel-control">
                {_({ id: "app.agenda.rawTriggers", message: "Trigger expressions" })}
              </summary>
              <For each={props.item.triggers}>
                {(trigger) => (
                  <Show when={trigger.type === "cron"}>
                    <p class="app-panel-caption break-words">
                      {trigger.type === "cron"
                        ? `${trigger.expr} · ${trigger.tz || Intl.DateTimeFormat().resolvedOptions().timeZone}`
                        : ""}
                    </p>
                  </Show>
                )}
              </For>
            </details>
          </Show>
          <Show when={props.runsError}>
            <div class="agenda-history-error" role="alert">
              <span>{_({ id: "app.agenda.detail.historyFailed", message: "Unable to load execution history." })}</span>
              <button type="button" class="agenda-secondary-action" onClick={props.onRetry}>
                {_({ id: "app.agenda.detail.retry", message: "Retry" })}
              </button>
            </div>
          </Show>
          <Show when={props.runs} fallback={!props.runsError ? <Spinner class="size-3.5 my-1" /> : undefined}>
            {(runs) => (
              <Show when={runs().length > 0}>
                <div class="agenda-detail-section">
                  <div class="agenda-detail-section-label">{_(A.detailRecentRuns)}</div>
                  <For each={runs().slice(0, 8)}>{(run) => <RunRow run={run} />}</For>
                </div>
              </Show>
            )}
          </Show>
          <div class="agenda-detail-footer">
            {_(A.detailCreated, { date: absoluteDate(fmt, props.item.time.created) })}
            <Show when={props.item.time.updated !== props.item.time.created}>
              {" · "}
              {_(A.detailUpdated, { date: absoluteDate(fmt, props.item.time.updated) })}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function RunRow(props: { run: AgendaRunLog }) {
  const { i18n, fmt } = useLocale()
  return (
    <div class="agenda-run-row">
      <span class={`shrink-0 ${agendaRunStatusTone(props.run.status)}`}>
        <span aria-hidden="true">{props.run.status === "ok" ? "✓" : props.run.status === "error" ? "✗" : "–"}</span>{" "}
        {translateDescriptor(agendaRunStatusLabel(props.run.status), i18n)}
      </span>
      <span class="text-text-weaker shrink-0">
        {translateDescriptor(agendaRunTriggerLabel(props.run.trigger.type), i18n)}
      </span>
      <Show when={props.run.duration !== undefined}>
        <span class="text-text-weaker shrink-0">{formatAgendaDuration(props.run.duration!)}</span>
      </Show>
      <span class="flex-1 min-w-0 text-text-weak truncate">
        <Show when={props.run.error} fallback="">
          <span class="text-text-diff-delete-base">{props.run.error}</span>
        </Show>
      </span>
      <span class="text-text-weaker shrink-0">{relativeTime(fmt, props.run.time.started)}</span>
    </div>
  )
}
