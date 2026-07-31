import { useLingui } from "@lingui/solid"
import type {
  ProviderAuthHealth,
  ProviderAuthResponse,
  ProviderConnection,
  ProviderListResponse,
  ProviderRuntimeAvailability,
} from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { disconnectProviderConfirm } from "@/components/dialog/confirm-copy"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { translateDescriptor } from "@/locales/translate"
import {
  compareProviderIDs,
  providerConnectCopy,
  providerConnectReason,
  type ProviderRecommendationMetadata,
} from "@/components/provider/provider-recommendation"
import { SettingsPage } from "../components/SettingsPrimitives"
import {
  providerNeedsAction,
  providerCanDisconnect,
  providerAuthTone,
  providerRecoveryActionLabel,
  providerRecoveryCopy,
  providerStatusLabel,
} from "@/components/provider/provider-auth-presentation"
import { groupProviderConnections } from "./provider-groups"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { requestErrorMessage } from "@/utils/error"

const SETTINGS_RECOMMENDED_PROVIDER_IDS = [
  "deepseek",
  "openrouter",
  "openai-codex",
  "zhipu-ai-coding-plan",
  "zhipu-coding-plan",
] as const

const SETTINGS_RECOMMENDED_PROVIDER_RANK = new Map<string, number>(
  SETTINGS_RECOMMENDED_PROVIDER_IDS.map((id, index) => [id, index]),
)

const pageTitle = { id: "settings.providers.page.title", message: "Providers" }
const pageDescription = {
  id: "settings.providers.page.description",
  message: "Connect model providers and manage runtime availability.",
}
const searchPlaceholder = { id: "settings.providers.search.placeholder", message: "Search providers..." }
const noMatch = { id: "settings.providers.noMatch", message: "No providers match this search." }
const needsAttentionTitle = { id: "settings.providers.needsAttention", message: "Needs attention" }
const recommendedTitle = { id: "settings.providers.recommended", message: "Recommended" }
const connectedTitle = { id: "settings.providers.connected", message: "Connected" }
const otherTitle = { id: "settings.providers.other", message: "Other" }
const selectHint = { id: "settings.providers.selectHint", message: "Select a provider to connect it." }
const accountTab = { id: "settings.providers.account", message: "Account" }
const connectTab = { id: "settings.providers.connect", message: "Connect" }
const accountConnectedDesc = {
  id: "settings.providers.accountConnected",
  message: "Credentials are connected. Use Usage for quota and billing details.",
}
const connectDesc = {
  id: "settings.providers.connectDesc",
  message: "Choose a sign-in method. Synergy will make available models selectable after connection.",
}
const recoveryDesc = {
  id: "settings.providers.recoveryDesc",
  message: "Choose a recovery method. Existing backup credentials remain available.",
}
const envRecoveryFallbackDesc = {
  id: "settings.providers.updateEnvRecovery",
  message:
    "Update the server environment, restart Synergy, then refresh this page. Environment values are never overwritten by Settings.",
}
const catalogRefreshing = { id: "settings.providers.catalog.refreshing", message: "Refreshing model list" }
const catalogBundled = { id: "settings.providers.catalog.bundled", message: "Showing default models" }
const catalogPending = { id: "settings.providers.catalog.pending", message: "Model list needs refresh" }
const catalogCached = { id: "settings.providers.catalog.cached", message: "Showing the last synced model list" }
const catalogRefreshAction = { id: "settings.providers.catalog.refresh", message: "Refresh models" }
const addAccountAction = { id: "settings.providers.account.add", message: "Add account" }
const editAccountAction = { id: "settings.providers.account.edit", message: "Edit account" }
const removeAccountAction = { id: "settings.providers.account.remove", message: "Remove account" }
const accountConnectionLabel = { id: "settings.providers.account.connection", message: "Account connection" }
const accountConnectionDescription = {
  id: "settings.providers.account.connection.description",
  message: "This account has independent credentials. It is not a credential failover entry.",
}
const addAccountTitle = { id: "settings.providers.account.add.title", message: "Add provider account" }
function addAccountDescription(providerName: string) {
  return {
    id: "settings.providers.account.add.description",
    message: "Create a named account connection for {providerName}. Connect its credentials separately after creation.",
    values: { providerName },
  }
}
const editAccountTitle = { id: "settings.providers.account.edit.title", message: "Edit provider account" }
const editAccountDescription = {
  id: "settings.providers.account.edit.description",
  message: "Update this account connection without changing sibling accounts.",
}
const accountNameLabel = { id: "settings.providers.account.name", message: "Account name" }
const accountNamePlaceholder = { id: "settings.providers.account.name.placeholder", message: "Work account" }
const endpointLabel = { id: "settings.providers.account.endpoint", message: "API endpoint" }
const endpointDescription = {
  id: "settings.providers.account.endpoint.description",
  message: "Optional. Leave empty to use the provider default.",
}
const endpointPlaceholder = {
  id: "settings.providers.account.endpoint.placeholder",
  message: "https://api.example.com/v1",
}
const enabledLabel = { id: "settings.providers.account.enabled", message: "Enabled" }
const cancelAction = { id: "settings.providers.account.cancel", message: "Cancel" }
const createAction = { id: "settings.providers.account.create", message: "Create account" }
const creatingAction = { id: "settings.providers.account.creating", message: "Creating..." }
const saveAction = { id: "settings.providers.account.save", message: "Save changes" }
const savingAction = { id: "settings.providers.account.saving", message: "Saving..." }
const closeDialogLabel = { id: "settings.providers.account.dialog.close", message: "Close account dialog" }
const createdToast = { id: "settings.providers.account.created", message: "Provider account created" }
const savedToast = { id: "settings.providers.account.saved", message: "Provider account updated" }
const requestFailedToast = { id: "settings.providers.account.requestFailed", message: "Account update failed" }
const removeAccountTitle = { id: "settings.providers.account.remove.title", message: "Remove provider account?" }
const removeAccountDescription = {
  id: "settings.providers.account.remove.description",
  message: "This removes the account connection and its Synergy-managed credentials. Sibling accounts are unchanged.",
}

function modelCount(count: number) {
  return {
    id: "settings.providers.modelCount",
    message: "{count, plural, one {# model} other {# models}}",
    values: { count },
  }
}

export type ProviderConnectionSummary = ProviderConnection & {
  connected: boolean
  modelCount: number
  health?: ProviderAuthHealth
  availability?: ProviderRuntimeAvailability
  catalog?: ProviderListResponse["modelCatalog"][string]
  profile?: ProviderRecommendationMetadata
}

export function ProvidersPanel(props: {
  summaries: ProviderConnectionSummary[]
  authMethods: ProviderAuthResponse
  providerFocusID?: string
}) {
  const { _, i18n } = useLingui()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const confirm = useConfirm()
  const [query, setQuery] = createSignal("")
  const [selectedID, setSelectedID] = createSignal<string | undefined>(props.providerFocusID)
  const [refreshingID, setRefreshingID] = createSignal<string | undefined>()

  createEffect(() => {
    if (props.providerFocusID) setSelectedID(props.providerFocusID)
  })

  const profileMap = createMemo(() =>
    Object.fromEntries(props.summaries.map((provider) => [provider.id, provider.profile])),
  )
  const summaries = createMemo(() =>
    props.summaries
      .slice()
      .sort((a, b) => compareProviderIDs(profileMap(), { id: a.id, name: a.name }, { id: b.id, name: b.name })),
  )
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return summaries()
    return summaries().filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(q))
  })
  const groups = createMemo(() => groupProviderConnections(filtered(), SETTINGS_RECOMMENDED_PROVIDER_RANK))
  const recommended = createMemo(() =>
    groups().recommended.sort((a, b) => settingsRecommendedRank(a.id) - settingsRecommendedRank(b.id)),
  )
  const needsAttention = () => groups().needsAttention
  const connected = () => groups().connected
  const other = () => groups().other
  const selected = createMemo(() => {
    const current = selectedID()
    return (
      summaries().find((provider) => provider.id === current) ??
      needsAttention()[0] ??
      recommended()[0] ??
      connected()[0] ??
      other()[0] ??
      summaries()[0]
    )
  })

  const statusLabel = (provider: ProviderConnectionSummary) =>
    translateDescriptor(providerStatusLabel(provider.health, provider.availability), i18n())

  const catalogLabel = (provider: ProviderConnectionSummary) => {
    if (refreshingID() === provider.id || provider.catalog?.refreshing) return _(catalogRefreshing)
    if (provider.catalog?.failure)
      return provider.catalog.source === "bundled" ? `${_(catalogPending)} · ${_(catalogBundled)}` : _(catalogPending)
    if (provider.catalog?.source === "bundled") return _(catalogBundled)
    return _(catalogCached)
  }

  async function refreshModels(providerID: string) {
    setRefreshingID(providerID)
    try {
      await globalSDK.client.provider.models.refresh({ providerID }, { throwOnError: true })
    } catch {
    } finally {
      await globalSync.refreshProviders()
      setRefreshingID(undefined)
    }
  }

  function confirmDisconnect(provider: ProviderConnectionSummary) {
    const copy = disconnectProviderConfirm(provider.name)
    confirm.show({
      ...copy,
      onConfirm: async () => {
        await globalSDK.client.provider.disconnect({ providerID: provider.id }, { throwOnError: true })
        await globalSync.refreshProviders()
      },
    })
  }

  function openAddAccount(provider: ProviderConnectionSummary) {
    dialog.push(() => (
      <ProviderAccountDialog
        profileID={provider.profileID}
        providerName={provider.profile?.displayName ?? provider.profile?.name ?? provider.name}
        onSaved={async (connection) => {
          await globalSync.refreshProviders()
          setSelectedID(connection.id)
        }}
      />
    ))
  }

  function openEditAccount(provider: ProviderConnectionSummary) {
    dialog.push(() => (
      <ProviderAccountDialog
        connection={provider}
        profileID={provider.profileID}
        providerName={provider.profile?.displayName ?? provider.profile?.name ?? provider.name}
        onSaved={async (connection) => {
          await globalSync.refreshProviders()
          setSelectedID(connection.id)
        }}
      />
    ))
  }

  function confirmRemoveAccount(provider: ProviderConnectionSummary) {
    confirm.show({
      title: removeAccountTitle,
      description: removeAccountDescription,
      confirmLabel: removeAccountAction,
      tone: "danger",
      onConfirm: async () => {
        await globalSDK.client.provider.connection.remove({ providerID: provider.id }, { throwOnError: true })
        await globalSync.refreshProviders()
        setSelectedID(provider.profileID)
      },
    })
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <div class="providers-workspace">
        <div class="providers-directory">
          <div class="providers-search">
            <Icon name={getSemanticIcon("action.search")} size="small" />
            <input
              value={query()}
              placeholder={_(searchPlaceholder)}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>

          <div class="providers-directory-scroll">
            <Show when={filtered().length > 0} fallback={<div class="providers-list-empty">{_(noMatch)}</div>}>
              <ProviderGroup
                title={_(needsAttentionTitle)}
                providers={needsAttention()}
                selectedID={selected()?.id}
                onSelect={setSelectedID}
                statusLabel={statusLabel}
              />
              <ProviderGroup
                title={_(recommendedTitle)}
                providers={recommended()}
                selectedID={selected()?.id}
                onSelect={setSelectedID}
                statusLabel={statusLabel}
              />
              <ProviderGroup
                title={_(connectedTitle)}
                providers={connected()}
                selectedID={selected()?.id}
                onSelect={setSelectedID}
                statusLabel={statusLabel}
              />
              <ProviderGroup
                title={_(otherTitle)}
                providers={other()}
                selectedID={selected()?.id}
                onSelect={setSelectedID}
                statusLabel={statusLabel}
              />
            </Show>
          </div>
        </div>

        <div class="providers-detail">
          <Show
            when={selected()}
            fallback={
              <div class="providers-empty-detail">
                <Icon name={getSemanticIcon("providers.main")} size="large" />
                <span>{_(selectHint)}</span>
              </div>
            }
          >
            {(provider) => (
              <div class="providers-detail-content">
                <div class="providers-detail-summary">
                  <div class="flex items-center gap-3 min-w-0">
                    <ProviderIcon id={provider().profileID} class="providers-detail-icon" />
                    <div class="min-w-0">
                      <div class="providers-detail-title">{provider().name}</div>
                      <div class="providers-detail-copy">
                        {providerConnectReason(provider().id, profileMap()) ??
                          providerConnectCopy(provider().id, profileMap(), provider().name)}
                      </div>
                    </div>
                  </div>
                  <span
                    class="ds-inline-badge"
                    classList={{ "ds-inline-badge-muted": providerAuthTone(provider().health) === "muted" }}
                    data-auth-tone={providerAuthTone(provider().health)}
                  >
                    {statusLabel(provider())}
                  </span>
                </div>

                <div class="providers-detail-meta">
                  <span>{provider().id}</span>
                  <span>{_(modelCount(provider().modelCount))}</span>
                  <Show when={provider().removable}>
                    <span>{_(accountConnectionLabel)}</span>
                  </Show>
                  <Show when={props.authMethods[provider().id]?.length}>
                    <span>{props.authMethods[provider().id].map((method) => method.label).join(", ")}</span>
                  </Show>
                </div>

                <div class="providers-account-actions">
                  <div class="providers-account-actions-copy">
                    <Show when={provider().removable}>{_(accountConnectionDescription)}</Show>
                  </div>
                  <div class="providers-connect-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      icon={getSemanticIcon("action.add")}
                      onClick={() => openAddAccount(provider())}
                    >
                      {_(addAccountAction)}
                    </Button>
                    <Show when={provider().removable}>
                      <Button type="button" variant="ghost" size="small" onClick={() => openEditAccount(provider())}>
                        {_(editAccountAction)}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        icon={getSemanticIcon("action.remove")}
                        onClick={() => confirmRemoveAccount(provider())}
                      >
                        {_(removeAccountAction)}
                      </Button>
                    </Show>
                  </div>
                </div>

                <Show when={provider().connected && provider().catalog}>
                  <div class="providers-auth-warning" role="status">
                    <Icon name={getSemanticIcon("action.refresh")} size="small" />
                    <span>{catalogLabel(provider())}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={refreshingID() === provider().id || provider().catalog?.refreshing}
                      onClick={() => void refreshModels(provider().id)}
                    >
                      {_(catalogRefreshAction)}
                    </Button>
                  </div>
                </Show>

                <Show when={providerNeedsAction(provider().health)}>
                  <div class="providers-auth-warning" role="status">
                    <Icon name={getSemanticIcon("providers.reconnect")} size="small" />
                    <span>
                      {translateDescriptor(
                        providerRecoveryCopy(provider().name, provider().health, provider().profile?.environment),
                        i18n(),
                      )}
                    </span>
                    <Show when={providerCanDisconnect(provider().health)}>
                      <Button type="button" variant="ghost" size="small" onClick={() => confirmDisconnect(provider())}>
                        {translateDescriptor(disconnectProviderConfirm(provider().name).confirmLabel, i18n())}
                      </Button>
                    </Show>
                  </div>
                </Show>

                <div class="providers-connect-section">
                  <div>
                    <div class="providers-connect-title">
                      {providerNeedsAction(provider().health)
                        ? translateDescriptor(providerRecoveryActionLabel(provider().health), i18n())
                        : provider().connected
                          ? _(accountTab)
                          : _(connectTab)}
                    </div>
                    <p class="providers-connect-copy">
                      {providerNeedsAction(provider().health)
                        ? _(recoveryDesc)
                        : provider().connected
                          ? _(accountConnectedDesc)
                          : _(connectDesc)}
                    </p>
                  </div>
                  <Show
                    when={provider().health?.recovery !== "update_environment"}
                    fallback={<p class="providers-connect-copy">{_(envRecoveryFallbackDesc)}</p>}
                  >
                    <Show keyed when={provider().id}>
                      {(providerID) => (
                        <ProviderConnectionFlow
                          providerID={providerID}
                          providerName={provider().name}
                          iconID={provider().profileID}
                          intent={providerNeedsAction(provider().health) ? "recover" : "connect"}
                          compact
                        />
                      )}
                    </Show>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </SettingsPage>
  )
}

function settingsRecommendedRank(providerID: string) {
  return SETTINGS_RECOMMENDED_PROVIDER_RANK.get(providerID) ?? Number.MAX_SAFE_INTEGER
}

function ProviderGroup(props: {
  title: string
  providers: ProviderConnectionSummary[]
  selectedID?: string
  statusLabel: (provider: ProviderConnectionSummary) => string
  onSelect: (providerID: string) => void
}) {
  return (
    <Show when={props.providers.length > 0}>
      <div class="providers-group">
        <div class="providers-group-label">{props.title}</div>
        <For each={props.providers}>
          {(provider) => (
            <button
              type="button"
              class="providers-row"
              classList={{ "providers-row-active": props.selectedID === provider.id }}
              onClick={() => props.onSelect(provider.id)}
            >
              <ProviderIcon id={provider.profileID} class="providers-row-icon" />
              <div class="min-w-0 flex-1">
                <div class="providers-row-name">{provider.name}</div>
                <div class="providers-row-copy">
                  {providerConnectCopy(provider.id, { [provider.id]: provider.profile }, provider.name)}
                </div>
              </div>
              <span
                class="ds-inline-badge"
                classList={{ "ds-inline-badge-muted": providerAuthTone(provider.health) === "muted" }}
                data-auth-tone={providerAuthTone(provider.health)}
              >
                {props.statusLabel(provider)}
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

function ProviderAccountDialog(props: {
  profileID: string
  providerName: string
  connection?: ProviderConnection
  onSaved: (connection: ProviderConnection) => void | Promise<void>
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal(props.connection?.name ?? "")
  const [endpoint, setEndpoint] = createSignal(props.connection?.endpoint ?? "")
  const [enabled, setEnabled] = createSignal(props.connection?.enabled ?? true)
  const [busy, setBusy] = createSignal(false)
  const editing = () => props.connection !== undefined
  const ready = () => name().trim().length > 0

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!ready() || busy()) return
    setBusy(true)
    try {
      const response = editing()
        ? await globalSDK.client.provider.connection.update(
            {
              providerID: props.connection!.id,
              providerConnectionUpdateInput: {
                name: name().trim(),
                endpoint: endpoint().trim() || null,
                enabled: enabled(),
              },
            },
            { throwOnError: true },
          )
        : await globalSDK.client.provider.connection.create(
            {
              providerConnectionCreateInput: {
                profileID: props.profileID,
                name: name().trim(),
                ...(endpoint().trim() ? { endpoint: endpoint().trim() } : {}),
                enabled: enabled(),
              },
            },
            { throwOnError: true },
          )
      if (!response.data) throw new Error("Provider account response was empty")
      await props.onSaved(response.data)
      showToast({ type: "success", title: editing() ? _(savedToast) : _(createdToast) })
      dialog.close()
    } catch (error) {
      showToast({
        type: "error",
        title: _(requestFailedToast),
        description: requestErrorMessage(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={editing() ? _(editAccountTitle) : _(addAccountTitle)}
      description={editing() ? _(editAccountDescription) : _(addAccountDescription(props.providerName))}
      size="form"
      class="provider-account-dialog"
      dismissible
      action={
        <button
          type="button"
          aria-label={_(closeDialogLabel)}
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          disabled={busy()}
          onClick={() => dialog.close()}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <form data-slot="dialog-form" onSubmit={submit}>
        <div class="provider-account-dialog-fields">
          <TextField
            autofocus
            label={_(accountNameLabel)}
            placeholder={_(accountNamePlaceholder)}
            value={name()}
            disabled={busy()}
            onChange={setName}
          />
          <TextField
            label={_(endpointLabel)}
            description={_(endpointDescription)}
            placeholder={_(endpointPlaceholder)}
            value={endpoint()}
            disabled={busy()}
            onChange={setEndpoint}
          />
          <Switch checked={enabled()} disabled={busy()} onChange={setEnabled}>
            {_(enabledLabel)}
          </Switch>
        </div>
        <div data-slot="dialog-actions" class="provider-account-dialog-actions">
          <Button type="button" variant="ghost" size="large" disabled={busy()} onClick={() => dialog.close()}>
            {_(cancelAction)}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={busy() || !ready()}>
            {busy() ? (editing() ? _(savingAction) : _(creatingAction)) : editing() ? _(saveAction) : _(createAction)}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
