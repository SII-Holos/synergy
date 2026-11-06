import { describe, expect, test } from "bun:test"
import { DelegationModel } from "../../src/cortex/delegation-model"

const PARENT = { providerID: "parent-provider", modelID: "parent-model" }
const THINKING = { providerID: "thinking-provider", modelID: "reasoner" }
const MID = { providerID: "mid-provider", modelID: "generalist" }
const CATEGORY = { providerID: "category-provider", modelID: "category-model" }
const SUBAGENT = { providerID: "subagent-provider", modelID: "subagent-model" }
const SUBTASK = { providerID: "host-provider", modelID: "host-model" }

const roleModels = {
  default: { providerID: "default-provider", modelID: "default-model" },
  thinking: THINKING,
  mid: MID,
  creative: { providerID: "creative-provider", modelID: "writer" },
}

function available(...models: DelegationModel.Ref[]) {
  return new Set(models.map(DelegationModel.format))
}

describe("delegation model resolution", () => {
  test("inherits the available parent model when no model is requested", () => {
    expect(
      DelegationModel.resolve({
        parent: PARENT,
        agentModel: SUBAGENT,
        roleModels,
        available: available(PARENT, SUBAGENT, THINKING),
      }),
    ).toEqual(PARENT)
  })

  test("uses the agent model only after the parent model is unavailable", () => {
    expect(
      DelegationModel.resolve({
        parent: PARENT,
        agentModel: SUBAGENT,
        roleModels,
        available: available(SUBAGENT, THINKING),
      }),
    ).toEqual(SUBAGENT)
  })

  test("keeps the parent reference when neither model is available", () => {
    expect(
      DelegationModel.resolve({
        parent: PARENT,
        roleModels,
        available: available(),
      }),
    ).toEqual(PARENT)
  })

  test("lets a category model override inheritance only when model is omitted", () => {
    expect(
      DelegationModel.resolve({
        parent: PARENT,
        categoryModel: CATEGORY,
        subtaskModel: SUBTASK,
        roleModels,
        available: available(PARENT),
      }),
    ).toEqual(CATEGORY)
  })

  test("uses the host subtask model below category and above parent inheritance", () => {
    expect(
      DelegationModel.resolve({
        parent: PARENT,
        subtaskModel: SUBTASK,
        roleModels,
        available: available(PARENT),
      }),
    ).toEqual(SUBTASK)
  })

  test("an explicit role wins over the parent and category models", () => {
    expect(
      DelegationModel.resolve({
        requested: "thinking",
        parent: PARENT,
        categoryModel: CATEGORY,
        roleModels,
        available: available(PARENT, THINKING),
      }),
    ).toEqual(THINKING)
  })

  test("an explicit provider/model wins and must be available", () => {
    const selected = { providerID: "explicit-provider", modelID: "explicit-model" }
    expect(
      DelegationModel.resolve({
        requested: "explicit-provider/explicit-model",
        parent: PARENT,
        categoryModel: CATEGORY,
        roleModels,
        available: available(PARENT, selected),
      }),
    ).toEqual(selected)
    expect(() =>
      DelegationModel.resolve({
        requested: "explicit-provider/missing",
        parent: PARENT,
        roleModels,
        available: available(PARENT),
      }),
    ).toThrow("not available for delegation")
  })

  test("rejects an unavailable role instead of falling back", () => {
    expect(() =>
      DelegationModel.resolve({
        requested: "nano",
        parent: PARENT,
        roleModels,
        available: available(PARENT),
      }),
    ).toThrow('Role "nano" has no available model')
  })

  test("rejects a model that is not a role or provider/model", () => {
    for (const requested of ["model-only", "/model", "provider/", "provider/ ", "vision"]) {
      expect(() =>
        DelegationModel.resolve({
          requested,
          parent: PARENT,
          roleModels,
          available: available(PARENT),
        }),
      ).toThrow("provider/model")
    }
  })

  test("lists only available configured roles and never vision", () => {
    const menu = DelegationModel.formatMenu([
      { id: "parent", model: DelegationModel.format(PARENT), summary: "this turn; used when model is omitted" },
      {
        id: "thinking",
        model: DelegationModel.format(THINKING),
        summary: "Deep reasoning, architecture, and implementation.",
      },
    ])
    const resolved = DelegationModel.roleModelsFromConfig({
      model: "default-provider/default-model",
      thinking_model: "thinking-provider/reasoner",
      vision_model: "vision-provider/eyes",
    } as never)
    expect(resolved.thinking).toEqual(THINKING)
    expect(resolved).not.toHaveProperty("vision")
    expect(menu).toContain("parent: parent-provider/parent-model")
    expect(menu).toContain("thinking: thinking-provider/reasoner")
    expect(menu).not.toContain("vision")
  })
})
