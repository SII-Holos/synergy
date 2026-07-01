import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import type { ModelKey, ModelsStore, ProviderGroup } from "./types"

type ModelRef = {
  providerID: string
  modelID: string
}

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

export function resolveModelRoleDraftDisplay(params: {
  summary: ModelRoleSummary
  value: string
  draftModels: ModelsStore
  savedModels: ModelsStore
  providerIndex: ProviderModelIndex
}): ModelRoleDraftDisplay {
  const { summary, value, draftModels, savedModels, providerIndex } = params
  const field = summary.field as ModelKey

  if (value) {
    const model = modelDisplayValue(value, providerIndex)
    const unchanged = value === savedModels[field]
    return {
      triggerLabel: model.label,
      triggerDetail: model.detail,
      fallbackDescription: fallbackDescription(summary, providerIndex),
      resolutionDescription: unchanged
        ? `${model.label} via ${fieldLabel(field)}`
        : `Will use ${model.label} after saving`,
    }
  }

  if (fallbackChainChanged(summary, draftModels, savedModels)) {
    const draftFallback = resolveDraftFallback(summary, draftModels, providerIndex)
    if (draftFallback) {
      const detail = `Will resolve to ${draftFallback.model.label} via ${fieldLabel(draftFallback.field)}`
      return {
        triggerLabel: "Use fallback",
        triggerDetail: detail,
        fallbackDescription: detail,
        resolutionDescription: detail,
      }
    }

    return {
      triggerLabel: "Use fallback",
      triggerDetail: "Will resolve after saving",
      fallbackDescription: "Will resolve after saving",
      resolutionDescription: "Will resolve after saving",
    }
  }

  if (summary.id === "vision" && !summary.resolvedModel) {
    return {
      triggerLabel: "Not configured",
      triggerDetail: "Image analysis disabled",
      fallbackDescription: "Image analysis disabled",
      resolutionDescription: summary.disabledReason ?? "No model is configured for this role.",
    }
  }

  if (!summary.resolvedModel) {
    return {
      triggerLabel: "Use fallback",
      triggerDetail: "Runtime default",
      fallbackDescription: "Runtime default",
      resolutionDescription: summary.disabledReason ?? "No model is configured for this role.",
    }
  }

  const model = modelDisplay(summary.resolvedModel, providerIndex)
  return {
    triggerLabel: "Use fallback",
    triggerDetail: `Resolves to ${model.label}`,
    fallbackDescription: `Resolves to ${model.label}`,
    resolutionDescription: `${model.label} via ${fieldLabel(summary.resolvedModel.via)}`,
  }
}

export function fieldLabel(field: string) {
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

function resolveDraftFallback(summary: ModelRoleSummary, draftModels: ModelsStore, providerIndex: ProviderModelIndex) {
  for (const field of summary.fallbackChain) {
    const value = draftModels[field as ModelKey]
    if (!value) continue
    return {
      field,
      model: modelDisplayValue(value, providerIndex),
    }
  }
  return undefined
}

function fallbackChainChanged(summary: ModelRoleSummary, draftModels: ModelsStore, savedModels: ModelsStore) {
  return summary.fallbackChain.some((field) => draftModels[field as ModelKey] !== savedModels[field as ModelKey])
}

function fallbackDescription(summary: ModelRoleSummary, models: ProviderModelIndex) {
  if (summary.id === "vision" && !summary.resolvedModel) return "Image analysis disabled"
  if (!summary.resolvedModel) return "Runtime default"
  const model = modelDisplay(summary.resolvedModel, models)
  return `Resolves to ${model.label}`
}

function modelDisplayValue(value: string, models: ProviderModelIndex) {
  const found = models.get(value)
  if (found) return { label: found.modelName, detail: found.providerName }
  return { label: value, detail: "Custom value" }
}

function modelDisplay(ref: ModelRef, models: ProviderModelIndex) {
  const found = models.get(`${ref.providerID}/${ref.modelID}`)
  if (found) return { label: found.modelName, detail: found.providerName }
  return { label: `${ref.providerID}/${ref.modelID}`, detail: ref.providerID }
}
