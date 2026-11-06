import { useSettingsViewState } from "../settings-view-state"
import { createEffect, createSignal, createUniqueId, For, Show, onCleanup, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

function mergePolicyText(policy: string) {
  return { id: "settings.pathRow.mergePolicy", message: "Merge policy: {policy}", values: { policy } }
}
const copyPathLabel = { id: "settings.pathRow.copy", message: "Copy Path" }
const copiedLabel = { id: "settings.pathRow.copied", message: "Copied" }
const openFileLabel = { id: "settings.pathRow.open", message: "Open File" }
const openingLabel = { id: "settings.pathRow.opening", message: "Opening..." }

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
          <div class="ds-content-header-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

export function SettingsSection(props: {
  title?: string
  description?: string
  actions?: JSX.Element
  children: JSX.Element
}) {
  return (
    <div class="ds-setting-section">
      <Show when={props.title || props.description || props.actions}>
        <div class="ds-section-heading">
          <div class="min-w-0 flex-1">
            <Show when={props.title}>
              <h2 class="ds-section-label">{props.title}</h2>
            </Show>
            <Show when={props.description}>
              <p class="ds-section-hint">{props.description}</p>
            </Show>
          </div>
          <Show when={props.actions}>
            <div class="ds-section-actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  )
}

export function SettingsAdvanced(props: {
  id?: string
  title: string
  forceOpen?: boolean
  fields?: readonly string[]
  children: JSX.Element
}) {
  const state = useSettingsViewState()
  const key = props.id ?? props.title
  const [open, setOpen] = createSignal(state?.expanded(key) ?? false)
  createEffect(() => {
    const field = state?.searchField()?.trim().toLocaleLowerCase()
    if (props.forceOpen || (field && props.fields?.some((label) => label.trim().toLocaleLowerCase() === field)))
      setOpen(true)
  })
  return (
    <details
      class="settings-advanced"
      open={open()}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        state?.setExpanded(key, event.currentTarget.open)
      }}
    >
      <summary>
        {props.title}
        <Icon name={getSemanticIcon("navigation.expand")} size="small" />
      </summary>
      <Show when={open()}>
        <div class="settings-advanced-content">{props.children}</div>
      </Show>
    </details>
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
  compact?: boolean
  expanded?: boolean
  label: string
  path: string
  description?: string
  status?: string
  ownedKeys?: string[]
  mergePolicy?: string
  onOpen?: () => void
  opening?: boolean
}) {
  const { _ } = useLingui()
  const state = useSettingsViewState()
  const [open, setOpen] = createSignal(props.expanded || state?.expanded(props.label) || false)
  let indexElement: HTMLDetailsElement | undefined
  let focusVersion = 0
  onCleanup(() => {
    focusVersion++
  })
  createEffect(() => {
    if (!props.expanded) return
    setOpen(true)
    const version = ++focusVersion
    requestAnimationFrame(async () => {
      const panel = indexElement?.closest(".settings-panel-content")
      await Promise.allSettled(
        (panel?.getAnimations({ subtree: true }) ?? [])
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      )
      if (version !== focusVersion || !indexElement?.isConnected) return
      indexElement.scrollIntoView({ block: "center" })
      indexElement.querySelector("summary")?.focus({ preventScroll: true })
    })
  })
  const copy = createCopyController({
    text: () => props.path,
    copyLabel: "Copy path",
    failureDescription: "Unable to copy the path.",
  })

  const content = () => (
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
          <div class="settings-path-meta mt-1">{_(mergePolicyText(props.mergePolicy!))}</div>
        </Show>
      </div>
      <div class="ds-path-actions">
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon={copy.copied() ? getSemanticIcon("state.success") : copy.icon()}
          aria-label={_({
            id: "settings.pathRow.copy.named",
            message: "Copy path: {name}",
            values: { name: props.label },
          })}
          data-copy-state={copy.state()}
          disabled={copy.disabled()}
          onClick={() => void copy.copy()}
        >
          {copy.copied() ? _(copiedLabel) : _(copyPathLabel)}
        </Button>
        <Show when={props.onOpen}>
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("action.open")}
            aria-label={_({
              id: "settings.pathRow.open.named",
              message: "Open file: {name}",
              values: { name: props.label },
            })}
            disabled={props.opening}
            onClick={props.onOpen}
          >
            {props.opening ? _(openingLabel) : _(openFileLabel)}
          </Button>
        </Show>
      </div>
    </div>
  )
  return (
    <Show when={props.compact} fallback={content()}>
      <details
        ref={indexElement}
        class="ds-path-index"
        open={open()}
        onToggle={(event) => {
          setOpen(event.currentTarget.open)
          state?.setExpanded(props.label, event.currentTarget.open)
        }}
      >
        <summary>
          <span class="settings-path-label">{props.label}</span>
          <Show when={props.status}>
            <span class="ds-inline-badge ds-inline-badge-muted">{props.status}</span>
          </Show>
          <Icon name={getSemanticIcon("navigation.expand")} size="small" />
        </summary>
        {content()}
      </details>
    </Show>
  )
}

export function SettingsSubsection(props: { title?: string; description?: string; children: JSX.Element }) {
  return (
    <div class="ds-setting-subsection">
      <Show when={props.title}>
        <h3 class="ds-subsection-title">{props.title}</h3>
      </Show>
      <Show when={props.description}>
        <p class="ds-section-hint">{props.description}</p>
      </Show>
      {props.children}
    </div>
  )
}

export function SettingsTabs<T extends string>(props: {
  id?: string
  value: T
  label: string
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const id = props.id ?? createUniqueId()
  return (
    <div class="settings-subviews" role="tablist" aria-label={props.label}>
      <For each={props.options}>
        {(option, index) => (
          <button
            type="button"
            role="tab"
            id={`${id}-tab-${option.value}`}
            aria-controls={`${id}-view-${option.value}`}
            aria-selected={props.value === option.value}
            tabIndex={props.value === option.value ? 0 : -1}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              event.preventDefault()
              const count = props.options.length
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? count - 1
                    : (index() + (event.key === "ArrowRight" ? 1 : count - 1)) % count
              props.onChange(props.options[next]!.value)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus()
            }}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}
