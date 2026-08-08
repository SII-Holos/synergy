import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { SettingsPage, SettingsSection, SettingsSubsection } from "../components/SettingsPrimitives"
import { AccountToggleCard } from "../components/AccountToggleCard"
import { BasicAccountToggleCard } from "../components/BasicAccountToggleCard"
import { SettingRow } from "../components/SettingRow"
import type { ChannelSettings, GithubAccountToggle, ProviderGroup } from "../types"

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
const githubSectionTitle = { id: "settings.channels.github.title", message: "GitHub" }
const githubAccountsDescription = {
  id: "settings.channels.github.description",
  message:
    "Enable or disable existing GitHub channel accounts. Configure watched repositories, workspace directory, and review behavior.",
}
const emptyGithubLabel = { id: "settings.channels.github.empty", message: "No GitHub accounts configured yet." }
const githubRepositoriesLabel = { id: "settings.channels.github.repositories", message: "Repositories" }
const githubRepositoriesDescription = {
  id: "settings.channels.github.repositoriesDescription",
  message: "Comma-separated owner/repo pairs to watch and respond to.",
}
const githubWorkspaceDirLabel = { id: "settings.channels.github.workspaceDir", message: "Workspace directory" }
const githubWorkspaceDirDescription = {
  id: "settings.channels.github.workspaceDirDescription",
  message: "Directory under which per-repository checkouts are created.",
}
const githubWorkspaceTtlLabel = {
  id: "settings.channels.github.workspaceTtlHours",
  message: "Checkout retention (hours)",
}
const githubWorkspaceTtlDescription = {
  id: "settings.channels.github.workspaceTtlHoursDescription",
  message:
    "Hours an unused per-thread checkout is kept before its local clone is removed. Session history is preserved; the checkout is recreated automatically the next time the thread is triggered.",
}
const githubPollingLabel = { id: "settings.channels.github.pollingIntervalMs", message: "Polling interval (ms)" }
const githubPollingDescription = {
  id: "settings.channels.github.pollingIntervalMsDescription",
  message: "Interval between GitHub API polls in milliseconds.",
}
const githubAutoReviewLabel = { id: "settings.channels.github.autoReview", message: "Auto-review pull requests" }
const githubAutoReviewDescription = {
  id: "settings.channels.github.autoReviewDescription",
  message: "Automatically review newly opened and updated pull requests.",
}
const githubAutoRespondLabel = { id: "settings.channels.github.autoRespond", message: "Auto-respond to mentions" }
const githubAutoRespondDescription = {
  id: "settings.channels.github.autoRespondDescription",
  message: "Respond to @mentions of the bot handle and questions in issues and pull requests.",
}
const githubMentionLabel = { id: "settings.channels.github.mention", message: "Mention handle" }
const githubMentionDescription = {
  id: "settings.channels.github.mentionDescription",
  message: "GitHub handle users @-mention to summon the bot. Leave empty to resolve automatically from the GitHub App.",
}
const githubRepositoriesPlaceholder = {
  id: "settings.channels.github.repositoriesPlaceholder",
  message: "owner/repo, owner/repo",
}
const githubWorkspaceDirPlaceholder = {
  id: "settings.channels.github.workspaceDirPlaceholder",
  message: "/path/to/workspace",
}
const githubPollingPlaceholder = { id: "settings.channels.github.pollingPlaceholder", message: "300000" }
const enabledLabel = { id: "settings.channels.github.enabled", message: "Enabled" }

export function ChannelsPanel(props: {
  channels: ChannelSettings
  providers: ProviderGroup[]
  popoverLayer?: HTMLElement
  clarusAccountName: (accountID: string) => string
  clarusAccountDescription: (accountID: string) => string
  canRefreshClarusAccount: (accountID: string) => boolean
  onFeishuToggle: (index: number, value: boolean) => void
  onFeishuModelChange: (index: number, model: string) => void
  onFeishuVariantChange: (index: number, variant: string) => void
  onClarusToggle: (index: number, value: boolean) => void
  onClarusRefresh: (accountID: string) => Promise<void>
  onClarusDiagnostics: (accountID: string) => Promise<void>
  onGithubToggle: (index: number, value: boolean) => void
  onGithubFieldChange: (index: number, field: keyof GithubAccountToggle, value: string | boolean) => void
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
          canRefresh={(account) => props.canRefreshClarusAccount(account.key)}
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
      <SettingsSection title={_(githubSectionTitle)} description={_(githubAccountsDescription)}>
        <Show
          when={props.channels.githubAccounts.length > 0}
          fallback={<div class="settings-row-description">{_(emptyGithubLabel)}</div>}
        >
          <For each={props.channels.githubAccounts}>
            {(account, index) => (
              <SettingsSubsection>
                <SettingRow
                  title={account.key}
                  description={_(enabledLabel)}
                  trailing={
                    <Switch
                      checked={account.enabled}
                      hideLabel
                      onChange={(value) => props.onGithubToggle(index(), value)}
                    >
                      {account.key}
                    </Switch>
                  }
                />
                <SettingRow
                  title={_(githubRepositoriesLabel)}
                  description={_(githubRepositoriesDescription)}
                  trailing={
                    <TextField
                      type="text"
                      placeholder={_(githubRepositoriesPlaceholder)}
                      value={account.repositories}
                      onChange={(value) => props.onGithubFieldChange(index(), "repositories", value)}
                    />
                  }
                />
                <SettingRow
                  title={_(githubWorkspaceDirLabel)}
                  description={_(githubWorkspaceDirDescription)}
                  trailing={
                    <TextField
                      type="text"
                      placeholder={_(githubWorkspaceDirPlaceholder)}
                      value={account.workspaceDir}
                      onChange={(value) => props.onGithubFieldChange(index(), "workspaceDir", value)}
                    />
                  }
                />
                <SettingRow
                  title={_(githubWorkspaceTtlLabel)}
                  description={_(githubWorkspaceTtlDescription)}
                  trailing={
                    <TextField
                      type="number"
                      placeholder="24"
                      value={account.workspaceTtlHours}
                      onChange={(value) => props.onGithubFieldChange(index(), "workspaceTtlHours", value)}
                    />
                  }
                />
                <SettingRow
                  title={_(githubPollingLabel)}
                  description={_(githubPollingDescription)}
                  trailing={
                    <TextField
                      type="number"
                      placeholder={_(githubPollingPlaceholder)}
                      value={account.pollingIntervalMs}
                      onChange={(value) => props.onGithubFieldChange(index(), "pollingIntervalMs", value)}
                    />
                  }
                />
                <SettingRow
                  title={_(githubAutoReviewLabel)}
                  description={_(githubAutoReviewDescription)}
                  trailing={
                    <Switch
                      checked={account.autoReview}
                      hideLabel
                      onChange={(value) => props.onGithubFieldChange(index(), "autoReview", value)}
                    >
                      {_(githubAutoReviewLabel)}
                    </Switch>
                  }
                />
                <SettingRow
                  title={_(githubAutoRespondLabel)}
                  description={_(githubAutoRespondDescription)}
                  trailing={
                    <Switch
                      checked={account.autoRespond}
                      hideLabel
                      onChange={(value) => props.onGithubFieldChange(index(), "autoRespond", value)}
                    >
                      {_(githubAutoRespondLabel)}
                    </Switch>
                  }
                />
                <SettingRow
                  title={_(githubMentionLabel)}
                  description={_(githubMentionDescription)}
                  trailing={
                    <TextField
                      type="text"
                      placeholder=""
                      value={account.mention}
                      onChange={(value) => props.onGithubFieldChange(index(), "mention", value)}
                    />
                  }
                />
              </SettingsSubsection>
            )}
          </For>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
