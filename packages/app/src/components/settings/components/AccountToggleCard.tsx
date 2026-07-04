import { For, Show, createMemo, createSignal } from "solid-js"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import type { AccountToggle, ProviderGroup } from "../types"
import { SettingRow } from "./SettingRow"

type ModelPickOption = {
  kind: "fallback" | "model"
  key: string
  group: string
  label: string
  value: string
}

export function AccountToggleCard(props: {
  title: string
  description: string
  accounts: AccountToggle[]
  emptyLabel: string
  providers: ProviderGroup[]
  onToggle: (index: number, value: boolean) => void
  onModelChange: (index: number, model: string) => void
}) {
  const modelOptions = createMemo<ModelPickOption[]>(() => [
    { kind: "fallback", key: "fallback", group: "Default", label: "Use default", value: "" },
    ...props.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        kind: "model" as const,
        key: `${provider.providerId}/${model.id}`,
        group: provider.providerName,
        label: model.name,
        value: `${provider.providerId}/${model.id}`,
      })),
    ),
  ])

  const selectedLabel = createMemo(() => {
    const labels = new Map<string, string>()
    for (const option of modelOptions()) {
      if (option.kind === "model") labels.set(option.value, `${option.group} / ${option.label}`)
    }
    return labels
  })

  return (
    <div class="ds-setting-subsection">
      <h3 class="ds-subsection-title">{props.title}</h3>
      <p class="ds-section-hint mb-2">{props.description}</p>
      <Show when={props.accounts.length > 0} fallback={<div class="settings-row-description">{props.emptyLabel}</div>}>
        <For each={props.accounts}>
          {(account, index) => {
            const [pickerOpen, setPickerOpen] = createSignal(false)
            const currentOption = createMemo(
              () => modelOptions().find((o) => o.value === account.model) ?? modelOptions()[0],
            )
            const displayText = createMemo(() =>
              account.model ? (selectedLabel().get(account.model) ?? account.model) : "Use default",
            )

            return (
              <SettingRow
                title={account.key}
                description={`Account ${account.key}`}
                trailing={
                  <div class="flex items-center gap-2">
                    <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
                      <KobaltePopover.Trigger
                        type="button"
                        class="settings-model-trigger"
                        aria-label={`Select model for ${account.key}`}
                      >
                        <span class="settings-model-trigger-text">
                          <span class="settings-model-trigger-title">{displayText()}</span>
                        </span>
                        <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
                      </KobaltePopover.Trigger>
                      <KobaltePopover.Content class="settings-model-picker-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
                        <KobaltePopover.Title class="sr-only">Select model for {account.key}</KobaltePopover.Title>
                        <List<ModelPickOption>
                          class="settings-model-picker-list"
                          search={{ placeholder: "Search models", autofocus: true }}
                          emptyMessage="No model results"
                          key={(option) => option.key}
                          items={modelOptions}
                          current={currentOption()}
                          filterKeys={["label", "value"]}
                          groupBy={(option) => option.group}
                          sortGroupsBy={sortModelGroups}
                          onSelect={(option) => {
                            if (!option) return
                            props.onModelChange(index(), option.value)
                            setPickerOpen(false)
                          }}
                        >
                          {(option) => (
                            <div class="settings-model-option">
                              <span class="settings-model-option-title">{option.label}</span>
                              <Show when={option.kind === "model"}>
                                <span class="settings-model-option-detail">{option.group}</span>
                              </Show>
                            </div>
                          )}
                        </List>
                      </KobaltePopover.Content>
                    </KobaltePopover>
                    <Switch checked={account.enabled} onChange={(value) => props.onToggle(index(), value)} />
                  </div>
                }
              />
            )
          }}
        </For>
      </Show>
    </div>
  )
}

function sortModelGroups(
  a: { category: string; items: ModelPickOption[] },
  b: { category: string; items: ModelPickOption[] },
) {
  if (a.category === "Default") return -1
  if (b.category === "Default") return 1
  return a.category.localeCompare(b.category)
}
