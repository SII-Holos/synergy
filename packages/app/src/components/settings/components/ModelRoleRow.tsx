import { useLingui } from "@lingui/solid"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { ModelKey, ModelsStore, ProviderGroup } from "../types"
import { createProviderModelIndex, fieldLabel, resolveModelRoleDraftDisplay } from "../model-role-draft"

const fallbackLabel = { id: "settings.modelRole.fallback", message: "Use fallback" }
const variantDefault = { id: "settings.modelRole.variant.default", message: "Default" }
const variantDesc = { id: "settings.modelRole.variant.desc", message: "Use the role default" }
const variantRoleDesc = { id: "settings.modelRole.variant.role", message: "Role variant" }
const noAgentsUse = { id: "settings.modelRole.noAgentsUse", message: "No agents directly use this role." }

type ModelRef = {
  providerID: string
  modelID: string
}

type ModelPickerOption =
  | {
      kind: "fallback"
      key: "fallback"
      group: "Default"
      label: string
      description: string
      value: ""
    }
  | {
      kind: "model"
      key: string
      group: string
      label: string
      description: string
      value: string
      ref: ModelRef
    }

type ModelVariantOption = {
  key: string
  label: string
  description: string
  value: string
}

export function ModelRoleRow(props: {
  summary: ModelRoleSummary
  value: string
  draftModels: ModelsStore
  savedModels: ModelsStore
  providers: ProviderGroup[]
  roleVariant?: string
  availableVariants: string[]
  popoverLayer?: HTMLElement
  onChange: (key: ModelKey, value: string) => void
  onVariantChange?: (variant: string) => void
}) {
  const { _ } = useLingui()
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [variantPickerOpen, setVariantPickerOpen] = createSignal(false)

  const providerIndex = createMemo(() => createProviderModelIndex(props.providers))

  const display = createMemo(() =>
    resolveModelRoleDraftDisplay({
      summary: props.summary,
      value: props.value,
      draftModels: props.draftModels,
      savedModels: props.savedModels,
      providerIndex: providerIndex(),
    }),
  )

  const options = createMemo<ModelPickerOption[]>(() => [
    {
      kind: "fallback",
      key: "fallback",
      group: "Default",
      label: _(fallbackLabel),
      description: display().fallbackDescription,
      value: "",
    },
    ...props.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        kind: "model" as const,
        key: `${provider.providerId}/${model.id}`,
        group: provider.providerName,
        label: model.name,
        description: provider.providerName,
        value: `${provider.providerId}/${model.id}`,
        ref: { providerID: provider.providerId, modelID: model.id },
      })),
    ),
  ])

  const currentOption = createMemo(() => {
    if (!props.value) return options()[0]
    return options().find((option) => option.value === props.value)
  })

  const variantOptions = createMemo<ModelVariantOption[]>(() => [
    { key: "default", label: _(variantDefault), description: _(variantDesc), value: "" },
    ...props.availableVariants.map((variant) => ({
      key: variant,
      label: variant,
      description: _(variantRoleDesc),
      value: variant,
    })),
  ])

  const currentVariantOption = createMemo(() =>
    variantOptions().find((option) => option.value === (props.roleVariant ?? "")),
  )

  function selectModelVariantOption(option: ModelVariantOption | undefined) {
    if (!option) return
    props.onVariantChange?.(option.value)
    setVariantPickerOpen(false)
  }

  function selectModelRoleOption(option: ModelPickerOption | undefined) {
    if (!option) return
    props.onChange(props.summary.field as ModelKey, option.value)
    setPickerOpen(false)
  }

  return (
    <div class="settings-model-row">
      <div class="settings-model-copy">
        <div class="settings-model-title-line">
          <span class="settings-model-title">{props.summary.label}</span>
          <Tooltip
            placement="right"
            value={
              <div class="settings-model-detail-popover">
                <div>
                  <div class="settings-model-detail-title">{props.summary.label}</div>
                  <div class="settings-model-detail-muted">{props.summary.summary}</div>
                </div>
                <div class="settings-model-detail-block">
                  <div class="settings-model-detail-label">Used by</div>
                  <Show
                    when={props.summary.usedBy.length > 0}
                    fallback={<div class="settings-model-detail-muted">{_(noAgentsUse)}</div>}
                  >
                    <div class="settings-model-agent-list">
                      <For each={props.summary.usedBy.slice(0, 8)}>
                        {(agent) => (
                          <span class="settings-model-chip">
                            {agent.name}
                            <Show when={agent.hidden}>
                              <span class="settings-model-chip-muted">system</span>
                            </Show>
                            <Show when={agent.modelSource === "explicit"}>
                              <span class="settings-model-chip-muted">override</span>
                            </Show>
                          </span>
                        )}
                      </For>
                      <Show when={props.summary.usedBy.length > 8}>
                        <span class="settings-model-chip">+{props.summary.usedBy.length - 8}</span>
                      </Show>
                    </div>
                  </Show>
                </div>
                <div class="settings-model-detail-block">
                  <div class="settings-model-detail-label">Fallback</div>
                  <div class="settings-model-fallback-chain">
                    <For each={props.summary.fallbackChain}>{(field) => <span>{fieldLabel(field)}</span>}</For>
                  </div>
                </div>
                <div class="settings-model-detail-block">
                  <div class="settings-model-detail-label">Resolution</div>
                  <div class="settings-model-detail-muted">{display().resolutionDescription}</div>
                </div>
              </div>
            }
          >
            <button type="button" class="settings-model-info-button" aria-label={`${props.summary.label} details`}>
              <Icon name={getSemanticIcon("action.info")} size="small" />
            </button>
          </Tooltip>
        </div>
        <span class="settings-model-description">{props.summary.summary}</span>
      </div>

      <div class="settings-model-selector">
        <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
          <KobaltePopover.Trigger
            type="button"
            class="settings-model-trigger"
            aria-label={`Select ${props.summary.label} model`}
          >
            <span class="settings-model-trigger-text">
              <span class="settings-model-trigger-title">{display().triggerLabel}</span>
              <span class="settings-model-trigger-detail">{display().triggerDetail}</span>
            </span>
            <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
          </KobaltePopover.Trigger>
          <Show when={props.popoverLayer}>
            {(layer) => (
              <Portal mount={layer()}>
                <KobaltePopover.Content class="settings-model-picker-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
                  <KobaltePopover.Title class="sr-only">Select {props.summary.label} model</KobaltePopover.Title>
                  <List<ModelPickerOption>
                    class="settings-model-picker-list"
                    search={{ placeholder: "Search models", autofocus: true }}
                    emptyMessage="No model results"
                    key={(option) => option.key}
                    items={options}
                    current={currentOption()}
                    filterKeys={["label", "description", "value"]}
                    groupBy={(option) => option.group}
                    sortGroupsBy={sortModelGroups}
                    onSelect={selectModelRoleOption}
                  >
                    {(option) => (
                      <div class="settings-model-option">
                        <span class="settings-model-option-title">{option.label}</span>
                        <span class="settings-model-option-detail">{option.description}</span>
                      </div>
                    )}
                  </List>
                </KobaltePopover.Content>
              </Portal>
            )}
          </Show>
        </KobaltePopover>
        <Show when={props.availableVariants.length > 0 && props.onVariantChange}>
          <KobaltePopover
            open={variantPickerOpen()}
            onOpenChange={setVariantPickerOpen}
            placement="bottom-end"
            gutter={8}
          >
            <KobaltePopover.Trigger type="button" class="settings-model-variant" aria-label="Select model variant">
              <span class="settings-model-variant-label">{currentVariantOption()?.label ?? _(variantDefault)}</span>
              <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
            </KobaltePopover.Trigger>
            <Show when={props.popoverLayer}>
              {(layer) => (
                <Portal mount={layer()}>
                  <KobaltePopover.Content class="settings-model-variant-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
                    <KobaltePopover.Title class="sr-only">Select model variant</KobaltePopover.Title>
                    <List<ModelVariantOption>
                      class="settings-model-picker-list"
                      key={(option) => option.key}
                      items={variantOptions}
                      current={currentVariantOption()}
                      filterKeys={["label", "description", "value"]}
                      onSelect={selectModelVariantOption}
                    >
                      {(option) => (
                        <div class="settings-model-option">
                          <span class="settings-model-option-title">{option.label}</span>
                          <span class="settings-model-option-detail">{option.description}</span>
                        </div>
                      )}
                    </List>
                  </KobaltePopover.Content>
                </Portal>
              )}
            </Show>
          </KobaltePopover>
        </Show>
      </div>
    </div>
  )
}

function sortModelGroups(
  a: { category: string; items: ModelPickerOption[] },
  b: { category: string; items: ModelPickerOption[] },
) {
  if (a.category === "Default") return -1
  if (b.category === "Default") return 1
  return a.category.localeCompare(b.category)
}
