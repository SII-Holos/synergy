import { createMemo, For, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { HolosAccountMeta } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useHolosAgentActions } from "@/components/holos/agent-actions"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

export function AccountPanel() {
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const actions = useHolosAgentActions(globalSDK)
  const activeAgentId = createMemo(() => holos.state.identity.activeAccount?.agentId)
  const displayName = createMemo(
    () => holos.state.social.profile?.name || holos.state.identity.agentId?.slice(0, 8) || "Synergy",
  )

  function accountLabel(account: HolosAccountMeta) {
    return account.label || account.agentId.slice(0, 8)
  }

  function connectionLabel() {
    if (!holos.loaded) return "Loading"
    if (!holos.state.identity.loggedIn) return "Signed out"
    return holos.state.connection.status.replace(/_/g, " ")
  }

  function accountStatus(account: HolosAccountMeta) {
    if (account.agentId !== activeAgentId()) return "Saved"
    if (!holos.loaded) return "Loading"
    return holos.state.connection.status === "connected" ? "Active" : connectionLabel()
  }

  return (
    <SettingsPage
      title="Account"
      description="Manage the Holos agent identity Synergy is currently using."
      actions={
        <div class="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("account.import")}
            onClick={actions.importAgent}
          >
            Import Agent
          </Button>
          <Button
            type="button"
            variant="primary"
            size="small"
            icon={getSemanticIcon("account.create")}
            onClick={() => void actions.createAgent()}
          >
            Create Agent
          </Button>
        </div>
      }
    >
      <SettingsSection>
        <div class="account-identity-card">
          <div class="account-identity-avatar">
            <img src={brandAssetPath(BRAND_ASSETS.synergy.productIcon)} alt="" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="account-identity-name">{displayName()}</div>
            <div class="account-identity-meta">
              {activeAgentId() ? activeAgentId() : "No active agent"}
              <span>•</span>
              <span>{connectionLabel()}</span>
            </div>
          </div>
          <Show when={holos.state.identity.loggedIn}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon={getSemanticIcon("account.logout")}
              onClick={() => void actions.logoutActiveAgent()}
            >
              Log out
            </Button>
          </Show>
        </div>
      </SettingsSection>

      <SettingsSection title="Agents" description="Stored agent identities are local to this Synergy installation.">
        <SettingsEntityList
          isEmpty={holos.state.identity.accounts.length === 0}
          emptyIcon={getSemanticIcon("settings.account")}
          emptyTitle="No saved agents"
          emptyDescription="Create a new Holos agent or import an existing one to connect Synergy."
        >
          <div class="account-agent-list">
            <For each={holos.state.identity.accounts}>
              {(account) => (
                <div
                  class="account-agent-row"
                  classList={{ "account-agent-row-active": account.agentId === activeAgentId() }}
                >
                  <div class="account-agent-icon">
                    <Icon
                      name={
                        account.agentId === activeAgentId()
                          ? getSemanticIcon("state.success")
                          : getSemanticIcon("state.empty")
                      }
                      size="small"
                    />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="account-agent-name">{accountLabel(account)}</div>
                    <div class="account-agent-meta">
                      <span>{account.agentId}</span>
                      <span>Updated {new Date(account.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <span
                    class="ds-inline-badge"
                    classList={{ "ds-inline-badge-muted": account.agentId !== activeAgentId() }}
                  >
                    {accountStatus(account)}
                  </span>
                  <Show when={account.agentId !== activeAgentId()}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      onClick={() => void actions.switchAgent(account.agentId)}
                    >
                      Switch
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </SettingsEntityList>
      </SettingsSection>
    </SettingsPage>
  )
}
