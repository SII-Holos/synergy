import { For, Show } from "solid-js"
import { DropdownMenu } from "@ericsanchezok/synergy-ui/dropdown-menu"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"

export type PromptAddMenuItem = {
  id: string
  label: string
  icon: IconName
  onSelect: () => void
  disabled?: boolean
  ariaDisabled?: boolean
  title?: string
  tooltip?: string
  iconClass?: string
  labelClass?: string
  classList?: Record<string, boolean>
}

export type PromptAddMenuSection = {
  id: string
  label?: string
  items: PromptAddMenuItem[]
}

function PromptAddMenuItemRow(props: { item: PromptAddMenuItem }) {
  const row = (
    <DropdownMenu.Item
      disabled={props.item.disabled}
      aria-disabled={props.item.ariaDisabled ? "true" : undefined}
      title={props.item.title}
      classList={props.item.classList}
      onSelect={props.item.onSelect}
    >
      <Icon name={props.item.icon} size="small" class={props.item.iconClass ?? "text-icon-base"} />
      <DropdownMenu.ItemLabel class={props.item.labelClass}>{props.item.label}</DropdownMenu.ItemLabel>
    </DropdownMenu.Item>
  )

  return (
    <Tooltip placement="right" inactive={!props.item.tooltip} value={props.item.tooltip}>
      {row}
    </Tooltip>
  )
}

export function PromptAddMenu(props: { sections: PromptAddMenuSection[] }) {
  return (
    <DropdownMenu placement="top-start" gutter={8}>
      <Tooltip placement="top" value="Add">
        <DropdownMenu.Trigger
          type="button"
          aria-label="Add"
          class="prompt-input-toolbar-icon-button flex items-center justify-center text-icon-base"
        >
          <Icon name="plus" size="small" />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="w-48 bg-surface-raised-stronger-non-alpha">
          <For each={props.sections}>
            {(section, index) => (
              <>
                <Show when={section.label}>
                  <DropdownMenu.GroupLabel class="px-2.5 py-1.5 text-11-medium text-text-subtle">
                    {section.label}
                  </DropdownMenu.GroupLabel>
                </Show>
                <DropdownMenu.Group>
                  <For each={section.items}>{(item) => <PromptAddMenuItemRow item={item} />}</For>
                </DropdownMenu.Group>
                <Show when={index() < props.sections.length - 1}>
                  <DropdownMenu.Separator />
                </Show>
              </>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
