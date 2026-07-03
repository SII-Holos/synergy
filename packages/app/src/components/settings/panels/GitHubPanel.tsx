import type { GitHubAuthStatus } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createMemo, createResource, Show } from "solid-js"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

export function GitHubPanel() {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [status, { refetch }] = createResource(async () => {
    const res = await globalSDK.client.auth.githubStatus()
    return res.data as GitHubAuthStatus | undefined
  })

  const connected = createMemo(() => status()?.status === "connected")
  const statusLabel = createMemo(() => githubStatusLabel(status()))

  async function refreshStatus() {
    await Promise.all([refetch(), globalSync.refreshAllConfigs()])
  }

  async function logout() {
    await globalSDK.client.auth.githubLogout({}, { throwOnError: true })
    await globalSDK.client.global.dispose()
    await refreshStatus()
    showToast({ type: "warning", title: "GitHub disconnected", description: "Stored GitHub credentials were removed." })
  }

  return (
    <SettingsPage
      title="GitHub"
      description="Connect GitHub credentials for issue, pull request, release, and GitHub CLI-backed actions."
      actions={
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon={getSemanticIcon("action.refresh")}
          onClick={refreshStatus}
        >
          Refresh
        </Button>
      }
    >
      <SettingsSection>
        <div class="providers-detail-summary">
          <div class="flex items-center gap-3 min-w-0">
            <Icon name={getSemanticIcon("settings.github")} class="providers-detail-icon" />
            <div class="min-w-0">
              <div class="providers-detail-title">GitHub</div>
              <div class="providers-detail-copy">
                Synergy injects a managed GH_TOKEN only when running GitHub CLI commands.
              </div>
            </div>
          </div>
          <span class="ds-inline-badge" classList={{ "ds-inline-badge-muted": !connected() }}>
            {statusLabel()}
          </span>
        </div>
      </SettingsSection>

      <Show when={status()?.account}>
        {(account) => (
          <SettingsSection title="Account">
            <div class="providers-connect-section">
              <div class="min-w-0 flex-1">
                <div class="providers-connect-title">{account().login}</div>
                <p class="providers-connect-copy">
                  GitHub credentials are connected and available to GitHub CLI-backed shell commands.
                </p>
              </div>
            </div>
            <Show when={account().url}>
              <div class="providers-connect-actions">
                <a class="provider-auth-link" href={account().url} target="_blank" rel="noreferrer">
                  <span>Open GitHub profile</span>
                  <Icon name={getSemanticIcon("action.open")} size="small" />
                </a>
                <button type="button" class="provider-auth-link" onClick={logout}>
                  <span>Log out</span>
                  <Icon name={getSemanticIcon("account.logout")} size="small" />
                </button>
              </div>
            </Show>
          </SettingsSection>
        )}
      </Show>

      <SettingsSection>
        <ProviderConnectionFlow
          providerID="github"
          providerName="GitHub"
          connectedOverride={connected()}
          compact
          completeDescription="GitHub credentials are ready for GitHub CLI-backed actions."
          onComplete={refreshStatus}
        />
      </SettingsSection>
    </SettingsPage>
  )
}

function githubStatusLabel(status: GitHubAuthStatus | undefined) {
  if (!status) return "Loading"
  if (status.status === "connected") return "Connected"
  if (status.status === "invalid") return "Invalid"
  if (status.status === "unverified") return "Unverified"
  return "Not connected"
}
