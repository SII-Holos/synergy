import type { ProviderAuthResponse } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import {
  ProviderConnectionFlow,
  providerConnectCopy,
  sortProviderIDs,
} from "@/components/provider/ProviderConnectionFlow"
import { popularProviders } from "@/hooks/use-providers"
import { SettingsFieldGrid, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { ProvidersStore } from "../types"

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
}

export function ProvidersPanel(props: {
  providers: ProvidersStore
  summaries: ProviderConnectionSummary[]
  authMethods: ProviderAuthResponse
  providerFocusID?: string
  onProviderChange: (key: keyof ProvidersStore, value: string) => void
}) {
  const [query, setQuery] = createSignal("")
  const [selectedID, setSelectedID] = createSignal<string | undefined>(props.providerFocusID)

  createEffect(() => {
    if (props.providerFocusID) setSelectedID(props.providerFocusID)
  })

  const summaries = createMemo(() => props.summaries.slice().sort((a, b) => sortProviderIDs(a.id, b.id)))
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return summaries()
    return summaries().filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(q))
  })
  const selected = createMemo(() => {
    const current = selectedID()
    return summaries().find((provider) => provider.id === current) ?? filtered()[0] ?? summaries()[0]
  })
  const recommended = createMemo(() =>
    filtered().filter((provider) => popularProviders.includes(provider.id) && !provider.connected),
  )
  const connected = createMemo(() => filtered().filter((provider) => provider.connected))
  const other = createMemo(() =>
    filtered().filter((provider) => !popularProviders.includes(provider.id) && !provider.connected),
  )

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
              <>
                <div class="providers-detail-summary">
                  <div class="flex items-center gap-3 min-w-0">
                    <ProviderIcon id={provider().id} class="providers-detail-icon" />
                    <div class="min-w-0">
                      <div class="providers-detail-title">{provider().name}</div>
                      <div class="providers-detail-copy">{providerConnectCopy(provider().id)}</div>
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
                <ProviderConnectionFlow providerID={provider().id} compact />
              </>
            )}
          </Show>
        </div>
      </div>

      <SettingsSection
        title="Advanced availability"
        description="Use these only when you need to force provider allow or deny lists."
      >
        <SettingsFieldGrid>
          <TextField
            label="Enabled Providers"
            multiline
            value={props.providers.enabledProviders}
            placeholder={"anthropic\nopenai"}
            description="When set, only these provider IDs are enabled."
            onChange={(value) => props.onProviderChange("enabledProviders", value)}
          />
          <TextField
            label="Disabled Providers"
            multiline
            value={props.providers.disabledProviders}
            placeholder={"example-provider"}
            description="Provider IDs to disable even if they are loaded automatically."
            onChange={(value) => props.onProviderChange("disabledProviders", value)}
          />
        </SettingsFieldGrid>
      </SettingsSection>
    </SettingsPage>
  )
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
                <div class="providers-row-copy">{providerConnectCopy(provider.id)}</div>
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
