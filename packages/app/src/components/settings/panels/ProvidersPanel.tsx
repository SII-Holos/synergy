import type { ProviderAuthResponse } from "@ericsanchezok/synergy-sdk/client"
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

export type ProviderConnectionSummary = {
  id: string
  name: string
  connected: boolean
  available: boolean
  modelCount: number
  authStatus?: string
  availabilityReason?: string
  reloginRequired?: boolean
  cooldownUntil?: number
  resetAt?: number
  failureCode?: string
  profile?: ProviderRecommendationMetadata
}

export function ProvidersPanel(props: {
  summaries: ProviderConnectionSummary[]
  authMethods: ProviderAuthResponse
  providerFocusID?: string
}) {
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
  const recommended = createMemo(() =>
    filtered()
      .filter((provider) => SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id))
      .sort((a, b) => settingsRecommendedRank(a.id) - settingsRecommendedRank(b.id)),
  )
  const connected = createMemo(() =>
    filtered().filter((provider) => provider.connected && !SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id)),
  )
  const other = createMemo(() =>
    filtered().filter((provider) => !SETTINGS_RECOMMENDED_PROVIDER_RANK.has(provider.id) && !provider.connected),
  )
  const selected = createMemo(() => {
    const current = selectedID()
    return (
      summaries().find((provider) => provider.id === current) ??
      recommended()[0] ??
      connected()[0] ??
      other()[0] ??
      summaries()[0]
    )
  })

  function statusLabel(provider: ProviderConnectionSummary) {
    if (provider.authStatus === "dead") return "Relogin"
    if (provider.authStatus === "exhausted") return "Exhausted"
    if (provider.authStatus === "expired") return "Expired"
    if (provider.connected) return provider.available ? "Connected" : "Unavailable"
    return "Not connected"
  }

  return (
    <SettingsPage title="Providers" description="Connect model providers and manage runtime availability.">
      <div class="providers-workspace">
        <div class="providers-directory">
          <div class="providers-search">
            <Icon name={getSemanticIcon("action.search")} size="small" />
            <input
              value={query()}
              placeholder="Search providers..."
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>

          <div class="providers-directory-scroll">
            <Show
              when={filtered().length > 0}
              fallback={<div class="providers-list-empty">No providers match this search.</div>}
            >
              <ProviderGroup
                title="Recommended"
                providers={recommended()}
                selectedID={selected()?.id}
                onSelect={setSelectedID}
                statusLabel={statusLabel}
              />
              <ProviderGroup
                title="Connected"
                providers={connected()}
                selectedID={selected()?.id}
                onSelect={setSelectedID}
                statusLabel={statusLabel}
              />
              <ProviderGroup
                title="Other"
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
                <Icon name={getSemanticIcon("settings.providers")} size="large" />
                <span>Select a provider to connect it.</span>
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
                    classList={{ "ds-inline-badge-muted": !provider().connected || !provider().available }}
                  >
                    {statusLabel(provider())}
                  </span>
                </div>

                <div class="providers-detail-meta">
                  <span>{provider().id}</span>
                  <span>{provider().modelCount} models</span>
                  <Show when={props.authMethods[provider().id]?.length}>
                    <span>{props.authMethods[provider().id].map((method) => method.label).join(", ")}</span>
                  </Show>
                  <Show when={provider().failureCode}>
                    <span>{provider().failureCode}</span>
                  </Show>
                  <Show when={provider().availabilityReason && provider().availabilityReason !== "connected"}>
                    <span>{provider().availabilityReason?.replace(/_/g, " ")}</span>
                  </Show>
                </div>

                <div class="providers-connect-section">
                  <div>
                    <div class="providers-connect-title">{provider().connected ? "Account" : "Connect"}</div>
                    <p class="providers-connect-copy">
                      {provider().connected
                        ? "Credentials are connected. Use Usage for quota and billing details."
                        : "Choose a sign-in method. Synergy will make available models selectable after connection."}
                    </p>
                  </div>
                  <ProviderConnectionFlow providerID={provider().id} compact />
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
                classList={{ "ds-inline-badge-muted": !provider.connected || !provider.available }}
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
