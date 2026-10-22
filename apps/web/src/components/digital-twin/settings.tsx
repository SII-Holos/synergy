import { createMemo } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
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
  const models = createMemo(() => [
    { value: "", label: _(twinCopy.follow) },
    ...props.models.map((model) => ({
      value: `${model.providerId}/${model.modelId}`,
      label: `${model.providerName} / ${model.modelName}`,
    })),
  ])
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
            <MenuField
              ariaLabel={_(twinCopy.model)}
              options={models()}
              value={props.value.model}
              onChange={(model) => props.change({ ...props.value, model })}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
