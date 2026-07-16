import { useLingui } from "@lingui/solid"
import type { AccountUsageSnapshot, ProviderAuthHealth } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createMemo, createResource, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLocale, type IntlFormatter } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { compareProviderIDs, providerConnectCopy } from "@/components/provider/provider-recommendation"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  formatUsageResetSentence,
  formatUsageWindowDetail,
  formatUsageWindowLabel,
  formatUsageWindowValue,
  nextUsageReset,
  usageWindowMeterPercent,
} from "./UsagePanel.model"
import {
  providerNeedsAction,
  providerRecoveryActionLabel,
  providerRecoveryCopy,
  providerUsageStatusLabel,
} from "@/components/provider/provider-auth-presentation"

const USAGE_FIRST_PROVIDER_IDS = ["openai-codex", "anthropic", "github-copilot", "openrouter", "openai"]

const pageTitle = { id: "settings.usage.page.title", message: "Usage" }
const pageDescription = {
  id: "settings.usage.page.description",
  message: "Review quota windows, credits, and provider account health.",
}
const connectedLabel = { id: "settings.usage.connected", message: "Connected accounts" }
const availableLabel = { id: "settings.usage.available", message: "Available to connect" }
const needsLabel = { id: "settings.usage.needs", message: "Needs attention" }
const nextResetLabel = { id: "settings.usage.nextReset", message: "Next reset" }
const lastRefreshedLabel = { id: "settings.usage.lastRefreshed", message: "Last refreshed" }
const refreshLabel = { id: "settings.usage.refresh", message: "Refresh" }
const errorTitle = { id: "settings.usage.error.title", message: "Usage data could not be loaded." }
const retryLabel = { id: "settings.usage.retry", message: "Retry" }
const attentionTitle = { id: "settings.usage.attention.title", message: "Needs attention" }
const attentionDescription = {
  id: "settings.usage.attention.description",
  message: "These accounts were rejected and remain here until their credentials are recovered.",
}
const attentionEmptyTitle = { id: "settings.usage.attention.empty", message: "No provider accounts need attention" }
const attentionEmptyDescription = {
  id: "settings.usage.attention.emptyDesc",
  message: "Credential recovery actions will appear here when a provider rejects a request.",
}
const connectableTitle = { id: "settings.usage.connectable.title", message: "Connectable providers" }
const connectableDescription = {
  id: "settings.usage.connectable.description",
  message: "Providers not connected yet stay here until credentials are added.",
}
const connectableEmptyTitle = { id: "settings.usage.connectable.empty", message: "Every tracked provider is connected" }
const connectableEmptyDescription = {
  id: "settings.usage.connectable.emptyDesc",
  message: "Usage-capable providers will appear below as account panels.",
}
const connectedUsageTitle = { id: "settings.usage.connectedUsage.title", message: "Connected usage" }
const connectedUsageDescription = {
  id: "settings.usage.connectedUsage.description",
  message: "Quota data is provider-specific; unavailable means Synergy has no reliable endpoint for that account.",
}
const loadingLabel = { id: "settings.usage.loading", message: "Loading usage..." }
const connectedEmptyTitle = { id: "settings.usage.connectedUsage.empty", message: "No connected usage providers" }
const connectedEmptyDescription = {
  id: "settings.usage.connectedUsage.emptyDesc",
  message: "Connect Codex, Anthropic, Copilot, or OpenRouter to see account usage here.",
}
const unavailableLabel = { id: "settings.usage.unavailable", message: "Usage unavailable for this provider." }
const creditsLabel = { id: "settings.usage.credits", message: "Credits" }

function cooldownText(date: string) {
  return { id: "settings.usage.cooldown", message: "Cooldown until {date}", values: { date } }
}
function providerRenewsText(date: string) {
  return { id: "settings.usage.providerRenews", message: "Provider renews {date}", values: { date } }
}
function planText(plan: string) {
  return { id: "settings.usage.plan", message: "Plan: {plan}", values: { plan } }
}

export function UsagePanel(props: { onConnectProvider: (providerID?: string) => void }) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
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
    const attentionIDs = Object.values(globalSync.data.provider.authHealth ?? {})
      .filter((health) => health.status === "action_required")
      .map((health) => health.providerID)
    const ids = new Set([...USAGE_FIRST_PROVIDER_IDS, ...Object.keys(usage() ?? {}), ...attentionIDs])
    return [...ids].filter((id) => providers().some((provider) => provider.id === id)).sort(sortProviderIDs)
  })
  const needsAttention = createMemo(() =>
    usageCapableIDs()
      .filter((id) => providerNeedsAction(globalSync.data.provider.authHealth?.[id], usage()?.[id]))
      .map((id) => ({ providerID: id, snapshot: usage()?.[id] })),
  )
  const attentionIDs = createMemo(() => new Set(needsAttention().map((item) => item.providerID)))
  const unconnected = createMemo(() =>
    usageCapableIDs().filter((id) => !connected().has(id) && !attentionIDs().has(id)),
  )
  const connectedUsage = createMemo(() =>
    usageCapableIDs()
      .filter((id) => connected().has(id) && !attentionIDs().has(id))
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
    return formatDate(new Date(Math.max(...times)).toISOString(), fmt)
  })
  const nextReset = createMemo(() =>
    nextUsageReset(
      connectedUsage().map((item) => item.snapshot),
      fmt,
    ),
  )

  function providerName(providerID: string) {
    return providers().find((provider) => provider.id === providerID)?.name ?? providerID
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <div class="usage-page-shell">
        <div class="usage-overview">
          <div class="usage-overview-metrics">
            <div class="usage-overview-metric">
              <span class="usage-overview-value">{connectedUsage().length}</span>
              <span class="usage-overview-label">{_(connectedLabel)}</span>
            </div>
            <div class="usage-overview-metric">
              <span class="usage-overview-value">{unconnected().length}</span>
              <span class="usage-overview-label">{_(availableLabel)}</span>
            </div>
            <Show when={needsAttention().length > 0}>
              <div class="usage-overview-metric">
                <span class="usage-overview-value">{needsAttention().length}</span>
                <span class="usage-overview-label">{_(needsLabel)}</span>
              </div>
            </Show>
            <Show when={nextReset()}>
              {(reset) => (
                <div class="usage-overview-metric" title={reset().title}>
                  <span class="usage-overview-value usage-overview-date">{reset().value}</span>
                  <span class="usage-overview-label">{_(nextResetLabel)}</span>
                </div>
              )}
            </Show>
            <Show when={lastFetched()}>
              {(value) => (
                <div class="usage-overview-metric">
                  <span class="usage-overview-value usage-overview-date">{value()}</span>
                  <span class="usage-overview-label">{_(lastRefreshedLabel)}</span>
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
              {_(refreshLabel)}
            </Button>
          </div>
        </div>

        <Show when={usage.error}>
          <div class="usage-request-error" role="alert">
            <Icon name={getSemanticIcon("state.error")} size="small" />
            <span>{_(errorTitle)}</span>
            <Button type="button" variant="secondary" size="small" onClick={() => void refetch()}>
              {_(retryLabel)}
            </Button>
          </div>
        </Show>

        <SettingsSection title={_(attentionTitle)} description={_(attentionDescription)}>
          <SettingsEntityList
            isEmpty={needsAttention().length === 0}
            emptyTitle={_(attentionEmptyTitle)}
            emptyDescription={_(attentionEmptyDescription)}
          >
            <div class="usage-panel-list">
              <For each={needsAttention()}>
                {(item) => (
                  <UsageProviderPanel
                    providerID={item.providerID}
                    providerName={providerName(item.providerID)}
                    snapshot={item.snapshot}
                    health={globalSync.data.provider.authHealth?.[item.providerID]}
                    environment={globalSync.data.provider.profiles?.[item.providerID]?.environment}
                    onConnect={() => props.onConnectProvider(item.providerID)}
                  />
                )}
              </For>
            </div>
          </SettingsEntityList>
        </SettingsSection>

        <SettingsSection title={_(connectableTitle)} description={_(connectableDescription)}>
          <SettingsEntityList
            isEmpty={unconnected().length === 0}
            emptyTitle={_(connectableEmptyTitle)}
            emptyDescription={_(connectableEmptyDescription)}
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

        <SettingsSection title={_(connectedUsageTitle)} description={_(connectedUsageDescription)}>
          <Show
            when={!usage.loading}
            fallback={
              <div class="usage-loading">
                <Spinner />
                <span>{_(loadingLabel)}</span>
              </div>
            }
          >
            <SettingsEntityList
              isEmpty={connectedUsage().length === 0}
              emptyTitle={_(connectedEmptyTitle)}
              emptyDescription={_(connectedEmptyDescription)}
            >
              <div class="usage-panel-list">
                <For each={connectedUsage()}>
                  {(item) => (
                    <UsageProviderPanel
                      providerID={item.providerID}
                      providerName={providerName(item.providerID)}
                      snapshot={item.snapshot}
                      health={globalSync.data.provider.authHealth?.[item.providerID]}
                      environment={globalSync.data.provider.profiles?.[item.providerID]?.environment}
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
  health?: ProviderAuthHealth
  environment?: string[]
  onConnect: () => void
}) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const needsAction = createMemo(() => providerNeedsAction(props.health, props.snapshot))
  const badge = createMemo(() => translateDescriptor(providerUsageStatusLabel(props.health, props.snapshot), _))
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
          {badge()}
        </span>
      </div>

      <Show when={needsAction()}>
        <div class="usage-warning-row">
          <Icon name={getSemanticIcon("providers.reconnect")} size="small" />
          <span>
            {translateDescriptor(providerRecoveryCopy(props.providerName, props.health, props.environment), _)}
          </span>
          <Button type="button" variant="secondary" size="small" onClick={props.onConnect}>
            {translateDescriptor(providerRecoveryActionLabel(props.health), _)}
          </Button>
        </div>
      </Show>
      <Show when={props.health?.cooldownUntil}>
        {(value) => <div class="usage-muted-row">{_(cooldownText(formatUnix(value(), fmt)))}</div>}
      </Show>
      <Show when={props.health?.resetAt}>
        {(value) => <div class="usage-muted-row">{_(providerRenewsText(formatUnix(value(), fmt)))}</div>}
      </Show>

      <Show when={props.snapshot} fallback={<div class="usage-muted-row">{_(unavailableLabel)}</div>}>
        {(snapshot) => (
          <>
            <Show when={snapshot().plan}>
              <div class="usage-muted-row">{_(planText(snapshot().plan!))}</div>
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
                  <div class="usage-window-reading">
                    <div class="usage-window-value">{formatUsageWindowValue(window)}</div>
                    <Show when={formatUsageResetSentence(window.resetAt, fmt)}>
                      {(reset) => (
                        <div class="usage-window-reset" title={reset().title}>
                          {reset().value}
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <Show when={snapshot().credits}>
              {(credits) => (
                <div class="usage-window-row">
                  <div class="usage-window-label">{_(creditsLabel)}</div>
                  <div class="usage-window-meter usage-window-meter-empty" aria-hidden="true" />
                  <div class="usage-window-reading">
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

function formatDate(value: string, fmt: IntlFormatter) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return fmt.dateTime(date)
}

function formatUnix(value: number, fmt: IntlFormatter) {
  return fmt.dateTime(new Date(value * 1000))
}
