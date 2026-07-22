import { useLingui } from "@lingui/solid"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { ModelKey, ModelsStore, ProviderGroup } from "../types"
import { createProviderModelIndex, fieldLabel, modelRoleCopy, resolveModelRoleDraftDisplay } from "../model-role-draft"

const variantDefault = { id: "settings.modelRole.variant.default", message: "Default" }
const variantDesc = { id: "settings.modelRole.variant.desc", message: "Use the role default" }
const variantRoleDesc = { id: "settings.modelRole.variant.role", message: "Role variant" }
const noAgentsUse = { id: "settings.modelRole.noAgentsUse", message: "No agents directly use this role." }
const usedByLabel = { id: "settings.modelRole.usedBy", message: "Used by" }
const fallbackChainLabel = { id: "settings.modelRole.fallbackChain", message: "Fallback" }
const resolutionLabel = { id: "settings.modelRole.resolution", message: "Resolution" }
const selectModelLabel = { id: "settings.modelRole.selectModel", message: "Select model" }
const searchModelsPlaceholder = {
  id: "settings.modelRole.searchModels",
  message: "Search models",
}
const noModelResultsLabel = { id: "settings.modelRole.noModelResults", message: "No model results" }
const selectVariantLabel = { id: "settings.modelRole.selectVariant", message: "Select model variant" }
const detailsAriaLabel = { id: "settings.modelRole.details.ariaLabel", message: "{label} details" }
const systemAgentLabel = { id: "settings.modelRole.system", message: "system" }
const overrideAgentLabel = { id: "settings.modelRole.override", message: "override" }
const defaultGroupLabel = { id: "settings.modelRole.group.default", message: "Default" }
type ModelRef = {
  providerID: string
  modelID: string
}

type ModelPickerOption =
  | {
      kind: "fallback"
      key: "fallback"
      group: string
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
  const [detailsOpen, setDetailsOpen] = createSignal(false)

  const providerIndex = createMemo(() => createProviderModelIndex(props.providers))
  const roleCopy = createMemo(() => modelRoleCopy(props.summary, _))

  const display = createMemo(() =>
    resolveModelRoleDraftDisplay(
      {
        summary: props.summary,
        value: props.value,
        draftModels: props.draftModels,
        savedModels: props.savedModels,
        providerIndex: providerIndex(),
      },
      _,
    ),
  )

  const options = createMemo<ModelPickerOption[]>(() => [
    {
      kind: "fallback",
      key: "fallback",
      group: _(defaultGroupLabel),
      label: display().triggerLabel,
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
          <span class="settings-model-title">{roleCopy().label}</span>
          <KobaltePopover open={detailsOpen()} onOpenChange={setDetailsOpen} placement="right-start" gutter={8}>
            <KobaltePopover.Trigger
              type="button"
              class="settings-model-info-button"
              aria-label={_({ ...detailsAriaLabel, values: { label: roleCopy().label } })}
            >
              <Icon name={getSemanticIcon("action.info")} size="small" />
            </KobaltePopover.Trigger>
            <Show when={props.popoverLayer}>
              {(layer) => (
                <Portal mount={layer()}>
                  <KobaltePopover.Content class="settings-model-detail-surface outline-none">
                    <KobaltePopover.Title class="sr-only">
                      {_({ ...detailsAriaLabel, values: { label: roleCopy().label } })}
                    </KobaltePopover.Title>
                    <div class="settings-model-detail-popover">
                      <div>
                        <div class="settings-model-detail-title">{roleCopy().label}</div>
                        <div class="settings-model-detail-muted">{roleCopy().description}</div>
                      </div>
                      <div class="settings-model-detail-block">
                        <div class="settings-model-detail-label">{_(usedByLabel)}</div>
                        <Show
                          when={props.summary.usedBy.length > 0}
                          fallback={<div class="settings-model-detail-muted">{_(noAgentsUse)}</div>}
                        >
                          <div class="settings-model-agent-list">
                            <For each={props.summary.usedBy}>
                              {(agent) => (
                                <span class="settings-model-chip">
                                  {agent.name}
                                  <Show when={agent.hidden}>
                                    <span class="settings-model-chip-muted">{_(systemAgentLabel)}</span>
                                  </Show>
                                  <Show when={agent.modelSource === "explicit"}>
                                    <span class="settings-model-chip-muted">{_(overrideAgentLabel)}</span>
                                  </Show>
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                      <div class="settings-model-detail-block">
                        <div class="settings-model-detail-label">{_(fallbackChainLabel)}</div>
                        <div class="settings-model-fallback-chain">
                          <For each={props.summary.fallbackChain}>{(field) => <span>{fieldLabel(field, _)}</span>}</For>
                        </div>
                      </div>
                      <div class="settings-model-detail-block">
                        <div class="settings-model-detail-label">{_(resolutionLabel)}</div>
                        <div class="settings-model-detail-muted">{display().resolutionDescription}</div>
                      </div>
                    </div>
                  </KobaltePopover.Content>
                </Portal>
              )}
            </Show>
          </KobaltePopover>
        </div>
        <span class="settings-model-description">{roleCopy().description}</span>
      </div>

      <div class="settings-model-selector">
        <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
          <KobaltePopover.Trigger
            type="button"
            class="settings-model-trigger"
            aria-label={`${_(selectModelLabel)} ${roleCopy().label}`}
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
                  <KobaltePopover.Title class="sr-only">
                    {_(selectModelLabel)} {roleCopy().label}
                  </KobaltePopover.Title>
                  <List<ModelPickerOption>
                    class="settings-model-picker-list"
                    search={{ placeholder: _(searchModelsPlaceholder), autofocus: true }}
                    emptyMessage={_(noModelResultsLabel)}
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
            <KobaltePopover.Trigger type="button" class="settings-model-variant" aria-label={_(selectVariantLabel)}>
              <span class="settings-model-variant-label">{currentVariantOption()?.label ?? _(variantDefault)}</span>
              <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
            </KobaltePopover.Trigger>
            <Show when={props.popoverLayer}>
              {(layer) => (
                <Portal mount={layer()}>
                  <KobaltePopover.Content class="settings-model-variant-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
                    <KobaltePopover.Title class="sr-only">{_(selectVariantLabel)}</KobaltePopover.Title>
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
  const aIsDefault = a.items.some((option) => option.kind === "fallback")
  const bIsDefault = b.items.some((option) => option.kind === "fallback")
  if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1
  return a.category.localeCompare(b.category)
}
