import { For, Show, createMemo, createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { channelAccountVariantKeys } from "../channel-account-model"
import type { AccountToggle, ProviderGroup } from "../types"
import { ModelVariantPicker } from "./ModelVariantPicker"
import { SettingRow } from "./SettingRow"

const useDefaultLabel = { id: "settings.accountToggle.useDefault", message: "Use default" }
const inheritDesc = { id: "settings.accountToggle.inherit", message: "Inherit from global model config" }
const modelOverrideTitle = { id: "settings.accountToggle.modelOverride", message: "Model override" }
const modelOverrideDesc = {
  id: "settings.accountToggle.modelOverrideDesc",
  message: "Select a model for messages from this account.",
}
const accountLabel = { id: "settings.accountToggle.account", message: "Account" }
const searchModelsPlaceholder = { id: "settings.accountToggle.searchModels", message: "Search models" }
const noModelResults = { id: "settings.accountToggle.noModelResults", message: "No model results" }
function selectModelAria(key: string) {
  return { id: "settings.accountToggle.selectModelFor", message: "Select model for {key}", values: { key } }
}

type ModelPickOption = {
  kind: "fallback" | "model"
  key: string
  group: string
  label: string
  description: string
  value: string
  variantKeys: string[]
}

export function AccountToggleCard(props: {
  title: string
  description: string
  accounts: AccountToggle[]
  emptyLabel: string
  providers: ProviderGroup[]
  popoverLayer?: HTMLElement
  onToggle: (index: number, value: boolean) => void
  onModelChange: (index: number, model: string) => void
  onVariantChange: (index: number, variant: string) => void
}) {
  const { _ } = useLingui()
  const modelOptions = createMemo<ModelPickOption[]>(() => [
    {
      kind: "fallback",
      key: "fallback",
      group: "Default",
      label: _(useDefaultLabel),
      description: _(inheritDesc),
      value: "",
      variantKeys: [],
    },
    ...props.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        kind: "model" as const,
        key: `${provider.providerId}/${model.id}`,
        group: provider.providerName,
        label: model.name,
        description: provider.providerName,
        value: `${provider.providerId}/${model.id}`,
        variantKeys: model.variantKeys,
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
              account.model ? (selectedLabel().get(account.model) ?? account.model) : _(useDefaultLabel),
            )
            const availableVariants = createMemo(() => channelAccountVariantKeys(account.model, props.providers))

            return (
              <div class="ds-setting-subsection">
                <SettingRow
                  title={account.key}
                  description={_(accountLabel)}
                  trailing={<Switch checked={account.enabled} onChange={(value) => props.onToggle(index(), value)} />}
                />
                <div class="settings-model-row">
                  <div class="settings-model-copy">
                    <div class="settings-model-title-line">
                      <span class="settings-model-title">{_(modelOverrideTitle)}</span>
                    </div>
                    <span class="settings-model-description">{_(modelOverrideDesc)}</span>
                  </div>
                  <div class="settings-model-selector">
                    <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
                      <KobaltePopover.Trigger
                        type="button"
                        class="settings-model-trigger"
                        aria-label={_(selectModelAria(account.key))}
                      >
                        <span class="settings-model-trigger-text">
                          <span class="settings-model-trigger-title">{displayText()}</span>
                        </span>
                        <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
                      </KobaltePopover.Trigger>
                      <KobaltePopover.Content class="settings-model-picker-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
                        <KobaltePopover.Title class="sr-only">{_(selectModelAria(account.key))}</KobaltePopover.Title>
                        <List<ModelPickOption>
                          class="settings-model-picker-list"
                          search={{ placeholder: _(searchModelsPlaceholder), autofocus: true }}
                          emptyMessage={_(noModelResults)}
                          key={(option) => option.key}
                          items={modelOptions}
                          current={currentOption()}
                          filterKeys={["label", "description", "value"]}
                          groupBy={(option) => option.group}
                          sortGroupsBy={sortModelGroups}
                          onSelect={(option) => {
                            if (!option) return
                            props.onModelChange(index(), option.value)
                            if (!option.variantKeys.includes(account.variant)) {
                              props.onVariantChange(index(), "")
                            }
                            setPickerOpen(false)
                          }}
                        >
                          {(option) => (
                            <div class="settings-model-option">
                              <span class="settings-model-option-title">{option.label}</span>
                              <span class="settings-model-option-detail">{option.description}</span>
                            </div>
                          )}
                        </List>
                      </KobaltePopover.Content>
                    </KobaltePopover>
                    <ModelVariantPicker
                      value={account.variant}
                      availableVariants={availableVariants()}
                      popoverLayer={props.popoverLayer}
                      onChange={(variant) => props.onVariantChange(index(), variant)}
                    />
                  </div>
                </div>
              </div>
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
