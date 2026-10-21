import { For } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingsPage, SettingsSection } from "../settings/components/SettingsPrimitives"
import { SettingRow } from "../settings/components/SettingsSettingRow"
import type { ProviderModel, SettingsState } from "../settings/types"
import { twinCopy } from "./copy"

export function DigitalTwinSettings(props: {
  value: SettingsState["digitalTwin"]
  models: ProviderModel[]
  change(value: SettingsState["digitalTwin"]): void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(twinCopy.title)} description={_(twinCopy.description)}>
      <SettingsSection>
        <SettingRow
          title={_(twinCopy.automatic)}
          description={_(twinCopy.automaticHint)}
          trailing={
            <Switch
              checked={props.value.automatic}
              hideLabel
              onChange={(automatic) => props.change({ ...props.value, automatic })}
            >
              {_(twinCopy.automatic)}
            </Switch>
          }
        />
        <SettingRow
          title={_(twinCopy.model)}
          trailing={
            <select
              class="ds-input"
              aria-label={_(twinCopy.model)}
              value={props.value.model}
              onChange={(event) => props.change({ ...props.value, model: event.currentTarget.value })}
            >
              <option value="">{_(twinCopy.follow)}</option>
              <For each={props.models}>
                {(model) => (
                  <option value={`${model.providerId}/${model.modelId}`}>
                    {model.providerName} / {model.modelName}
                  </option>
                )}
              </For>
            </select>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
