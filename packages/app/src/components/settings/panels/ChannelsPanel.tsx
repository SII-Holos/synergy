import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { AccountToggleCard } from "../components/AccountToggleCard"
import type { ChannelSettings, ProviderGroup } from "../types"

export function ChannelsPanel(props: {
  channels: ChannelSettings
  providers: ProviderGroup[]
  onChannelToggle: (index: number, value: boolean) => void
  onChannelModelChange: (index: number, model: string) => void
}) {
  return (
    <SettingsPage title="Channels" description="External messaging channel accounts.">
      <SettingsSection title="Feishu">
        <AccountToggleCard
          title="Feishu accounts"
          description="Enable or disable existing Feishu channel accounts. Optionally override the model for each account."
          accounts={props.channels.feishuAccounts}
          emptyLabel="No Feishu accounts configured yet."
          providers={props.providers}
          onToggle={props.onChannelToggle}
          onModelChange={props.onChannelModelChange}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
