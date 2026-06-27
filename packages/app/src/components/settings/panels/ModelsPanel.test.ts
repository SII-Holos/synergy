import { describe, expect, test } from "bun:test"

const modelRoleRow = await Bun.file(new URL("../components/ModelRoleRow.tsx", import.meta.url)).text()
const modelsPanel = await Bun.file(new URL("./ModelsPanel.tsx", import.meta.url)).text()

describe("Models panel UI contract", () => {
  test("uses compact popover model pickers instead of native role selects", () => {
    expect(modelRoleRow).toContain("KobaltePopover")
    expect(modelRoleRow).toContain("settings-model-trigger")
    expect(modelRoleRow).toContain("settings-model-picker-popover")
    expect(modelRoleRow).not.toContain("<select")
    expect(modelRoleRow).not.toContain("<option")
  })

  test("model picker writes the selected value to the role config field", () => {
    expect(modelRoleRow).toContain("props.onChange(props.summary.field as ModelKey, option.value)")
    expect(modelsPanel).toContain("value={props.models[summary.field as ModelKey]}")
  })

  test("vision unset state is presented as disabled image analysis", () => {
    expect(modelRoleRow).toContain("Image analysis disabled")
    expect(modelRoleRow).toContain("Not configured")
    expect(modelRoleRow).not.toContain("global required")
  })
})
