import { For, Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
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

function PromptStartModeItem(props: { option: PromptStartOption; close: () => void }) {
  const disabled = () => !!props.option.disabled

  const button = (
    <button
      type="button"
      aria-label={props.option.label}
      aria-pressed={props.option.selected}
      aria-disabled={disabled() ? "true" : undefined}
      class="prompt-input-start-mode-item"
      classList={{
        "is-selected": props.option.selected,
        "is-disabled": disabled(),
      }}
      onClick={(event) => {
        if (disabled()) {
          event.preventDefault()
          return
        }
        props.option.onSelect()
        props.close()
      }}
    >
      <Icon name={props.option.icon} size="small" class="prompt-input-start-mode-icon" />
      <span class="prompt-input-start-mode-copy">
        <span class="prompt-input-start-mode-label">{props.option.label}</span>
        <Show when={props.option.description}>
          {(description) => <span class="prompt-input-start-mode-description">{description()}</span>}
        </Show>
      </span>
      <Show when={props.option.selected}>
        <Icon name="check" size="small" class="prompt-input-start-mode-check" />
      </Show>
    </button>
  )

  return (
    <Tooltip placement="top" inactive={!props.option.tooltip} value={props.option.tooltip}>
      {button}
    </Tooltip>
  )
}

export function PromptStartModeSelector(props: { groups: PromptStartOptionGroup[] }) {
  const selectedOption = () => props.groups.flatMap((group) => group.options).find((option) => option.selected)

  return (
    <Show when={props.groups.length > 0}>
      <ToolbarSelectorPopover
        trigger={
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
        }
        title="Start mode"
        contentClass="w-64"
        placement="top-start"
      >
        {(close) => (
          <div class="prompt-input-start-mode-menu">
            <For each={props.groups}>
              {(group) => (
                <div class="prompt-input-start-mode-group">
                  <div class="prompt-input-start-mode-group-label">{group.label}</div>
                  <For each={group.options}>{(option) => <PromptStartModeItem option={option} close={close} />}</For>
                </div>
              )}
            </For>
          </div>
        )}
      </ToolbarSelectorPopover>
    </Show>
  )
}
