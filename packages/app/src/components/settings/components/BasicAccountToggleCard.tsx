import { For, Show, createSignal } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import type { BasicAccountToggle } from "../types"
import {
  channelAccountActionKey,
  isChannelAccountActionPending,
  type ChannelAccountAction,
} from "../channel-account-model"

export function BasicAccountToggleCard(props: {
  accounts: BasicAccountToggle[]
  emptyLabel: string
  accountDescription: (account: BasicAccountToggle) => string
  accountName: (account: BasicAccountToggle) => string
  enableLabel: string
  enableAccountLabel: (accountName: string) => string
  maintenanceLabel: string
  maintenanceAccountLabel: (accountName: string) => string
  refreshLabel: string
  refreshingLabel: string
  diagnosticsLabel: string
  preparingDiagnosticsLabel: string
  onToggle: (index: number, value: boolean) => void
  onRefresh: (account: BasicAccountToggle) => Promise<void>
  onDiagnostics: (account: BasicAccountToggle) => Promise<void>
}) {
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())

  const runAction = async (
    action: ChannelAccountAction,
    account: BasicAccountToggle,
    execute: (account: BasicAccountToggle) => Promise<void>,
  ) => {
    const key = channelAccountActionKey(action, account.key)
    setPending((current) => new Set(current).add(key))
    try {
      await execute(account)
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }
  return (
    <div class="settings-channel-account-list">
      <Show when={props.accounts.length > 0} fallback={<div class="settings-row-description">{props.emptyLabel}</div>}>
        <For each={props.accounts}>
          {(account, index) => {
            const accountName = () => props.accountName(account)
            const refreshing = () => isChannelAccountActionPending(pending(), "refresh", account.key)
            const preparingDiagnostics = () => isChannelAccountActionPending(pending(), "diagnostics", account.key)

            return (
              <article class="settings-channel-account" data-channel-account={account.key} aria-label={accountName()}>
                <div class="settings-channel-account-header">
                  <div class="settings-channel-account-identity">
                    <span class="settings-row-title">{accountName()}</span>
                    <span class="ds-inline-badge ds-inline-badge-muted" aria-live="polite">
                      {props.accountDescription(account)}
                    </span>
                  </div>
                  <div class="settings-channel-account-toggle">
                    <span class="settings-channel-account-toggle-label" aria-hidden="true">
                      {props.enableLabel}
                    </span>
                    <Switch hideLabel checked={account.enabled} onChange={(value) => props.onToggle(index(), value)}>
                      {props.enableAccountLabel(accountName())}
                    </Switch>
                  </div>
                </div>
                <div
                  class="settings-channel-account-maintenance"
                  role="group"
                  aria-label={props.maintenanceAccountLabel(accountName())}
                >
                  <span class="settings-channel-account-maintenance-label">{props.maintenanceLabel}</span>
                  <div class="settings-channel-account-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      icon={getSemanticIcon("action.refresh")}
                      disabled={refreshing()}
                      aria-busy={refreshing()}
                      onClick={() => runAction("refresh", account, props.onRefresh)}
                    >
                      {refreshing() ? props.refreshingLabel : props.refreshLabel}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      icon={getSemanticIcon("action.download")}
                      disabled={preparingDiagnostics()}
                      aria-busy={preparingDiagnostics()}
                      onClick={() => runAction("diagnostics", account, props.onDiagnostics)}
                    >
                      {preparingDiagnostics() ? props.preparingDiagnosticsLabel : props.diagnosticsLabel}
                    </Button>
                  </div>
                </div>
              </article>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
