import { For, Show, createSignal } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import type { BasicAccountToggle } from "../types"
import { SettingRow } from "./SettingRow"
import {
  channelAccountActionKey,
  isChannelAccountActionPending,
  type ChannelAccountAction,
} from "../channel-account-model"

export function BasicAccountToggleCard(props: {
  title: string
  description: string
  accounts: BasicAccountToggle[]
  emptyLabel: string
  accountDescription: (account: BasicAccountToggle) => string
  accountName: (account: BasicAccountToggle) => string
  refreshLabel: string
  diagnosticsLabel: string
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
    <div class="ds-setting-subsection">
      <h3 class="ds-subsection-title">{props.title}</h3>
      <p class="ds-section-hint mb-2">{props.description}</p>
      <Show when={props.accounts.length > 0} fallback={<div class="settings-row-description">{props.emptyLabel}</div>}>
        <For each={props.accounts}>
          {(account, index) => (
            <SettingRow
              title={props.accountName(account)}
              description={props.accountDescription(account)}
              trailing={
                <div class="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={isChannelAccountActionPending(pending(), "refresh", account.key)}
                    onClick={() => runAction("refresh", account, props.onRefresh)}
                  >
                    {props.refreshLabel}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={isChannelAccountActionPending(pending(), "diagnostics", account.key)}
                    onClick={() => runAction("diagnostics", account, props.onDiagnostics)}
                  >
                    {props.diagnosticsLabel}
                  </Button>
                  <Switch checked={account.enabled} onChange={(value) => props.onToggle(index(), value)} />
                </div>
              }
            />
          )}
        </For>
      </Show>
    </div>
  )
}
