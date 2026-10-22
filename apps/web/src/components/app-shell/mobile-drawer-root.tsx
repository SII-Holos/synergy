import { createMemo, createUniqueId, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { SessionDraftBadge } from "../sidebar/session-draft-badge"
import type { SessionVisualState } from "../sidebar/session-visual-state"

const RECENT_ICON_TONE_CLASS: Partial<Record<SessionVisualState["tone"], string>> = {
  active: "text-icon-base",
  retry: "text-icon-critical-base",
  waiting: "text-icon-critical-base",
  paused: "text-icon-warning-base",
  blueprint: "text-icon-info-base",
  "blueprint-running": "text-icon-success-base",
  "blueprint-waiting": "text-icon-warning-base",
  "blueprint-audit": "text-icon-info-base",
  loop: "text-icon-info-base",
  muted: "text-text-weaker",
}

function recentIconClass(visual: SessionVisualState): string | undefined {
  return RECENT_ICON_TONE_CLASS[visual.tone]
}

function MobileDrawerActionButton(props: { label: string; icon: SemanticIconTokenName; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      class="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-14-medium text-text-base transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong"
      onClick={props.onClick}
    >
      <Icon name={getSemanticIcon(props.icon)} size="normal" class="shrink-0" />
      <span>{props.label}</span>
    </button>
  )
}

export function MobileDrawerAddProjectButton(props: { label: string; onClick: () => void }) {
  return <MobileDrawerActionButton label={props.label} icon="workspace.add" onClick={props.onClick} />
}

export function MobileDrawerSettingsButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      class="flex size-11 shrink-0 items-center justify-center rounded-xl text-icon-weak-base transition-colors hover:bg-surface-raised-base-hover hover:text-icon-base"
      onClick={props.onClick}
    >
      <Icon name={getSemanticIcon("settings.general")} size="normal" />
    </button>
  )
}

export function MobileDrawerAccountRow(props: {
  name: string
  description: string
  avatarSrc: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-action="account"
      class="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-1.5 text-left transition-colors hover:bg-surface-raised-base-hover"
      onClick={props.onClick}
    >
      <img src={props.avatarSrc} alt="" class="size-8 shrink-0 rounded-full" />
      <span class="flex min-w-0 flex-1 flex-col justify-center">
        <span class="truncate text-13-medium text-text-strong">{props.name}</span>
        <span class="truncate text-11-regular text-text-weak">{props.description}</span>
      </span>
      <Icon name={getSemanticIcon("navigation.expand")} size="small" class="shrink-0 text-icon-weak-base" />
    </button>
  )
}

export interface MobileDrawerRecentVisual {
  visual: SessionVisualState
  /** Localized accessibility label; empty while the session is resting. */
  label: string
}

export interface MobileDrawerRecentGroups {
  today: string
  earlier: string
}

export function MobileDrawerRecent(props: {
  label: string
  emptyLabel: string
  loadMoreLabel: string
  untitledLabel: string
  draftLabel: string
  hasDraft: (sessionID: string) => boolean
  entries: NavEntry[]
  currentSessionID?: string
  visualFor: (entry: NavEntry) => MobileDrawerRecentVisual
  hasMore: boolean
  onSelect: (entry: NavEntry) => void
  onLoadMore: () => void
  groups?: MobileDrawerRecentGroups
}) {
  const headingID = createUniqueId()

  // Grouping is opt-in: the flat list stays the default so callers that do not
  // pass labels never render empty headings.
  const grouped = createMemo(() => {
    const labels = props.groups
    if (!labels) return [{ heading: "", entries: props.entries }]
    const todayStart = new Date().setHours(0, 0, 0, 0)
    const buckets: Array<{ heading: string; entries: NavEntry[] }> = []
    for (const entry of props.entries) {
      const heading = entry.lastActivityAt >= todayStart ? labels.today : labels.earlier
      const last = buckets.at(-1)
      if (last?.heading === heading) last.entries.push(entry)
      else buckets.push({ heading, entries: [entry] })
    }
    return buckets
  })

  const row = (entry: NavEntry) => {
    const active = () => entry.id === props.currentSessionID
    const resolved = createMemo(() => props.visualFor(entry))
    return (
      <button
        type="button"
        data-session-id={entry.id}
        aria-current={active() ? "page" : undefined}
        classList={{
          "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors": true,
          "bg-surface-raised-base-hover text-text-strong": active(),
          "text-text-base hover:bg-surface-raised-base-hover hover:text-text-strong": !active(),
        }}
        onClick={() => props.onSelect(entry)}
      >
        <span
          classList={{
            "relative flex size-4 shrink-0 items-center justify-center text-icon-weak-base": true,
            "sb-session-icon-pulse": !!resolved().visual.pulse,
          }}
        >
          <Icon name={resolved().visual.icon} size="small" class={recentIconClass(resolved().visual)} />
          <Show when={resolved().visual.completionUnread}>
            <span class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-icon-critical-base" />
          </Show>
        </span>
        <SessionDraftBadge
          dirty={props.hasDraft(entry.id)}
          sessionID={entry.id}
          label={props.draftLabel}
          class="shrink-0 translate-y-px text-10-medium text-text-error"
        />
        <span class="min-w-0 flex-1 truncate text-13-medium">{entry.title || props.untitledLabel}</span>
        <Show when={resolved().label}>{(label) => <span class="sr-only">{label()}</span>}</Show>
      </button>
    )
  }

  return (
    <section aria-labelledby={headingID}>
      <div class="px-4 pb-1.5 pt-1">
        <h2 id={headingID} class="text-11-medium uppercase tracking-wider text-text-weak">
          {props.label}
        </h2>
      </div>
      <Show
        when={props.entries.length > 0}
        fallback={<div class="px-4 py-3 text-13-regular text-text-weak">{props.emptyLabel}</div>}
      >
        <For each={grouped()}>
          {(bucket) => (
            <div class="px-2">
              <Show when={bucket.heading}>
                <h3 class="px-3 pb-1 pt-2 text-10-medium uppercase tracking-wider text-text-weaker">
                  {bucket.heading}
                </h3>
              </Show>
              <For each={bucket.entries}>{row}</For>
            </div>
          )}
        </For>
        <Show when={props.hasMore}>
          <div class="px-4 pt-1">
            <button
              type="button"
              data-action="load-more-recent"
              class="min-h-11 text-12-medium text-text-weak transition-colors hover:text-text-base"
              onClick={props.onLoadMore}
            >
              {props.loadMoreLabel}
            </button>
          </div>
        </Show>
      </Show>
    </section>
  )
}
