import type { MessageDescriptor } from "@lingui/core"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { getModelRoleDefinition, type ModelKey, type ModelsStore, type ProviderGroup } from "./types"

type ModelRef = {
  providerID: string
  modelID: string
}

export type TranslateModelRoleDescriptor = (descriptor: MessageDescriptor) => string

type ModelRoleCopySource = Pick<ModelRoleSummary, "label" | "summary"> & { field: string }

export const modelRoleDraftCopy = {
  useFallback: { id: "settings.modelRole.fallback", message: "Use fallback" },
  willUseAfterSaving: { id: "settings.modelRole.willUseAfterSaving", message: "Will use {model} after saving" },
  willResolveToVia: {
    id: "settings.modelRole.willResolveToVia",
    message: "Will resolve to {model} via {role}",
  },
  willResolveAfterSaving: {
    id: "settings.modelRole.willResolveAfterSaving",
    message: "Will resolve after saving",
  },
  notConfigured: { id: "settings.modelRole.notConfigured", message: "Not configured" },
  imageAnalysisDisabled: {
    id: "settings.modelRole.imageAnalysisDisabled",
    message: "Image analysis disabled",
  },
  visionModelRequired: {
    id: "settings.modelRole.visionModelRequired",
    message: "Configure a vision model to enable image analysis.",
  },
  noModelConfigured: {
    id: "settings.modelRole.noModelConfigured",
    message: "No model is configured for this role.",
  },
  runtimeDefault: { id: "settings.modelRole.runtimeDefault", message: "Runtime default" },
  resolvesTo: { id: "settings.modelRole.resolvesTo", message: "Resolves to {model}" },
  modelViaRole: { id: "settings.modelRole.modelViaRole", message: "{model} via {role}" },
  customValue: { id: "settings.modelRole.customValue", message: "Custom value" },
} as const satisfies Record<string, MessageDescriptor>

export type ProviderModelIndex = Map<string, { providerName: string; modelName: string }>

export type ModelRoleDraftDisplay = {
  triggerLabel: string
  triggerDetail: string
  fallbackDescription: string
  resolutionDescription: string
}

export function createProviderModelIndex(providers: ProviderGroup[]): ProviderModelIndex {
  const models: ProviderModelIndex = new Map()
  for (const provider of providers) {
    for (const model of provider.models) {
      models.set(`${provider.providerId}/${model.id}`, {
        providerName: provider.providerName,
        modelName: model.name,
      })
    }
  }
  return models
}

export function resolveModelRoleDraftDisplay(
  params: {
    summary: ModelRoleSummary
    value: string
    draftModels: ModelsStore
    savedModels: ModelsStore
    providerIndex: ProviderModelIndex
  },
  translate: TranslateModelRoleDescriptor,
): ModelRoleDraftDisplay {
  const { summary, value, draftModels, savedModels, providerIndex } = params
  const field = summary.field as ModelKey

  if (value) {
    const model = modelDisplayValue(value, providerIndex, translate)
    const unchanged = value === savedModels[field]
    return {
      triggerLabel: model.label,
      triggerDetail: model.detail,
      fallbackDescription: fallbackDescription(summary, providerIndex, translate),
      resolutionDescription: unchanged
        ? translate({
            ...modelRoleDraftCopy.modelViaRole,
            values: { model: model.label, role: fieldLabel(field, translate) },
          })
        : translate({ ...modelRoleDraftCopy.willUseAfterSaving, values: { model: model.label } }),
    }
  }

  if (fallbackChainChanged(summary, draftModels, savedModels)) {
    const draftFallback = resolveDraftFallback(summary, draftModels, providerIndex, translate)
    if (draftFallback) {
      const detail = translate({
        ...modelRoleDraftCopy.willResolveToVia,
        values: { model: draftFallback.model.label, role: fieldLabel(draftFallback.field, translate) },
      })
      return {
        triggerLabel: translate(modelRoleDraftCopy.useFallback),
        triggerDetail: detail,
        fallbackDescription: detail,
        resolutionDescription: detail,
      }
    }

    const pendingResolution = translate(modelRoleDraftCopy.willResolveAfterSaving)
    return {
      triggerLabel: translate(modelRoleDraftCopy.useFallback),
      triggerDetail: pendingResolution,
      fallbackDescription: pendingResolution,
      resolutionDescription: pendingResolution,
    }
  }

  if (summary.id === "vision" && !summary.resolvedModel) {
    const disabled = translate(modelRoleDraftCopy.imageAnalysisDisabled)
    return {
      triggerLabel: translate(modelRoleDraftCopy.notConfigured),
      triggerDetail: disabled,
      fallbackDescription: disabled,
      resolutionDescription: summary.disabledReason ?? translate(modelRoleDraftCopy.visionModelRequired),
    }
  }

  if (!summary.resolvedModel) {
    const runtimeDefault = translate(modelRoleDraftCopy.runtimeDefault)
    return {
      triggerLabel: translate(modelRoleDraftCopy.useFallback),
      triggerDetail: runtimeDefault,
      fallbackDescription: runtimeDefault,
      resolutionDescription: summary.disabledReason ?? translate(modelRoleDraftCopy.noModelConfigured),
    }
  }

  const model = modelDisplay(summary.resolvedModel, providerIndex)
  const resolved = translate({ ...modelRoleDraftCopy.resolvesTo, values: { model: model.label } })
  return {
    triggerLabel: translate(modelRoleDraftCopy.useFallback),
    triggerDetail: resolved,
    fallbackDescription: resolved,
    resolutionDescription: translate({
      ...modelRoleDraftCopy.modelViaRole,
      values: { model: model.label, role: fieldLabel(summary.resolvedModel.via, translate) },
    }),
  }
}

export function fieldLabel(field: string, translate: TranslateModelRoleDescriptor): string {
  const definition = getModelRoleDefinition(field)
  return definition ? translate(definition.label) : field
}

export function modelRoleCopy(summary: ModelRoleCopySource, translate: TranslateModelRoleDescriptor) {
  const definition = getModelRoleDefinition(summary.field)
  return definition
    ? { label: translate(definition.label), description: translate(definition.description) }
    : { label: summary.label, description: summary.summary }
}

function resolveDraftFallback(
  summary: ModelRoleSummary,
  draftModels: ModelsStore,
  providerIndex: ProviderModelIndex,
  translate: TranslateModelRoleDescriptor,
) {
  for (const field of summary.fallbackChain) {
    const value = draftModels[field as ModelKey]
    if (!value) continue
    return {
      field,
      model: modelDisplayValue(value, providerIndex, translate),
    }
  }
  return undefined
}

function fallbackChainChanged(summary: ModelRoleSummary, draftModels: ModelsStore, savedModels: ModelsStore) {
  return summary.fallbackChain.some((field) => draftModels[field as ModelKey] !== savedModels[field as ModelKey])
}

function fallbackDescription(
  summary: ModelRoleSummary,
  models: ProviderModelIndex,
  translate: TranslateModelRoleDescriptor,
) {
  if (summary.id === "vision" && !summary.resolvedModel) return translate(modelRoleDraftCopy.imageAnalysisDisabled)
  if (!summary.resolvedModel) return translate(modelRoleDraftCopy.runtimeDefault)
  const model = modelDisplay(summary.resolvedModel, models)
  return translate({ ...modelRoleDraftCopy.resolvesTo, values: { model: model.label } })
}

function modelDisplayValue(value: string, models: ProviderModelIndex, translate: TranslateModelRoleDescriptor) {
  const found = models.get(value)
  if (found) return { label: found.modelName, detail: found.providerName }
  return { label: value, detail: translate(modelRoleDraftCopy.customValue) }
}

function modelDisplay(ref: ModelRef, models: ProviderModelIndex) {
  const found = models.get(`${ref.providerID}/${ref.modelID}`)
  if (found) return { label: found.modelName, detail: found.providerName }
  return { label: `${ref.providerID}/${ref.modelID}`, detail: ref.providerID }
}
