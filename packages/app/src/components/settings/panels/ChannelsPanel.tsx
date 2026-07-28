import { useLingui } from "@lingui/solid"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { AccountToggleCard } from "../components/AccountToggleCard"
import { BasicAccountToggleCard } from "../components/BasicAccountToggleCard"
import type { ChannelSettings, ProviderGroup } from "../types"

const pageTitle = { id: "settings.channels.page.title", message: "Channels" }
const pageDescription = {
  id: "settings.channels.page.description",
  message: "Messaging and task channel accounts.",
}
const feishuSectionTitle = { id: "settings.channels.feishu.title", message: "Feishu" }
const feishuAccountsTitle = { id: "settings.channels.feishu.accounts", message: "Feishu accounts" }
const feishuAccountsDescription = {
  id: "settings.channels.feishu.description",
  message: "Enable or disable existing Feishu channel accounts. Optionally override the model for each account.",
}
const emptyFeishuLabel = { id: "settings.channels.feishu.empty", message: "No Feishu accounts configured yet." }
const clarusSectionTitle = { id: "settings.channels.clarus.title", message: "Clarus" }
const clarusAccountsDescription = {
  id: "settings.channels.clarus.description",
  message: "Allow each Holos Agent account to receive and run Clarus tasks.",
}
const emptyClarusLabel = { id: "settings.channels.clarus.empty", message: "No Clarus accounts configured yet." }
const clarusEnableLabel = { id: "settings.channels.clarus.enable", message: "Clarus task execution" }
function clarusEnableAccountLabel(accountName: string) {
  return {
    id: "settings.channels.clarus.enableAccount",
    message: "Enable Clarus task execution for {accountName}",
    values: { accountName },
  }
}
const clarusMaintenanceLabel = { id: "settings.channels.clarus.maintenance", message: "Account maintenance" }
function clarusMaintenanceAccountLabel(accountName: string) {
  return {
    id: "settings.channels.clarus.maintenanceAccount",
    message: "Account maintenance for {accountName}",
    values: { accountName },
  }
}
const clarusRefreshLabel = { id: "settings.channels.clarus.refresh", message: "Refresh projects" }
const clarusRefreshingLabel = { id: "settings.channels.clarus.refreshing", message: "Refreshing…" }
const clarusDiagnosticsLabel = { id: "settings.channels.clarus.diagnostics", message: "Download diagnostics" }
const clarusPreparingDiagnosticsLabel = {
  id: "settings.channels.clarus.preparingDiagnostics",
  message: "Preparing diagnostics…",
}

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
      <SettingsSection title={_(clarusSectionTitle)} description={_(clarusAccountsDescription)}>
        <BasicAccountToggleCard
          accounts={props.channels.clarusAccounts}
          emptyLabel={_(emptyClarusLabel)}
          accountDescription={(account) => props.clarusAccountDescription(account.key)}
          accountName={(account) => props.clarusAccountName(account.key)}
          enableLabel={_(clarusEnableLabel)}
          enableAccountLabel={(accountName) => _(clarusEnableAccountLabel(accountName))}
          maintenanceLabel={_(clarusMaintenanceLabel)}
          maintenanceAccountLabel={(accountName) => _(clarusMaintenanceAccountLabel(accountName))}
          refreshLabel={_(clarusRefreshLabel)}
          refreshingLabel={_(clarusRefreshingLabel)}
          diagnosticsLabel={_(clarusDiagnosticsLabel)}
          preparingDiagnosticsLabel={_(clarusPreparingDiagnosticsLabel)}
          onToggle={props.onClarusToggle}
          onRefresh={(account) => props.onClarusRefresh(account.key)}
          onDiagnostics={(account) => props.onClarusDiagnostics(account.key)}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
