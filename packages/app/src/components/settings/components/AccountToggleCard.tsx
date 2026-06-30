import { For, Show } from "solid-js"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import type { AccountToggle } from "../types"
import { SettingRow } from "./SettingRow"

export function AccountToggleCard(props: {
  title: string
  description: string
  accounts: AccountToggle[]
  emptyLabel: string
  onToggle: (index: number, value: boolean) => void
}) {
  return (
    <div class="ds-setting-subsection">
      <h3 class="ds-subsection-title">{props.title}</h3>
      <p class="ds-section-hint mb-2">{props.description}</p>
      <Show when={props.accounts.length > 0} fallback={<div class="settings-row-description">{props.emptyLabel}</div>}>
        <For each={props.accounts}>
          {(account, index) => (
            <SettingRow
              title={account.key}
              description={`Account ${account.key}`}
              trailing={<Switch checked={account.enabled} onChange={(value) => props.onToggle(index(), value)} />}
            />
          )}
        </For>
      </Show>
    </div>
  )
}
