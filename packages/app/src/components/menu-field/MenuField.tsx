import { Popover } from "@kobalte/core/popover"
import { Listbox, Item, ItemLabel } from "@kobalte/core/listbox"
import { createSignal, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import "./menu-field.css"

export type MenuFieldOption<T extends string> = {
  value: T
  label: string
  count?: number
  disabled?: boolean
}

type MenuFieldBaseProps<T extends string> = {
  options: MenuFieldOption<T>[]
  ariaLabel: string
  disabled?: boolean
  placement?: "bottom-start" | "bottom-end"
  popoverLayer?: HTMLElement
  surfaceClass?: string
  /** Overrides the trigger class when the host surface styles it (e.g. Library sort buttons). */
  triggerClass?: string
  /** Overrides the trigger label instead of deriving it from the current value. */
  triggerLabel?: string
  /** Renders an extra action row above the option list; `close` closes the popover. */
  leading?: (close: () => void) => JSX.Element
  children?: (option: MenuFieldOption<T>) => JSX.Element
}

export type MenuFieldSingleProps<T extends string> = MenuFieldBaseProps<T> & {
  multiple?: false
  value: T
  onChange: (value: T) => void
}

export type MenuFieldMultipleProps<T extends string> = MenuFieldBaseProps<T> & {
  multiple: true
  value: T[]
  onChange: (value: T[]) => void
}

export type MenuFieldProps<T extends string> = MenuFieldSingleProps<T> | MenuFieldMultipleProps<T>

export function MenuField<T extends string>(props: MenuFieldProps<T>) {
  const [open, setOpen] = createSignal(false)
  const multiple = () => props.multiple === true
  const selected = () =>
    multiple() ? (props as MenuFieldMultipleProps<T>).value : [(props as MenuFieldSingleProps<T>).value]
  const current = () => props.options.find((option) => option.value === (props as MenuFieldSingleProps<T>).value)
  const triggerText = () => props.triggerLabel ?? current()?.label ?? ""

  function handleChange(next: Set<string>) {
    const values = [...next] as T[]
    if (multiple()) {
      ;(props as MenuFieldMultipleProps<T>).onChange(values)
    } else {
      const value = values[0]
      // Kobalte fires selection changes even when the same option is pressed
      // again; only surface a change when the value actually differs.
      if (value !== undefined && value !== (props as MenuFieldSingleProps<T>).value) {
        ;(props as MenuFieldSingleProps<T>).onChange(value)
      }
    }
    if (!multiple()) setOpen(false)
  }

  const content = () => (
    <Popover.Content class={`menu-field-surface ${props.surfaceClass ?? ""}`}>
      {props.leading?.(() => setOpen(false))}
      <Listbox
        class="menu-field-list"
        options={props.options}
        optionValue={(option) => option.value}
        optionTextValue={(option) => option.label}
        optionDisabled={(option) => option.disabled ?? false}
        selectionMode={multiple() ? "multiple" : "single"}
        disallowEmptySelection={!multiple()}
        allowDuplicateSelectionEvents={!multiple()}
        value={selected()}
        onChange={handleChange}
        renderItem={(node) => {
          const option = node.rawValue as MenuFieldOption<T>
          return (
            <Item item={node} class="menu-field-item">
              <ItemLabel class="menu-field-item-label">
                {props.children ? props.children(option) : option.label}
              </ItemLabel>
              <Show when={option.count !== undefined}>
                <span class="menu-field-count">{option.count}</span>
              </Show>
            </Item>
          )
        }}
      />
    </Popover.Content>
  )

  return (
    <Popover open={open()} onOpenChange={setOpen} placement={props.placement ?? "bottom-start"} gutter={8}>
      <Popover.Trigger
        as="button"
        type="button"
        class={props.triggerClass ?? "menu-field-trigger"}
        aria-label={triggerText() ? `${props.ariaLabel}: ${triggerText()}` : props.ariaLabel}
        disabled={props.disabled}
      >
        <span class={props.triggerClass ? undefined : "menu-field-value"}>{triggerText()}</span>
        <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="menu-field-chevron" />
      </Popover.Trigger>
      <Show when={props.popoverLayer} fallback={<Popover.Portal>{content()}</Popover.Portal>}>
        {(layer) => <Portal mount={layer()}>{content()}</Portal>}
      </Show>
    </Popover>
  )
}
