import { For } from "solid-js"
import type { ProviderGroup } from "../types"

export function ModelRoleRow(props: {
  label: string
  description: string
  value: string
  providers: ProviderGroup[]
  onChange: (value: string) => void
}) {
  return (
    <div class="ds-setting-row ds-model-role-row">
      <div class="flex flex-col gap-0.5 min-w-0" style={{ flex: "0 0 180px" }}>
        <span class="text-13-medium text-text-base">{props.label}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-1 min-w-0">
        <select
          class="ds-model-select"
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        >
          <option value="">— Default</option>
          <For each={props.providers}>
            {(provider) => (
              <optgroup label={provider.providerName}>
                <For each={provider.models}>
                  {(model) => <option value={`${provider.providerId}/${model.id}`}>{model.name}</option>}
                </For>
              </optgroup>
            )}
          </For>
        </select>
      </div>
    </div>
  )
}
