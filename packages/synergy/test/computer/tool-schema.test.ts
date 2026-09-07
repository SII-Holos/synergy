import { expect, test } from "bun:test"
import { z } from "zod"
import { ComputerAppsTool, ComputerObserveTool, ComputerActionTool } from "../../src/computer/tools"
test("every native Computer tool exposes object-shaped model parameters", async () => {
  for (const tool of [ComputerAppsTool, ComputerObserveTool, ComputerActionTool]) {
    const initialized = await tool.init()
    expect(z.toJSONSchema(initialized.parameters).type).toBe("object")
  }
})
