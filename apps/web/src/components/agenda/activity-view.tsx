import { translateDescriptor } from "@/locales/translate"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { AgendaActivityEntry } from "@ericsanchezok/synergy-sdk/client"
import {
  agendaRunDotTone,
  agendaStatusTone,
  formatAgendaDuration,
  agendaStatusLabel,
  agendaRunStatusLabel,
} from "./shared"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { A } from "./agenda-i18n"
import "./activity-view.css"

export type AgendaActivityGroup = {
  agendaID: string
  title: string
  status: string
  tags?: string[]
  entries: AgendaActivityEntry[]
}

export function groupAgendaActivity(items: AgendaActivityEntry[]): AgendaActivityGroup[] {
  const map = new Map<string, AgendaActivityGroup>()
  for (const entry of items) {
    const id = entry.agenda.id
    const existing = map.get(id)
    if (existing) {
      existing.entries.push(entry)
    } else {
      map.set(id, {
        agendaID: id,
        title: entry.agenda.title,
        status: entry.agenda.status,
        tags: entry.agenda.tags,
        entries: [entry],
      })
    }
  }
  return [...map.values()].map((group) => ({
    ...group,
    entries: group.entries.sort((a, b) => b.run.time.started - a.run.time.started),
  }))
}

export function ActivityView(props: {
  items: AgendaActivityEntry[]
  total: number
  hasMore: boolean
  loading: boolean
  query: string
  error?: string | null
  onQueryChange: (value: string) => void
  onRetry?: () => void
  onLoadMore: () => void
  onNavigate: (sessionID: string, scopeID: string) => void
  onItemClick: (itemId: string) => void
}) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }, values?: Record<string, unknown>) =>
    i18n._(values ? { ...d, values } : d)
  let searchInput: HTMLInputElement | undefined
  const grouped = createMemo(() => groupAgendaActivity(props.items))

  return (
    <div class="agenda-activity-surface flex min-h-0 flex-1 flex-col pb-3">
      <div class="mb-3 flex items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <input
            ref={searchInput}
            aria-label={_(A.activitySearchPlaceholder)}
            value={props.query}
            onInput={(e) => props.onQueryChange(e.currentTarget.value)}
            placeholder={_(A.activitySearchPlaceholder)}
            class="workbench-input-surface h-9 w-full rounded-xl border border-border-base/30 bg-surface-raised-base px-3 app-panel-copy text-text-strong outline-none placeholder:text-text-weaker"
          />
        </div>
        <div class="shrink-0 app-panel-caption text-text-weaker">{_(A.activityRuns, { count: props.total })}</div>
      </div>

      <Show when={props.error && props.items.length}>
        <div
          role="alert"
          class="flex flex-wrap items-center justify-between gap-2 pb-3 app-panel-caption text-text-weak"
        >
          <span>{props.error}</span>
          <button type="button" class="agenda-secondary-action" onClick={props.onRetry}>
            {_({ id: "app.agenda.activity.retry", message: "Retry" })}
          </button>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Show
          when={!props.loading || props.items.length > 0}
          fallback={
            <div class="flex items-center justify-center py-16">
              <Spinner class="size-4" />
            </div>
          }
        >
          <Show
            when={grouped().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center py-16 gap-2 rounded-[1.05rem] bg-surface-inset-base ring-1 ring-inset ring-border-base/35">
                <Icon name={getSemanticIcon("agenda.main")} size="large" class="text-icon-weak-base" />
                <span class="app-panel-caption text-text-weaker">
                  {props.error ??
                    (props.query
                      ? _({ id: "app.agenda.activity.noMatch", message: "No matching executions" })
                      : _(A.activityNoHistory))}
                </span>
                <Show when={props.error && props.onRetry}>
                  <button type="button" class="agenda-secondary-action" onClick={props.onRetry}>
                    {_({ id: "app.agenda.activity.retry", message: "Retry" })}
                  </button>
                </Show>
                <Show when={props.query}>
                  <button
                    type="button"
                    class="agenda-secondary-action"
                    onClick={() => {
                      props.onQueryChange("")
                      searchInput?.focus()
                    }}
                  >
                    {_({ id: "app.agenda.activity.clear", message: "Clear filters" })}
                  </button>
                </Show>
              </div>
            }
          >
            <div class="flex flex-col gap-2.5">
              <For each={grouped()}>
                {(group) => (
                  <ActivityGroupCard group={group} onNavigate={props.onNavigate} onItemClick={props.onItemClick} />
                )}
              </For>
            </div>
          </Show>

          <Show when={props.hasMore}>
            <div class="flex justify-center pt-3">
              <button
                type="button"
                class="workbench-control-surface inline-flex h-9 items-center justify-center rounded-xl bg-surface-raised-base px-4 app-panel-caption font-medium text-text-strong ring-1 ring-inset ring-border-base/30 transition-colors hover:bg-surface-raised-base-hover"
                onClick={props.onLoadMore}
              >
                {_(A.activityLoadMore)}
              </button>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function ActivityGroupCard(props: {
  group: AgendaActivityGroup
  onNavigate: (sessionID: string, scopeID: string) => void
  onItemClick: (itemId: string) => void
}) {
  const { i18n } = useLocale()
  const [expanded, setExpanded] = createSignal(true)

  return (
    <div class="workbench-control-surface overflow-hidden rounded-xl bg-surface-inset-base ring-1 ring-inset ring-border-base/30">
      <div class="flex items-center gap-2 pr-3">
        <button
          type="button"
          aria-expanded={expanded()}
          class="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-raised-base-hover"
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon
            name={getSemanticIcon("navigation.expand")}
            size="small"
            class={`shrink-0 text-icon-weak-base transition-transform duration-120 ${expanded() ? "rotate-90" : ""}`}
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <span class="truncate app-panel-row-title text-text-strong">{props.group.title}</span>
              <span
                class={`shrink-0 rounded-full px-2 py-0.5 app-panel-caption font-medium ${agendaStatusTone(props.group.status)}`}
              >
                {translateDescriptor(agendaStatusLabel(props.group.status), i18n)}
              </span>
            </div>
            <Show when={(props.group.tags?.length ?? 0) > 0}>
              <div class="mt-1 flex flex-wrap gap-1">
                <For each={props.group.tags?.slice(0, 3) ?? []}>
                  {(tag) => (
                    <span class="rounded-full bg-surface-raised-base px-2 py-0.5 app-panel-caption font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                      {tag}
                    </span>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </button>
        <button
          type="button"
          aria-label={i18n._({ ...A.detailRuns, values: { count: props.group.entries.length } })}
          class="min-h-8 shrink-0 rounded-full bg-surface-raised-stronger-non-alpha px-2 app-panel-caption font-medium text-text-weaker ring-1 ring-inset ring-border-base/45"
          onClick={() => props.onItemClick(props.group.agendaID)}
        >
          {props.group.entries.length}
        </button>
      </div>

      <div
        class="activity-group-content"
        classList={{ "is-open": expanded() }}
        aria-hidden={!expanded()}
        inert={!expanded()}
      >
        <div class="activity-group-content-inner">
          <div class="flex flex-col gap-1.5 px-2.5 pb-2.5">
            <For each={props.group.entries}>
              {(entry) => <ActivityRunRow entry={entry} onNavigate={props.onNavigate} />}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}

function ActivityRunRow(props: {
  entry: AgendaActivityEntry
  onNavigate: (sessionID: string, scopeID: string) => void
}) {
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const session = () => props.entry.session
  const title = () => {
    const sessionTitle = session()?.title
    if (sessionTitle) return sessionTitle
    if (props.entry.run.status === "error") return props.entry.run.error ?? _(A.activityRunError)
    return props.entry.run.id
  }

  return (
    <button
      type="button"
      disabled={!session()}
      class="workbench-card-surface flex w-full items-start gap-2.5 rounded-xl bg-surface-raised-base px-3.5 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover"
      onClick={() => {
        const s = session()
        if (s) props.onNavigate(s.id, s.scopeID)
      }}
    >
      <span class={`mt-1 shrink-0 h-1.5 w-1.5 rounded-full ${agendaRunDotTone(props.entry.run.status)}`} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="min-w-0 truncate app-panel-copy text-text-strong">{title()}</span>
          <span
            class={`shrink-0 app-panel-caption font-medium ${props.entry.run.status === "error" ? "text-text-diff-delete-base" : props.entry.run.status === "ok" ? "text-text-on-success-base" : "text-text-weaker"}`}
          >
            {translateDescriptor(agendaRunStatusLabel(props.entry.run.status), i18n)}
          </span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 app-panel-caption text-text-weaker">
          <span>{absoluteDate(fmt, props.entry.run.time.started)}</span>
          <span>·</span>
          <span>{relativeTime(fmt, props.entry.run.time.started)}</span>
          <Show when={props.entry.run.duration != null}>
            <>
              <span>·</span>
              <span>{formatAgendaDuration(props.entry.run.duration!)}</span>
            </>
          </Show>
          <Show when={session()}>
            <>
              <span>·</span>
              <span class="truncate">{_(A.activitySessionReady)}</span>
            </>
          </Show>
        </div>
        <Show when={props.entry.run.error}>
          <div class="mt-1 line-clamp-2 app-panel-caption leading-relaxed text-text-diff-delete-base">
            {props.entry.run.error}
          </div>
        </Show>
      </div>
    </button>
  )
}
