import { SectionLabel } from "../components/SectionLabel"
import { AccountToggleCard } from "../components/AccountToggleCard"
import type { ChannelSettings, ProviderGroup } from "../types"

export function ChannelsPanel(props: {
  channels: ChannelSettings
  providers: ProviderGroup[]
  onChannelToggle: (index: number, value: boolean) => void
  onChannelModelChange: (index: number, model: string) => void
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">Channels</h1>
      <div class="ds-setting-section">
        <SectionLabel title="Feishu" />
        <AccountToggleCard
          title="Feishu accounts"
          description="Enable or disable existing Feishu channel accounts. Optionally override the model for each account."
          accounts={props.channels.feishuAccounts}
          emptyLabel="No Feishu accounts configured yet."
          providers={props.providers}
          onToggle={props.onChannelToggle}
          onModelChange={props.onChannelModelChange}
        />
      </div>
    </div>
  )
}
