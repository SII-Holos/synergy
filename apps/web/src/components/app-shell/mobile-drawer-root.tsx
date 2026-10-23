import { createMemo, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
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
    <button type="button" aria-label={props.label} class="mobile-drawer-action w-full" onClick={props.onClick}>
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
      class="mobile-drawer-action mobile-drawer-icon-action"
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
  onClick?: () => void
}) {
  return (
    <Dynamic
      component={props.onClick ? "button" : "div"}
      type={props.onClick ? "button" : undefined}
      data-action={props.onClick ? "account" : undefined}
      class="mobile-drawer-label flex min-h-11 min-w-0 flex-1 items-center gap-2.5 p-2"
      classList={{ "mobile-drawer-action": !!props.onClick }}
      onClick={props.onClick}
    >
      <img src={props.avatarSrc} alt="" class="size-8 shrink-0 rounded-full" />
      <span class="flex min-w-0 flex-1 flex-col justify-center">
        <span class="truncate text-text-strong">{props.name}</span>
        <span class="truncate text-11-regular text-text-weak">{props.description}</span>
      </span>
      <Show when={props.onClick}>
        <Icon name={getSemanticIcon("navigation.expand")} size="small" class="shrink-0 text-icon-weak-base" />
      </Show>
    </Dynamic>
  )
}

export interface MobileDrawerRecentVisual {
  visual: SessionVisualState
  /** Localized accessibility label; empty while the session is resting. */
  label: string
}

export interface MobileDrawerRecentGroups {
  pinned: string
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
  // Grouping is opt-in: the flat list stays the default so callers that do not
  // pass labels never render empty headings.
  //
  // Entries arrive in production order, where pinned sessions sort ahead of
  // everything else and are therefore interleaved with `lastActivityAt`. Folding
  // by run of equal heading would emit Earlier/Today/Earlier for a pinned old
  // session above a fresh one, so buckets are keyed by heading and emitted in
  // fixed order: pinned keeps its own heading, then today, then earlier.
  const grouped = createMemo(() => {
    const labels = props.groups
    if (!labels) return [{ heading: "", entries: props.entries }]
    const todayStart = new Date().setHours(0, 0, 0, 0)
    const pinned: NavEntry[] = []
    const today: NavEntry[] = []
    const earlier: NavEntry[] = []
    for (const entry of props.entries) {
      if (entry.pinned) pinned.push(entry)
      else if (entry.lastActivityAt >= todayStart) today.push(entry)
      else earlier.push(entry)
    }
    return [
      { heading: labels.pinned, entries: pinned },
      { heading: labels.today, entries: today },
      { heading: labels.earlier, entries: earlier },
    ].filter((bucket) => bucket.entries.length > 0)
  })

  const row = (entry: NavEntry) => {
    const active = () => entry.id === props.currentSessionID
    const resolved = createMemo(() => props.visualFor(entry))
    return (
      <button
        type="button"
        data-session-id={entry.id}
        aria-current={active() ? "page" : undefined}
        class="mobile-drawer-action w-full"
        onClick={() => props.onSelect(entry)}
      >
        <span
          classList={{
            "relative flex size-5 shrink-0 items-center justify-center text-icon-weak-base": true,
            "sb-session-icon-pulse": !!resolved().visual.pulse,
          }}
        >
          <Icon name={resolved().visual.icon} size="normal" class={recentIconClass(resolved().visual)} />
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
        <span class="min-w-0 flex-1 truncate">{entry.title || props.untitledLabel}</span>
        <Show when={resolved().label}>{(label) => <span class="sr-only">{label()}</span>}</Show>
      </button>
    )
  }

  return (
    <section aria-label={props.label}>
      <Show
        when={props.entries.length > 0}
        fallback={<div class="mobile-drawer-label px-4 py-3 text-text-weak">{props.emptyLabel}</div>}
      >
        <For each={grouped()}>
          {(bucket) => (
            <div class="px-4">
              <Show when={bucket.heading}>
                <h3 class="mobile-drawer-section-label">{bucket.heading}</h3>
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
              class="mobile-drawer-action"
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
