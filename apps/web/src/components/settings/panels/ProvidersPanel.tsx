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
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { disconnectProviderConfirm } from "@/components/dialog/confirm-copy"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import { translateDescriptor } from "@/locales/translate"
import {
  compareProviderIDs,
  providerConnectReason,
  type ProviderRecommendationMetadata,
} from "@/components/provider/provider-recommendation"
import { SettingsPage } from "../components/SettingsPrimitives"
import {
  providerNeedsAction,
  providerCanDisconnect,
  providerAuthTone,
  providerRecoveryCopy,
  providerStatusLabel,
} from "@/components/provider/provider-auth-presentation"
import { groupProviderConnections } from "./provider-groups"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { requestErrorMessage } from "@/utils/error"
import {
  canAddProviderAccount,
  createProviderAccountCommand,
  removeProviderAccount,
  saveProviderAccount,
} from "./provider-account-operations"

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
  const [catalogOpen, setCatalogOpen] = createSignal(false)
  const [creatingAccountFor, setCreatingAccountFor] = createSignal<ProviderConnectionSummary>()
  const [authEditing, setAuthEditing] = createSignal(false)
  const [catalogError, setCatalogError] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [accountQuery, setAccountQuery] = createSignal("")
  const [selectedID, setSelectedID] = createSignal<string | undefined>(props.providerFocusID)
  const [refreshingID, setRefreshingID] = createSignal<string | undefined>()
  const pendingCatalogReads = new Set<string>()

  createEffect(() => {
    if (props.providerFocusID) setSelectedID(props.providerFocusID)
  })

  const serviceHint = (provider: ProviderConnectionSummary) => {
    switch (provider.profileID) {
      case "openai":
        return _({ id: "settings.providers.service.platform", message: "OpenAI Platform API key" })
      case "openai-codex":
        return _({ id: "settings.providers.service.codex", message: "ChatGPT/Codex subscription" })
      case "anthropic":
        return _({ id: "settings.providers.service.anthropic", message: "Claude Pro/Max or API key" })
      case "github-copilot":
      case "github-copilot-enterprise":
        return _({ id: "settings.providers.service.copilot", message: "GitHub Copilot subscription" })
      case "grok":
        return _({ id: "settings.providers.service.grok", message: "Grok subscription" })
      case "google":
        return _({ id: "settings.providers.service.google", message: "Gemini API key" })
      case "openrouter":
        return _({ id: "settings.providers.service.openrouter", message: "Model routing service" })
      default:
        return provider.profile?.recommendation?.headline
    }
  }

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
  const selected = createMemo(() => summaries().find((provider) => provider.id === selectedID()))
  const accounts = () =>
    summaries().filter(
      (provider) =>
        (provider.connected || provider.removable || providerNeedsAction(provider.health)) &&
        `${provider.name} ${provider.id}`.toLocaleLowerCase().includes(accountQuery().toLocaleLowerCase().trim()),
    )
  let origin: { catalog: boolean; providerID?: string; scroll: number } | undefined
  let restoration = 0
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const body = () => document.querySelector<HTMLElement>(".settings-panel-content")
  function rememberOrigin(providerID?: string) {
    origin = { catalog: catalogOpen(), providerID, scroll: body()?.scrollTop ?? 0 }
  }
  function chooseProvider(id: string) {
    rememberOrigin(id)
    setSelectedID(id)
    setCatalogOpen(false)
    setAuthEditing(false)
  }
  function back() {
    setSelectedID(undefined)
    setCreatingAccountFor(undefined)
    setAuthEditing(false)
    setCatalogOpen(origin?.catalog ?? false)
    const version = ++restoration
    requestAnimationFrame(async () => {
      const content = body()
      await Promise.all(
        (content?.getAnimations({ subtree: true }) ?? [])
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      )
      if (!alive || version !== restoration) return
      const target = origin?.providerID
        ? [...document.querySelectorAll<HTMLElement>("[data-provider-id]")].find(
            (node) => node.dataset.providerId === origin?.providerID,
          )
        : document.querySelector<HTMLElement>("[data-add-service]")
      if (content) content.scrollTop = origin?.scroll ?? 0
      target?.focus({ preventScroll: true })
    })
  }
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
    setCatalogError(undefined)
    setRefreshingID(providerID)
    try {
      if (!pendingCatalogReads.has(providerID)) {
        await globalSDK.client.provider.models.refresh({ providerID }, { throwOnError: true })
        pendingCatalogReads.add(providerID)
      }
      await globalSync.refreshProviders()
      pendingCatalogReads.delete(providerID)
    } catch (error) {
      setCatalogError(requestErrorMessage(error))
    } finally {
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
    setCreatingAccountFor(provider)
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
        await removeProviderAccount(globalSDK.client.provider.connection, provider.id)
        await globalSync.refreshProviders()
        setSelectedID(provider.profileID)
      },
    })
  }

  return (
    <SettingsPage
      title={_(pageTitle)}
      description={_(pageDescription)}
      actions={
        <Show
          when={selected() || catalogOpen()}
          fallback={
            <Button
              data-add-service
              variant="secondary"
              icon={getSemanticIcon("action.add")}
              onClick={() => {
                rememberOrigin()
                setCatalogOpen(true)
              }}
            >
              {_({ id: "settings.providers.addService", message: "Add service" })}
            </Button>
          }
        >
          <Button
            variant="ghost"
            icon={getSemanticIcon("navigation.back")}
            onClick={() => {
              if (!selected()) origin = { catalog: false, scroll: 0 }
              back()
            }}
          >
            {selected() && origin?.catalog
              ? _({ id: "settings.providers.backToServices", message: "Back to services" })
              : _({ id: "settings.providers.back", message: "Back to accounts" })}
          </Button>
        </Show>
      }
    >
      <Show when={!selected() && !catalogOpen()}>
        <TextField
          hideLabel
          label={_({ id: "settings.providers.accounts.search", message: "Search connected accounts" })}
          placeholder={_({ id: "settings.providers.accounts.search", message: "Search connected accounts" })}
          value={accountQuery()}
          onChange={setAccountQuery}
        />
        <div class="providers-connected-list">
          <Show
            when={accounts().length}
            fallback={
              <div class="ds-empty-state">
                <Show
                  when={accountQuery().trim()}
                  fallback={
                    <>
                      <span>{_({ id: "settings.providers.empty.title", message: "No connected services" })}</span>
                      <p>
                        {_({
                          id: "settings.providers.empty.description",
                          message: "Add a service to start choosing models.",
                        })}
                      </p>
                    </>
                  }
                >
                  <span>{_(noMatch)}</span>
                  <Button variant="ghost" onClick={() => setAccountQuery("")}>
                    {_({ id: "settings.search.clear", message: "Clear search" })}
                  </Button>
                </Show>
              </div>
            }
          >
            <For each={accounts()}>
              {(provider) => (
                <button
                  type="button"
                  class="providers-connected-account"
                  data-provider-id={provider.id}
                  onClick={() => chooseProvider(provider.id)}
                >
                  <ProviderIcon id={provider.profileID} class="size-6 shrink-0" />
                  <span class="providers-connected-copy">
                    <span class="settings-row-title">{provider.name}</span>
                    <span class="settings-row-description">
                      {provider.connected
                        ? statusLabel(provider)
                        : _({
                            id: "settings.providers.unfinished",
                            message: "Unfinished connection · Continue connecting",
                          })}
                    </span>
                    <span class="settings-row-description">
                      {_(modelCount(provider.modelCount))} · {catalogLabel(provider)}
                    </span>
                  </span>
                  <Icon name={getSemanticIcon("navigation.expand")} size="small" />
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <div class="providers-workspace">
        <Show when={catalogOpen() && !selected()}>
          <div class="providers-directory">
            <div class="providers-search">
              <Icon name={getSemanticIcon("action.search")} size="small" />
              <input
                value={query()}
                placeholder={_(searchPlaceholder)}
                aria-label={_(searchPlaceholder)}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <Show when={query()}>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  icon={getSemanticIcon("action.close")}
                  aria-label={_({ id: "settings.search.clear", message: "Clear search" })}
                  onClick={() => setQuery("")}
                />
              </Show>
            </div>

            <div class="providers-directory-scroll">
              <Show when={filtered().length > 0} fallback={<div class="providers-list-empty">{_(noMatch)}</div>}>
                <ProviderGroup
                  title={_(needsAttentionTitle)}
                  providers={needsAttention()}
                  selectedID={selected()?.id}
                  onSelect={chooseProvider}
                  statusLabel={statusLabel}
                  serviceHint={serviceHint}
                />
                <ProviderGroup
                  title={_(recommendedTitle)}
                  providers={recommended()}
                  selectedID={selected()?.id}
                  onSelect={chooseProvider}
                  statusLabel={statusLabel}
                  serviceHint={serviceHint}
                />
                <ProviderGroup
                  title={_(connectedTitle)}
                  providers={connected()}
                  selectedID={selected()?.id}
                  onSelect={chooseProvider}
                  statusLabel={statusLabel}
                  serviceHint={serviceHint}
                />
                <ProviderGroup
                  title={_(otherTitle)}
                  providers={other()}
                  selectedID={selected()?.id}
                  onSelect={chooseProvider}
                  statusLabel={statusLabel}
                  serviceHint={serviceHint}
                />
              </Show>
            </div>
          </div>
        </Show>
        <Show when={selected()}>
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
                        <Show when={serviceHint(provider()) ?? providerConnectReason(provider().id, profileMap())}>
                          {(text) => <div class="providers-detail-copy">{text()}</div>}
                        </Show>
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
                    <span>{_(modelCount(provider().modelCount))}</span>
                    <Show when={provider().removable}>
                      <span>{_(accountConnectionLabel)}</span>
                    </Show>
                  </div>

                  <div class="providers-account-actions">
                    <div class="providers-account-actions-copy">
                      <Show when={provider().removable}>{_(accountConnectionDescription)}</Show>
                    </div>
                    <div class="providers-connect-actions">
                      <Show when={canAddProviderAccount(provider())}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          icon={getSemanticIcon("action.add")}
                          onClick={() => openAddAccount(provider())}
                        >
                          {_(addAccountAction)}
                        </Button>
                      </Show>
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          onClick={() => confirmDisconnect(provider())}
                        >
                          {translateDescriptor(disconnectProviderConfirm(provider().name).confirmLabel, i18n())}
                        </Button>
                      </Show>
                    </div>
                  </Show>

                  <Show when={catalogError()}>
                    <p class="settings-request-error" role="alert">
                      {catalogError()}
                    </p>
                  </Show>
                  <Show
                    when={creatingAccountFor()}
                    fallback={
                      <Show
                        when={!provider().connected || providerNeedsAction(provider().health) || authEditing()}
                        fallback={
                          <Button variant="secondary" onClick={() => setAuthEditing(true)}>
                            {_({ id: "settings.providers.updateCredentials", message: "Update credentials" })}
                          </Button>
                        }
                      >
                        <div class="providers-connect-section">
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
                                  connectedOverride={false}
                                  onComplete={() => {
                                    setAuthEditing(false)
                                    setCreatingAccountFor(undefined)
                                  }}
                                />
                              )}
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    }
                  >
                    {(account) => (
                      <ProviderAccountDialog
                        inline
                        profileID={account().profileID}
                        providerName={account().name}
                        onCancel={() => setCreatingAccountFor(undefined)}
                        onSaved={async (connection) => {
                          await globalSync.refreshProviders()
                          setSelectedID(connection.id)
                          setAuthEditing(true)
                        }}
                      />
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>
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
  serviceHint: (provider: ProviderConnectionSummary) => string | undefined
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
              data-provider-id={provider.id}
              classList={{ "providers-row-active": props.selectedID === provider.id }}
              onClick={() => props.onSelect(provider.id)}
            >
              <ProviderIcon id={provider.profileID} class="providers-row-icon" />
              <div class="min-w-0 flex-1">
                <div class="providers-row-name">{provider.name}</div>
                <Show when={props.serviceHint(provider)}>
                  {(text) => <div class="providers-row-copy">{text()}</div>}
                </Show>
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
  inline?: boolean
  onCancel?: () => void
  profileID: string
  providerName: string
  connection?: ProviderConnection
  onSaved: (connection: ProviderConnection) => void | Promise<void>
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const close = () => (props.onCancel ? props.onCancel() : dialog.close())
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal(props.connection?.name ?? "")
  const [endpoint, setEndpoint] = createSignal(props.connection?.endpoint ?? "")
  const [enabled, setEnabled] = createSignal(props.connection?.enabled ?? true)
  const [busy, setBusy] = createSignal(false)
  const [persisted, setPersisted] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const editing = () => props.connection !== undefined
  const ready = () => name().trim().length > 0

  const command = createProviderAccountCommand(
    async () => {
      const connection = await saveProviderAccount(
        globalSDK.client.provider.connection,
        editing()
          ? {
              mode: "update",
              providerID: props.connection!.id,
              name: name().trim(),
              endpoint: endpoint().trim() || null,
              enabled: enabled(),
            }
          : {
              mode: "create",
              profileID: props.profileID,
              name: name().trim(),
              ...(endpoint().trim() ? { endpoint: endpoint().trim() } : {}),
              enabled: enabled(),
            },
      )
      setPersisted(true)
      return connection
    },
    async (connection) => {
      await props.onSaved(connection)
    },
  )

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!ready() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await command.run()
      showToast({ type: "success", title: editing() ? _(savedToast) : _(createdToast) })
      close()
    } catch (cause) {
      setError(requestErrorMessage(cause))
      showToast({
        type: "error",
        title: _(requestFailedToast),
        description: requestErrorMessage(cause),
      })
    } finally {
      setBusy(false)
    }
  }

  const form = () => (
    <form data-slot="dialog-form" onSubmit={submit}>
      <Show when={error()}>
        <p class="settings-request-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="provider-account-dialog-fields">
        <TextField
          autofocus
          label={_(accountNameLabel)}
          required
          placeholder={_(accountNamePlaceholder)}
          value={name()}
          disabled={busy() || persisted()}
          onChange={setName}
        />
        <TextField
          label={_(endpointLabel)}
          description={_(endpointDescription)}
          placeholder={_(endpointPlaceholder)}
          value={endpoint()}
          disabled={busy() || persisted()}
          onChange={setEndpoint}
        />
        <Switch checked={enabled()} disabled={busy() || persisted()} onChange={setEnabled}>
          {_(enabledLabel)}
        </Switch>
      </div>
      <div data-slot="dialog-actions" class="provider-account-dialog-actions">
        <Button type="button" variant="ghost" size="large" disabled={busy()} onClick={() => close()}>
          {_(cancelAction)}
        </Button>
        <Button type="submit" variant="primary" size="large" disabled={busy() || !ready()}>
          {busy()
            ? editing()
              ? _(savingAction)
              : _(creatingAction)
            : persisted()
              ? _({ id: "settings.providers.account.retryRefresh", message: "Refresh connection" })
              : editing()
                ? _(saveAction)
                : _(createAction)}
        </Button>
      </div>
    </form>
  )
  return (
    <Show
      when={props.inline}
      fallback={
        <Dialog title={editing() ? _(editAccountTitle) : _(addAccountTitle)} size="form">
          {form()}
        </Dialog>
      }
    >
      <div class="providers-account-create">
        <h2 class="ds-section-label">{_(addAccountTitle)}</h2>
        {form()}
      </div>
    </Show>
  )
}
