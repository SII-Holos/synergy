import { Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"

export type PromptStartOption = {
  id: string
  label: string
  description?: string
  icon: IconName
  selected: boolean
  disabled?: boolean
  tooltip?: string
  onSelect: () => void
}

export type PromptStartOptionGroup = {
  id: string
  label: string
  options: PromptStartOption[]
}

function PromptStartModeItem(props: { option: PromptStartOption }) {
  const disabled = () => !!props.option.disabled

  const row = (
    <div
      title={props.option.tooltip}
      classList={{
        "flex items-center justify-between gap-3 px-2 py-1.5": true,
        "opacity-45": disabled(),
      }}
    >
      <div class="flex min-w-0 items-center gap-2">
        <Icon name={props.option.icon} size="small" class="shrink-0 text-icon-base" />
        <div class="text-13-medium text-text-base truncate">{props.option.label}</div>
      </div>
    </div>
  )

  return (
    <Tooltip placement="right" inactive={!props.option.tooltip} value={props.option.tooltip}>
      {row}
    </Tooltip>
  )
}

export function PromptStartModeSelector(props: { groups: PromptStartOptionGroup[] }) {
  const options = () => props.groups.flatMap((group) => group.options)
  const selectedOption = () => props.groups.flatMap((group) => group.options).find((option) => option.selected)

  return (
    <Show when={props.groups.length > 0}>
      <ToolbarSelectorPopover
        trigger={
          <Tooltip placement="top" value="Start mode">
            <button
              type="button"
              aria-label="Start mode"
              class="prompt-input-toolbar-button prompt-input-compact-control flex items-center gap-1.5 transition-colors"
            >
              <Icon name={selectedOption()?.icon ?? "circle"} size="small" class="shrink-0 text-icon-base" />
              <span class="prompt-input-compact-label text-12-medium whitespace-nowrap text-text-base">
                {selectedOption()?.label ?? "Start"}
              </span>
              <Icon name="chevron-down" size="small" class="prompt-input-compact-chevron opacity-70 shrink-0" />
            </button>
          </Tooltip>
        }
        title="Start mode"
        contentClass="w-52 max-h-80"
        placement="top-start"
      >
        {(close) => (
          <List
            class="p-1"
            items={options()}
            key={(option) => option.id}
            current={selectedOption()}
            onSelect={(option) => {
              if (!option) return
              if (option.disabled) return
              option.onSelect()
              close()
            }}
          >
            {(option) => <PromptStartModeItem option={option} />}
          </List>
        )}
      </ToolbarSelectorPopover>
    </Show>
  )
}
