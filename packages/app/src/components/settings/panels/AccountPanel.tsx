import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useHolosAgentActions } from "@/components/holos/agent-actions"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

export function AccountPanel() {
  const globalSDK = useGlobalSDK()
  const holos = useHolos()
  const actions = useHolosAgentActions(globalSDK)
  const [editingProfile, setEditingProfile] = createSignal(false)
  const [profileForm, setProfileForm] = createStore({
    name: "",
    description: "",
    avatarUrl: "",
    nameError: undefined as string | undefined,
    avatarUrlError: undefined as string | undefined,
    saving: false,
  })

  const activeAgentId = createMemo(
    () => holos.state.identity.activeAccount?.agentId ?? holos.state.identity.agentId ?? undefined,
  )
  const shortAgentId = createMemo(() => activeAgentId()?.slice(0, 8))
  const profile = createMemo(() => holos.state.social.profile)
  const displayName = createMemo(
    () => profile()?.name || (shortAgentId() ? `Agent ${shortAgentId()}` : "No Holos agent"),
  )
  const description = createMemo(() => profile()?.description?.trim())
  const avatarSrc = createMemo(
    () => profile()?.avatarUrl || brandAssetPath(BRAND_ASSETS.synergy.productIcon),
  )
  const profileErrorMessage = createMemo(() => {
    if (!holos.state.social.profileError) return undefined
    return "Holos could not load this profile. Retry, or import the agent again if this keeps failing."
  })

  function connectionLabel() {
    if (!holos.loaded) return "Loading"
    if (!holos.state.identity.loggedIn) return "Signed out"
    return holos.state.connection.status.replace(/_/g, " ")
  }

  function validateAvatarUrl(value: string): string | undefined {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    try {
      new URL(trimmed)
      return undefined
    } catch {
      return "Enter a valid URL"
    }
  }

  function resetProfileForm() {
    const current = profile()
    setProfileForm({
      name: current?.name ?? "",
      description: current?.description ?? "",
      avatarUrl: current?.avatarUrl ?? "",
      nameError: undefined,
      avatarUrlError: undefined,
    })
  }

  createEffect(() => {
    if (editingProfile()) return
    resetProfileForm()
  })

  function beginProfileEdit() {
    resetProfileForm()
    setEditingProfile(true)
  }

  function cancelProfileEdit() {
    resetProfileForm()
    setEditingProfile(false)
  }

  async function copyAgentID() {
    const agentId = activeAgentId()
    if (!agentId) return
    try {
      await navigator.clipboard.writeText(agentId)
      showToast({ type: "success", title: "Agent ID copied" })
    } catch {
      showToast({ type: "error", title: "Copy failed", description: "Unable to copy the agent ID." })
    }
  }

  async function saveProfile(e: SubmitEvent) {
    e.preventDefault()
    const name = profileForm.name.trim()
    const description = profileForm.description.trim()
    const avatarUrl = profileForm.avatarUrl.trim()
    const avatarUrlError = validateAvatarUrl(avatarUrl)

    setProfileForm("nameError", name ? undefined : "Name is required")
    setProfileForm("avatarUrlError", avatarUrlError)
    if (!name || avatarUrlError) return

    setProfileForm("saving", true)
    try {
      await globalSDK.client.holos.profile.update(
        {
          holosAgentProfileInput: {
            name,
            ...(description ? { description } : { description: "" }),
            ...(avatarUrl ? { avatarUrl } : { avatarUrl: "" }),
          },
        },
        { throwOnError: true },
      )
      await holos.refresh()
      setEditingProfile(false)
      showToast({ type: "success", title: "Profile saved", description: "Holos profile was updated." })
    } catch (err) {
      showToast({
        type: "error",
        title: "Profile save failed",
        description: err instanceof Error ? err.message : "Unable to update Holos profile.",
      })
    } finally {
      setProfileForm("saving", false)
    }
  }

  return (
    <SettingsPage title="Account" description="Manage the Holos agent identity Synergy is currently using.">
      <SettingsSection>
        <div class="account-profile-card" classList={{ "account-profile-card-editing": editingProfile() }}>
          <Show
            when={editingProfile()}
            fallback={
              <>
                <div class="account-profile-display">
                  <div class="account-identity-avatar">
                    <img src={avatarSrc()} alt="" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="account-identity-name">{displayName()}</div>
                    <div class="account-identity-description">
                      <Show
                        when={holos.state.identity.loggedIn}
                        fallback="Create or import a Holos agent to use identity features."
                      >
                        <Show when={!holos.state.social.profileError} fallback="Profile unavailable">
                          {description() || "No description yet."}
                        </Show>
                      </Show>
                    </div>
                    <div class="account-identity-meta">
                      <span>{connectionLabel()}</span>
                      <Show when={shortAgentId()}>
                        <span>•</span>
                        <span>{shortAgentId()}</span>
                      </Show>
                    </div>
                  </div>
                  <Show when={holos.state.identity.loggedIn}>
                    <div class="account-profile-card-actions">
                      <Show when={profile() && !holos.state.social.profileError}>
                        <Button type="button" variant="secondary" size="small" onClick={beginProfileEdit}>
                          Edit profile
                        </Button>
                      </Show>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        icon={getSemanticIcon("account.logout")}
                        class="account-profile-logout"
                        onClick={() => void actions.logoutActiveAgent()}
                      >
                        Log out
                      </Button>
                    </div>
                  </Show>
                </div>
                <Show when={profileErrorMessage()}>
                  {(message) => (
                    <div
                      class="account-profile-warning account-profile-warning-inline"
                      title={holos.state.social.profileError}
                    >
                      <Icon name={getSemanticIcon("state.warning")} size="small" />
                      <span>{message()}</span>
                      <Button type="button" variant="ghost" size="small" onClick={() => void holos.refresh()}>
                        Retry
                      </Button>
                    </div>
                  )}
                </Show>
              </>
            }
          >
            <form class="account-profile-form" onSubmit={saveProfile}>
              <div class="account-profile-edit-head">
                <div class="account-identity-avatar">
                  <img src={avatarSrc()} alt="" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="account-identity-name">Edit profile</div>
                  <div class="account-identity-description">Saved directly to Holos.</div>
                </div>
              </div>
              <div class="account-profile-grid">
                <TextField
                  label="Name"
                  type="text"
                  placeholder="Agent name"
                  value={profileForm.name}
                  disabled={!holos.state.identity.loggedIn || profileForm.saving}
                  onChange={(value) => {
                    setProfileForm("name", value)
                    if (value.trim()) setProfileForm("nameError", undefined)
                  }}
                  validationState={profileForm.nameError ? "invalid" : undefined}
                  error={profileForm.nameError}
                />
                <TextField
                  label="Avatar URL"
                  type="url"
                  placeholder="https://..."
                  value={profileForm.avatarUrl}
                  disabled={!holos.state.identity.loggedIn || profileForm.saving}
                  onChange={(value) => {
                    setProfileForm("avatarUrl", value)
                    setProfileForm("avatarUrlError", validateAvatarUrl(value))
                  }}
                  validationState={profileForm.avatarUrlError ? "invalid" : undefined}
                  error={profileForm.avatarUrlError}
                />
              </div>
              <TextField
                label="Description"
                multiline
                placeholder="What this agent represents"
                value={profileForm.description}
                disabled={!holos.state.identity.loggedIn || profileForm.saving}
                onChange={(value) => setProfileForm("description", value)}
              />
              <div class="account-profile-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  disabled={profileForm.saving}
                  onClick={cancelProfileEdit}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="small"
                  disabled={!holos.state.identity.loggedIn || profileForm.saving}
                >
                  {profileForm.saving ? "Saving..." : "Save changes"}
                </Button>
              </div>
            </form>
          </Show>
        </div>
      </SettingsSection>

      <SettingsSection title="Holos agent" description="Connection and local credential actions for this installation.">
        <div class="account-detail-list">
          <div class="account-detail-row">
            <div>
              <div class="account-detail-label">Status</div>
              <div class="account-detail-copy">Current Holos connection state</div>
            </div>
            <span class="ds-inline-badge">{connectionLabel()}</span>
          </div>
          <div class="account-detail-row">
            <div class="min-w-0">
              <div class="account-detail-label">Agent ID</div>
              <div class="account-detail-value">{activeAgentId() ?? "No active agent"}</div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="small"
              icon={getSemanticIcon("action.copy")}
              disabled={!activeAgentId()}
              onClick={() => void copyAgentID()}
            >
              Copy
            </Button>
          </div>
        </div>
        <div class="account-agent-actions">
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={holos.state.identity.accounts.length <= 1}
            onClick={() => actions.openAgentSwitcher()}
          >
            Switch Agent
          </Button>
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
      </SettingsSection>
    </SettingsPage>
  )
}
