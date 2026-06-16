import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { AccountToggleCard } from "../components/AccountToggleCard"
import type { ChannelSettings } from "../types"

export function ChannelsPanel(props: {
  channels: ChannelSettings
  onChannelToggle: (index: number, value: boolean) => void
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">Channels</h1>
      <div class="ds-setting-section">
        <SectionLabel title="Feishu" />
        <AccountToggleCard
          title="Feishu accounts"
          description="Enable or disable existing Feishu channel accounts. Add accounts and detailed settings in the JSON editor."
          accounts={props.channels.feishuAccounts}
          emptyLabel="No Feishu accounts configured yet. Add them in JSON first."
          onToggle={props.onChannelToggle}
        />
      </div>
    </div>
  )
}
