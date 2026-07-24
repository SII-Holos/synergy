import { useLingui } from "@lingui/solid"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { AccountToggleCard } from "../components/AccountToggleCard"
import type { ChannelSettings, ProviderGroup } from "../types"

const pageTitle = { id: "settings.channels.page.title", message: "Channels" }
const pageDescription = {
  id: "settings.channels.page.description",
  message: "External messaging channel accounts.",
}
const feishuSectionTitle = { id: "settings.channels.feishu.title", message: "Feishu" }
const feishuAccountsTitle = { id: "settings.channels.feishu.accounts", message: "Feishu accounts" }
const feishuAccountsDescription = {
  id: "settings.channels.feishu.description",
  message: "Enable or disable existing Feishu channel accounts. Optionally override the model for each account.",
}
const emptyFeishuLabel = { id: "settings.channels.feishu.empty", message: "No Feishu accounts configured yet." }

export function ChannelsPanel(props: {
  channels: ChannelSettings
  providers: ProviderGroup[]
  popoverLayer?: HTMLElement
  onChannelToggle: (index: number, value: boolean) => void
  onChannelModelChange: (index: number, model: string) => void
  onChannelVariantChange: (index: number, variant: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <SettingsSection title={_(feishuSectionTitle)}>
        <AccountToggleCard
          title={_(feishuAccountsTitle)}
          description={_(feishuAccountsDescription)}
          accounts={props.channels.feishuAccounts}
          emptyLabel={_(emptyFeishuLabel)}
          providers={props.providers}
          popoverLayer={props.popoverLayer}
          onToggle={props.onChannelToggle}
          onModelChange={props.onChannelModelChange}
          onVariantChange={props.onChannelVariantChange}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
