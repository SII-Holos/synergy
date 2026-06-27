import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"

export type PromptAddMenuItem = {
  id: string
  label: string
  description?: string
  icon: IconName
  onSelect: (event?: Event) => void
  selected?: boolean
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
    <div
      title={props.item.title}
      classList={{
        "flex items-center justify-between gap-3 px-2 py-1.5": true,
        "opacity-45": !!props.item.ariaDisabled || !!props.item.disabled,
        ...(props.item.classList ?? {}),
      }}
    >
      <div class="flex min-w-0 items-center gap-2">
        <Icon name={props.item.icon} size="small" class={`shrink-0 ${props.item.iconClass ?? "text-icon-base"}`} />
        <div class={`text-13-medium text-text-base truncate ${props.item.labelClass ?? ""}`}>{props.item.label}</div>
      </div>
    </div>
  )

  return (
    <Tooltip placement="right" inactive={!props.item.tooltip} value={props.item.tooltip}>
      {row}
    </Tooltip>
  )
}

export function PromptAddMenu(props: { sections: PromptAddMenuSection[] }) {
  const items = () => props.sections.flatMap((section) => section.items)
  const currentItem = () => items().find((item) => item.selected)

  return (
    <ToolbarSelectorPopover
      trigger={
        <Tooltip placement="top" value="Add">
          <button
            type="button"
            aria-label="Add"
            class="prompt-input-toolbar-icon-button flex items-center justify-center text-icon-base"
          >
            <Icon name={getSemanticIcon("action.add")} size="small" />
          </button>
        </Tooltip>
      }
      title="Add"
      contentClass="w-52 max-h-80"
      placement="top-start"
    >
      {(close) => (
        <List
          class="p-1"
          items={items()}
          key={(item) => item.id}
          current={currentItem()}
          onSelect={(item) => {
            if (!item) return
            if (item.disabled || item.ariaDisabled) return
            item.onSelect()
            close()
          }}
        >
          {(item) => <PromptAddMenuItemRow item={item} />}
        </List>
      )}
    </ToolbarSelectorPopover>
  )
}
