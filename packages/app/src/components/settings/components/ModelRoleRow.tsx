import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { List } from "@ericsanchezok/synergy-ui/list"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { ModelKey, ProviderGroup } from "../types"

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

export function ModelRoleRow(props: {
  summary: ModelRoleSummary
  value: string
  providers: ProviderGroup[]
  onChange: (key: ModelKey, value: string) => void
}) {
  const [pickerOpen, setPickerOpen] = createSignal(false)

  const providerIndex = createMemo(() => {
    const models = new Map<string, { providerName: string; modelName: string }>()
    for (const provider of props.providers) {
      for (const model of provider.models) {
        models.set(`${provider.providerId}/${model.id}`, {
          providerName: provider.providerName,
          modelName: model.name,
        })
      }
    }
    return models
  })

  const options = createMemo<ModelPickerOption[]>(() => [
    {
      kind: "fallback",
      key: "fallback",
      group: "Default",
      label: "Use fallback",
      description: fallbackDescription(props.summary, providerIndex()),
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

  const selectedLabel = createMemo(() => {
    const current = currentOption()
    if (current?.kind === "model") return current.label
    if (props.value) return props.value
    if (props.summary.id === "vision" && !props.summary.resolvedModel) return "Not configured"
    return "Use fallback"
  })

  const selectedDetail = createMemo(() => {
    const current = currentOption()
    if (current?.kind === "model") return current.description
    if (props.value) return "Custom value"
    if (props.summary.id === "vision" && !props.summary.resolvedModel) return "Image analysis disabled"
    return fallbackDescription(props.summary, providerIndex())
  })

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
                    fallback={<div class="settings-model-detail-muted">No agents directly use this role.</div>}
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
                  <div class="settings-model-detail-muted">{resolutionDescription(props.summary, providerIndex())}</div>
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

      <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
        <KobaltePopover.Trigger class="settings-model-trigger" aria-label={`Select ${props.summary.label} model`}>
          <span class="settings-model-trigger-text">
            <span class="settings-model-trigger-title">{selectedLabel()}</span>
            <span class="settings-model-trigger-detail">{selectedDetail()}</span>
          </span>
          <Icon name="chevron-down" size="small" class="settings-model-trigger-icon" />
        </KobaltePopover.Trigger>
        <KobaltePopover.Portal>
          <KobaltePopover.Content class="settings-model-picker-popover flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden">
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
              onSelect={(option) => {
                if (!option) return
                props.onChange(props.summary.field as ModelKey, option.value)
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
        </KobaltePopover.Portal>
      </KobaltePopover>
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

function fieldLabel(field: string) {
  const labels: Record<string, string> = {
    model: "Default",
    nano_model: "Nano",
    mini_model: "Mini",
    mid_model: "Mid",
    thinking_model: "Thinking",
    long_context_model: "Long context",
    creative_model: "Creative",
    vision_model: "Vision",
  }
  return labels[field] ?? field
}

function fallbackDescription(
  summary: ModelRoleSummary,
  models: Map<string, { providerName: string; modelName: string }>,
) {
  if (summary.id === "vision" && !summary.resolvedModel) return "Image analysis disabled"
  if (!summary.resolvedModel) return "Runtime default"
  const model = modelDisplay(summary.resolvedModel, models)
  return `Resolves to ${model.label}`
}

function resolutionDescription(
  summary: ModelRoleSummary,
  models: Map<string, { providerName: string; modelName: string }>,
) {
  if (!summary.resolvedModel) return summary.disabledReason ?? "No model is configured for this role."
  const model = modelDisplay(summary.resolvedModel, models)
  return `${model.label} via ${fieldLabel(summary.resolvedModel.via)}`
}

function modelDisplay(ref: ModelRef, models: Map<string, { providerName: string; modelName: string }>) {
  const found = models.get(`${ref.providerID}/${ref.modelID}`)
  if (found) return { label: found.modelName, detail: found.providerName }
  return { label: `${ref.providerID}/${ref.modelID}`, detail: ref.providerID }
}
