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
import { ProviderAdditionalAccountSetup } from "./ProviderAdditionalAccountSetup"
import { createProviderSetupDrafts, type ProviderSetupDrafts } from "@/components/provider/provider-setup-drafts"
import { providerCatalogPresentation } from "@/components/provider/provider-catalog-presentation"
import { useLocale } from "@/context/locale"
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
const catalogBundled = { id: "settings.providers.catalog.bundled", message: "Using preloaded models" }
const catalogCached = { id: "settings.providers.catalog.cached", message: "Using saved model list" }
const catalogUpdated = { id: "settings.providers.catalog.updated", message: "Model list updated" }
const catalogRefreshAction = { id: "settings.providers.catalog.refresh", message: "Refresh list" }
const addAccountAction = { id: "settings.providers.account.add", message: "Add another account" }
const editAccountAction = { id: "settings.providers.account.edit", message: "Edit account" }
const removeAccountAction = { id: "settings.providers.account.remove", message: "Remove account" }

const editAccountTitle = { id: "settings.providers.account.edit.title", message: "Edit provider account" }
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
const saveAction = { id: "settings.providers.account.save", message: "Save changes" }
const savingAction = { id: "settings.providers.account.saving", message: "Saving..." }
const savedToast = { id: "settings.providers.account.saved", message: "Provider account updated" }
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
  drafts?: ProviderSetupDrafts
}) {
  const { _, i18n } = useLingui()
  const { fmt } = useLocale()
  const drafts = props.drafts ?? createProviderSetupDrafts()
  if (!props.drafts) onCleanup(() => drafts.clear())
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()
  const confirm = useConfirm()
  const catalogOpen = () => drafts.view.catalogOpen
  const setCatalogOpen = (value: boolean) => drafts.setView("catalogOpen", value)
  const creatingAccountFor = () => props.summaries.find((item) => item.id === drafts.view.addingSourceID)
  const setCreatingAccountFor = (value?: ProviderConnectionSummary) => drafts.setView("addingSourceID", value?.id)
  const [authEditing, setAuthEditing] = createSignal(false)
  const [catalogError, setCatalogError] = createSignal<{ providerID: string; message: string }>()
  const [catalogResult, setCatalogResult] = createSignal<{
    providerID: string
    catalog: ProviderConnectionSummary["catalog"]
  }>()
  const query = () => drafts.view.query
  const setQuery = (value: string) => drafts.setView("query", value)
  const accountQuery = () => drafts.view.accountQuery
  const setAccountQuery = (value: string) => drafts.setView("accountQuery", value)
  const selectedID = () => drafts.view.selectedID
  const setSelectedID = (value?: string) => drafts.setView("selectedID", value)
  const [refreshingID, setRefreshingID] = createSignal<string | undefined>()
  const pendingCatalogReads = new Set<string>()

  let focusID = props.providerFocusID
  if (!selectedID() && focusID) setSelectedID(focusID)
  createEffect(() => {
    const id = props.providerFocusID
    if (id === focusID) return
    focusID = id
    if (id) chooseProvider(id)
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
  const origin = () => drafts.view.origin
  let restoration = 0
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const body = () => document.querySelector<HTMLElement>(".settings-panel-content")
  function rememberOrigin(providerID?: string) {
    drafts.setView("origin", { catalog: catalogOpen(), providerID, scroll: body()?.scrollTop ?? 0 })
  }
  function chooseProvider(id: string) {
    if (selectedID() && selectedID() !== id) drafts.remove(`existing:${selectedID()}`)
    cancelSetup()
    rememberOrigin(id)
    setSelectedID(id)
    setCatalogOpen(false)
    setAuthEditing(false)
  }
  function back() {
    if (selectedID()) drafts.remove(`existing:${selectedID()}`)
    setSelectedID(undefined)
    cancelSetup()
    setAuthEditing(false)
    setCatalogOpen(origin()?.catalog ?? false)
    const version = ++restoration
    requestAnimationFrame(async () => {
      const content = body()
      await Promise.all(
        (content?.getAnimations({ subtree: true }) ?? [])
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      )
      if (!alive || version !== restoration) return
      const target = origin()?.providerID
        ? [...document.querySelectorAll<HTMLElement>("[data-provider-id]")].find(
            (node) => node.dataset.providerId === origin()?.providerID,
          )
        : document.querySelector<HTMLElement>("[data-add-service]")
      if (content) content.scrollTop = origin()?.scroll ?? 0
      target?.focus({ preventScroll: true })
    })
  }
  const statusLabel = (provider: ProviderConnectionSummary) =>
    translateDescriptor(providerStatusLabel(provider.health, provider.availability), i18n())

  const catalogState = (provider: ProviderConnectionSummary) =>
    providerCatalogPresentation(
      catalogResult()?.providerID === provider.id ? catalogResult()?.catalog : provider.catalog,
      refreshingID() === provider.id,
    )
  const catalogLabel = (provider: ProviderConnectionSummary) => {
    switch (catalogState(provider).status) {
      case "loading":
        return _(catalogRefreshing)
      case "failed":
        return _({ id: "settings.providers.catalog.failed", message: "Could not refresh the model list" })
      case "bundled":
        return _(catalogBundled)
      case "updated":
        return _(catalogUpdated)
      case "cached":
        return _(catalogCached)
      default:
        return ""
    }
  }
  async function refreshModels(providerID: string) {
    if (refreshingID()) return
    setCatalogError(undefined)
    setRefreshingID(providerID)
    try {
      if (!pendingCatalogReads.has(providerID)) {
        const response = await globalSDK.client.provider.models.refresh({ providerID }, { throwOnError: true })
        pendingCatalogReads.add(providerID)
        if (alive && selectedID() === providerID && response.data)
          setCatalogResult({ providerID, catalog: response.data })
      }
      if (!alive) return
      await globalSync.refreshProviders()
      pendingCatalogReads.delete(providerID)
      if (alive && catalogResult()?.providerID === providerID) setCatalogResult(undefined)
    } catch (error) {
      if (alive && selectedID() === providerID) setCatalogError({ providerID, message: requestErrorMessage(error) })
    } finally {
      if (alive) setRefreshingID(undefined)
    }
  }
  function cancelSetup() {
    const sourceID = drafts.view.addingSourceID
    if (sourceID) drafts.remove(`additional:${sourceID}`)
    setCreatingAccountFor(undefined)
    if (sourceID)
      requestAnimationFrame(() => {
        if (alive) document.querySelector<HTMLElement>("[data-add-provider-account]")?.focus()
      })
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
    setAuthEditing(false)
    drafts.remove(`existing:${provider.id}`)
    setCreatingAccountFor(provider)
  }

  function openEditAccount(provider: ProviderConnectionSummary) {
    dialog.push(() => (
      <ProviderAccountDialog
        connection={provider}
        allowEndpoint={props.authMethods[provider.id]?.some((method) => method.type === "api") ?? false}
        onSaved={async (connection) => {
          await globalSync.refreshProviders()
          if (alive) setSelectedID(connection.id)
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
              {_({ id: "settings.providers.addService", message: "Add model service" })}
            </Button>
          }
        >
          <Button
            variant="ghost"
            icon={getSemanticIcon("navigation.back")}
            onClick={() => {
              if (!selected()) drafts.setView("origin", { catalog: false, scroll: 0 })
              back()
            }}
          >
            {selected() && origin()?.catalog
              ? _({ id: "settings.providers.backToServices", message: "Back to services" })
              : _({ id: "settings.providers.back", message: "Back to accounts" })}
          </Button>
        </Show>
      }
    >
      <p class="providers-immediate-hint">
        {_({
          id: "settings.providers.immediate",
          message: "Account actions take effect immediately. You can leave Settings without saving them again.",
        })}
      </p>
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
                    <span class="settings-row-title">
                      {provider.profile?.displayName ?? provider.profile?.name ?? provider.name}
                    </span>
                    <span class="settings-row-description">
                      {provider.removable ? `${provider.name} · ` : ""}
                      {provider.connected || providerNeedsAction(provider.health)
                        ? statusLabel(provider)
                        : _({
                            id: "settings.providers.unfinished",
                            message: "Unfinished connection · Continue connecting",
                          })}
                    </span>
                    <span class="settings-row-description">
                      {_(modelCount(provider.modelCount))}
                      <Show when={provider.catalog}> · {catalogLabel(provider)}</Show>
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
                        <div class="providers-detail-title">
                          {provider().profile?.displayName ?? provider().profile?.name ?? provider().name}
                        </div>
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

                  <div
                    class="providers-catalog-status"
                    classList={{ "providers-catalog-warning": catalogState(provider()).tone === "warning" }}
                    role="status"
                  >
                    <div class="providers-catalog-copy">
                      <span>{_(modelCount(provider().modelCount))}</span>
                      <Show when={provider().catalog}>
                        <span> · {catalogLabel(provider())}</span>
                        <Show when={catalogState(provider()).verifiedAt}>
                          {(timestamp) => (
                            <time dateTime={new Date(timestamp()).toISOString()}>
                              {_({
                                id: "settings.providers.catalog.lastUpdated",
                                message: "Last updated {time}",
                                values: { time: fmt.dateTime(timestamp()) },
                              })}
                            </time>
                          )}
                        </Show>
                        <Show when={catalogState(provider()).status === "failed" && provider().modelCount > 0}>
                          <span class="providers-catalog-note">
                            {provider().catalog?.source === "bundled"
                              ? _(catalogBundled)
                              : _({
                                  id: "settings.providers.catalog.stillAvailable",
                                  message: "You can keep using the existing models.",
                                })}
                          </span>
                        </Show>
                      </Show>
                    </div>
                    <Show when={provider().connected && provider().catalog}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        icon={getSemanticIcon("action.refresh")}
                        disabled={Boolean(refreshingID()) || provider().catalog?.refreshing}
                        onClick={() => void refreshModels(provider().id)}
                      >
                        {_(catalogRefreshAction)}
                      </Button>
                    </Show>
                  </div>

                  <div class="providers-account-actions">
                    <Show when={provider().removable}>
                      <span class="providers-account-actions-copy">{provider().name}</span>
                    </Show>
                    <div class="providers-connect-actions">
                      <Show when={provider().connected && canAddProviderAccount(provider()) && !creatingAccountFor()}>
                        <Button
                          data-add-provider-account
                          type="button"
                          variant="ghost"
                          size="small"
                          icon={getSemanticIcon("action.add")}
                          onClick={() => openAddAccount(provider())}
                        >
                          {_(addAccountAction)}
                        </Button>
                      </Show>
                      <Show
                        when={
                          (provider().connected && provider().health?.recovery !== "update_environment") ||
                          provider().removable
                        }
                      >
                        <details class="providers-management">
                          <summary>{_({ id: "settings.providers.account.manage", message: "Manage account" })}</summary>
                          <div class="providers-management-actions">
                            <Show when={provider().connected && provider().health?.recovery !== "update_environment"}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="small"
                                onClick={() => {
                                  cancelSetup()
                                  setAuthEditing(true)
                                }}
                              >
                                {_({ id: "settings.providers.updateCredentials", message: "Update credentials" })}
                              </Button>
                            </Show>
                            <Show when={provider().removable}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="small"
                                onClick={() => openEditAccount(provider())}
                              >
                                {_(editAccountAction)}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="small"
                                onClick={() => confirmRemoveAccount(provider())}
                              >
                                {_(removeAccountAction)}
                              </Button>
                            </Show>
                          </div>
                        </details>
                      </Show>
                    </div>
                  </div>
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

                  <Show when={catalogError()?.providerID === provider().id && catalogError()}>
                    <p class="providers-auth-warning" role="alert">
                      {catalogError()?.message}
                    </p>
                  </Show>
                  <Show
                    when={creatingAccountFor()}
                    fallback={
                      <Show
                        when={
                          !provider().connected ||
                          providerNeedsAction(provider().health) ||
                          authEditing() ||
                          drafts.peek(`existing:${provider().id}`)?.credentialsSaved
                        }
                      >
                        <div class="providers-connect-section">
                          <Show when={authEditing()}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="small"
                              onClick={() => {
                                drafts.remove(`existing:${provider().id}`)
                                setAuthEditing(false)
                              }}
                            >
                              {_(cancelAction)}
                            </Button>
                          </Show>
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
                                  draft={drafts.get(`existing:${providerID}`)}
                                  onDraftChange={(value) => drafts.update(`existing:${providerID}`, value)}
                                  connectedOverride={false}
                                  onComplete={() => {
                                    drafts.remove(`existing:${providerID}`)
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
                      <ProviderAdditionalAccountSetup
                        source={account()}
                        summaries={props.summaries}
                        drafts={drafts}
                        onCancel={cancelSetup}
                        onComplete={(providerID) => {
                          setCreatingAccountFor(undefined)
                          setSelectedID(providerID)
                          setAuthEditing(false)
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
  connection: ProviderConnection
  allowEndpoint: boolean
  onSaved: (connection: ProviderConnection) => void | Promise<void>
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal(props.connection.name)
  const [endpoint, setEndpoint] = createSignal(props.connection.endpoint ?? "")
  const [enabled, setEnabled] = createSignal(props.connection.enabled)
  const [busy, setBusy] = createSignal(false)
  const [persisted, setPersisted] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let active = true
  onCleanup(() => {
    active = false
  })
  const command = createProviderAccountCommand(
    async () => {
      const connection = await saveProviderAccount(globalSDK.client.provider.connection, {
        mode: "update",
        providerID: props.connection.id,
        name: name().trim(),
        endpoint: endpoint().trim() || null,
        enabled: enabled(),
      })
      if (active) setPersisted(true)
      return connection
    },
    async (connection) => {
      if (active) await props.onSaved(connection)
    },
  )
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!name().trim() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await command.run()
      if (!active) return
      showToast({ type: "success", title: _(savedToast) })
      dialog.close()
    } catch (cause) {
      if (active) setError(requestErrorMessage(cause))
    } finally {
      if (active) setBusy(false)
    }
  }
  return (
    <Dialog title={_(editAccountTitle)} size="form">
      <form data-slot="dialog-form" onSubmit={submit}>
        <Show when={error()}>
          <p class="settings-request-error" role="alert">
            <Show when={persisted()}>
              {_({
                id: "settings.providers.account.savedRefreshFailed",
                message: "Account changes saved. Refresh the connection to update this view.",
              })}
            </Show>
            {error()}
          </p>
        </Show>
        <div class="provider-account-dialog-fields">
          <TextField
            autofocus
            label={_(accountNameLabel)}
            required
            maxLength={80}
            placeholder={_(accountNamePlaceholder)}
            value={name()}
            disabled={busy() || persisted()}
            onChange={setName}
          />
          <Show when={props.allowEndpoint || props.connection.endpoint}>
            <details class="providers-advanced">
              <summary>{_({ id: "settings.providers.account.advanced", message: "Advanced settings" })}</summary>
              <TextField
                label={_(endpointLabel)}
                description={_(endpointDescription)}
                placeholder={_(endpointPlaceholder)}
                value={endpoint()}
                disabled={busy() || persisted()}
                onChange={setEndpoint}
              />
            </details>
          </Show>
          <Switch checked={enabled()} disabled={busy() || persisted()} onChange={setEnabled}>
            {_(enabledLabel)}
          </Switch>
        </div>
        <div data-slot="dialog-actions" class="provider-account-dialog-actions">
          <Button type="button" variant="ghost" size="large" disabled={busy()} onClick={() => dialog.close()}>
            {_(cancelAction)}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={busy() || !name().trim()}>
            {busy()
              ? _(savingAction)
              : persisted()
                ? _({ id: "settings.providers.account.retryRefresh", message: "Refresh connection" })
                : _(saveAction)}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
