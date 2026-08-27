import { createUniqueId, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { NavEntry } from "@/context/layout"
import { SessionDraftBadge } from "../sidebar/session-draft-badge"

function MobileDrawerActionButton(props: { label: string; icon: SemanticIconTokenName; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      class="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-14-medium text-text-base transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus-base"
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
  return <MobileDrawerActionButton label={props.label} icon="settings.general" onClick={props.onClick} />
}

export function MobileDrawerRecent(props: {
  label: string
  emptyLabel: string
  loadMoreLabel: string
  untitledLabel: string
  draftLabel: string
  entries: NavEntry[]
  currentSessionID?: string
  unreadLabel: (entry: NavEntry) => string | undefined
  hasMore: boolean
  onSelect: (entry: NavEntry) => void
  onLoadMore: () => void
}) {
  const headingID = createUniqueId()
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
        <div class="px-2">
          <For each={props.entries}>
            {(entry) => {
              const active = () => entry.id === props.currentSessionID
              return (
                <button
                  type="button"
                  data-session-id={entry.id}
                  aria-current={active() ? "page" : undefined}
                  classList={{
                    "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus-base": true,
                    "bg-surface-raised-base-hover text-text-strong": active(),
                    "text-text-base hover:bg-surface-raised-base-hover hover:text-text-strong": !active(),
                  }}
                  onClick={() => props.onSelect(entry)}
                >
                  <span class="relative flex size-4 shrink-0 items-center justify-center text-icon-weak-base">
                    <Icon name={getSemanticIcon("session.default")} size="small" />
                    <Show when={entry.completionNotice?.unread}>
                      <span class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-icon-critical-base" />
                    </Show>
                  </span>
                  <SessionDraftBadge
                    sessionID={entry.id}
                    label={props.draftLabel}
                    class="shrink-0 translate-y-px text-10-medium text-text-error"
                  />
                  <span class="min-w-0 flex-1 truncate text-13-medium">{entry.title || props.untitledLabel}</span>
                  <Show when={props.unreadLabel(entry)}>{(label) => <span class="sr-only">{label()}</span>}</Show>
                </button>
              )
            }}
          </For>
        </div>
        <Show when={props.hasMore}>
          <div class="px-4 pt-1">
            <button
              type="button"
              data-action="load-more-recent"
              class="min-h-11 text-12-medium text-text-weak transition-colors hover:text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-base"
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
