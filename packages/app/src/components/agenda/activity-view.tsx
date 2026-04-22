import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { relativeTime, absoluteDate } from "@/utils/time"
import type { AgendaActivityEntry } from "@ericsanchezok/synergy-sdk/client"

export type AgendaActivityGroup = {
  agendaID: string
  title: string
  status: string
  tags?: string[]
  entries: AgendaActivityEntry[]
}

function runStatusTone(status: string) {
  if (status === "ok") return "bg-icon-success-base"
  if (status === "error") return "bg-text-diff-delete-base"
  return "bg-text-weaker/40"
}

function statusPillTone(status: string) {
  if (status === "active") return "bg-icon-success-base/12 text-icon-success-base ring-icon-success-base/15"
  if (status === "paused") return "bg-icon-warning-base/14 text-icon-warning-base ring-icon-warning-base/15"
  if (status === "done") return "bg-surface-inset-base/85 text-text-weak ring-border-base/40"
  if (status === "cancelled")
    return "bg-text-diff-delete-base/12 text-text-diff-delete-base ring-text-diff-delete-base/12"
  return "bg-surface-interactive-selected-weak text-text-interactive-base ring-border-interactive-base/15"
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
  onQueryChange: (value: string) => void
  onLoadMore: () => void
  onNavigate: (sessionID: string, scopeID: string) => void
  onItemClick: (itemId: string) => void
}) {
  const grouped = createMemo(() => groupAgendaActivity(props.items))

  return (
    <div class="flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div class="mb-2.5 flex items-center gap-2 rounded-[1rem] bg-surface-inset-base/42 p-2.5 ring-1 ring-inset ring-border-base/45 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
        <div class="relative min-w-0 flex-1">
          <Icon
            name="search"
            size="small"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-icon-weak"
          />
          <input
            value={props.query}
            onInput={(e) => props.onQueryChange(e.currentTarget.value)}
            placeholder="Search activity, agenda title, errors..."
            class="h-9 w-full rounded-[0.9rem] border border-border-base/40 bg-surface-raised-base/92 pl-9 pr-3 text-12-regular text-text-strong outline-none placeholder:text-text-weaker shadow-[inset_0_1px_0_rgba(214,204,190,0.08)]"
          />
        </div>
        <div class="shrink-0 rounded-full bg-surface-raised-stronger-non-alpha px-2.5 py-1 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/45">
          {props.total} runs
        </div>
      </div>

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
              <div class="flex flex-col items-center justify-center py-16 gap-2 rounded-[1.05rem] bg-surface-inset-base/24 ring-1 ring-inset ring-border-base/35">
                <Icon name="clock" size="large" class="text-icon-weak" />
                <span class="text-12-regular text-text-weaker">No activity found</span>
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
                class="inline-flex h-9 items-center justify-center rounded-full bg-surface-raised-base px-4 text-11-medium text-text-strong ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.08)] transition-colors hover:bg-surface-raised-base-hover"
                onClick={props.onLoadMore}
              >
                Load more
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
  const [expanded, setExpanded] = createSignal(true)

  return (
    <div class="overflow-hidden rounded-[1.1rem] bg-surface-inset-base/34 ring-1 ring-inset ring-border-base/40 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-raised-base-hover/18"
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon
          name="chevron-right"
          size="small"
          class={`shrink-0 text-icon-weak transition-transform duration-150 ${expanded() ? "rotate-90" : ""}`}
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <span class="truncate text-11-medium text-text-strong">{props.group.title}</span>
            <span
              class={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium ring-1 ring-inset ${statusPillTone(props.group.status)}`}
            >
              {props.group.status}
            </span>
          </div>
          <Show when={(props.group.tags?.length ?? 0) > 0}>
            <div class="mt-1 flex flex-wrap gap-1">
              <For each={props.group.tags?.slice(0, 3) ?? []}>
                {(tag) => (
                  <span class="rounded-full bg-surface-raised-base/88 px-2 py-0.5 text-[9px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/35">
                    {tag}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-full bg-surface-raised-stronger-non-alpha px-2 py-0.5 text-[10px] font-medium text-text-weaker ring-1 ring-inset ring-border-base/45"
          onClick={(e) => {
            e.stopPropagation()
            props.onItemClick(props.group.agendaID)
          }}
        >
          {props.group.entries.length}
        </button>
      </button>

      <Show when={expanded()}>
        <div class="flex flex-col gap-1.5 px-2.5 pb-2.5">
          <For each={props.group.entries}>
            {(entry) => <ActivityRunRow entry={entry} onNavigate={props.onNavigate} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

function ActivityRunRow(props: {
  entry: AgendaActivityEntry
  onNavigate: (sessionID: string, scopeID: string) => void
}) {
  const session = () => props.entry.session
  const title = () => {
    const sessionTitle = session()?.title
    if (sessionTitle) return sessionTitle
    if (props.entry.run.status === "error") return props.entry.run.error ?? "Run error"
    return props.entry.run.id
  }

  return (
    <div
      class="flex items-start gap-2.5 rounded-[0.95rem] bg-surface-raised-base/90 px-3.5 py-2.5 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)] transition-colors hover:bg-surface-raised-base"
      onClick={() => {
        const s = session()
        if (s) props.onNavigate(s.id, s.scopeID)
      }}
    >
      <span class={`mt-1 shrink-0 h-1.5 w-1.5 rounded-full ${runStatusTone(props.entry.run.status)}`} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-11-regular text-text-strong">{title()}</span>
          <span
            class={`shrink-0 text-[10px] font-medium ${props.entry.run.status === "error" ? "text-text-diff-delete-base" : props.entry.run.status === "ok" ? "text-icon-success-base" : "text-text-weaker"}`}
          >
            {props.entry.run.status}
          </span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-text-weaker">
          <span>{absoluteDate(props.entry.run.time.started)}</span>
          <span>·</span>
          <span>{relativeTime(props.entry.run.time.started)}</span>
          <Show when={props.entry.run.duration != null}>
            <>
              <span>·</span>
              <span>{formatDuration(props.entry.run.duration!)}</span>
            </>
          </Show>
          <Show when={session()}>
            <>
              <span>·</span>
              <span class="truncate">session ready</span>
            </>
          </Show>
        </div>
        <Show when={props.entry.run.error}>
          <div class="mt-1 line-clamp-2 text-[10px] leading-relaxed text-text-diff-delete-base">
            {props.entry.run.error}
          </div>
        </Show>
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
