import { describe, expect, test } from "bun:test"
import type { ProviderListResponse } from "@ericsanchezok/synergy-sdk"
import {
  isSelectableModel,
  listSelectableConnectedModels,
  recommendQuickSwitcherModels,
  resolveSessionModel,
} from "../../../src/components/provider/model-catalog"

type Provider = ProviderListResponse["all"][number]

function provider(models: Provider["models"]): Provider {
  return {
    id: "provider",
    name: "Provider",
    source: "custom",
    env: [],
    options: {},
    models,
  }
}

const baseModel: Provider["models"][string] = {
  id: "model",
  providerID: "provider",
  api: { id: "model", url: "https://example.test", npm: "test" },
  name: "Model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1, output: 1 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

describe("provider model catalog selection", () => {
  test("new selections exclude retained and deprecated models", () => {
    expect(isSelectableModel({ ...baseModel, catalogState: "active" })).toBe(true)
    expect(isSelectableModel({ ...baseModel, catalogState: "retained" })).toBe(false)
    expect(isSelectableModel({ ...baseModel, status: "deprecated" })).toBe(false)
  })

  test("an existing session can still resolve a retained model", () => {
    const retained = { ...baseModel, catalogState: "retained" as const }
    const resolved = resolveSessionModel([provider({ model: retained })], {
      providerID: "provider",
      modelID: "model",
    })

    expect(resolved?.model).toBe(retained)
  })

  test("quick-switcher management lists only selectable models from connected providers", () => {
    const connected = provider({
      active: { ...baseModel, id: "active", catalogState: "active" },
      retained: { ...baseModel, id: "retained", catalogState: "retained" },
      deprecated: { ...baseModel, id: "deprecated", status: "deprecated" },
    })
    const disconnected = {
      ...provider({
        other: { ...baseModel, id: "other", catalogState: "active" },
      }),
      id: "disconnected",
    }

    expect(listSelectableConnectedModels([connected, disconnected], ["provider"]).map((model) => model.id)).toEqual([
      "active",
    ])
  })

  test("quick-switcher recommendations use deterministic tie-breaking", () => {
    const connected = provider({
      sol: {
        ...baseModel,
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        capabilities: {
          ...baseModel.capabilities,
          reasoning: true,
          input: { ...baseModel.capabilities.input, image: true },
        },
        cost: { ...baseModel.cost, input: 1, output: 1 },
      },
      terra: {
        ...baseModel,
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        capabilities: {
          ...baseModel.capabilities,
          reasoning: true,
          input: { ...baseModel.capabilities.input, image: true },
        },
        cost: { ...baseModel.cost, input: 1, output: 1 },
      },
      luna: {
        ...baseModel,
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        capabilities: {
          ...baseModel.capabilities,
          reasoning: true,
          input: { ...baseModel.capabilities.input, image: true },
        },
        cost: { ...baseModel.cost, input: 1, output: 1 },
      },
    })
    const models = listSelectableConnectedModels([connected], ["provider"])
    const defaults = { provider: "gpt-5.6-terra" }

    expect(recommendQuickSwitcherModels(models, defaults)).toEqual([
      { providerID: "provider", modelID: "gpt-5.6-terra" },
      { providerID: "provider", modelID: "gpt-5.6-luna" },
    ])
    expect(recommendQuickSwitcherModels([...models].reverse(), defaults)).toEqual(
      recommendQuickSwitcherModels(models, defaults),
    )
  })
})
