import { getAgentVisual } from "../../agent-visual"
import { restorePopoverFocus } from "@ericsanchezok/synergy-ui/popover"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useLingui } from "@lingui/solid"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { ModelKey, ModelsStore, ProviderGroup } from "../types"
import { createProviderModelIndex, fieldLabel, modelRoleCopy, resolveModelRoleDraftDisplay } from "../model-role-draft"
import { ModelVariantPicker } from "@/components/provider/model-thinking-picker"
import { translateDescriptor } from "@/locales/translate"

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
  onConnectProvider?: (providerID: string) => void
}) {
  const { _, i18n } = useLingui()
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  let pickerTrigger: HTMLButtonElement | undefined
  let pickerSurface: HTMLDivElement | undefined
  let detailsTrigger: HTMLButtonElement | undefined
  let detailsSurface: HTMLDivElement | undefined

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

  const automaticDisplay = createMemo(() =>
    resolveModelRoleDraftDisplay(
      {
        summary: props.summary,
        value: "",
        draftModels: { ...props.draftModels, [props.summary.field]: "" },
        savedModels: props.savedModels,
        providerIndex: providerIndex(),
      },
      _,
    ),
  )
  const unavailable = () => Boolean(props.value && !providerIndex().has(props.value))
  const options = createMemo<ModelPickerOption[]>(() => [
    {
      kind: "fallback",
      key: "fallback",
      group: _(defaultGroupLabel),
      label: _({ id: "settings.modelRole.automatic", message: "Automatic" }),
      description: automaticDisplay().resolutionDescription,
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

  function selectModelRoleOption(option: ModelPickerOption | undefined) {
    if (!option) return
    props.onChange(props.summary.field as ModelKey, option.value)
    setPickerOpen(false)
  }

  return (
    <div class="settings-model-row">
      <div class="settings-model-copy">
        <div class="settings-model-title-line">
          <span class="settings-model-title settings-row-title">{roleCopy().label}</span>
          <KobaltePopover open={detailsOpen()} onOpenChange={setDetailsOpen} placement="right-start" gutter={8}>
            <KobaltePopover.Trigger
              ref={detailsTrigger}
              type="button"
              class="settings-model-info-button"
              aria-label={_({ ...detailsAriaLabel, values: { label: roleCopy().label } })}
            >
              <Icon name={getSemanticIcon("action.info")} size="small" />
            </KobaltePopover.Trigger>
            <Show when={props.popoverLayer}>
              {(layer) => (
                <KobaltePopover.Portal mount={layer()}>
                  <KobaltePopover.Content
                    ref={detailsSurface}
                    onCloseAutoFocus={(event) => {
                      event.preventDefault()
                      void restorePopoverFocus(detailsTrigger, detailsSurface)
                    }}
                    onEscapeKeyDown={(event) => event.stopPropagation()}
                    class="settings-model-detail-surface outline-none"
                  >
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
                                  {translateDescriptor(getAgentVisual(agent.name).label, i18n())}
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
                </KobaltePopover.Portal>
              )}
            </Show>
          </KobaltePopover>
        </div>
        <span class="settings-model-description">{roleCopy().description}</span>
        <Show when={unavailable()}>
          <div class="settings-model-unavailable" role="status">
            <span>
              {_({
                id: "settings.models.unavailable",
                message:
                  "This model is unavailable. Your selection is kept. Check the service connection or refresh its model list.",
              })}
            </span>
            <Show when={props.onConnectProvider}>
              <Button
                size="small"
                variant="ghost"
                onClick={() => props.onConnectProvider?.(props.value.split("/")[0]!)}
              >
                {_({ id: "settings.models.repair", message: "Check service" })}
              </Button>
            </Show>
          </div>
        </Show>
      </div>

      <div class="settings-model-selector">
        <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
          <KobaltePopover.Trigger
            ref={pickerTrigger}
            type="button"
            class="settings-model-trigger"
            aria-label={_({
              id: "settings.modelRole.select.named",
              message: "{role}: {intent}, {model}",
              values: {
                role: roleCopy().label,
                intent: props.value
                  ? _({ id: "settings.modelRole.fixed", message: "Fixed model" })
                  : _({ id: "settings.modelRole.automatic", message: "Automatic" }),
                model: [display().triggerLabel, display().triggerDetail].filter(Boolean).join(" · "),
              },
            })}
          >
            <span class="settings-model-trigger-text">
              <span class="settings-model-trigger-title">{display().triggerLabel}</span>
              <span class="settings-model-trigger-detail">{display().triggerDetail}</span>
            </span>
            <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
          </KobaltePopover.Trigger>
          <Show when={props.popoverLayer}>
            {(layer) => (
              <KobaltePopover.Portal mount={layer()}>
                <KobaltePopover.Content
                  ref={pickerSurface}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    void restorePopoverFocus(pickerTrigger, pickerSurface)
                  }}
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                  class="settings-model-picker-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden"
                >
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
              </KobaltePopover.Portal>
            )}
          </Show>
        </KobaltePopover>
        <Show when={props.onVariantChange}>
          {(onVariantChange) => (
            <ModelVariantPicker
              value={props.roleVariant}
              availableVariants={props.availableVariants}
              popoverLayer={props.popoverLayer}
              onChange={onVariantChange()}
            />
          )}
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
