import { useLingui } from "@lingui/solid"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { AccountToggleCard } from "../components/AccountToggleCard"
import { BasicAccountToggleCard } from "../components/BasicAccountToggleCard"
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
const clarusSectionTitle = { id: "settings.channels.clarus.title", message: "Clarus" }
const clarusAccountsTitle = { id: "settings.channels.clarus.accounts", message: "Clarus accounts" }
const clarusAccountsDescription = {
  id: "settings.channels.clarus.description",
  message: "Enable or disable Clarus task execution for Holos Agent accounts.",
}
const emptyClarusLabel = { id: "settings.channels.clarus.empty", message: "No Clarus accounts configured yet." }
const clarusRefreshLabel = { id: "settings.channels.clarus.refresh", message: "Refresh projects" }
const clarusDiagnosticsLabel = { id: "settings.channels.clarus.diagnostics", message: "Download diagnostics" }

export function ChannelsPanel(props: {
  channels: ChannelSettings
  providers: ProviderGroup[]
  popoverLayer?: HTMLElement
  clarusAccountName: (accountID: string) => string
  clarusAccountDescription: (accountID: string) => string
  onFeishuToggle: (index: number, value: boolean) => void
  onFeishuModelChange: (index: number, model: string) => void
  onFeishuVariantChange: (index: number, variant: string) => void
  onClarusToggle: (index: number, value: boolean) => void
  onClarusRefresh: (accountID: string) => Promise<void>
  onClarusDiagnostics: (accountID: string) => Promise<void>
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
          onToggle={props.onFeishuToggle}
          onModelChange={props.onFeishuModelChange}
          onVariantChange={props.onFeishuVariantChange}
        />
      </SettingsSection>
      <SettingsSection title={_(clarusSectionTitle)}>
        <BasicAccountToggleCard
          title={_(clarusAccountsTitle)}
          description={_(clarusAccountsDescription)}
          accounts={props.channels.clarusAccounts}
          emptyLabel={_(emptyClarusLabel)}
          accountDescription={(account) => props.clarusAccountDescription(account.key)}
          accountName={(account) => props.clarusAccountName(account.key)}
          refreshLabel={_(clarusRefreshLabel)}
          diagnosticsLabel={_(clarusDiagnosticsLabel)}
          onToggle={props.onClarusToggle}
          onRefresh={(account) => props.onClarusRefresh(account.key)}
          onDiagnostics={(account) => props.onClarusDiagnostics(account.key)}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
