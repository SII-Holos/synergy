import { For } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { SettingsFieldGrid, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { ProvidersStore } from "../types"

export type ProviderConnectionSummary = {
  id: string
  name: string
  connected: boolean
  modelCount: number
}

export function ProvidersPanel(props: {
  providers: ProvidersStore
  summaries: ProviderConnectionSummary[]
  onProviderChange: (key: keyof ProvidersStore, value: string) => void
  onConnectProvider: () => void
}) {
  return (
    <SettingsPage
      title="Providers"
      description="Provider availability and connection status."
      actions={
        <Button type="button" variant="secondary" size="small" onClick={props.onConnectProvider}>
          Connect Provider
        </Button>
      }
    >
      <SettingsSection title="Availability">
        <SettingsFieldGrid>
          <TextField
            label="Enabled Providers"
            multiline
            value={props.providers.enabledProviders}
            placeholder={"anthropic\nopenai"}
            description="When set, only these provider IDs are enabled."
            onChange={(value) => props.onProviderChange("enabledProviders", value)}
          />
          <TextField
            label="Disabled Providers"
            multiline
            value={props.providers.disabledProviders}
            placeholder={"example-provider"}
            description="Provider IDs to disable even if they are loaded automatically."
            onChange={(value) => props.onProviderChange("disabledProviders", value)}
          />
        </SettingsFieldGrid>
      </SettingsSection>

      <SettingsSection title="Connections">
        <div class="ds-summary-list">
          <For each={props.summaries}>
            {(provider) => (
              <div class="ds-summary-row">
                <div class="min-w-0">
                  <div class="text-13-medium text-text-base truncate">{provider.name}</div>
                  <div class="text-12-regular text-text-weak truncate">{provider.id}</div>
                </div>
                <div class="flex items-center gap-2">
                  <span class="ds-inline-badge" classList={{ "ds-inline-badge-muted": !provider.connected }}>
                    {provider.connected ? "Connected" : "Not Connected"}
                  </span>
                  <span class="text-12-regular text-text-weaker">{provider.modelCount} models</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
