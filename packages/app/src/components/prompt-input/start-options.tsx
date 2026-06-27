import { For, Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"

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

function PromptStartOptionButton(props: { option: PromptStartOption }) {
  const disabled = () => !!props.option.disabled

  const button = (
    <button
      type="button"
      aria-label={props.option.label}
      aria-pressed={props.option.selected}
      aria-disabled={disabled() ? "true" : undefined}
      class="prompt-input-start-option"
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
      }}
    >
      <Icon name={props.option.icon} size="small" class="prompt-input-start-option-icon" />
      <span class="prompt-input-start-option-copy">
        <span class="prompt-input-start-option-label">{props.option.label}</span>
        <Show when={props.option.description}>
          {(description) => <span class="prompt-input-start-option-description">{description()}</span>}
        </Show>
      </span>
      <Show when={props.option.selected}>
        <Icon name="check" size="small" class="prompt-input-start-option-check" />
      </Show>
    </button>
  )

  return (
    <Tooltip placement="top" inactive={!props.option.tooltip} value={props.option.tooltip}>
      {button}
    </Tooltip>
  )
}

export function PromptStartOptions(props: { groups: PromptStartOptionGroup[] }) {
  return (
    <Show when={props.groups.length > 0}>
      <div class="prompt-input-start-options" aria-label="New session options">
        <For each={props.groups}>
          {(group) => (
            <div class="prompt-input-start-group">
              <div class="prompt-input-start-group-label">{group.label}</div>
              <div class="prompt-input-start-group-items" role="group" aria-label={group.label}>
                <For each={group.options}>{(option) => <PromptStartOptionButton option={option} />}</For>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
