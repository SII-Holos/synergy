import { describe, expect, test } from "bun:test"
import z from "zod"
import { DiagramTool } from "../../src/tool/diagram"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.diagram", () => {
  test("exports a top-level object schema", async () => {
    const tool = await DiagramTool.init()
    const schema = z.toJSONSchema(tool.parameters) as any

    expect(schema.type).toBe("object")
    expect(schema.properties.type.enum).toEqual(["graph", "compare", "sequence", "timeline", "tree", "chart"])
  })

  test("preserves variant validation for graph inputs", async () => {
    const tool = await DiagramTool.init()

    await expect(tool.execute({ type: "graph", title: "Architecture" } as any, ctx)).rejects.toThrow(
      "invalid arguments",
    )
  })

  test("renders a graph with the object-shaped parameters", async () => {
    const tool = await DiagramTool.init()
    const result = await tool.execute(
      {
        type: "graph",
        title: "Architecture",
        nodes: ["Client", "Server"],
        edges: ["Client -> Server"],
      },
      ctx,
    )

    expect(result.output).toContain(`Graph diagram: "Architecture"`)
    expect(result.metadata.render).toBe("diagram")
    expect(result.metadata.document).toEqual({
      type: "graph",
      title: "Architecture",
      direction: undefined,
      nodes: [{ label: "Client" }, { label: "Server" }],
      edges: [{ from: "Client", to: "Server", label: undefined }],
    })
  })
})
