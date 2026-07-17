import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useHolos } from "@/context/holos"
import { useHolosAgentActions } from "@/components/holos/agent-actions"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

const loadingLabel = { id: "settings.account.loading", message: "Loading" }
const signedOutLabel = { id: "settings.account.signedOut", message: "Signed out" }
const profileSavedTitle = { id: "settings.account.profileSaved.title", message: "Profile saved" }
const profileSavedDesc = { id: "settings.account.profileSaved.description", message: "Holos profile was updated." }
const profileSaveFailedTitle = { id: "settings.account.profileSaveFailed.title", message: "Profile save failed" }
const profileSaveFailedDesc = {
  id: "settings.account.profileSaveFailed.description",
  message: "Unable to update Holos profile.",
}
const profileLoadError = {
  id: "settings.account.profileLoadError",
  message: "Holos could not load this profile. Retry, or import the agent again if this keeps failing.",
}
const profileUnavailable = { id: "settings.account.profileUnavailable", message: "Profile unavailable" }
const noDescription = { id: "settings.account.noDescription", message: "No description yet." }
const noHolosAgent = {
  id: "settings.account.noHolosAgent",
  message: "Create or import a Holos agent to use identity features.",
}
const noAgentLabel = { id: "settings.account.noAgent", message: "No Holos agent" }
const nameRequiredError = { id: "settings.account.nameRequired", message: "Name is required" }
const invalidUrlError = { id: "settings.account.invalidUrl", message: "Enter a valid URL" }
const pageTitle = { id: "settings.account.page.title", message: "Account" }
const pageDescription = {
  id: "settings.account.page.description",
  message: "Manage the Holos agent identity Synergy is currently using.",
}
const editProfileLabel = { id: "settings.account.editProfile", message: "Edit profile" }
const logOutLabel = { id: "settings.account.logout", message: "Log out" }
const retryLabel = { id: "settings.account.retry", message: "Retry" }
const savedToHolosLabel = { id: "settings.account.savedToHolos", message: "Saved directly to Holos." }
const nameLabel = { id: "settings.account.editProfile.name", message: "Name" }
const namePlaceholder = { id: "settings.account.editProfile.namePlaceholder", message: "Agent name" }
const avatarUrlLabel = { id: "settings.account.editProfile.avatarUrl", message: "Avatar URL" }
const descriptionLabel = { id: "settings.account.editProfile.description", message: "Description" }
const descriptionPlaceholder = {
  id: "settings.account.editProfile.descriptionPlaceholder",
  message: "What this agent represents",
}
const cancelLabel = { id: "settings.account.editProfile.cancel", message: "Cancel" }
const saveChangesLabel = { id: "settings.account.editProfile.saveChanges", message: "Save changes" }
const savingLabel = { id: "settings.account.editProfile.saving", message: "Saving..." }
const holosSectionTitle = { id: "settings.account.holosSection.title", message: "Holos agent" }
const holosSectionDescription = {
  id: "settings.account.holosSection.description",
  message: "Connection and local credential actions for this installation.",
}
const statusLabel = { id: "settings.account.holosSection.status", message: "Status" }
const statusDescription = {
  id: "settings.account.holosSection.statusDescription",
  message: "Current Holos connection state",
}
const agentIdLabel = { id: "settings.account.holosSection.agentId", message: "Agent ID" }
const noActiveAgent = { id: "settings.account.holosSection.noActiveAgent", message: "No active agent" }
const copyLabel = { id: "settings.account.holosSection.copy", message: "Copy" }
const copiedLabel = { id: "settings.account.holosSection.copied", message: "Copied" }
const switchAgentLabel = { id: "settings.account.actions.switch", message: "Switch Agent" }
const importAgentLabel = { id: "settings.account.actions.import", message: "Import Agent" }
const createAgentLabel = { id: "settings.account.actions.create", message: "Create Agent" }
const avatarUrlPlaceholder = { id: "settings.account.editProfile.avatarUrlPlaceholder", message: "https://..." }

function agentPrefix(id: string) {
  return { id: "settings.account.agentPrefix", message: "Agent {id}", values: { id } }
}

export function AccountPanel() {
  const { _ } = useLingui()
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
  const copyAgentID = createCopyController({
    text: activeAgentId,
    copyLabel: "Copy agent ID",
    failureDescription: "Unable to copy the agent ID.",
  })
  const shortAgentId = createMemo(() => activeAgentId()?.slice(0, 8))
  const profile = createMemo(() => holos.state.social.profile)
  const displayName = createMemo(
    () => profile()?.name || (shortAgentId() ? _(agentPrefix(shortAgentId()!)) : _(noAgentLabel)),
  )
  const description = createMemo(() => profile()?.description?.trim())
  const avatarSrc = createMemo(() => profile()?.avatarUrl || brandAssetPath(BRAND_ASSETS.synergy.productIcon))
  const profileErrorMessage = createMemo(() => {
    if (!holos.state.social.profileError) return undefined
    return _(profileLoadError)
  })

  function connectionLabel() {
    if (!holos.loaded) return _(loadingLabel)
    if (!holos.state.identity.loggedIn) return _(signedOutLabel)
    return holos.state.connection.status.replace(/_/g, " ")
  }

  function validateAvatarUrl(value: string): string | undefined {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    try {
      new URL(trimmed)
      return undefined
    } catch {
      return _(invalidUrlError)
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

  async function saveProfile(e: SubmitEvent) {
    e.preventDefault()
    const name = profileForm.name.trim()
    const description = profileForm.description.trim()
    const avatarUrl = profileForm.avatarUrl.trim()
    const avatarUrlError = validateAvatarUrl(avatarUrl)

    setProfileForm("nameError", name ? undefined : _(nameRequiredError))
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
      showToast({ type: "success", title: _(profileSavedTitle), description: _(profileSavedDesc) })
    } catch (err) {
      showToast({
        type: "error",
        title: _(profileSaveFailedTitle),
        description: err instanceof Error ? err.message : _(profileSaveFailedDesc),
      })
    } finally {
      setProfileForm("saving", false)
    }
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
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
                      <Show when={holos.state.identity.loggedIn} fallback={_(noHolosAgent)}>
                        <Show when={!holos.state.social.profileError} fallback={_(profileUnavailable)}>
                          {description() || _(noDescription)}
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
                          {_(editProfileLabel)}
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
                        {_(logOutLabel)}
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
                        {_(retryLabel)}
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
                  <div class="account-identity-name">{_(editProfileLabel)}</div>
                  <div class="account-identity-description">{_(savedToHolosLabel)}</div>
                </div>
              </div>
              <div class="account-profile-grid">
                <TextField
                  label={_(nameLabel)}
                  type="text"
                  placeholder={_(namePlaceholder)}
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
                  label={_(avatarUrlLabel)}
                  type="url"
                  placeholder={_(avatarUrlPlaceholder)}
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
                label={_(descriptionLabel)}
                multiline
                placeholder={_(descriptionPlaceholder)}
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
                  {_(cancelLabel)}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="small"
                  disabled={!holos.state.identity.loggedIn || profileForm.saving}
                >
                  {profileForm.saving ? _(savingLabel) : _(saveChangesLabel)}
                </Button>
              </div>
            </form>
          </Show>
        </div>
      </SettingsSection>

      <SettingsSection title={_(holosSectionTitle)} description={_(holosSectionDescription)}>
        <div class="account-detail-list">
          <div class="account-detail-row">
            <div>
              <div class="account-detail-label">{_(statusLabel)}</div>
              <div class="account-detail-copy">{_(statusDescription)}</div>
            </div>
            <span class="ds-inline-badge">{connectionLabel()}</span>
          </div>
          <div class="account-detail-row">
            <div class="min-w-0">
              <div class="account-detail-label">{_(agentIdLabel)}</div>
              <div class="account-detail-value">{activeAgentId() ?? _(noActiveAgent)}</div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="small"
              icon={copyAgentID.copied() ? getSemanticIcon("state.success") : copyAgentID.icon()}
              data-copy-state={copyAgentID.state()}
              disabled={copyAgentID.disabled()}
              onClick={() => void copyAgentID.copy()}
            >
              {copyAgentID.copied() ? _(copiedLabel) : _(copyLabel)}
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
            {_(switchAgentLabel)}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("account.import")}
            onClick={actions.importAgent}
          >
            {_(importAgentLabel)}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="small"
            icon={getSemanticIcon("account.create")}
            onClick={() => void actions.createAgent()}
          >
            {_(createAgentLabel)}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
