import { For, Show, type JSX } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function SettingsPage(props: {
  title: string
  description?: string
  actions?: JSX.Element
  children: JSX.Element
}) {
  return (
    <div class="ds-content-inner">
      <div class="ds-content-header">
        <div class="min-w-0">
          <h1 class="ds-content-title">{props.title}</h1>
          <Show when={props.description}>
            <p class="ds-section-hint">{props.description}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="shrink-0">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

export function SettingsSection(props: { title?: string; description?: string; children: JSX.Element }) {
  return (
    <div class="ds-setting-section">
      <Show when={props.title}>
        <div class="ds-section-label">
          <span>{props.title}</span>
        </div>
      </Show>
      <Show when={props.description}>
        <p class="ds-section-hint">{props.description}</p>
      </Show>
      {props.children}
    </div>
  )
}

export function SettingsFieldGrid(props: { children: JSX.Element }) {
  return <div class="grid grid-cols-1 md:grid-cols-2 gap-3">{props.children}</div>
}

export function SettingsEntityList(props: {
  emptyIcon?: IconName
  emptyTitle: string
  emptyDescription?: string
  children: JSX.Element
  isEmpty: boolean
}) {
  return (
    <Show
      when={!props.isEmpty}
      fallback={
        <div class="ds-empty-state">
          <Icon name={props.emptyIcon ?? getSemanticIcon("state.empty")} size="normal" class="text-text-weaker" />
          <span>{props.emptyTitle}</span>
          <Show when={props.emptyDescription}>
            <span class="text-text-weaker">{props.emptyDescription}</span>
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

export function SettingsPathRow(props: {
  label: string
  path: string
  description?: string
  status?: string
  ownedKeys?: string[]
  mergePolicy?: string
  onCopy?: () => void
  onOpen?: () => void
  opening?: boolean
}) {
  return (
    <div class="ds-path-row">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <span class="settings-path-label truncate">{props.label}</span>
          <Show when={props.status}>
            <span class="ds-inline-badge ds-inline-badge-muted">{props.status}</span>
          </Show>
        </div>
        <Show when={props.description}>
          <div class="settings-path-description mt-0.5">{props.description}</div>
        </Show>
        <div class="ds-path-text" title={props.path}>
          {props.path}
        </div>
        <Show when={props.ownedKeys?.length}>
          <div class="ds-key-list">
            <For each={props.ownedKeys}>{(key) => <span>{key}</span>}</For>
          </div>
        </Show>
        <Show when={props.mergePolicy}>
          <div class="settings-path-meta mt-1">Merge policy: {props.mergePolicy}</div>
        </Show>
      </div>
      <div class="ds-path-actions">
        <Show when={props.onCopy}>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon={getSemanticIcon("action.copy")}
            onClick={props.onCopy}
          >
            Copy Path
          </Button>
        </Show>
        <Show when={props.onOpen}>
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("action.open")}
            disabled={props.opening}
            onClick={props.onOpen}
          >
            {props.opening ? "Opening..." : "Open File"}
          </Button>
        </Show>
      </div>
    </div>
  )
}
