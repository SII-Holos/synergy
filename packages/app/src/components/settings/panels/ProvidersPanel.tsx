import { useLingui } from "@lingui/solid"
import type {
  ProviderAuthHealth,
  ProviderAuthResponse,
  ProviderRuntimeAvailability,
} from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"
import {
  compareProviderIDs,
  providerConnectCopy,
  providerConnectReason,
  type ProviderRecommendationMetadata,
} from "@/components/provider/provider-recommendation"
import { SettingsPage } from "../components/SettingsPrimitives"
import {
  providerNeedsAction,
  providerAuthTone,
  providerRecoveryActionLabel,
  providerRecoveryCopy,
  providerStatusLabel,
} from "@/components/provider/provider-auth-presentation"
import { groupProviderConnections } from "./provider-groups"

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

function modelCount(count: number) {
  return {
    id: "settings.providers.modelCount",
    message: "{count, plural, one {# model} other {# models}}",
    values: { count },
  }
}

export type ProviderConnectionSummary = {
  id: string
  name: string
  connected: boolean
  modelCount: number
  health?: ProviderAuthHealth
  availability?: ProviderRuntimeAvailability
  profile?: ProviderRecommendationMetadata
}

export function ProvidersPanel(props: {
  summaries: ProviderConnectionSummary[]
  authMethods: ProviderAuthResponse
  providerFocusID?: string
}) {
  const { _ } = useLingui()
  const [query, setQuery] = createSignal("")
  const [selectedID, setSelectedID] = createSignal<string | undefined>(props.providerFocusID)

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
    _(providerStatusLabel(provider.health, provider.availability))

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
                    <ProviderIcon id={provider().id} class="providers-detail-icon" />
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
                  <Show when={props.authMethods[provider().id]?.length}>
                    <span>{props.authMethods[provider().id].map((method) => method.label).join(", ")}</span>
                  </Show>
                  <Show when={provider().availability?.reason && provider().availability?.reason !== "connected"}>
                    <span>{provider().availability?.reason?.replace(/_/g, " ")}</span>
                  </Show>
                </div>

                <Show when={providerNeedsAction(provider().health)}>
                  <div class="providers-auth-warning" role="status">
                    <Icon name={getSemanticIcon("providers.reconnect")} size="small" />
                    <span>
                      {_(providerRecoveryCopy(provider().name, provider().health, provider().profile?.environment))}
                    </span>
                  </div>
                </Show>

                <div class="providers-connect-section">
                  <div>
                    <div class="providers-connect-title">
                      {providerNeedsAction(provider().health)
                        ? _(providerRecoveryActionLabel(provider().health))
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
                    fallback={
                      <p class="providers-connect-copy">
                        Update the server environment, restart Synergy, then refresh this page. Environment values are
                        never overwritten by Settings.
                      </p>
                    }
                  >
                    <ProviderConnectionFlow
                      providerID={provider().id}
                      intent={providerNeedsAction(provider().health) ? "recover" : "connect"}
                      compact
                    />
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
              <ProviderIcon id={provider.id} class="providers-row-icon" />
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
