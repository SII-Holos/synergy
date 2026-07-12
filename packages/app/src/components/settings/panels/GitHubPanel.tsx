import type { GitHubAuthStatus, ProviderAuthHealth } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createMemo, createResource, Show } from "solid-js"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  providerNeedsAction,
  providerRecoveryCopy,
  providerStatusLabel,
} from "@/components/provider/provider-auth-presentation"

export function GitHubPanel() {
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
    needsAction() ? providerStatusLabel(effectiveHealth()) : githubStatusLabel(status()),
  )

  async function refreshStatus() {
    await Promise.all([refetch(), globalSync.refreshProviders()])
  }

  async function logout() {
    await globalSDK.client.auth.githubLogout({}, { throwOnError: true })
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
            <Icon name={getSemanticIcon("github.main")} class="providers-detail-icon" />
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

      <Show when={needsAction()}>
        <SettingsSection title="Action required">
          <div class="providers-auth-warning" role="status">
            <Icon name={getSemanticIcon("providers.reconnect")} size="small" />
            <span>{providerRecoveryCopy("GitHub", effectiveHealth(), ["GH_TOKEN", "GITHUB_TOKEN"])}</span>
          </div>
        </SettingsSection>
      </Show>

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
            <div class="providers-connect-actions">
              <Show when={account().url}>
                {(url) => (
                  <a class="provider-auth-link" href={url()} target="_blank" rel="noreferrer">
                    <span>Open GitHub profile</span>
                    <Icon name={getSemanticIcon("action.open")} size="small" />
                  </a>
                )}
              </Show>
              <Show when={status()?.source === "store"}>
                <button type="button" class="provider-auth-link" onClick={logout}>
                  <span>Log out</span>
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
          <SettingsSection title="Environment credentials">
            <p class="providers-connect-copy">
              {needsAction()
                ? "Update GH_TOKEN or GITHUB_TOKEN in the Synergy server environment, then restart the server and refresh this page."
                : "GitHub is connected through GH_TOKEN or GITHUB_TOKEN in the Synergy server environment."}
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

function githubStatusLabel(status: GitHubAuthStatus | undefined) {
  if (!status) return "Loading"
  if (status.status === "connected") return "Connected"
  if (status.status === "invalid") return "Invalid"
  if (status.status === "unverified") return "Unverified"
  return "Not connected"
}
