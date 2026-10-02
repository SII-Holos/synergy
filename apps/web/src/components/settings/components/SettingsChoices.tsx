import { useSettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import { RadioGroup } from "@kobalte/core/radio-group"
import { For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function SettingsChoices<T extends string>(props: {
  value: T
  ariaLabel: string
  options: { value: T; label: string; description?: string }[]
  onChange: (value: T) => void
  class?: string
}) {
  const row = useSettingRow()
  return (
    <RadioGroup
      class={`settings-choices ${props.class ?? ""}`}
      value={props.value}
      onChange={(value) => {
        const option = props.options.find((option) => option.value === value)
        if (option) props.onChange(option.value)
      }}
      aria-label={props.ariaLabel}
      aria-describedby={row?.descriptionId || undefined}
    >
      <For each={props.options}>
        {(option) => (
          <RadioGroup.Item value={option.value} class="settings-choice">
            <RadioGroup.ItemInput />
            <RadioGroup.ItemLabel>
              <span class="settings-choice-copy">
                <span>{option.label}</span>
                <Show when={option.description}>
                  <span class="settings-row-description">{option.description}</span>
                </Show>
              </span>
              <span class="settings-choice-mark" aria-hidden="true">
                <Show when={props.value === option.value}>
                  <Icon name={getSemanticIcon("state.success")} size="small" />
                </Show>
              </span>
            </RadioGroup.ItemLabel>
          </RadioGroup.Item>
        )}
      </For>
    </RadioGroup>
  )
}
