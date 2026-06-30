import type { AccountUsageSnapshot, AccountUsageWindow } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createMemo, createResource, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { compareProviderIDs, providerConnectCopy } from "@/components/provider/provider-recommendation"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

const USAGE_FIRST_PROVIDER_IDS = ["openai-codex", "anthropic", "github-copilot", "openrouter", "openai"]

export function UsagePanel(props: { onConnectProvider: (providerID?: string) => void }) {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [usage, { refetch }] = createResource(async () => {
    const res = await globalSDK.client.provider.usage.list({ scopeID: "home" }, { throwOnError: true })
    return res.data ?? {}
  })

  const providers = createMemo(() => globalSync.data.provider.all)
  const connected = createMemo(() => new Set(globalSync.data.provider.connected))
  const sortProviderIDs = (a: string, b: string) =>
    compareProviderIDs(
      globalSync.data.provider.profiles,
      { id: a, name: providerName(a) },
      { id: b, name: providerName(b) },
    )
  const usageCapableIDs = createMemo(() => {
    const ids = new Set([...USAGE_FIRST_PROVIDER_IDS, ...Object.keys(usage() ?? {})])
    return [...ids].filter((id) => providers().some((provider) => provider.id === id)).sort(sortProviderIDs)
  })
  const unconnected = createMemo(() => usageCapableIDs().filter((id) => !connected().has(id)))
  const connectedUsage = createMemo(() =>
    usageCapableIDs()
      .filter((id) => connected().has(id))
      .map((id) => ({ providerID: id, snapshot: usage()?.[id] }))
      .sort((a, b) => sortProviderIDs(a.providerID, b.providerID)),
  )
  const lastFetched = createMemo(() => {
    const times = connectedUsage()
      .map((item) => item.snapshot?.fetchedAt)
      .filter((value): value is string => !!value)
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value))
    if (times.length === 0) return undefined
    return formatDate(new Date(Math.max(...times)).toISOString())
  })

  function providerName(providerID: string) {
    return providers().find((provider) => provider.id === providerID)?.name ?? providerID
  }

  return (
    <SettingsPage title="Usage" description="Review quota windows, credits, and provider account health.">
      <div class="usage-page-shell">
        <div class="usage-overview">
          <div class="usage-overview-metrics">
            <div class="usage-overview-metric">
              <span class="usage-overview-value">{connectedUsage().length}</span>
              <span class="usage-overview-label">Connected accounts</span>
            </div>
            <div class="usage-overview-metric">
              <span class="usage-overview-value">{unconnected().length}</span>
              <span class="usage-overview-label">Available to connect</span>
            </div>
            <Show when={lastFetched()}>
              {(value) => (
                <div class="usage-overview-metric">
                  <span class="usage-overview-value usage-overview-date">{value()}</span>
                  <span class="usage-overview-label">Last refreshed</span>
                </div>
              )}
            </Show>
          </div>
          <div class="usage-overview-actions">
            <Button
              type="button"
              variant="secondary"
              size="small"
              icon={getSemanticIcon("action.refresh")}
              disabled={usage.loading}
              onClick={() => void refetch()}
            >
              Refresh
            </Button>
          </div>
        </div>

        <SettingsSection
          title="Connectable providers"
          description="Providers not connected yet stay here until credentials are added."
        >
          <SettingsEntityList
            isEmpty={unconnected().length === 0}
            emptyTitle="Every tracked provider is connected"
            emptyDescription="Usage-capable providers will appear below as account panels."
          >
            <div class="usage-connect-grid">
              <For each={unconnected()}>
                {(providerID) => (
                  <button type="button" class="usage-connect-card" onClick={() => props.onConnectProvider(providerID)}>
                    <ProviderIcon id={providerID} class="usage-provider-icon" />
                    <div class="min-w-0 flex-1">
                      <div class="usage-provider-name">{providerName(providerID)}</div>
                      <div class="usage-provider-copy">
                        {providerConnectCopy(providerID, globalSync.data.provider.profiles, providerName(providerID))}
                      </div>
                    </div>
                    <Icon name={getSemanticIcon("action.add")} size="small" />
                  </button>
                )}
              </For>
            </div>
          </SettingsEntityList>
        </SettingsSection>

        <SettingsSection
          title="Connected usage"
          description="Quota data is provider-specific; unavailable means Synergy has no reliable endpoint for that account."
        >
          <Show
            when={!usage.loading}
            fallback={
              <div class="usage-loading">
                <Spinner />
                <span>Loading usage...</span>
              </div>
            }
          >
            <SettingsEntityList
              isEmpty={connectedUsage().length === 0}
              emptyTitle="No connected usage providers"
              emptyDescription="Connect Codex, Anthropic, Copilot, or OpenRouter to see account usage here."
            >
              <div class="usage-panel-list">
                <For each={connectedUsage()}>
                  {(item) => (
                    <UsageProviderPanel
                      providerID={item.providerID}
                      providerName={providerName(item.providerID)}
                      snapshot={item.snapshot}
                      reloginRequired={globalSync.data.provider.authHealth?.[item.providerID]?.reloginRequired}
                      cooldownUntil={globalSync.data.provider.authHealth?.[item.providerID]?.cooldownUntil}
                      resetAt={globalSync.data.provider.authHealth?.[item.providerID]?.resetAt}
                      status={globalSync.data.provider.authHealth?.[item.providerID]?.status}
                      onConnect={() => props.onConnectProvider(item.providerID)}
                    />
                  )}
                </For>
              </div>
            </SettingsEntityList>
          </Show>
        </SettingsSection>
      </div>
    </SettingsPage>
  )
}

function UsageProviderPanel(props: {
  providerID: string
  providerName: string
  snapshot?: AccountUsageSnapshot
  reloginRequired?: boolean
  cooldownUntil?: number
  resetAt?: number
  status?: string
  onConnect: () => void
}) {
  return (
    <div class="usage-provider-panel">
      <div class="usage-provider-panel-head">
        <div class="flex items-center gap-3 min-w-0">
          <ProviderIcon id={props.providerID} class="usage-provider-icon" />
          <div class="min-w-0">
            <div class="usage-provider-name">{props.providerName}</div>
            <div class="usage-provider-copy">{props.providerID}</div>
          </div>
        </div>
        <span class="ds-inline-badge" classList={{ "ds-inline-badge-muted": props.snapshot?.status !== "available" }}>
          {props.snapshot?.status ?? props.status ?? "connected"}
        </span>
      </div>

      <Show when={props.reloginRequired}>
        <div class="usage-warning-row">
          <Icon name={getSemanticIcon("state.warning")} size="small" />
          <span>Relogin required.</span>
          <Button type="button" variant="secondary" size="small" onClick={props.onConnect}>
            Reconnect
          </Button>
        </div>
      </Show>

      <Show when={props.cooldownUntil}>
        {(value) => <div class="usage-muted-row">Cooldown until {formatUnix(value())}</div>}
      </Show>
      <Show when={props.resetAt}>
        {(value) => <div class="usage-muted-row">Provider renews {formatUnix(value())}</div>}
      </Show>

      <Show when={props.snapshot} fallback={<div class="usage-muted-row">Usage unavailable for this provider.</div>}>
        {(snapshot) => (
          <>
            <Show when={snapshot().plan}>
              <div class="usage-muted-row">Plan: {snapshot().plan}</div>
            </Show>
            <Show when={snapshot().unavailableReason}>
              <div class="usage-muted-row">{snapshot().unavailableReason}</div>
            </Show>
            <For each={snapshot().windows}>
              {(window) => (
                <div class="usage-window-row">
                  <div class="usage-window-copy">
                    <div class="usage-window-label">{formatUsageWindowLabel(window.label)}</div>
                    <Show when={formatUsageWindowDetail(window)}>
                      {(value) => <div class="usage-provider-copy">{value()}</div>}
                    </Show>
                  </div>
                  <div class="usage-window-meter" aria-hidden="true">
                    <span style={{ width: `${usageWindowMeterPercent(window)}%` }} />
                  </div>
                  <div class="usage-window-value">{formatUsageWindowValue(window)}</div>
                </div>
              )}
            </For>
            <Show when={snapshot().credits}>
              {(credits) => (
                <div class="usage-window-row">
                  <div class="usage-window-label">Credits</div>
                  <div class="usage-window-meter usage-window-meter-empty" aria-hidden="true" />
                  <div class="usage-window-value">
                    {credits().unlimited
                      ? "unlimited"
                      : credits().balance !== undefined
                        ? `${credits().balance}${credits().currency ? ` ${credits().currency}` : ""}`
                        : credits().hasCredits === false
                          ? "none"
                          : "available"}
                  </div>
                </div>
              )}
            </Show>
            <For each={snapshot().details}>{(detail) => <div class="usage-muted-row">{detail}</div>}</For>
          </>
        )}
      </Show>
    </div>
  )
}

function formatPercent(value: number | undefined) {
  if (value === undefined) return "n/a"
  return `${Math.round(value)}%`
}

function formatUsageWindowLabel(label: string) {
  const normalized = label.trim().toLowerCase()
  if (normalized === "session") return "5-hour window"
  if (normalized === "weekly") return "Weekly window"
  if (normalized === "monthly") return "Monthly window"
  return label
}

function formatUsageWindowValue(window: AccountUsageWindow) {
  if (window.remainingPercent !== undefined) return `${formatPercent(window.remainingPercent)} remaining`
  if (window.usedPercent !== undefined) return `${formatPercent(window.usedPercent)} used`
  return "n/a"
}

function formatUsageWindowDetail(window: AccountUsageWindow) {
  const detail = window.detail?.trim()
  const renews = window.resetAt ? `Renews ${formatDate(window.resetAt)}` : undefined
  if (detail && renews) return `${detail} · ${renews}`
  return detail || renews
}

function usageWindowMeterPercent(window: AccountUsageWindow) {
  const value =
    window.remainingPercent !== undefined
      ? window.remainingPercent
      : window.usedPercent !== undefined
        ? 100 - window.usedPercent
        : 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function formatUnix(value: number) {
  return new Date(value * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
