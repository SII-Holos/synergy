import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import "@ericsanchezok/synergy-ui/menu-field"
import { useLingui } from "@lingui/solid"
import type {
  ProviderAuthHealth,
  ProviderAuthResponse,
  ProviderConnection,
  ProviderListResponse,
  ProviderRuntimeAvailability,
} from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useOverlayLayer } from "@ericsanchezok/synergy-ui/context/overlay-layer"
import { PortalStyleOwner } from "@ericsanchezok/synergy-ui/context/ui-style"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { disconnectProviderConfirm } from "@/components/dialog/confirm-copy"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { ProviderAccountSetup } from "./ProviderAdditionalAccountSetup"
import { ProviderAccountEditor } from "./ProviderAccountEditor"
import { CustomProviderEditor } from "./CustomProviderEditor"
import { createProviderSetupDrafts, type ProviderSetupDrafts } from "@/components/provider/provider-setup-drafts"
import { providerCatalogPresentation } from "@/components/provider/provider-catalog-presentation"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { compareProviderIDs, type ProviderRecommendationMetadata } from "@/components/provider/provider-recommendation"
import { SettingsPage } from "../components/SettingsPrimitives"
import {
  providerNeedsAction,
  providerCanDisconnect,
  providerAuthTone,
  providerRecoveryCopy,
  providerStatusLabel,
} from "@/components/provider/provider-auth-presentation"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { requestErrorMessage } from "@/utils/error"
import { canAddProviderAccount, removeProviderAccount } from "./provider-account-operations"

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
const searchPlaceholder = { id: "settings.providers.search.placeholder", message: "Search providers..." }
const noMatch = { id: "settings.providers.noMatch", message: "No providers match this search." }
const recommendedTitle = { id: "settings.providers.recommended", message: "Recommended" }
const otherTitle = { id: "settings.providers.other", message: "Other" }
const catalogRefreshing = { id: "settings.providers.catalog.refreshing", message: "Refreshing model list" }
const catalogBundled = { id: "settings.providers.catalog.bundled", message: "Using preloaded models" }
const catalogCached = { id: "settings.providers.catalog.cached", message: "Using saved model list" }
const catalogUpdated = { id: "settings.providers.catalog.updated", message: "Model list updated" }
const catalogRefreshAction = { id: "settings.providers.catalog.refresh", message: "Refresh list" }
const addAccountAction = { id: "settings.providers.account.add", message: "Add another account" }
const editAccountAction = { id: "settings.providers.account.edit", message: "Edit account" }
const removeAccountAction = { id: "settings.providers.account.remove", message: "Remove account" }

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
  const confirm = useConfirm()
  const overlayLayer = useOverlayLayer()
  const catalogOpen = () => drafts.view.catalogOpen
  const customOpen = () => drafts.view.customOpen
  const setCatalogOpen = (value: boolean) => drafts.setView("catalogOpen", value)
  const creatingAccountFor = () => props.summaries.find((item) => item.id === drafts.view.addingSourceID)
  let closeGuard: (() => Promise<boolean>) | undefined
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
  const serviceName = (provider: ProviderConnectionSummary) =>
    provider.profile?.displayName ?? provider.profile?.name ?? provider.name
  const services = createMemo(() => summaries().filter((provider) => !provider.removable))
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    return services().filter((provider) => `${serviceName(provider)} ${provider.id}`.toLowerCase().includes(q))
  })
  const recommended = () =>
    filtered()
      .filter((provider) => SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id))
      .sort((a, b) => settingsRecommendedRank(a.id) - settingsRecommendedRank(b.id))
  const other = () => filtered().filter((provider) => !SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id))
  const selected = createMemo(() => summaries().find((provider) => provider.id === selectedID()))
  const accounts = () =>
    summaries().filter(
      (provider) =>
        (provider.connected || provider.configured || provider.removable || providerNeedsAction(provider.health)) &&
        `${serviceName(provider)} ${provider.name} ${provider.id}`
          .toLowerCase()
          .includes(accountQuery().toLowerCase().trim()),
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
    rememberOrigin(id)
    drafts.setView({ selectedID: id, addingSourceID: undefined, catalogOpen: false, customOpen: false })
  }
  function chooseService(id: string, additional?: boolean) {
    const source = summaries().find((item) => item.id === id)
    rememberOrigin(id)
    drafts.setView({
      selectedID: id,
      addingSourceID: id,
      addingAdditional:
        additional ?? Boolean(source?.connected || source?.removable || providerNeedsAction(source?.health)),
      catalogOpen: false,
      customOpen: false,
    })
  }
  async function back() {
    if (closeGuard && !(await closeGuard())) return
    const sourceID = drafts.view.addingSourceID
    if (sourceID && drafts.dirty(`setup:${sourceID}`)) {
      const discard = await confirm.ask({
        title: { id: "confirm.discardSettings.title", message: "Discard unsaved changes?" },
        description: { id: "settings.providers.account.discardSetup", message: "This account has not been connected." },
        confirmLabel: { id: "confirm.discardSettings.confirm", message: "Discard" },
        cancelLabel: { id: "confirm.discardSettings.cancel", message: "Keep Editing" },
        tone: "warning",
      })
      if (!discard) return
    }
    if (sourceID) drafts.remove(`setup:${sourceID}`)
    const wasCustom = customOpen()
    drafts.setView("customOpen", false)
    setSelectedID(undefined)
    drafts.setView("addingSourceID", undefined)
    setCatalogOpen(wasCustom ? false : (origin()?.catalog ?? false))
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
    const source = services().find((item) => item.profileID === provider.profileID)
    if (source) chooseService(source.id, true)
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
        drafts.remove(`edit:${provider.id}`)
        drafts.remove(`existing:${provider.id}`)
        setSelectedID(undefined)
        setCatalogOpen(false)
      },
    })
  }

  return (
    <SettingsPage
      title={_(pageTitle)}
      actions={
        <Show
          when={selected() || catalogOpen() || customOpen()}
          fallback={
            <div class="providers-add-actions">
              <Button
                data-add-service
                variant="secondary"
                icon={getSemanticIcon("action.add")}
                onClick={() => {
                  rememberOrigin()
                  setCatalogOpen(true)
                }}
              >
                {_({ id: "settings.providers.addThirdParty", message: "Add third-party provider" })}
              </Button>
              <Button
                data-add-custom
                variant="secondary"
                icon={getSemanticIcon("action.add")}
                onClick={() => {
                  rememberOrigin()
                  drafts.setView("customOpen", true)
                }}
              >
                {_({ id: "settings.providers.addCustom", message: "Add custom model API" })}
              </Button>
            </div>
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
      <Show when={!selected() && !catalogOpen() && !customOpen()}>
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
                <div class="providers-connected-account">
                  <button
                    type="button"
                    class="providers-connected-open"
                    data-provider-id={provider.id}
                    onClick={() => chooseProvider(provider.id)}
                  >
                    <ProviderIcon id={provider.profileID} class="size-6 shrink-0" />
                    <span class="providers-connected-copy">
                      <span class="settings-row-title">{serviceName(provider)}</span>
                      <span class="settings-row-description">
                        {provider.name !== serviceName(provider) ? `${provider.name} · ` : ""}
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
                  </button>
                  <div class="providers-row-actions">
                    <Button variant="ghost" size="small" onClick={() => chooseProvider(provider.id)}>
                      {_(editAccountAction)}
                    </Button>
                    <Show when={canAddProviderAccount(provider) || provider.removable}>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as="button"
                          type="button"
                          class="providers-more"
                          aria-label={_({ id: "settings.providers.account.actions", message: "Account actions" })}
                        >
                          <Icon name={getSemanticIcon("action.more")} size="small" />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal mount={overlayLayer()}>
                          <PortalStyleOwner>
                            <DropdownMenu.Content
                              class="menu-field-surface"
                              onEscapeKeyDown={(event) => event.stopPropagation()}
                            >
                              <Show when={canAddProviderAccount(provider)}>
                                <DropdownMenu.Item class="menu-field-item" onSelect={() => openAddAccount(provider)}>
                                  {_(addAccountAction)}
                                </DropdownMenu.Item>
                              </Show>
                              <Show when={provider.removable}>
                                <DropdownMenu.Item
                                  class="menu-field-item"
                                  onSelect={() => confirmRemoveAccount(provider)}
                                >
                                  {_(removeAccountAction)}
                                </DropdownMenu.Item>
                              </Show>
                            </DropdownMenu.Content>
                          </PortalStyleOwner>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
      <div class="providers-workspace">
        <Show when={customOpen()}>
          <div class="providers-custom-heading">
            <h2>{_({ id: "settings.providers.custom.title", message: "Custom model API" })}</h2>
          </div>
          <CustomProviderEditor
            occupiedIDs={props.summaries.map((item) => item.id)}
            drafts={drafts}
            registerCloseGuard={(guard) => {
              closeGuard = guard
            }}
            onCancel={() => void back()}
            onSaved={(providerID) => {
              drafts.setView({
                customOpen: false,
                selectedID: providerID,
                origin: { catalog: false, scroll: 0, providerID },
              })
              drafts.remove("custom:new")
            }}
          />
        </Show>
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
                  title={_(recommendedTitle)}
                  providers={recommended()}
                  selectedID={selected()?.id}
                  onSelect={chooseService}
                  statusLabel={statusLabel}
                  serviceHint={serviceHint}
                />
                <ProviderGroup
                  title={_(otherTitle)}
                  providers={other()}
                  selectedID={selected()?.id}
                  onSelect={chooseService}
                  statusLabel={statusLabel}
                  serviceHint={serviceHint}
                />
              </Show>
            </div>
          </div>
        </Show>
        <Show keyed when={selected()?.id}>
          {(id) => {
            const provider = () => summaries().find((item) => item.id === id)!
            return (
              <div class="providers-detail">
                <div class="providers-detail-content">
                  <div class="providers-detail-summary">
                    <div class="flex items-center gap-3 min-w-0">
                      <ProviderIcon id={provider().profileID} class="providers-detail-icon" />
                      <div class="min-w-0">
                        <div class="providers-detail-title">{serviceName(provider())}</div>
                        <Show when={creatingAccountFor() && serviceHint(provider())}>
                          {(text) => <div class="providers-detail-copy">{text()}</div>}
                        </Show>
                      </div>
                    </div>
                    <Show when={!creatingAccountFor()}>
                      <span
                        class="ds-inline-badge"
                        classList={{ "ds-inline-badge-muted": providerAuthTone(provider().health) === "muted" }}
                        data-auth-tone={providerAuthTone(provider().health)}
                      >
                        {statusLabel(provider())}
                      </span>
                    </Show>
                  </div>

                  <Show when={!creatingAccountFor()}>
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
                      when={provider().protocol}
                      fallback={
                        <ProviderAccountEditor
                          connection={provider()}
                          allowEndpoint={
                            props.authMethods[provider().id]?.some((method) => method.type === "api") ?? false
                          }
                          drafts={drafts}
                          onSaved={() => globalSync.refreshProviders()}
                          registerCloseGuard={(guard) => {
                            closeGuard = guard
                          }}
                          onCancel={() => void back()}
                        />
                      }
                    >
                      <CustomProviderEditor
                        connection={provider()}
                        occupiedIDs={props.summaries.map((item) => item.id)}
                        drafts={drafts}
                        onSaved={() => {}}
                        registerCloseGuard={(guard) => {
                          closeGuard = guard
                        }}
                        onCancel={() => void back()}
                      />
                    </Show>
                  </Show>
                  <Show when={creatingAccountFor()}>
                    {(source) => (
                      <>
                        <ProviderAccountSetup
                          source={source()}
                          summaries={props.summaries}
                          additional={drafts.view.addingAdditional}
                          drafts={drafts}
                          onComplete={(providerID) => {
                            drafts.setView({
                              addingSourceID: undefined,
                              selectedID: providerID,
                              origin: { catalog: false, scroll: 0, providerID },
                            })
                          }}
                        />
                        <Button variant="ghost" onClick={() => void back()}>
                          {_({ id: "settings.providers.account.cancel", message: "Cancel" })}
                        </Button>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            )
          }}
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
              disabled={provider.connected && !canAddProviderAccount(provider)}
              onClick={() => props.onSelect(provider.id)}
            >
              <ProviderIcon id={provider.profileID} class="providers-row-icon" />
              <div class="min-w-0 flex-1">
                <div class="providers-row-name">
                  {provider.profile?.displayName ?? provider.profile?.name ?? provider.name}
                </div>
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
