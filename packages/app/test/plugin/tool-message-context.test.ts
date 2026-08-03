import { describe, expect, test } from "bun:test"
import type { PluginSurfaceContext } from "@ericsanchezok/synergy-plugin"
import type { ToolProps } from "@ericsanchezok/synergy-ui/message-part"
import { createPluginToolMessageContext } from "../../src/plugin/tool-message-context"

describe("plugin tool message context", () => {
  test("reflects streaming tool input and metadata updates", () => {
    const props: ToolProps = {
      tool: "plugin__test__tool",
      input: {},
      metadata: {},
      status: "running",
      messageId: "message-one",
    }
    const context = createPluginToolMessageContext({} as PluginSurfaceContext, props)

    props.input = { restatement: "Updated" }
    props.metadata = { plugin: { batchId: "batch-one" } }
    props.status = "completed"

    expect(context.tool.input).toEqual({ restatement: "Updated" })
    expect(context.tool.metadata).toEqual({ plugin: { batchId: "batch-one" } })
    expect(context.tool.status).toBe("completed")
  })
})
