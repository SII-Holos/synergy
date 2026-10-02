import { createMemo, For, Show } from "solid-js"
import type { AgendaActivityEntry } from "@ericsanchezok/synergy-sdk/client"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { agendaRunStatusLabel, agendaRunStatusTone, agendaRunTriggerLabel, formatAgendaDuration } from "./shared"
import { groupAgendaActivity } from "./activity-state"
import { A } from "./agenda-i18n"

export function ActivityView(props: {
  items: AgendaActivityEntry[]
  total: number
  hasMore: boolean
  loading: boolean
  query: string
  error?: string | null
  onQueryChange: (value: string) => void
  onRetry?: () => void
  onRefresh?: () => void
  onLoadMore: () => void
  onNavigate: (sessionID: string, scopeID: string) => void
  onItemClick: (itemId: string) => void
}) {
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }, values?: Record<string, unknown>) => i18n._({ ...d, values })
  let search: HTMLInputElement | undefined
  const grouped = createMemo(() => groupAgendaActivity(props.items))
  return (
    <div class="agenda-activity-surface">
      <div class="agenda-page-tools">
        <div class="agenda-search">
          <input
            ref={search}
            value={props.query}
            aria-label={_(A.activitySearchPlaceholder)}
            placeholder={_(A.activitySearchPlaceholder)}
            onInput={(e) => props.onQueryChange(e.currentTarget.value)}
          />
          <Show when={props.query}>
            <button
              type="button"
              class="agenda-secondary-action"
              onClick={() => {
                props.onQueryChange("")
                search?.focus()
              }}
            >
              {_({ id: "app.agenda.search.clear", message: "Clear search" })}
            </button>
          </Show>
        </div>
        <span class="app-panel-caption text-text-weak">
          {_(
            { id: "app.agenda.activity.loaded", message: "{shown} of {total} executions loaded" },
            { shown: props.items.length, total: props.total },
          )}
        </span>
        <Show when={props.onRefresh}>
          <button type="button" class="agenda-secondary-action" disabled={props.loading} onClick={props.onRefresh}>
            {props.loading
              ? _({ id: "app.agenda.activity.refreshing", message: "Refreshing…" })
              : _({ id: "app.agenda.activity.refresh", message: "Refresh" })}
          </button>
        </Show>
      </div>
      <Show when={props.error}>
        <div class="agenda-history-error py-4" role="alert">
          <span>{props.error}</span>
          <Show when={props.onRetry}>
            <button type="button" class="agenda-secondary-action" onClick={props.onRetry}>
              {_({ id: "app.agenda.activity.retry", message: "Retry" })}
            </button>
          </Show>
        </div>
      </Show>
      <Show
        when={!props.loading || props.items.length}
        fallback={
          <div class="agenda-arrangement-empty">
            <Spinner class="size-4" />
          </div>
        }
      >
        <Show
          when={props.items.length}
          fallback={
            !props.error ? (
              <div class="agenda-arrangement-empty">
                <p class="app-panel-row-title">
                  {props.query
                    ? _({ id: "app.agenda.activity.noMatch", message: "No matching executions" })
                    : _(A.activityNoHistory)}
                </p>
                <Show when={props.query}>
                  <button
                    type="button"
                    class="agenda-secondary-action"
                    onClick={() => {
                      props.onQueryChange("")
                      search?.focus()
                    }}
                  >
                    {_({ id: "app.agenda.filters.clear", message: "Clear filters" })}
                  </button>
                </Show>
              </div>
            ) : undefined
          }
        >
          <For each={grouped()}>
            {(group) => (
              <section class="agenda-date-section">
                <h2 class="app-panel-section-title">{fmt.date(group.day, { dateStyle: "full" })}</h2>
                <For each={group.entries}>
                  {(entry) => (
                    <article class="agenda-execution-row" data-panel-item={entry.run.id}>
                      <time
                        class="app-panel-control text-text-weak"
                        dateTime={new Date(entry.run.time.started).toISOString()}
                      >
                        {fmt.time(entry.run.time.started, { hour: "2-digit", minute: "2-digit", hour12: false })}
                      </time>
                      <div class="agenda-execution-copy">
                        <button
                          type="button"
                          class="app-panel-row-title text-text-strong text-left line-clamp-2"
                          data-panel-focus-entry
                          aria-haspopup="dialog"
                          onClick={() => props.onItemClick(entry.agenda.id)}
                        >
                          {entry.agenda.title}
                        </button>
                        <div class="agenda-execution-meta app-panel-caption">
                          <span class={agendaRunStatusTone(entry.run.status)}>
                            {translateDescriptor(agendaRunStatusLabel(entry.run.status), i18n)}
                          </span>
                          <span>{translateDescriptor(agendaRunTriggerLabel(entry.run.trigger.type), i18n)}</span>
                          <Show when={entry.run.duration != null}>
                            <span>{formatAgendaDuration(entry.run.duration!)}</span>
                          </Show>
                        </div>
                        <Show when={entry.run.error}>
                          <p class="app-panel-caption text-text-on-critical-base whitespace-pre-wrap">
                            {entry.run.error}
                          </p>
                        </Show>
                        <Show when={!entry.session}>
                          <p class="app-panel-caption text-text-weak">
                            {_({ id: "app.agenda.activity.noSession", message: "No related conversation available" })}
                          </p>
                        </Show>
                      </div>
                      <Show when={entry.session}>
                        {(session) => (
                          <button
                            type="button"
                            class="agenda-secondary-action"
                            onClick={() => props.onNavigate(session().id, session().scopeID)}
                          >
                            {_({ id: "app.agenda.activity.openSession", message: "Open conversation" })}
                          </button>
                        )}
                      </Show>
                    </article>
                  )}
                </For>
              </section>
            )}
          </For>
        </Show>
        <Show when={props.hasMore}>
          <div class="agenda-history-paging">
            <p class="app-panel-caption text-text-weak">
              {_({
                id: "app.agenda.activity.moreHint",
                message: "More executions are available beyond the loaded records.",
              })}
            </p>
            <button type="button" class="agenda-secondary-action" disabled={props.loading} onClick={props.onLoadMore}>
              {props.loading
                ? _({ id: "app.agenda.activity.loadingMore", message: "Loading…" })
                : _(A.activityLoadMore)}
            </button>
          </div>
        </Show>
      </Show>
    </div>
  )
}
