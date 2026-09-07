import { expect, test } from "bun:test"
import { getComputerToolPresentation, classifyTool } from "../../../src/components/tool/classifier"
test("Computer tools have distinct titles and hide typed text from collapsed cards", () => {
  for (const name of ["computer_apps", "computer_observe", "computer_action"]) {
    const info = getComputerToolPresentation(name, { action: "type", text: "private text" })
    expect(info?.title.id).toStartWith("computer.title.")
    expect(JSON.stringify(info)).not.toContain("private text")
    expect(classifyTool(name).titleDescriptor?.id).toStartWith("computer.title.")
  }
  expect(getComputerToolPresentation("bash")).toBeUndefined()
})

test("action cards read the model-facing input wrapper", () => {
  const info = getComputerToolPresentation("computer_action", { input: { action: "type", text: "private" } })
  expect(info?.subtitle).toBe("type")
  expect(JSON.stringify(info)).not.toContain("private")
})
