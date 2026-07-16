import { useLingui } from "@lingui/solid"
import type { GitHubAuthStatus, ProviderAuthHealth } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createMemo, createResource, Show } from "solid-js"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { translateDescriptor } from "@/locales/translate"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  providerNeedsAction,
  providerRecoveryCopy,
  providerStatusLabel,
} from "@/components/provider/provider-auth-presentation"

const pageTitle = { id: "settings.github.page.title", message: "GitHub" }
const pageDescription = {
  id: "settings.github.page.description",
  message: "Connect GitHub credentials for issue, pull request, release, and GitHub CLI-backed actions.",
}
const refreshLabel = { id: "settings.github.refresh", message: "Refresh" }
const loadingLabel = { id: "settings.github.loading", message: "Loading" }
const connectedLabel = { id: "settings.github.connected", message: "Connected" }
const invalidLabel = { id: "settings.github.invalid", message: "Invalid" }
const unverifiedLabel = { id: "settings.github.unverified", message: "Unverified" }
const notConnectedLabel = { id: "settings.github.notConnected", message: "Not connected" }
const envCredentialsTitle = { id: "settings.github.envCredentials", message: "Environment credentials" }
const actionRequiredTitle = { id: "settings.github.actionRequired", message: "Action required" }
const accountTitle = { id: "settings.github.account", message: "Account" }
const githubTitleDisplay = { id: "settings.github.display.title", message: "GitHub" }
const githubSubtitle = {
  id: "settings.github.display.subtitle",
  message: "Synergy injects a managed GH_TOKEN only when running GitHub CLI commands.",
}
const disconnectTitle = { id: "settings.github.disconnect.title", message: "GitHub disconnected" }
const disconnectDesc = {
  id: "settings.github.disconnect.description",
  message: "Stored GitHub credentials were removed.",
}
const connectedDescription = {
  id: "settings.github.connected.description",
  message: "GitHub credentials are connected and available to GitHub CLI-backed shell commands.",
}
const openProfileLabel = { id: "settings.github.openProfile", message: "Open GitHub profile" }
const logoutLabel = { id: "settings.github.logout", message: "Log out" }
const envRecoveryDescription = {
  id: "settings.github.envRecoveryDesc",
  message:
    "Update GH_TOKEN or GITHUB_TOKEN in the Synergy server environment, then restart the server and refresh this page.",
}
const envConnectedDescription = {
  id: "settings.github.envConnectedDesc",
  message: "GitHub is connected through GH_TOKEN or GITHUB_TOKEN in the Synergy server environment.",
}

export function GitHubPanel() {
  const { _, i18n } = useLingui()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [status, { refetch }] = createResource(async () => {
    const res = await globalSDK.client.auth.githubStatus()
    return res.data as GitHubAuthStatus | undefined
  })

  const connected = createMemo(() => status()?.status === "connected")
  const effectiveHealth = createMemo<ProviderAuthHealth | undefined>(() => {
    const health = globalSync.data.provider.authHealth?.github
    if (health?.status === "action_required") return health
    if (status()?.status !== "invalid") return health
    return {
      providerID: "github",
      status: "action_required",
      recovery: status()?.source === "env" ? "update_environment" : "reconnect",
      source: status()?.source,
      authKind: status()?.authKind,
    }
  })
  const needsAction = createMemo(() => providerNeedsAction(effectiveHealth()))
  const statusLabel = createMemo(() =>
    needsAction()
      ? translateDescriptor(providerStatusLabel(effectiveHealth()), i18n())
      : githubStatusLabel(status(), _),
  )

  async function refreshStatus() {
    await Promise.all([refetch(), globalSync.refreshProviders()])
  }

  async function logout() {
    await globalSDK.client.auth.githubLogout({}, { throwOnError: true })
    await refreshStatus()
    showToast({ type: "warning", title: _(disconnectTitle), description: _(disconnectDesc) })
  }

  return (
    <SettingsPage
      title={_(pageTitle)}
      description={_(pageDescription)}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon={getSemanticIcon("action.refresh")}
          onClick={refreshStatus}
        >
          {_(refreshLabel)}
        </Button>
      }
    >
      <SettingsSection>
        <div class="providers-detail-summary">
          <div class="flex items-center gap-3 min-w-0">
            <Icon name={getSemanticIcon("github.main")} class="providers-detail-icon" />
            <div class="min-w-0">
              <div class="providers-detail-title">{_(githubTitleDisplay)}</div>
              <div class="providers-detail-copy">{_(githubSubtitle)}</div>
            </div>
          </div>
          <span class="ds-inline-badge" classList={{ "ds-inline-badge-muted": !connected() }}>
            {statusLabel()}
          </span>
        </div>
      </SettingsSection>

      <Show when={needsAction()}>
        <SettingsSection title={_(actionRequiredTitle)}>
          <div class="providers-auth-warning" role="status">
            <Icon name={getSemanticIcon("providers.reconnect")} size="small" />
            <span>
              {translateDescriptor(
                providerRecoveryCopy("GitHub", effectiveHealth(), ["GH_TOKEN", "GITHUB_TOKEN"]),
                i18n(),
              )}
            </span>
          </div>
        </SettingsSection>
      </Show>

      <Show when={status()?.account}>
        {(account) => (
          <SettingsSection title={_(accountTitle)}>
            <div class="providers-connect-section">
              <div class="min-w-0 flex-1">
                <div class="providers-connect-title">{account().login}</div>
                <p class="providers-connect-copy">{_(connectedDescription)}</p>
              </div>
            </div>
            <div class="providers-connect-actions">
              <Show when={account().url}>
                {(url) => (
                  <a class="provider-auth-link" href={url()} target="_blank" rel="noreferrer">
                    <span>{_(openProfileLabel)}</span>
                    <Icon name={getSemanticIcon("action.open")} size="small" />
                  </a>
                )}
              </Show>
              <Show when={status()?.source === "store"}>
                <button type="button" class="provider-auth-link" onClick={logout}>
                  <span>{_(logoutLabel)}</span>
                  <Icon name={getSemanticIcon("account.logout")} size="small" />
                </button>
              </Show>
            </div>
          </SettingsSection>
        )}
      </Show>

      <Show
        when={status()?.source !== "env"}
        fallback={
          <SettingsSection title={_(envCredentialsTitle)}>
            <p class="providers-connect-copy">
              {needsAction() ? _(envRecoveryDescription) : _(envConnectedDescription)}
            </p>
          </SettingsSection>
        }
      >
        <SettingsSection>
          <ProviderConnectionFlow
            providerID="github"
            providerName="GitHub"
            intent={needsAction() ? "recover" : "connect"}
            connectedOverride={connected()}
            skipAutoAdvance
            completeDescription="GitHub credentials are ready for GitHub CLI-backed actions."
            onComplete={refreshStatus}
          />
        </SettingsSection>
      </Show>
    </SettingsPage>
  )
}

function githubStatusLabel(status: GitHubAuthStatus | undefined, _: ReturnType<typeof useLingui>["_"]) {
  if (!status) return _(loadingLabel)
  if (status.status === "connected") return _(connectedLabel)
  if (status.status === "invalid") return _(invalidLabel)
  if (status.status === "unverified") return _(unverifiedLabel)
  return _(notConnectedLabel)
}
