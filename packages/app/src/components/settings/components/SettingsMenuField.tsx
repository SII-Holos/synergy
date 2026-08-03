import { createSignal, For, Show, type JSX } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Portal } from "solid-js/web"

export type SettingsMenuOption<T extends string> = {
  value: T
  label: string
  count?: number
}

export function SettingsMenuField<T extends string>(props: {
  value: T
  options: SettingsMenuOption<T>[]
  ariaLabel: string
  disabled?: boolean
  popoverLayer?: HTMLElement
  onChange: (value: T) => void
  children?: (option: SettingsMenuOption<T>) => JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  const current = () => props.options.find((option) => option.value === props.value) ?? props.options[0]

  function select(option: SettingsMenuOption<T>) {
    props.onChange(option.value)
    setOpen(false)
  }

  const content = () => (
    <KobaltePopover.Content class="settings-menu-field-surface flex flex-col outline-none">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class="settings-menu-field-item"
            classList={{ "is-active": option.value === props.value }}
            onClick={() => select(option)}
          >
            <span>{props.children ? props.children(option) : option.label}</span>
            <Show when={option.count !== undefined}>
              <span class="settings-menu-field-count">{option.count}</span>
            </Show>
          </button>
        )}
      </For>
    </KobaltePopover.Content>
  )

  return (
    <KobaltePopover open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={8}>
      <KobaltePopover.Trigger
        type="button"
        class="settings-menu-field-trigger"
        aria-label={props.ariaLabel}
        disabled={props.disabled}
      >
        <span class="settings-menu-field-value">{current()?.label ?? ""}</span>
        <Icon
          name={getSemanticIcon("navigation.collapse")}
          size="small"
          class="settings-menu-field-chevron opacity-60"
        />
      </KobaltePopover.Trigger>
      <Show when={props.popoverLayer} fallback={content()}>
        {(layer) => <Portal mount={layer()}>{content()}</Portal>}
      </Show>
    </KobaltePopover>
  )
}
